'use strict';
/**
 * 朋友圈助手引擎（动作「启动引擎」，mode: service）。
 *
 * 宿主目前只给自带界面三种能力：发 ready / run(actionId) / notify，不能传参数、不能显示本地图片。
 * 所以插件自己补上需求文档第 10 节的 H1–H4 和"传参数"：
 *   - 本机接口（只监听 127.0.0.1，带随机口令）：界面用 fetch 读写草稿、看缩略图、上传处理结果；
 *   - 局域网网页（监听 0.0.0.0，每次传图一个一次性口令，10 分钟无上传失效）：手机扫码传图 / 存回手机；
 *   - AI 调用：Claude 或 OpenAI 兼容接口，key 加密存在插件数据目录；
 *   - 图片处理在界面里用 canvas 完成（浏览器自带解码和 JPEG 编码，比 PowerShell 快得多）。
 * 清单里的其他动作（挑照片、调色……）是"瘦客户端"：连到本引擎执行对应步骤，把进度输出到宿主的输出区。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { createDrafts, IMAGE_EXT, MAX_PHOTO_BYTES } = require('./lib/drafts');
const { createMemory, ONBOARDING } = require('./lib/memory');
const { createSecretStore } = require('./lib/secret');
const { injectExif } = require('./lib/exif');
const Grade = require('./lib/grade');
const S = require('./lib/select');
const C = require('./lib/caption');
const P = require('./lib/prompts');
const ai = require('./lib/ai');
const { qrSvg } = require('./lib/qr');
const phone = require('./lib/phone-page');

const SESSION_IDLE_MS = 10 * 60 * 1000;
const MAX_UPLOADS = 100;
const AI_BATCH = 4;

function createEngine({ dataDir, sdk, log = console.log, lanHost = '0.0.0.0', clipboard = copyToClipboard }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const drafts = createDrafts(dataDir);
  const memory = createMemory(dataDir);
  const secret = createSecretStore(dataDir);
  const settingsFile = path.join(dataDir, 'settings.json');
  const token = crypto.randomBytes(18).toString('base64url');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (_) {}
  const saveSettings = () => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  let pendingAi = null;
  let cur = null;

  // ── 草稿 ───────────────────────────────────────────────
  function draft() {
    if (cur) return cur;
    if (settings.lastDraft) { try { cur = drafts.load(settings.lastDraft); return cur; } catch (_) {} }
    return newDraft();
  }
  function newDraft() { cur = drafts.create(); settings.lastDraft = cur.id; saveSettings(); return cur; }
  function openDraft(id) { cur = drafts.load(id); settings.lastDraft = id; saveSettings(); return cur; }
  const save = (d = draft()) => drafts.save(d);
  const photoOf = (d, id) => d.photos.find(p => p.id === id);
  const draftDir = d => drafts.dirOf(d.id);
  const thumbPath = (d, p) => path.join(draftDir(d), 'thumbs', p.id + '.jpg');
  const exportDir = d => path.join(draftDir(d), '发布包');

  // ── AI 配置 ──────────────────────────────────────────────
  function aiConfig() {
    const a = settings.ai;
    if (!a || !a.keyBlob) return null;
    try { return { provider: a.provider, baseUrl: a.baseUrl, model: a.model, apiKey: secret.decrypt(a.keyBlob) }; }
    catch (e) { return null; }
  }
  function aiPublic() {
    const a = settings.ai || {};
    return { configured: !!a.keyBlob, provider: a.provider || 'anthropic', baseUrl: a.baseUrl || '', model: a.model || '', providers: ai.PROVIDERS,
      totalCalls: memory.load().aiCalls || 0, pending: !!pendingAi };
  }
  async function callAi(d, opts) {
    const cfg = aiConfig();
    if (!cfg) throw new ai.AiError('请先在「AI 设置」里配置接口');
    const text = await ai.chat(cfg, { system: P.SYSTEM, ...opts });
    d.aiCalls = (d.aiCalls || 0) + 1;
    memory.update(m => { m.aiCalls = (m.aiCalls || 0) + 1; });
    return text;
  }
  const thumbImage = (d, p) => ({ data: fs.readFileSync(thumbPath(d, p)).toString('base64'), mime: 'image/jpeg' });
  const hasThumb = (d, p) => fs.existsSync(thumbPath(d, p));

  // ── 局域网：手机传图 / 存回手机 ─────────────────────────────
  const sessions = new Map();
  let lan = null, lanPort = 0;
  function lanAddress() {
    const all = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) all.push({ name, address: a.address });
    }
    all.sort((a, b) => (b.address.startsWith('192.168') - a.address.startsWith('192.168')) || (/^(en|eth|wlan|wi-?fi|以太网|无线)/i.test(b.name) - /^(en|eth|wlan|wi-?fi|以太网|无线)/i.test(a.name)));
    return all[0] ? all[0].address : null;
  }
  function ensureLan() {
    if (lan) return Promise.resolve(lanPort);
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => handleLan(req, res).catch(e => sendJson(res, 500, { error: e.message })));
      srv.on('error', reject);
      srv.listen(0, lanHost, () => { lan = srv; lanPort = srv.address().port; resolve(lanPort); });
    });
  }
  function startSession(kind, d) {
    for (const s of sessions.values()) if (!s.ended && s.kind === kind) endSession(s, 'replaced');
    const s = { token: crypto.randomBytes(12).toString('base64url'), kind, draftId: d.id, created: Date.now(), last: Date.now(), received: 0, names: [], ended: false, endReason: '', listeners: new Set() };
    s.done = new Promise(r => { s.resolve = r; });
    sessions.set(s.token, s);
    return s;
  }
  function endSession(s, reason) {
    if (s.ended) return;
    s.ended = true; s.endReason = reason; s.resolve(reason);
    for (const fn of s.listeners) fn({ type: 'end', reason });
  }
  const sweep = setInterval(() => {
    for (const s of sessions.values()) if (!s.ended && Date.now() - s.last > SESSION_IDLE_MS) endSession(s, 'expired');
  }, 5000);
  sweep.unref();
  function sessionUrl(s) { const ip = lanAddress(); return ip ? `http://${ip}:${lanPort}/${s.kind === 'import' ? 'u' : 's'}/${s.token}` : null; }
  function phoneStatus() {
    const out = {};
    for (const kind of ['import', 'export']) {
      const s = [...sessions.values()].filter(x => x.kind === kind).sort((a, b) => b.created - a.created)[0];
      if (!s) continue;
      const url = sessionUrl(s);
      out[kind] = { active: !s.ended, url, qr: url && !s.ended ? qrSvg(url) : null, received: s.received, endReason: s.endReason,
        expiresAt: s.last + SESSION_IDLE_MS, draftId: s.draftId };
    }
    return out;
  }
  const EXPIRED_TEXT = { expired: '10 分钟没有新照片，二维码已自动失效。', done: '这次导入已经完成。', stopped: '电脑上已结束这次传图。', replaced: '电脑上已生成了新的二维码。' };
  async function handleLan(req, res) {
    const u = new URL(req.url, 'http://x');
    const m = /^\/(u|s)\/([\w-]+)(?:\/(upload|done|\d+))?$/.exec(u.pathname);
    const s = m && sessions.get(m[2]);
    const valid = s && !s.ended && Date.now() - s.last <= SESSION_IDLE_MS && s.kind === (m[1] === 'u' ? 'import' : 'export');
    if (!m) return sendText(res, 404, 'not found');
    if (!valid) {
      if (req.method === 'GET') return sendHtml(res, 410, phone.expiredPage(s ? EXPIRED_TEXT[s.endReason] || EXPIRED_TEXT.expired : '二维码不对或已失效。'));
      return sendJson(res, 410, { error: '二维码已失效，请在电脑上重新生成' });
    }
    if (m[1] === 'u') {
      if (!m[3] && req.method === 'GET') return sendHtml(res, 200, phone.uploadPage({ max: MAX_UPLOADS, maxMb: 30 }));
      if (m[3] === 'done' && req.method === 'POST') { endSession(s, 'done'); return sendJson(res, 200, { ok: true }); }
      if (m[3] === 'upload' && req.method === 'POST') {
        if (s.received >= MAX_UPLOADS) return sendJson(res, 400, { error: `一次最多 ${MAX_UPLOADS} 张` });
        if (!/^image\//.test(req.headers['content-type'] || '')) return sendJson(res, 400, { error: '只能上传图片' });
        if (Number(req.headers['content-length'] || 0) > MAX_PHOTO_BYTES) return sendJson(res, 413, { error: '单张不能超过 30 MB' });
        s.last = Date.now();
        const buf = await readBody(req, MAX_PHOTO_BYTES);
        const d = s.draftId === draft().id ? draft() : drafts.load(s.draftId);
        let p;
        try { p = drafts.addPhoto(d, buf, u.searchParams.get('name') || 'photo.jpg', 'phone'); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
        drafts.sortPhotos(d); save(d);
        s.received++; s.last = Date.now(); s.names.push(p.name);
        for (const fn of s.listeners) fn({ type: 'photo', photo: p });
        return sendJson(res, 200, { ok: true, warning: p.unsupported ? '这张照片格式不支持，可以在手机相册里换成兼容格式' : '' });
      }
    } else {
      const d = s.draftId === draft().id ? draft() : drafts.load(s.draftId);
      const files = d.export.files || [];
      if (!m[3] && req.method === 'GET') return sendHtml(res, 200, phone.savePage({ files, caption: d.caption.text, base: u.pathname }));
      if (/^\d+$/.test(m[3] || '') && req.method === 'GET') {
        const f = files[Number(m[3]) - 1];
        if (!f) return sendText(res, 404, 'not found');
        s.last = Date.now();
        return sendFile(res, path.join(exportDir(d), f));
      }
    }
    return sendText(res, 404, 'not found');
  }

  // ── 挑照片 ───────────────────────────────────────────────
  function photoScore(p, weights, med) {
    return p.ai ? S.totalScore(p.ai.scores, weights, p.ai.hasPeople) : S.localQuality(p, med);
  }
  /** 用已有分数重新组合挑选（改权重、改张数时不再调用 AI） */
  function selectFromScores(d) {
    const mem = memory.load();
    const weights = S.normalizeWeights(d.pick.weights || mem.weights);
    const byId = Object.fromEntries(d.photos.map(p => [p.id, p]));
    const ids = S.capCandidates(d.photos, d.pick.candidates.filter(id => byId[id]));
    const med = S.median(ids.map(id => byId[id].metrics.sharp));
    const items = ids.map(id => ({ id, score: photoScore(byId[id], weights, med), category: byId[id].ai ? byId[id].ai.category : 'other', scene: (d.pick.flags[id] || {}).group || id }));
    const count = Math.min(d.pick.count || 9, items.length);
    const r = S.chooseSet(items, { count, catBias: mem.catBias });
    for (const id of r.selected) {
      const p = byId[id];
      const best = p.ai && Object.entries(p.ai.reasons).filter(([k, v]) => v && p.ai.scores[k] != null).sort((a, b) => p.ai.scores[b[0]] - p.ai.scores[a[0]])[0];
      r.reasons[id] = r.reasons[id] + (best ? `；${best[1]}` : p.ai ? '' : '；清晰度和曝光较好（未用 AI）');
    }
    d.pick.selected = r.selected; d.pick.alternates = r.alternates; d.pick.reasons = r.reasons;
    d.pick.initial = [...r.selected]; d.pick.swaps = [];
    d.pick.scores = Object.fromEntries(items.map(it => [it.id, it.score]));
    d.pick.weightsUsed = weights;
    return r;
  }
  async function stepPick(out, signal) {
    const d = draft();
    const usable = d.photos.filter(p => !p.unsupported);
    if (!usable.length) { out('[失败] 草稿里还没有照片。建议：先「从手机导入」或「从文件夹导入」'); return 1; }
    const pendingN = usable.filter(p => !p.metrics || !hasThumb(d, p)).length;
    if (pendingN) { out(`[失败] 还有 ${pendingN} 张照片没分析完（界面正在生成缩略图）。建议：打开朋友圈助手界面，等进度条走完再点`); return 1; }
    out('== 第 1 步：本地预筛（不调用 AI）==');
    const pre = S.prefilter(d.photos);
    const vals = Object.values(pre.flags);
    const dupRemoved = vals.filter(f => !f.best && !f.blurry && !f.exposure).length;
    out(`[OK] 共 ${usable.length} 张：可能拍糊 ${vals.filter(f => f.blurry).length} 张，曝光问题 ${vals.filter(f => f.exposure).length} 张，连拍/相似去掉 ${dupRemoved} 张`);
    out(`[OK] 进入候选 ${pre.candidates.length} 张（被筛掉的照片没有删除，可以在界面里放回候选）`);
    if (!pre.candidates.length) { out('[失败] 没有可用的候选照片。建议：在界面里把想要的照片手动放回候选'); return 1; }
    d.pick.flags = pre.flags; d.pick.candidates = pre.candidates;
    const ids = S.capCandidates(d.photos, pre.candidates);
    if (pre.candidates.length > ids.length) out(`[警告] 候选超过 ${S.MAX_AI_CANDIDATES} 张，按清晰度和曝光取前 ${ids.length} 张交给 AI`);
    const cfg = aiConfig();
    const opts = d.pick.opts || {};
    d.pick.usedAi = false;
    if (cfg && !opts.local) {
      const todo = ids.map(id => photoOf(d, id)).filter(p => opts.rescore || !p.ai);
      out('== 第 2 步：AI 分项打分 ==');
      out(`[OK] 需要打分 ${todo.length} 张（已打过分的不重复调用），将调用 AI 约 ${Math.ceil(todo.length / AI_BATCH)} 次`);
      const summary = memory.summary();
      for (let i = 0; i < todo.length; i += AI_BATCH) {
        if (signal.aborted) { out('（已停止）'); save(d); return 0; }
        const batch = todo.slice(i, i + AI_BATCH);
        let parsed = null, lastErr = null;
        for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
          try { parsed = P.parseScores(ai.parseJson(await callAi(d, { text: P.scorePrompt(batch.length, summary), images: batch.map(p => thumbImage(d, p)), signal })), batch.length); }
          catch (e) { lastErr = e; if (signal.aborted || /key|权限|地址|连不上|配置/.test(e.message)) break; }
        }
        if (!parsed) {
          if (i === 0) { out('[失败] ' + lastErr.message); if (lastErr.detail) out('  详情：' + lastErr.detail); out('  已完成的步骤和草稿不受影响；也可以在界面勾选「不用 AI」只按本地清晰度挑选'); save(d); return 1; }
          out(`[警告] 第 ${i + 1}–${i + batch.length} 张打分失败（${lastErr.message}），这几张按本地清晰度计分`);
          continue;
        }
        batch.forEach((p, k) => { if (parsed[k]) p.ai = parsed[k]; });
        out(`[OK] 已打分 ${Math.min(i + AI_BATCH, todo.length)} / ${todo.length}`);
        save(d);
      }
      d.pick.usedAi = true;
    } else {
      out(cfg ? '[OK] 已选择不用 AI：按本地清晰度和曝光挑选' : '[警告] 没有配置 AI：按本地清晰度和曝光挑选。想要 AI 打分，请先在「AI 设置」里配置');
    }
    out('== 第 3 步：组合挑选（同一场景最多 2 张，照顾不同类型）==');
    const r = selectFromScores(d);
    r.selected.forEach((id, i) => out(`[OK] ${i + 1}. ${photoOf(d, id).name}：${r.reasons[id]}`));
    out(`结论：挑出 ${r.selected.length} 张，另有 ${r.alternates.length} 张候补。可以在界面里换图`);
    d.pick.done = true; d.step = 'pick';
    drafts.markStale(d, 'pick');
    save(d);
    return 0;
  }

  // ── 调色 ───────────────────────────────────────────────
  function sampleThumbs(d, n) {
    const ids = (d.layout.order.length ? d.layout.order : d.pick.selected.length ? d.pick.selected : d.photos.map(p => p.id));
    return ids.map(id => photoOf(d, id)).filter(p => p && !p.unsupported && hasThumb(d, p)).slice(0, n);
  }
  async function stepGrade(out, signal) {
    const d = draft();
    const req = d.grade.request;
    if (!req) { out('[失败] 请先在界面里输入一句话描述，或上传参考图'); return 1; }
    const before = d.grade.params;
    const cfg = aiConfig();
    const summary = memory.summary();
    if (req.type === 'text') {
      out(`== 一句话调色：「${req.text}」==`);
      let result = null;
      if (cfg) {
        try {
          const imgs = sampleThumbs(d, 2).map(p => thumbImage(d, p));
          result = P.parseGrade(ai.parseJson(await callAi(d, { text: P.gradePrompt(before, req.text, summary), images: imgs, signal })));
          out('[OK] AI：' + (result.explain || '已调整'));
        } catch (e) {
          if (signal.aborted) { out('（已停止）'); return 0; }
          out('[警告] AI 调色失败：' + e.message + '，改用离线规则');
        }
      }
      if (!result) {
        const r = Grade.parseInstruction(req.text, before);
        if (!r.understood) { out('[失败] 没听懂这句话。可以试试："暖一点""再亮一点""日系通透一点，别太黄""天空再蓝一点"'); return 1; }
        result = { params: r.params, explain: r.notes.join('，') };
        out('[OK] 离线规则：' + result.explain);
      }
      d.grade.history.push(before);
      d.grade.params = result.params; d.grade.explain = result.explain; d.grade.preset = 'custom';
      d.grade.presetName = d.grade.presetName && !/（调整）$/.test(d.grade.presetName) ? d.grade.presetName + '（调整）' : (d.grade.presetName || '一句话调色');
    } else if (req.type === 'reference') {
      out('== 复刻同款滤镜 ==');
      const local = Grade.normalize(req.params);
      out('[OK] 本地颜色迁移：' + Grade.describe(local));
      let params = local, style = '';
      const ref = path.join(draftDir(d), 'reference.jpg');
      if (cfg && fs.existsSync(ref)) {
        try {
          const imgs = [{ data: fs.readFileSync(ref).toString('base64'), mime: 'image/jpeg' }, ...sampleThumbs(d, 2).map(p => thumbImage(d, p))];
          const r = P.parseGrade(ai.parseJson(await callAi(d, { text: P.referencePrompt(local, summary), images: imgs, signal })));
          params = r.params; style = r.style;
          out(`[OK] AI 分析参考图风格：${style || '（无描述）'}，已校正参数`);
        } catch (e) {
          if (signal.aborted) { out('（已停止）'); return 0; }
          out('[警告] AI 分析失败：' + e.message + '，只使用本地颜色迁移结果');
        }
      } else if (!cfg) out('[警告] 没有配置 AI：只使用本地颜色迁移结果');
      d.grade.history.push(before);
      d.grade.params = params; d.grade.preset = 'custom'; d.grade.presetName = '复刻滤镜'; d.grade.explain = style;
      d.grade.reference = { ...(d.grade.reference || {}), style };
    }
    out('结论：' + Grade.describe(d.grade.params));
    out(req.type === 'reference' ? '提示：参考图被平台压缩过、拍摄场景也不同，效果是"风格接近"，不保证完全一致。满意的话可以在界面里存为预设' : '提示：可以继续说"再…一点"在当前效果上调整；满意的话可以在界面里存为预设');
    d.grade.request = null;
    d.step = 'grade';
    save(d);
    return 0;
  }

  // ── 排版 ───────────────────────────────────────────────
  async function stepLayout(out, signal) {
    const d = draft();
    const ids = d.pick.selected.filter(id => photoOf(d, id));
    if (!ids.length) { out('[失败] 还没有挑照片。建议：先完成「挑照片」'); return 1; }
    const scores = d.pick.scores || {};
    const meta = Object.fromEntries(ids.map(id => [id, { scene: (d.pick.flags[id] || {}).group || id, rank: 0 }]));
    const byScore = [...ids].sort((a, b) => (scores[b] || 0) - (scores[a] || 0));
    byScore.forEach((id, i) => { meta[id].rank = i; });
    let order = null, count = d.layout.wantCount || null, reasons = [];
    const cfg = aiConfig();
    if (cfg && !(d.layout.opts || {}).local) {
      out('== AI 排版 ==');
      const shown = ids.filter(id => hasThumb(d, photoOf(d, id))).slice(0, 9);
      try {
        const r = P.parseLayout(ai.parseJson(await callAi(d, { text: P.layoutPrompt(shown.length, d.caption.occasion, memory.summary()), images: shown.map(id => thumbImage(d, photoOf(d, id))), signal })), shown.length);
        if (r.order.length) order = r.order.map(i => shown[i]);
        if (r.rank.length) { r.rank.forEach((i, k) => { meta[shown[i]].rank = k; }); for (const id of ids) if (!r.rank.some(i => shown[i] === id)) meta[id].rank += 100; }
        count = count || r.count; reasons = r.reasons;
        out('[OK] AI 建议发 ' + (r.count || '?') + ' 张');
        reasons.forEach(x => out('  · ' + x));
      } catch (e) {
        if (signal.aborted) { out('（已停止）'); return 0; }
        out('[警告] AI 排版失败：' + e.message + '，改用规则排版');
      }
    } else out(cfg ? '== 按规则排版 ==' : '[警告] 没有配置 AI：按规则排版（封面 = 总分最高；类型交替；同一场景不相邻）');
    if (!order) {
      order = S.defaultOrder(ids.map(id => ({ id, score: scores[id] || 0, category: (photoOf(d, id).ai || {}).category || 'other', scene: meta[id].scene, time: Date.parse(photoOf(d, id).takenAt || '') || photoOf(d, id).order })));
      if (!reasons.length) reasons = ['封面是总分最高的一张', '其余按拍摄时间排列，尽量让人像、风景等类型交替'];
    }
    const fixed = S.applyLayoutRules(order.concat(ids.filter(id => !order.includes(id))), meta, count);
    if (fixed.count === 9) reasons.push('第 5 张（九宫格正中间）放了第二吸引人的照片');
    if (fixed.conflicts) out('[警告] 同一场景的照片太多，有 ' + fixed.conflicts + ' 处无法避免相邻');
    d.layout.order = fixed.order; d.layout.count = fixed.count; d.layout.reasons = reasons; d.layout.suggested = [...fixed.order];
    d.layout.drags = 0; d.layout.stale = false; d.layout.rank = Object.fromEntries(ids.map(id => [id, meta[id].rank]));
    fixed.order.forEach((id, i) => out(`[OK] 第 ${i + 1} 张：${photoOf(d, id).name}${i === 0 ? '（封面）' : ''}`));
    out(`结论：发 ${fixed.count} 张，${S.gridColumns(fixed.count) === 2 ? '2×2' : '每行 3 张'}显示。可以在界面里拖动调整顺序`);
    d.step = 'layout';
    save(d);
    return 0;
  }

  // ── 文案 ───────────────────────────────────────────────
  function styleById(id) {
    const b = C.BUILTIN_STYLES.find(s => s.id === id);
    if (b) return { name: b.name, card: b.card };
    const u = memory.styles.list().find(s => s.id === id);
    return u ? { name: u.name, card: u.card, user: true } : null;
  }
  async function stepCaption(out, signal) {
    const d = draft();
    const c = d.caption;
    const cfg = aiConfig();
    const refText = String(c.refText || '').trim();
    let style = c.styleId === 'ref' ? null : styleById(c.styleId);
    out('== 写文案 ==');
    if (/https?:\/\//i.test(refText)) { out('[失败] 本版不从链接抓取文案（平台大多要登录、有反爬限制）。请直接复制粘贴文案文字'); return 1; }
    if (!cfg) {
      c.options = C.offlineCaptions(c.occasion, C.BUILTIN_STYLES.some(s => s.id === c.styleId) ? c.styleId : 'short');
      out('[警告] 没有配置 AI：给出几条离线模板（只用了你写的场合，没有编造内容）。配置 AI 后可以看图写文案、复刻风格');
    } else {
      const summary = memory.summary();
      if (refText && (c.styleId === 'ref' || !style)) {
        try {
          const r = P.parseStyle(ai.parseJson(await callAi(d, { text: P.stylePrompt(refText), signal })));
          c.styleCard = r.card; c.styleCardName = r.name;
          style = { name: r.name, card: r.card };
          out(`[OK] 分析出风格卡「${r.name}」：${C.cardText(r.card)}`);
        } catch (e) { if (signal.aborted) { out('（已停止）'); return 0; } out('[失败] 分析参考文案失败：' + e.message); return 1; }
      }
      if (!style) style = styleById('short');
      const imgs = sampleThumbs(d, 4).map(p => thumbImage(d, p));
      let good = [], avoid = null;
      for (let attempt = 0; attempt < 3 && good.length < 3; attempt++) {
        let list;
        try { list = P.parseCaptions(ai.parseJson(await callAi(d, { text: P.captionPrompt({ occasion: c.occasion, styleName: style.name, card: style.card, refText, summary, avoid }), images: imgs, signal }))); }
        catch (e) { if (signal.aborted) { out('（已停止）'); return 0; } if (attempt === 0 && !good.length) { out('[失败] ' + e.message); if (e.detail) out('  详情：' + e.detail); return 1; } break; }
        const copied = list.filter(x => C.copiesReference(x, refText));
        if (copied.length) { out(`[警告] 有 ${copied.length} 条和参考文案连续 ${C.COPY_LIMIT} 个字以上相同，已丢弃${attempt < 2 ? '并重新生成' : ''}`); avoid = copied; }
        for (const x of list) if (!copied.includes(x) && !good.includes(x)) good.push(x);
      }
      if (!good.length) { out('[失败] 生成的文案都和参考文案太像，请换一段参考文案或改用内置风格'); return 1; }
      c.options = good.slice(0, 5);
      c.styleName = style.name;
      if (style.user) memory.styles.use(c.styleId);
    }
    c.options.forEach((x, i) => out(`[OK] ${i + 1}. ${x.replace(/\n/g, ' / ')}`));
    out('结论：生成了 ' + c.options.length + ' 条，在界面里选一条，可以直接修改，改完一键复制');
    c.chosen = null; c.stale = false;
    d.step = 'caption';
    save(d);
    return 0;
  }

  // ── 导出 ───────────────────────────────────────────────
  async function stepExport(out) {
    const d = draft();
    const dir = exportDir(d);
    const files = (d.export.files || []).filter(f => fs.existsSync(path.join(dir, f)));
    if (!files.length || files.length !== (d.export.expected || 0)) { out('[失败] 发布包里的照片还没生成完。建议：在界面的「导出」页点「生成发布包」'); return 1; }
    out('== 导出发布包 ==');
    if (!d.export.stripGps && d.layout.form === 'multi') {
      d.layout.order.forEach((id, i) => {
        const p = photoOf(d, id), f = path.join(dir, files[i]);
        if (p && p.format === 'jpeg' && fs.existsSync(f)) fs.writeFileSync(f, injectExif(fs.readFileSync(f), fs.readFileSync(path.join(draftDir(d), 'photos', p.file))));
      });
      out('[警告] 已保留照片里的拍摄信息（包括定位）。发到朋友圈前请确认可以公开拍摄地点');
    } else out('[OK] 已去掉照片里的定位等拍摄信息');
    const text = String(d.caption.text || '').trim();
    if (text) {
      fs.writeFileSync(path.join(dir, '文案.txt'), text + '\n', 'utf8');
      try { clipboard(text); out('[OK] 文案已复制到剪贴板，并保存为 文案.txt'); }
      catch (e) { out('[警告] 复制到剪贴板失败（' + e.message + '），文案已保存为 文案.txt'); }
    } else out('[警告] 没有选文案，只导出照片');
    files.forEach(f => out('[OK] ' + f));
    out('[OK] 位置：' + dir);
    // 写入记忆：最终的选择（照片、参数、排版、文案）
    const cats = {};
    for (const id of d.layout.order.length ? d.layout.order : d.pick.selected) { const p = photoOf(d, id); const k = (p && p.ai && p.ai.category) || 'other'; cats[k] = (cats[k] || 0) + 1; }
    memory.record('grade', { preset: d.grade.presetName || '原图', params: Grade.describe(d.grade.params) });
    memory.record('layout', { drags: d.layout.drags || 0, form: d.layout.form });
    if (text) memory.record('caption', { style: d.caption.styleName || '', edited: text !== String(d.caption.original || '').trim(), length: [...text].length });
    const recalculated = memory.recordExport({ count: files.length, occasion: String(d.caption.occasion || '').slice(0, 20) || undefined, cats, preset: d.grade.presetName || undefined, style: d.caption.styleName || undefined, form: d.layout.form });
    if (recalculated) out('[OK] 已根据最近 5 次的习惯重新调整挑图权重');
    d.export.done = true; d.export.at = new Date().toISOString(); d.step = 'export';
    save(d);
    await ensureLan();
    const s = startSession('export', d);
    const url = sessionUrl(s);
    if (url) out('[OK] 手机扫码存回相册：' + url + '（10 分钟内有效）');
    else out('[警告] 电脑没有连上局域网，不能扫码存回手机。可以打开文件夹，用微信「文件传输助手」发到手机');
    out('结论：发布包已生成，共 ' + files.length + ' 张');
    return 0;
  }

  // ── 导入 ───────────────────────────────────────────────
  async function stepImportPhone(out, signal) {
    const d = draft();
    if (!lanAddress()) { out('[失败] 电脑没有连上局域网（Wi-Fi 或网线）。建议：连上和手机相同的 Wi-Fi，或改用「从文件夹导入」'); return 1; }
    try { await ensureLan(); } catch (e) { out('[失败] 无法在局域网开启传图服务：' + e.message); return 1; }
    const s = startSession('import', d);
    out('== 扫码传图 ==');
    out('[OK] 手机和电脑连同一个 Wi-Fi，用微信或相机扫界面上的二维码');
    out('[OK] 手机打开的地址：' + sessionUrl(s));
    out('提示：第一次使用时系统防火墙可能询问是否允许，请选择允许，否则手机连不上');
    const listener = e => { if (e.type === 'photo') out(`[OK] 收到 ${e.photo.name}${e.photo.unsupported ? '（[警告] 这张照片格式不支持，可以在手机相册里换成兼容格式）' : ''}，已收到 ${s.received} 张`); };
    s.listeners.add(listener);
    const onAbort = () => endSession(s, 'stopped');
    signal.addEventListener('abort', onAbort);
    const reason = await s.done;
    signal.removeEventListener('abort', onAbort);
    s.listeners.delete(listener);
    out({ expired: '[警告] 10 分钟没有新上传，二维码已失效', done: '[OK] 手机上点了「完成导入」', stopped: '[OK] 已结束传图', replaced: '[OK] 已生成新的二维码' }[reason] || '');
    out(`结论：本次收到 ${s.received} 张照片`);
    return 0;
  }
  async function stepImportFolder(out, signal, body) {
    const d = draft();
    const folder = body && body.folder;
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) { out('[失败] 文件夹不存在'); return 1; }
    const names = fs.readdirSync(folder).filter(n => IMAGE_EXT.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    out(`== 从文件夹导入：${folder} ==`);
    if (!names.length) { out('[失败] 这个文件夹里没有照片（只读取这一层，不进入子文件夹）'); return 1; }
    const limit = 300;
    if (names.length > limit) out(`[警告] 照片超过 ${limit} 张，只导入前 ${limit} 张`);
    let ok = 0, bad = 0;
    for (const n of names.slice(0, limit)) {
      if (signal.aborted) break;
      try {
        const f = path.join(folder, n);
        if (fs.statSync(f).size > MAX_PHOTO_BYTES) throw new Error('超过 30 MB');
        const p = drafts.addPhoto(d, fs.readFileSync(f), n, 'folder');
        ok++;
        if (p.unsupported) out(`[警告] ${n}：这张照片格式不支持，界面里无法显示和处理`);
      } catch (e) { bad++; out(`[警告] 跳过 ${n}：${e.message}`); }
    }
    drafts.sortPhotos(d); save(d);
    out(`结论：导入 ${ok} 张${bad ? `，跳过 ${bad} 张` : ''}。原图只是复制进草稿，原文件夹不会被修改`);
    return 0;
  }

  // ── 我的偏好 / AI 设置 ─────────────────────────────────────
  async function stepPreferences(out, signal) {
    const shotsDir = path.join(dataDir, 'screens');
    const shots = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter(f => f.endsWith('.jpg')) : [];
    if (shots.length) {
      out(`== 分析 ${shots.length} 张以前的朋友圈截图 ==`);
      if (!aiConfig()) out('[警告] 没有配置 AI，无法分析截图，已跳过');
      else {
        try {
          const imgs = shots.slice(0, 6).map(f => ({ data: fs.readFileSync(path.join(shotsDir, f)).toString('base64'), mime: 'image/jpeg' }));
          const r = ai.parseJson(await callAi(draft(), { text: P.screenshotPrompt(imgs.length), images: imgs, signal }));
          memory.update(m => { m.screenshotPrefs = String(r.prefs || '').slice(0, 120); m.onboarding = m.onboarding || {}; for (const k of ['tone', 'length', 'content']) if (r[k] && !m.onboarding[k]) m.onboarding[k] = String(r[k]).slice(0, 40); });
          out('[OK] ' + (r.prefs || '已分析'));
        } catch (e) { out('[失败] 分析截图失败：' + e.message); }
      }
      fs.rmSync(shotsDir, { recursive: true, force: true });
    }
    out('== AI 记住的偏好 ==');
    const m = memory.load();
    const items = memory.derivedItems(m);
    if (!items.length) out('（还没有记忆。用几次、或者在界面里回答 3 个问题后就会有）');
    items.forEach(x => out(`[OK] ${x.kind}：${x.text}`));
    out(`[OK] 预设 ${memory.presets.list().length} 个，风格卡 ${memory.styles.list().length} 张；已导出 ${m.totalExports} 次`);
    out('结论：偏好摘要 —— ' + (memory.summary(m) || '（空）'));
    return 0;
  }
  async function stepAiSettings(out, signal) {
    out('== AI 设置 ==');
    out('说明：发给 AI 的只有压缩后的缩略图（长边 1024）和文字，不发原图');
    if (pendingAi) {
      const cfg = { ...pendingAi };
      if (!cfg.apiKey && settings.ai && settings.ai.keyBlob && settings.ai.provider === cfg.provider) { const old = aiConfig(); cfg.apiKey = old && old.apiKey; }
      if (!cfg.apiKey) { out('[失败] 请填写 API key'); pendingAi = null; return 1; }
      out(`[OK] 测试连接：${ai.PROVIDERS[cfg.provider] ? ai.PROVIDERS[cfg.provider].name : cfg.provider} / ${cfg.model}，发送一张测试图片…`);
      let r;
      try { r = await ai.testConnection(cfg, signal); }
      catch (e) { out('[失败] ' + e.message); if (e.detail) out('  详情：' + e.detail); pendingAi = null; return 1; }
      memory.update(mm => { mm.aiCalls = (mm.aiCalls || 0) + 1; });
      if (!r.ok) { out(`[失败] 模型没认出测试图片的颜色（回答："${r.answer}"），可能不支持看图。建议：换一个支持看图的模型`); pendingAi = null; return 1; }
      let keyBlob;
      try { keyBlob = secret.encrypt(cfg.apiKey); } catch (e) { out('[失败] 加密保存 key 失败：' + e.message); pendingAi = null; return 1; }
      settings.ai = { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, keyBlob, savedAt: new Date().toISOString() };
      saveSettings(); pendingAi = null;
      out(`[OK] 模型能看图（回答："${r.answer}"），配置已加密保存`);
    } else if (!settings.ai) out('[警告] 还没有配置。请在界面「AI 设置」里填写接口地址、API key 和模型名');
    else out(`[OK] 当前：${settings.ai.provider} / ${settings.ai.model}`);
    out(`[OK] 本次草稿已调用 AI ${draft().aiCalls || 0} 次，累计 ${memory.load().aiCalls || 0} 次`);
    out('结论：' + (settings.ai ? 'AI 已配置' : '未配置 AI（导入、预筛、预设滤镜、手动排版、导出仍可使用）'));
    return 0;
  }

  const STEPS = { 'import-phone': stepImportPhone, 'import-folder': stepImportFolder, 'pick-photos': stepPick, 'color-grade': stepGrade,
    layout: stepLayout, 'write-caption': stepCaption, export: stepExport, preferences: stepPreferences, 'ai-settings': stepAiSettings };
  const running = new Set();

  // ── 状态汇总（界面每次刷新用）──────────────────────────────
  function state() {
    const d = draft(), m = memory.load();
    return {
      draft: d, steps: [...running], ai: aiPublic(), phone: phoneStatus(), lan: !!lanAddress(),
      memory: { summary: memory.summary(m), summaryOverride: m.summaryOverride, items: memory.derivedItems(m), onboarding: m.onboarding, onboardingSkipped: m.onboardingSkipped,
        needsOnboarding: !m.onboarding && !m.onboardingSkipped && !m.totalExports, weights: m.weights, catBias: m.catBias, totalExports: m.totalExports, questions: ONBOARDING },
      presets: [...Grade.PRESETS.map(p => ({ id: p.id, name: p.name, builtin: true })), ...memory.presets.list().map(p => ({ id: p.id, name: p.name, params: p.params, uses: p.uses }))],
      styles: [...C.BUILTIN_STYLES.map(s => ({ id: s.id, name: s.name, builtin: true, card: s.card })), ...memory.styles.list().map(s => ({ id: s.id, name: s.name, card: s.card, uses: s.uses }))],
      criteria: S.CRITERIA, categories: S.CATEGORIES, allowedCounts: S.ALLOWED_COUNTS, cardFields: C.CARD_FIELDS
    };
  }

  // ── 本机接口 ─────────────────────────────────────────────
  const routes = [];
  const route = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern + '$'), fn, ...opts });
  const body = req => req.json || {};
  const need = (cond, msg) => { if (!cond) { const e = new Error(msg); e.status = 400; throw e; } };

  route('GET', '/api/ping', () => ({ ok: true, pid: process.pid }));
  route('GET', '/api/state', () => state());
  route('GET', '/api/drafts', () => ({ drafts: drafts.list(), current: draft().id }));
  route('POST', '/api/draft/new', () => { newDraft(); return state(); });
  route('POST', '/api/draft/open', req => { openDraft(String(body(req).id)); return state(); });
  route('POST', '/api/draft/step', req => { const d = draft(); d.step = String(body(req).step || d.step); save(d); return { ok: true }; });
  route('POST', '/api/drafts/delete', async req => {
    const list = drafts.list();
    let ids = body(req).expired ? list.filter(x => x.expired).map(x => x.id) : (body(req).ids || []);
    ids = ids.filter(id => list.some(x => x.id === id));
    if (!ids.length) return { ok: true, deleted: 0, message: '没有要清理的草稿' };
    const bytes = list.filter(x => ids.includes(x.id)).reduce((s, x) => s + x.bytes, 0);
    const ok = await sdk.request('confirm', { title: '清理草稿', message: `将删除 ${ids.length} 份草稿（含收到的照片和发布包），释放 ${(bytes / 1048576).toFixed(1)} MB。\n删除后无法恢复，确定吗？` });
    if (!ok) return { ok: true, deleted: 0, message: '已取消' };
    for (const id of ids) drafts.remove(id);
    if (cur && ids.includes(cur.id)) { cur = null; settings.lastDraft = null; saveSettings(); }
    return { ok: true, deleted: ids.length, message: `已删除 ${ids.length} 份，释放 ${(bytes / 1048576).toFixed(1)} MB` };
  });

  // 照片：缩略图、指标、放回候选
  route('PUT', '/api/photos/([\\w]+)/thumb', req => {
    const d = draft(), p = photoOf(d, req.params[0]); need(p, '照片不存在');
    need(req.raw && req.raw[0] === 0xFF && req.raw[1] === 0xD8, '缩略图必须是 JPEG');
    fs.mkdirSync(path.dirname(thumbPath(d, p)), { recursive: true });
    fs.writeFileSync(thumbPath(d, p), req.raw);
    p.thumb = true; save(d); return { ok: true };
  }, { raw: 8 * 1024 * 1024 });
  route('POST', '/api/photos/([\\w]+)/metrics', req => {
    const d = draft(), p = photoOf(d, req.params[0]); need(p, '照片不存在');
    const b = body(req);
    if (b.unsupported) { p.unsupported = true; p.metrics = null; }
    else p.metrics = { sharp: +b.sharp || 0, dark: +b.dark || 0, bright: +b.bright || 0, mean: +b.mean || 0, hash: String(b.hash || '').slice(0, 16), rgb: Array.isArray(b.rgb) ? b.rgb.slice(0, 3).map(Number) : null, w: +b.w || 0, h: +b.h || 0 };
    save(d); return { ok: true };
  });
  route('POST', '/api/photos/([\\w]+)/manual', req => {
    const d = draft(), p = photoOf(d, req.params[0]); need(p, '照片不存在');
    const v = body(req).manual; p.manual = v === 'include' || v === 'exclude' ? v : null;
    const pre = S.prefilter(d.photos); d.pick.flags = pre.flags; d.pick.candidates = pre.candidates;
    save(d); return { ok: true };
  });
  route('POST', '/api/photos/([\\w]+)/remove', req => {
    const d = draft(), p = photoOf(d, req.params[0]); need(p, '照片不存在');
    d.photos = d.photos.filter(x => x !== p);
    for (const k of ['selected', 'alternates', 'candidates', 'initial']) d.pick[k] = d.pick[k].filter(id => id !== p.id);
    d.layout.order = d.layout.order.filter(id => id !== p.id);
    fs.rmSync(path.join(draftDir(d), 'photos', p.file), { force: true }); fs.rmSync(thumbPath(d, p), { force: true });
    save(d); return { ok: true };
  });

  // 挑照片：选项、换图、改权重/张数
  route('POST', '/api/pick/options', req => {
    const d = draft(), b = body(req);
    d.pick.opts = { local: !!b.local, rescore: !!b.rescore };
    if (b.count !== undefined) d.pick.count = b.count ? Math.max(1, Math.min(9, Number(b.count) || 9)) : null;
    save(d); return { ok: true };
  });
  route('POST', '/api/pick/rescore', req => {
    const d = draft(), b = body(req);
    need(d.pick.candidates.length, '请先运行一次「挑照片」');
    if (b.weights) d.pick.weights = S.normalizeWeights(b.weights);
    if (b.resetWeights) d.pick.weights = null;
    if (b.count !== undefined) d.pick.count = b.count ? Math.max(1, Math.min(9, Number(b.count) || 9)) : null;
    selectFromScores(d); drafts.markStale(d, 'pick'); save(d);
    return { ok: true };
  });
  route('POST', '/api/pick/swap', req => {
    const d = draft(), b = body(req);
    const outId = b.out ? String(b.out) : null, inId = b.in ? String(b.in) : null;
    const sel = d.pick.selected;
    need(!outId || sel.includes(outId), '要换掉的照片不在入选里');
    need(!inId || (photoOf(d, inId) && !sel.includes(inId)), '要换上的照片不可用');
    if (outId && inId) sel[sel.indexOf(outId)] = inId;
    else if (outId) sel.splice(sel.indexOf(outId), 1);
    else if (inId) { need(sel.length < 9, '最多 9 张'); sel.push(inId); }
    d.pick.alternates = d.pick.alternates.filter(id => id !== inId);
    if (outId && !d.pick.alternates.includes(outId)) d.pick.alternates.unshift(outId);
    if (inId && !d.pick.candidates.includes(inId)) d.pick.candidates.push(inId);
    const cat = id => { const p = id && photoOf(d, id); return (p && p.ai && p.ai.category) || 'other'; };
    d.pick.swaps.push({ out: outId, in: inId, t: Date.now() });
    if (outId && inId) memory.record('swap', { outCat: cat(outId), inCat: cat(inId) });
    if (d.layout.order.length) {
      if (outId && inId && d.layout.order.includes(outId)) d.layout.order[d.layout.order.indexOf(outId)] = inId;
      else d.layout.stale = true;
      d.layout.order = d.layout.order.filter(id => sel.includes(id));
    }
    if (d.caption.options.length) d.caption.stale = true;
    d.export.done = false;
    save(d); return { ok: true };
  });

  // 调色
  route('POST', '/api/grade', req => {
    const d = draft(), b = body(req);
    if (b.undo) { need(d.grade.history.length, '没有可以撤销的调整'); d.grade.params = d.grade.history.pop(); d.grade.preset = 'custom'; }
    else if (b.preset) {
      const builtin = Grade.PRESETS.find(p => p.id === b.preset);
      const user = !builtin && memory.presets.list().find(p => p.id === b.preset);
      need(builtin || user, '预设不存在');
      const sel = sampleThumbs(d, 9).filter(p => p.metrics);
      const avg = sel.length ? sel.reduce((s, p) => s + p.metrics.mean, 0) / sel.length : undefined;
      d.grade.history.push(d.grade.params);
      d.grade.params = builtin ? Grade.presetParams(builtin.id, avg) : Grade.normalize(user.params);
      d.grade.preset = b.preset; d.grade.presetName = (builtin || user).name; d.grade.explain = '';
      if (user) memory.presets.use(user.id);
    } else if (b.params) {
      d.grade.history.push(d.grade.params);
      d.grade.params = Grade.normalize(b.params); d.grade.preset = 'custom';
      if (b.manual) d.grade.presetName = (d.grade.presetName || '手动').replace(/（调整）$/, '') + '（调整）';
    }
    if (d.grade.history.length > 30) d.grade.history.shift();
    d.export.done = false; d.step = 'grade';
    save(d); return { ok: true, params: d.grade.params, describe: Grade.describe(d.grade.params) };
  });
  route('POST', '/api/grade/request', req => {
    const d = draft(), b = body(req);
    if (b.type === 'text') { need(String(b.text || '').trim(), '请输入一句话'); need(!/https?:\/\//i.test(b.text), '本版不从链接抓图，请截图后上传'); d.grade.request = { type: 'text', text: String(b.text).trim().slice(0, 100) }; }
    else if (b.type === 'reference') { need(b.params, '缺少本地颜色迁移结果'); d.grade.request = { type: 'reference', params: Grade.normalize(b.params) }; }
    else need(false, '未知的调色方式');
    save(d); return { ok: true };
  });
  route('PUT', '/api/grade/reference', req => {
    const d = draft(); need(req.raw && req.raw[0] === 0xFF && req.raw[1] === 0xD8, '参考图必须是 JPEG');
    fs.writeFileSync(path.join(draftDir(d), 'reference.jpg'), req.raw);
    d.grade.reference = { at: Date.now() }; save(d); return { ok: true };
  }, { raw: 8 * 1024 * 1024 });
  route('POST', '/api/presets', req => { const b = body(req); const id = memory.presets.save(b.name, { params: Grade.normalize(b.params || draft().grade.params) }); return { ok: true, id }; });
  route('POST', '/api/presets/delete', req => { memory.presets.remove(String(body(req).id)); return { ok: true }; });

  // 排版
  route('POST', '/api/layout', req => {
    const d = draft(), b = body(req);
    if (b.form) { need(['multi', 'grid9', 'collage'].includes(b.form), '未知的排版形式'); d.layout.form = b.form; }
    if (b.template) d.layout.template = String(b.template);
    if (b.order) {
      const sel = new Set(d.pick.selected);
      const order = [...new Set(b.order.map(String))].filter(id => sel.has(id));
      need(order.length && S.ALLOWED_COUNTS.includes(order.length), '张数只能是 1 / 3 / 4 / 6 / 9');
      if (b.drag) d.layout.drags = (d.layout.drags || 0) + 1;
      d.layout.order = order; d.layout.count = order.length; d.layout.stale = false;
    }
    if (b.wantCount !== undefined) d.layout.wantCount = b.wantCount ? Number(b.wantCount) : null;
    if (b.local !== undefined) d.layout.opts = { local: !!b.local };
    d.export.done = false;
    save(d); return { ok: true };
  });

  // 文案
  route('POST', '/api/caption', req => {
    const d = draft(), b = body(req), c = d.caption;
    if (b.occasion !== undefined) c.occasion = String(b.occasion).slice(0, 60);
    if (b.styleId !== undefined) c.styleId = String(b.styleId);
    if (b.refText !== undefined) { c.refText = String(b.refText).slice(0, 500); if (c.styleId === 'ref') c.styleCard = null; }
    if (b.choose !== undefined) { need(c.options[b.choose] != null, '没有这条文案'); c.chosen = b.choose; c.text = c.options[b.choose]; c.original = c.options[b.choose]; }
    if (b.text !== undefined) c.text = String(b.text).slice(0, 2000);
    save(d); return { ok: true };
  });
  route('POST', '/api/caption/copy', () => { const t = String(draft().caption.text || '').trim(); need(t, '还没有文案'); clipboard(t); return { ok: true }; });
  route('POST', '/api/styles', req => {
    const d = draft(), b = body(req);
    const card = C.normalizeCard(b.card || d.caption.styleCard);
    const id = memory.styles.save(b.name || d.caption.styleCardName || '我的风格', { card });
    d.caption.styleId = id; save(d); return { ok: true, id };
  });
  route('POST', '/api/styles/delete', req => { memory.styles.remove(String(body(req).id)); return { ok: true }; });

  // 导出：界面先 begin（清空发布包），再逐张上传处理好的 JPEG，最后运行「导出发布包」动作
  route('POST', '/api/export/begin', req => {
    const d = draft(), b = body(req);
    const n = Number(b.count);
    need(n >= 1 && n <= 9, '张数不对');
    const dir = exportDir(d);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    d.export.files = []; d.export.expected = n; d.export.stripGps = b.stripGps !== false; d.export.done = false;
    save(d); return { ok: true };
  });
  route('PUT', '/api/export/file/(\\d+)', req => {
    const d = draft(), n = Number(req.params[0]);
    need(n >= 1 && n <= (d.export.expected || 0), '序号不对');
    need(req.raw && req.raw[0] === 0xFF && req.raw[1] === 0xD8, '必须是 JPEG');
    const name = String(n).padStart(2, '0') + '.jpg';
    fs.writeFileSync(path.join(exportDir(d), name), req.raw);
    d.export.files[n - 1] = name; save(d); return { ok: true };
  }, { raw: 40 * 1024 * 1024 });
  route('POST', '/api/export/open', async () => { await sdk.request('openPath', { path: exportDir(draft()) }); return { ok: true }; });

  // 手机传图会话
  route('POST', '/api/phone/stop', req => {
    const kind = body(req).kind || 'import';
    for (const s of sessions.values()) if (s.kind === kind && !s.ended) endSession(s, kind === 'import' ? 'stopped' : 'stopped');
    return { ok: true };
  });

  // 记忆
  route('POST', '/api/memory/onboarding', req => {
    const b = body(req);
    memory.update(m => {
      if (b.skip) { m.onboardingSkipped = true; return; }
      m.onboarding = {};
      for (const q of ONBOARDING) if (b[q.key]) m.onboarding[q.key] = String(b[q.key]).slice(0, 40);
    });
    return { ok: true };
  });
  route('POST', '/api/memory/delete', req => { memory.deleteItem(String(body(req).key)); return { ok: true }; });
  route('POST', '/api/memory/edit', req => { memory.editItem(String(body(req).key), body(req).value); return { ok: true }; });
  route('POST', '/api/memory/clear', async () => {
    const ok = await sdk.request('confirm', { title: '清空记忆', message: '将清空 AI 记住的全部偏好、调色预设和文案风格卡，回到第一次使用的状态。草稿不受影响。确定吗？' });
    if (ok) memory.clearAll();
    return { ok: true, cleared: ok };
  });
  route('PUT', '/api/memory/screen/(\\d+)', req => {
    need(req.raw && req.raw[0] === 0xFF && req.raw[1] === 0xD8, '必须是 JPEG');
    const dir = path.join(dataDir, 'screens'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, req.params[0] + '.jpg'), req.raw); return { ok: true };
  }, { raw: 8 * 1024 * 1024 });

  // AI 设置：先暂存，运行「AI 设置」动作测试通过后才加密保存
  route('POST', '/api/ai/pending', req => {
    const b = body(req);
    need(ai.PROVIDERS[b.provider], '未知的接口类型');
    const baseUrl = String(b.baseUrl || ai.PROVIDERS[b.provider].baseUrl).trim();
    need(/^https?:\/\/[^\s]+$/.test(baseUrl), '接口地址要以 http:// 或 https:// 开头');
    need(String(b.model || '').trim(), '请填写模型名');
    pendingAi = { provider: b.provider, baseUrl, model: String(b.model).trim(), apiKey: String(b.apiKey || '').trim() };
    return { ok: true };
  });
  route('POST', '/api/ai/clear', () => { delete settings.ai; saveSettings(); return { ok: true }; });

  // 图片（<img> 不能带请求头，口令放在查询参数里）
  route('GET', '/api/img/(orig|thumb)/([\\w]+)', (req, res) => {
    const d = draft(), p = photoOf(d, req.params[1]); need(p, '照片不存在');
    const f = req.params[0] === 'thumb' && hasThumb(d, p) ? thumbPath(d, p) : path.join(draftDir(d), 'photos', p.file);
    sendFile(res, f); return undefined;
  });
  route('GET', '/api/img/ref', (req, res) => { sendFile(res, path.join(draftDir(draft()), 'reference.jpg')); return undefined; });
  route('GET', '/api/img/export/(\\d+)', (req, res) => { const d = draft(); const f = d.export.files[Number(req.params[0]) - 1]; need(f, '没有这张'); sendFile(res, path.join(exportDir(d), f)); return undefined; });

  // 步骤（由清单里的动作调用，流式返回进度文字，最后一行 @@EXIT <退出码>）
  route('POST', '/api/step/([\\w-]+)', async (req, res) => {
    const name = req.params[0], fn = STEPS[name];
    need(fn, '未知的步骤：' + name);
    res.writeHead(200, { ...CORS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    const ctl = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
    const out = line => { if (line && !res.writableEnded) res.write(String(line) + '\n'); };
    running.add(name);
    let code = 1;
    try { code = await fn(out, ctl.signal, body(req)); }
    catch (e) { out('[失败] ' + e.message); code = 1; }
    finally { running.delete(name); }
    if (!res.writableEnded) res.end('@@EXIT ' + code + '\n');
    return undefined;
  });

  async function handleApi(req, res) {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const u = new URL(req.url, 'http://x');
    const given = req.headers['x-token'] || u.searchParams.get('t');
    if (!given || !safeEqual(given, token)) return sendJson(res, 403, { error: '口令不对' });
    const r = routes.find(x => x.method === req.method && x.re.test(u.pathname));
    if (!r) return sendJson(res, 404, { error: '没有这个接口' });
    req.params = r.re.exec(u.pathname).slice(1);
    try {
      if (req.method === 'POST' || req.method === 'PUT') {
        const buf = await readBody(req, r.raw || 1024 * 1024);
        if (r.raw) req.raw = buf;
        else req.json = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      }
      const result = await r.fn(req, res);
      if (result !== undefined) sendJson(res, 200, result);
    } catch (e) {
      if (!res.headersSent) sendJson(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.message });
    }
  }

  const api = http.createServer((req, res) => { handleApi(req, res).catch(e => { try { sendJson(res, 500, { error: e.message }); } catch (_) {} }); });
  function listen(port = 0) {
    return new Promise((resolve, reject) => { api.on('error', reject); api.listen(port, '127.0.0.1', () => resolve(api.address().port)); });
  }
  function close() { clearInterval(sweep); api.close(); if (lan) lan.close(); for (const s of sessions.values()) endSession(s, 'stopped'); }
  return { listen, close, token, state, draft, newDraft, steps: STEPS, memory, drafts, startSession, endSession, sessions, ensureLan, get lanPort() { return lanPort; }, selectFromScores };
}

// ── HTTP 小工具 ─────────────────────────────────────────────
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-token', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-allow-private-network': 'true' };
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.avif': 'image/avif' };
function sendJson(res, status, obj) { res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function sendText(res, status, text) { res.writeHead(status, { ...CORS, 'content-type': 'text/plain; charset=utf-8' }); res.end(text); }
function sendHtml(res, status, html) { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); }
function sendFile(res, f) {
  if (!fs.existsSync(f)) return sendText(res, 404, 'not found');
  res.writeHead(200, { ...CORS, 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('内容太大'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

/** 复制文字到系统剪贴板（Windows 用 PowerShell，避免 clip.exe 的中文编码问题） */
function copyToClipboard(text) {
  const tries = process.platform === 'win32'
    ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8;Set-Clipboard -Value ([Console]::In.ReadToEnd())']]]
    : process.platform === 'darwin' ? [['pbcopy', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { input: text, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (!r.error && r.status === 0) return;
  }
  throw new Error('系统剪贴板不可用');
}

module.exports = { createEngine, copyToClipboard };
