// 朋友圈助手 · 自带界面
// 和宿主：只用 ready / run(actionId) / notify，接收 host-init / action-started / output / action-exit。
// 和引擎：打开时运行「启动引擎」（已在运行则运行「查询引擎地址」），从输出里拿到本机端口和口令，之后用 fetch 读写草稿。
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STEP_LIST = [['import', '导入'], ['pick', '挑图'], ['grade', '调色'], ['layout', '排版'], ['caption', '文案'], ['export', '导出']];
const REQUIRED = ['import-phone', 'import-folder', 'pick-photos', 'color-grade', 'layout', 'write-caption', 'export', 'preferences', 'ai-settings', 'engine', 'engine-info'];
const STEP_TITLE = { 'import-phone': '从手机导入', 'import-folder': '从文件夹导入', 'pick-photos': '挑照片', 'color-grade': '调色', layout: '排版', 'write-caption': '写文案', export: '导出发布包', preferences: '我的偏好', 'ai-settings': 'AI 设置' };

const app = {
  actions: {}, engine: null, st: null, view: 'import', running: {}, waiters: {}, analyzing: new Set(), analyzeTotal: 0, analyzeDone: 0,
  swapFrom: null, detail: null, gradeFocus: null, ref: null, exportProgress: null, draftsList: null, aiForm: null, ver: Date.now()
};

// ── 宿主通信 ──────────────────────────────────────────────
const post = msg => parent.postMessage(msg, '*');
function hostRun(name) {
  const a = app.actions[name];
  if (!a) return Promise.resolve(1);
  if (app.running[name]) return app.running[name].promise;
  let resolve; const promise = new Promise(r => { resolve = r; });
  app.running[name] = { promise, resolve, started: false };
  post({ type: 'run', actionId: a.id });
  setTimeout(() => { const r = app.running[name]; if (r && !r.started && r.promise === promise) { delete app.running[name]; resolve(1); renderAll(); } }, 8000);
  renderAll();
  return promise;
}
window.addEventListener('message', ev => {
  if (ev.source !== parent) return;
  const m = ev.data || {};
  const name = m.actionId ? m.actionId.slice(m.actionId.lastIndexOf(':') + 1) : '';
  if (m.type === 'host-init') onInit(m);
  else if (m.type === 'action-started') {
    if (!app.running[name]) { let resolve; const promise = new Promise(r => { resolve = r; }); app.running[name] = { promise, resolve }; }
    app.running[name].started = true;
    if (STEP_TITLE[name]) logLine('▶ ' + STEP_TITLE[name], 'h');
    renderAll();
  } else if (m.type === 'workspace-message' && m.name === 'engine-ready') {
    connect(m.data);
  } else if (m.type === 'output') onOutput(name, m.text || '');
  else if (m.type === 'action-exit') {
    const r = app.running[name]; delete app.running[name];
    if (r) r.resolve(m.code);
    if (name === 'engine') { app.engine = null; showConnect('引擎已停止', '点下面的按钮重新启动；或在宿主的动作列表里运行「启动引擎」', true); }
    else if (name === 'engine-info' && m.code !== 0 && !app.engine) hostRun('engine');
    else if (STEP_TITLE[name]) { logLine(m.stopped ? '■ 已停止' : m.code === 0 ? '✓ 完成' : '✗ 失败（退出码 ' + m.code + '）', m.code === 0 ? 'ok' : 'err'); refresh(); }
    renderAll();
  }
});
function onInit(m) {
  app.actions = {};
  for (const a of m.actions || []) app.actions[a.id.slice(a.id.lastIndexOf(':') + 1)] = a;
  const missing = REQUIRED.filter(k => !app.actions[k]);
  if (missing.length) return showConnect('界面和清单不匹配', '找不到动作：' + missing.join('、') + '。请重新安装插件。');
  if (app.engine || app.running.engine || app.running['engine-info']) return;
  const eng = app.actions.engine;
  if (eng.available === false) return showConnect('当前系统不支持', eng.unavailableReason || '');
  showConnect('连接中…', '正在启动朋友圈助手引擎');
  hostRun(eng.running ? 'engine-info' : 'engine');
}
let outBuf = {};
function onOutput(name, text) {
  outBuf[name] = (outBuf[name] || '') + text;
  let i;
  while ((i = outBuf[name].indexOf('\n')) >= 0) {
    const line = outBuf[name].slice(0, i).replace(/\r$/, ''); outBuf[name] = outBuf[name].slice(i + 1);
    if (STEP_TITLE[name]) logLine(line);
  }
}
function showConnect(text, hint, retry) {
  $('connect').classList.remove('hidden');
  $('connectText').textContent = text; $('connectHint').textContent = hint || '';
  $('retry').classList.toggle('hidden', !retry);
  $('engineState').innerHTML = '<span class="dot off"></span>引擎未连接';
}
$('retry').onclick = () => { showConnect('连接中…', '正在启动朋友圈助手引擎'); hostRun('engine'); };

// ── 引擎接口 ──────────────────────────────────────────────
async function connect(info) {
  app.engine = { base: 'http://127.0.0.1:' + info.port, token: info.token };
  try { await refresh(); } catch (e) { app.engine = null; return showConnect('连不上引擎', e.message, true); }
  $('connect').classList.add('hidden');
  $('engineState').innerHTML = '<span class="dot"></span>引擎已连接';
  app.view = STEP_LIST.some(s => s[0] === app.st.draft.step) ? app.st.draft.step : 'import';
  if (app.st.memory.needsOnboarding) app.view = 'prefs';
  renderAll();
}
async function api(method, url, body, raw) {
  if (!app.engine) throw new Error('引擎未连接');
  const r = await fetch(app.engine.base + url, {
    method, headers: { 'x-token': app.engine.token, 'content-type': raw ? 'image/jpeg' : 'application/json' },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('请求失败 ' + r.status));
  return j;
}
const imgUrl = (kind, id) => `${app.engine.base}/api/img/${kind}/${id}?t=${encodeURIComponent(app.engine.token)}&v=${app.ver}`;
async function refresh() {
  app.st = await api('GET', '/api/state');
  renderAll();
  queueAnalysis();
  schedulePoll();
}
let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = Object.keys(app.running).some(k => STEP_TITLE[k]) || (app.st && app.st.phone.import && app.st.phone.import.active);
  if (busy) pollTimer = setTimeout(() => refresh().catch(() => {}), 1500);
}
async function act(fn) {
  try { await fn(); } catch (e) { toast(e.message, 'err'); }
}
function toast(text, kind) { logLine((kind === 'err' ? '[失败] ' : '') + text, kind); if (kind === 'err') post({ type: 'notify', text: '朋友圈助手：' + text }); }
/** 运行清单里的某个步骤动作，结束后刷新 */
async function runStep(name) {
  const code = await hostRun(name);
  await refresh().catch(() => {});
  return code;
}

// ── 进度日志 ──────────────────────────────────────────────
function logLine(text, cls) {
  if (!text) return;
  const div = document.createElement('div');
  if (!cls) cls = /^\[OK\]|^结论/.test(text) ? 'ok' : /^\[警告\]/.test(text) ? 'warn' : /^\[失败\]/.test(text) ? 'err' : /^==/.test(text) ? 'h' : '';
  if (cls) div.className = cls;
  div.textContent = text;
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
}
$('clearLog').onclick = () => { $('log').innerHTML = ''; };

// ── 照片分析：生成缩略图 + 预筛指标（在界面里用 canvas 算）──────────
function queueAnalysis() {
  const d = app.st.draft;
  const todo = d.photos.filter(p => !p.unsupported && (!p.metrics || !p.thumb) && !app.analyzing.has(p.id));
  if (!todo.length) return;
  if (!app.analyzing.size) { app.analyzeTotal = 0; app.analyzeDone = 0; }
  app.analyzeTotal += todo.length;
  todo.forEach(p => app.analyzing.add(p.id));
  const queue = [...todo];
  const draftId = d.id;
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      try {
        const img = await Imaging.loadImage(imgUrl('orig', p.id));
        const thumb = await Imaging.toJpeg(Imaging.drawScaled(img, 1024), 0.85);
        if (app.st.draft.id !== draftId) return;
        await api('PUT', `/api/photos/${p.id}/thumb`, thumb, true);
        await api('POST', `/api/photos/${p.id}/metrics`, Imaging.metrics(img));
      } catch (e) {
        if (app.st.draft.id === draftId) await api('POST', `/api/photos/${p.id}/metrics`, { unsupported: true }).catch(() => {});
        logLine(`[警告] ${p.name}：这张照片格式不支持，可以在手机相册里换成兼容格式`, 'warn');
      }
      app.analyzing.delete(p.id); app.analyzeDone++;
      if (app.analyzeDone % 4 === 0 || !app.analyzing.size) refresh().catch(() => {});
      else renderTip();
    }
  };
  worker(); worker();
}

// ── 渲染 ────────────────────────────────────────────────
const isRunning = name => !!app.running[name];
const aiOn = () => app.st.ai.configured;
const photo = id => app.st.draft.photos.find(p => p.id === id);
function phImg(p, opts = {}) {
  if (!p) return '<div class="ph"><div class="ph-empty">已删除</div></div>';
  const inner = p.unsupported ? '<div class="ph-empty">格式不支持<br>请换成 JPG</div>' : p.thumb ? `<img loading="lazy" src="${imgUrl('thumb', p.id)}" alt="">` : '<div class="ph-empty">分析中…</div>';
  return `<div class="ph ${opts.cls || ''}" data-id="${p.id}" ${opts.attrs || ''} title="${esc(p.name)}">${inner}${opts.tag ? `<span class="tag ${opts.tagCls || ''}">${esc(opts.tag)}</span>` : ''}${opts.score != null ? `<span class="score">${Number(opts.score).toFixed(1)}</span>` : ''}${opts.x ? `<button class="x" data-act="${opts.x}" data-id="${p.id}" title="移除">✕</button>` : ''}</div>`;
}
function renderAll() {
  if (!app.st) return;
  const d = app.st.draft;
  $('draftLabel').textContent = `草稿 ${d.id} · ${d.photos.length} 张照片${d.aiCalls ? ` · 已调用 AI ${d.aiCalls} 次` : ''}`;
  $('navPrefs').classList.toggle('on', app.view === 'prefs');
  $('navAi').classList.toggle('on', app.view === 'ai');
  const order = STEP_LIST.map(s => s[0]), cur = order.indexOf(d.step);
  const stale = { layout: d.layout.stale, caption: d.caption.stale };
  $('steps').innerHTML = STEP_LIST.map(([k, n], i) => `<button data-step="${k}" class="${app.view === k ? 'on' : ''} ${i <= cur ? 'done' : ''}"><span class="n">${i + 1}</span>${n}${stale[k] ? '<span class="stale" title="前面的步骤改过，需要重新生成">●</span>' : ''}</button>`).join('');
  const views = { import: viewImport, pick: viewPick, grade: viewGrade, layout: viewLayout, caption: viewCaption, export: viewExport, prefs: viewPrefs, ai: viewAi };
  const keepScroll = window.scrollY;
  const focused = document.activeElement && document.activeElement.id;
  const sel = focused && document.activeElement.selectionStart;
  if (!($('main').contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.dataset.live)) {
    $('main').innerHTML = views[app.view]();
    if (focused && $(focused)) { $(focused).focus(); try { $(focused).setSelectionRange(sel, sel); } catch (_) {} }
    afterRender[app.view] && afterRender[app.view]();
  }
  window.scrollTo(0, keepScroll);
  renderTip();
}
function renderTip() {
  const n = app.analyzing.size;
  const parts = [];
  if (n) parts.push(`正在分析照片 ${app.analyzeDone} / ${app.analyzeTotal}（生成缩略图、检查清晰度）`);
  const runningSteps = Object.keys(app.running).filter(k => STEP_TITLE[k]);
  if (runningSteps.length) parts.push('正在执行：' + runningSteps.map(k => STEP_TITLE[k]).join('、') + '（可在宿主卡片上点「■ 停止」）');
  $('tip').innerHTML = parts.map(esc).join('<br>') + (n ? `<div class="progress"><i style="width:${app.analyzeTotal ? app.analyzeDone / app.analyzeTotal * 100 : 0}%"></i></div>` : '');
}
const afterRender = {};
const needAi = text => aiOn() ? '' : `<p class="muted small">💡 ${text || '配置 AI 后效果更好'}：<button class="link" data-act="goAi">去 AI 设置</button></p>`;
const staleBanner = flag => flag ? '<div class="banner warn">前面的步骤改过，这一步的结果需要重新生成。</div>' : '';
const nextBtn = (to, label) => `<div class="row end" style="margin-top:16px"><button class="primary big" data-step="${to}">${label} →</button></div>`;

// 1. 导入
function viewImport() {
  const d = app.st.draft, im = app.st.phone.import;
  const active = im && im.active && im.draftId === d.id;
  const usable = d.photos.filter(p => !p.unsupported).length;
  return `<div class="card">
    <h2>第 1 步：导入照片</h2>
    <p class="muted">扫码从手机相册直接选图，不用先存到文件夹。原图只会复制进草稿，永远不会被修改。</p>
    <div class="row" style="margin-top:12px">
      <button class="primary big" data-act="importPhone" ${isRunning('import-phone') || !app.st.lan ? 'disabled' : ''}>📱 从手机导入</button>
      <button class="big" data-act="importFolder" ${isRunning('import-folder') ? 'disabled' : ''}>📁 从文件夹导入</button>
    </div>
    ${!app.st.lan ? '<div class="banner warn">电脑没有连上局域网，不能扫码传图。可以用「从文件夹导入」。</div>' : ''}
    ${active ? `<div class="qr"><div class="code">${im.qr || ''}</div><div class="grow">
        <p><b>手机和电脑连同一个 Wi-Fi，用微信或相机扫码</b></p>
        <p class="muted small">手机网页上点「选择照片」会打开系统相册，可以多选。照片会陆续出现在下面。</p>
        <p class="muted small">⚠ 第一次使用时，系统防火墙可能询问是否允许，<b>请选择允许</b>，否则手机连不上。</p>
        <p>已收到 <b>${im.received}</b> 张 · 10 分钟没有新照片会自动失效</p>
        <button data-act="stopPhone">完成导入</button>
        <details><summary>手机打不开网页？</summary><ol class="small muted" style="padding-left:18px;margin:4px 0">
          <li>确认手机连的是<b>和电脑同一个 Wi-Fi</b>（不是 4G/5G），并关掉手机上的 VPN / 代理。</li>
          <li>学校、公司、商场的 Wi-Fi 大多开启了"设备隔离"，手机访问不到电脑。可以让电脑连上<b>手机热点</b>后重新生成二维码，或者用家里的 Wi-Fi。</li>
          <li>电脑开了代理软件的"增强模式 / TUN 模式"时，可能拦住手机的访问，先关掉再试。</li>
          <li>还是不行：先把照片用隔空投送、微信文件传输助手等传到电脑，再用「从文件夹导入」。</li>
        </ol><p class="small muted">手机浏览器里也可以直接输入：${esc(im.url || '')}</p></details></div></div>` : im && !im.active && im.endReason === 'expired' && im.draftId === d.id ? '<div class="banner warn">二维码已失效（10 分钟没有新上传）。需要的话重新点「从手机导入」。</div>' : ''}
  </div>
  <div class="card">
    <div class="row"><h3 class="grow" style="margin:0">照片（${d.photos.length} 张${d.photos.length - usable ? `，${d.photos.length - usable} 张格式不支持` : ''}）</h3><span class="muted small">按拍摄时间排序</span></div>
    ${d.photos.length ? `<div class="grid" style="margin-top:8px">${d.photos.map(p => phImg(p, { x: 'removePhoto', tag: p.unsupported ? '不支持' : '', tagCls: 'bad' })).join('')}</div>` : '<p class="muted" style="padding:24px 0;text-align:center">还没有照片</p>'}
    ${usable ? nextBtn('pick', '下一步：挑照片') : ''}
  </div>`;
}

// 2. 挑图
function viewPick() {
  const d = app.st.draft, pk = d.pick;
  const flags = pk.flags || {};
  const scores = pk.scores || {};
  const analyzed = d.photos.filter(p => p.metrics);
  const unscored = analyzed.filter(p => !p.ai).length;
  const calls = Math.ceil(Math.min(60, unscored) / 4);
  const sel = pk.selected || [];
  const filtered = d.photos.filter(p => flags[p.id] && !pk.candidates.includes(p.id));
  const others = pk.candidates.filter(id => !sel.includes(id) && !(pk.alternates || []).includes(id));
  const w = pk.weightsUsed || app.st.memory.weights;
  return `<div class="card">
    <h2>第 2 步：挑照片</h2>
    <p class="muted">先在本地筛掉拍糊、曝光有问题、连拍重复的照片，再由 AI 按构图、主体、人物、色彩、审美五项打分，最后挑一组（同一场景最多 2 张，尽量覆盖不同类型）。</p>
    <div class="row" style="margin-top:12px">
      <label class="row">张数 <select id="pickCount" style="width:auto">${['', 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<option value="${n}" ${String(pk.count || '') === String(n) ? 'selected' : ''}>${n || '自动（最多 9）'}</option>`).join('')}</select></label>
      ${aiOn() ? `<label class="row"><input type="checkbox" id="pickLocal" ${(pk.opts || {}).local ? 'checked' : ''}> 不用 AI</label>` : ''}
      <button class="primary big" data-act="runPick" ${isRunning('pick-photos') || app.analyzing.size ? 'disabled' : ''}>✨ ${pk.done ? '重新挑选' : '开始挑选'}</button>
    </div>
    ${app.analyzing.size ? '<p class="muted small">照片还在分析中，完成后才能挑选。</p>' : ''}
    ${aiOn() ? `<p class="muted small">将调用 AI 约 ${calls} 次（已打过分的照片不会重复调用；一次最多把 60 张候选发给 AI）。</p>` : needAi('现在只按清晰度和曝光挑选；配置 AI 后可以按审美打分')}
  </div>
  ${pk.done ? `<div class="card">
    <div class="row"><h3 class="grow" style="margin:0">入选 ${sel.length} 张 ${pk.usedAi ? '' : '<span class="muted small">（未用 AI）</span>'}</h3>
      <span class="muted small">${app.swapFrom ? '现在点下面的候补或其他照片，和选中的那张互换' : '点一张入选照片，再点候补就能换图'}</span></div>
    <div class="grid big" style="margin-top:8px">${sel.map(id => `<div class="pick-item">${phImg(photo(id), { cls: app.swapFrom === id ? 'sel' : '', attrs: 'data-act="pickSel"', score: scores[id] })}<div class="cap">${esc(pk.reasons[id] || '')}</div></div>`).join('')}</div>
    ${sel.length < 9 ? '<p class="muted small">张数不够 9 张时，也可以直接点候补把它加进来。</p>' : ''}
    <h3>候补 ${(pk.alternates || []).length} 张</h3>
    <div class="grid">${(pk.alternates || []).map(id => phImg(photo(id), { attrs: 'data-act="pickAlt"', score: scores[id], cls: app.swapFrom ? '' : 'dim' })).join('') || '<span class="muted small">没有候补</span>'}</div>
    ${app.detail && photo(app.detail) ? detailBox(photo(app.detail)) : ''}
    <details ${others.length || filtered.length ? '' : 'hidden'}><summary>其他候选 ${others.length} 张 · 被筛掉 ${filtered.length} 张</summary>
      <div class="grid">${others.map(id => phImg(photo(id), { attrs: 'data-act="pickAlt"', score: scores[id], cls: 'dim' })).join('')}</div>
      <h3>被筛掉的照片（没有删除，可以放回候选）</h3>
      <div class="grid">${filtered.map(p => { const f = flags[p.id]; const why = f.blurry ? '可能拍糊' : f.exposure ? '曝光问题' : `连拍（${f.groupSize} 张留 1 张）`; return `<div class="pick-item">${phImg(p, { tag: why, tagCls: 'warn', cls: 'dim' })}<button class="link small" data-act="includePhoto" data-id="${p.id}">放回候选</button></div>`; }).join('') || '<span class="muted small">没有</span>'}</div>
      ${d.photos.some(p => p.manual === 'include') ? '<p class="muted small">放回候选后，点「重新挑选」生效。</p>' : ''}
    </details>
    <details><summary>评分权重（${app.st.memory.totalExports ? '已根据你的习惯微调' : '默认'}）</summary>
      <div class="sliders">${app.st.criteria.map(c => `<label>${c.name}<input type="range" min="0" max="60" step="1" data-w="${c.key}" value="${Math.round((w[c.key] || c.weight) * 100)}"><span>${Math.round((w[c.key] || c.weight) * 100)}%</span></label>`).join('')}</div>
      <div class="row" style="margin-top:8px"><button data-act="rescore">按新权重重新挑（不调用 AI）</button><button class="link" data-act="resetWeights">恢复默认</button></div>
    </details>
    ${sel.length ? nextBtn('grade', '下一步：调色') : ''}
  </div>` : ''}`;
}
function detailBox(p) {
  if (!p.ai) return `<div class="banner">「${esc(p.name)}」没有 AI 分数（按本地清晰度计分）。</div>`;
  return `<div class="banner"><b>${esc(p.name)}</b> · ${esc(app.st.categories[p.ai.category] || '')} · ${esc(p.ai.comment)}
    <table class="score-table">${app.st.criteria.map(c => `<tr><td>${c.name}</td><td>${p.ai.scores[c.key] == null ? '不计分' : p.ai.scores[c.key]}</td><td class="muted">${esc(p.ai.reasons[c.key] || '')}</td></tr>`).join('')}</table></div>`;
}

// 3. 调色
const SLIDERS = [['exposure', -2, 2, 0.05], ['contrast', -100, 100, 1], ['highlights', -100, 100, 1], ['shadows', -100, 100, 1], ['whites', -100, 100, 1], ['blacks', -100, 100, 1],
  ['temperature', -100, 100, 1], ['tint', -100, 100, 1], ['saturation', -100, 100, 1], ['vibrance', -100, 100, 1], ['grain', 0, 100, 1], ['vignette', 0, 100, 1], ['sharpen', 0, 100, 1]];
function gradeTargets() { const d = app.st.draft; return (d.pick.selected.length ? d.pick.selected : d.photos.map(p => p.id)).map(photo).filter(p => p && p.thumb && !p.unsupported); }
function viewGrade() {
  const d = app.st.draft, g = d.grade, targets = gradeTargets();
  if (!targets.length) return `<div class="card"><h2>第 3 步：调色</h2><p class="muted">还没有可以调色的照片。请先完成导入和挑选。</p></div>`;
  if (!targets.some(p => p.id === app.gradeFocus)) app.gradeFocus = targets[0].id;
  const p = Grade.normalize(g.params);
  return `<div class="card">
    <h2>第 3 步：调色</h2>
    <p class="muted">只调颜色和明暗，不重绘照片，人脸和画面内容保持不变。默认对所有入选照片用同一组参数，保证整组风格统一。</p>
    <div class="compare" id="compare" style="margin-top:12px"><canvas id="cvBefore"></canvas><div class="after" id="afterWrap"><canvas id="cvAfter"></canvas></div><div class="handle" id="handle"></div><span class="lbl" style="left:8px">原图</span><span class="lbl" style="right:8px">效果</span></div>
    <input type="range" id="split" min="0" max="100" value="50" style="width:100%">
    <div class="row" style="overflow-x:auto;flex-wrap:nowrap">${targets.map(t => `<div style="width:64px;flex:none">${phImg(t, { cls: t.id === app.gradeFocus ? 'sel' : '', attrs: 'data-act="gradeFocus"' })}</div>`).join('')}</div>
    <p class="small" style="margin-top:8px">当前：<b>${esc(g.presetName || '原图')}</b> · <span class="muted">${esc(Grade.describe(p))}</span>${g.explain ? `<br><span class="muted">${esc(g.explain)}</span>` : ''}</p>
    <div class="row"><button data-act="gradeUndo" ${g.history.length ? '' : 'disabled'}>↶ 撤销</button><button data-act="gradeReset">恢复原图</button>
      <input type="text" id="presetName" placeholder="给这个效果起个名字" style="width:180px"><button data-act="savePreset">存为我的预设</button></div>
  </div>
  <div class="card">
    <h3 style="margin-top:0">方式 1：预设滤镜</h3>
    <div class="row">${app.st.presets.map(x => `<button class="chip ${g.preset === x.id ? 'on' : ''}" data-act="preset" data-id="${x.id}">${esc(x.name)}${x.builtin ? '' : ' ★'}</button>`).join('')}</div>
    <h3>方式 2：一句话调色</h3>
    <div class="row"><input type="text" id="gradeText" class="grow" placeholder="例如：日系通透一点，别太黄 / 再暖一点 / 天空再蓝一点" data-live="1"><button class="primary" data-act="gradeText" ${isRunning('color-grade') ? 'disabled' : ''}>调整</button></div>
    <p class="muted small">可以连续说，"再暖一点"会在当前效果上继续调。${aiOn() ? 'AI 会看照片决定参数。' : '没配 AI 时用离线规则理解常见说法。'}</p>
    <h3>方式 3：复刻同款滤镜</h3>
    <div class="drop-zone" id="refZone" tabindex="0">${app.ref ? '' : '点这里选一张参考图，或者截图后在这里按 Ctrl+V / ⌘V 粘贴'}</div>
    ${app.ref ? `<div class="ref-box" id="refBox" style="margin-top:8px"><canvas id="cvRef"></canvas><div class="sel-rect hidden" id="refRect"></div></div>
      <p class="muted small">在参考图上拖动鼠标<b>框选照片区域</b>，去掉 App 的按钮和文字。</p>
      <div class="row"><button class="primary" data-act="refApply" ${isRunning('color-grade') ? 'disabled' : ''}>复刻同款</button><button data-act="refClear">换一张</button></div>` : ''}
    <p class="muted small">说明：参考图被平台压缩过、拍摄场景也不同，复刻效果是"风格接近"，不保证完全一致。本版不从小红书、抖音等链接抓图，请截图后上传。</p>
    <details><summary>手动微调</summary>
      <div class="sliders">${SLIDERS.map(([k, lo, hi, st]) => `<label>${Grade.LABEL[k]}<input type="range" min="${lo}" max="${hi}" step="${st}" data-g="${k}" value="${p[k]}"><span>${p[k]}</span></label>`).join('')}</div>
    </details>
    ${nextBtn('layout', '下一步：排版')}
  </div>`;
}
let previewParams = null, previewTimer = null;
afterRender.grade = () => {
  if (!$('compare')) return;
  previewParams = app.st.draft.grade.params;
  drawCompare();
  $('split').oninput = () => setSplit($('split').value);
  if (app.ref) drawRef();
  const zone = $('refZone');
  zone.onclick = () => $('fileRef').click();
  zone.onpaste = e => {
    const item = [...(e.clipboardData || {}).items || []].find(i => i.type.startsWith('image/'));
    if (item) return loadRef(item.getAsFile());
    const txt = e.clipboardData.getData('text');
    if (/https?:\/\//.test(txt)) toast('本版不从链接抓图：请在 App 里截图，再粘贴截图', 'err');
  };
};
async function drawCompare() {
  const p = photo(app.gradeFocus);
  if (!p) return;
  const img = await Imaging.loadImage(imgUrl('thumb', p.id));
  const before = $('cvBefore'), after = $('cvAfter');
  if (!before) return;
  const base = Imaging.drawScaled(img, 1024);
  before.width = after.width = base.width; before.height = after.height = base.height;
  before.getContext('2d').drawImage(base, 0, 0);
  after.getContext('2d').drawImage(base, 0, 0);
  Imaging.applyGrade(after, previewParams);
  after.style.width = $('compare').clientWidth + 'px';
  setSplit($('split').value);
}
function setSplit(v) {
  const w = $('compare').clientWidth;
  $('afterWrap').style.clipPath = `inset(0 0 0 ${v}%)`;
  $('handle').style.left = (w * v / 100) + 'px';
}
$('fileRef').onchange = () => { const f = $('fileRef').files[0]; $('fileRef').value = ''; if (f) loadRef(f); };
async function loadRef(file) {
  const url = URL.createObjectURL(file);
  try { const img = await Imaging.loadImage(url); app.ref = { canvas: Imaging.drawScaled(img, 1024), rect: null }; }
  catch (e) { toast('参考图无法打开：' + e.message, 'err'); }
  finally { URL.revokeObjectURL(url); }
  renderAll();
}
function drawRef() {
  const cv = $('cvRef'), src = app.ref.canvas;
  cv.width = src.width; cv.height = src.height;
  cv.getContext('2d').drawImage(src, 0, 0);
  const box = $('refBox'), rectEl = $('refRect');
  const showRect = () => {
    const r = app.ref.rect; if (!r) return rectEl.classList.add('hidden');
    const k = cv.clientWidth / cv.width;
    Object.assign(rectEl.style, { left: r.x * k + 'px', top: r.y * k + 'px', width: r.w * k + 'px', height: r.h * k + 'px' });
    rectEl.classList.remove('hidden');
  };
  showRect();
  let start = null;
  const pos = e => { const b = cv.getBoundingClientRect(), k = cv.width / b.width; return { x: Math.max(0, Math.min(cv.width, (e.clientX - b.left) * k)), y: Math.max(0, Math.min(cv.height, (e.clientY - b.top) * k)) }; };
  box.onpointerdown = e => { start = pos(e); box.setPointerCapture(e.pointerId); };
  box.onpointermove = e => { if (!start) return; const q = pos(e); app.ref.rect = { x: Math.min(start.x, q.x), y: Math.min(start.y, q.y), w: Math.abs(q.x - start.x), h: Math.abs(q.y - start.y) }; showRect(); };
  box.onpointerup = () => { start = null; if (app.ref.rect && (app.ref.rect.w < 20 || app.ref.rect.h < 20)) { app.ref.rect = null; showRect(); } };
}

// 4. 排版
function viewLayout() {
  const d = app.st.draft, L = d.layout, sel = d.pick.selected;
  if (!sel.length) return `<div class="card"><h2>第 4 步：排版</h2><p class="muted">还没有挑照片，请先完成第 2 步。</p></div>`;
  const allowed = app.st.allowedCounts.filter(n => n <= sel.length);
  const order = L.order.length ? L.order : [];
  const cols = order.length === 4 ? 'c2' : order.length === 1 ? 'c1' : 'c3';
  const text = d.caption.text || '（文案在下一步写）';
  const T = Imaging.TEMPLATES;
  let preview = '';
  if (L.form === 'multi') preview = `<div class="mgrid ${cols}" id="mgrid">${order.map((id, i) => phImg(photo(id), { attrs: 'draggable="true"', tag: i === 0 ? '封面' : order.length === 9 && i === 4 ? '中心' : '' })).join('')}</div>`;
  else if (L.form === 'grid9') { const p = photo(order[0] || sel[0]); preview = `<div class="tiles9">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => `<div style="background-image:url('${p ? imgUrl('thumb', p.id) : ''}');background-position:${(i % 3) * 50}% ${Math.floor(i / 3) * 50}%"></div>`).join('')}</div><p class="muted small">用封面（第 1 张）切成 9 张，发的时候按 1–9 顺序选。</p>`; }
  else { const t = T[L.template] || T.grid2x2; preview = `<canvas id="cvCollage" width="600" height="600" style="width:300px;border-radius:2px;background:#fff"></canvas><p class="muted small">${esc(t.name)}：按排版顺序取前 ${t.n} 张拼成 1 张图。</p>`; }
  return `<div class="card">
    <h2>第 4 步：排版</h2>
    <p class="muted">AI 决定发几张、哪张做封面、怎么排；规则保证朋友圈的展示方式：4 张显示 2×2，9 张时正中间放第二吸引人的照片，同一场景不相邻。</p>
    <div class="row" style="margin-top:12px">
      <label class="row">形式 <select id="layoutForm" style="width:auto"><option value="multi" ${L.form === 'multi' ? 'selected' : ''}>普通多图</option><option value="grid9" ${L.form === 'grid9' ? 'selected' : ''}>九宫格切图</option><option value="collage" ${L.form === 'collage' ? 'selected' : ''}>拼图</option></select></label>
      ${L.form === 'collage' ? `<select id="layoutTpl" style="width:auto">${Object.entries(T).map(([k, t]) => `<option value="${k}" ${L.template === k ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}
      <label class="row">张数 <select id="layoutCount" style="width:auto"><option value="">${aiOn() ? 'AI 决定' : '自动'}</option>${allowed.map(n => `<option value="${n}" ${String(L.wantCount || '') === String(n) ? 'selected' : ''}>${n} 张</option>`).join('')}</select></label>
      ${aiOn() ? `<label class="row"><input type="checkbox" id="layoutLocal" ${(L.opts || {}).local ? 'checked' : ''}> 不用 AI</label>` : ''}
      <button class="primary big" data-act="runLayout" ${isRunning('layout') ? 'disabled' : ''}>🧩 ${aiOn() && !(L.opts || {}).local ? 'AI 排版' : '按规则排版'}</button>
    </div>
    ${needAi('现在按规则排版；配置 AI 后由 AI 选张数、封面和顺序')}
    ${staleBanner(L.stale)}
  </div>
  ${order.length ? `<div class="card">
    <div class="row"><h3 class="grow" style="margin:0">朋友圈预览</h3>${L.form === 'multi' ? '<span class="muted small">拖动照片可以调整顺序</span>' : ''}</div>
    <div class="moment" style="margin-top:8px"><div class="avatar"></div><div><div class="name">我</div><div class="text">${esc(text)}</div>${preview}<div class="muted small" style="margin-top:6px">刚刚</div></div></div>
    ${L.form === 'multi' ? `<div class="row" style="margin-top:8px">调整张数：${allowed.map(n => `<button class="chip ${order.length === n ? 'on' : ''}" data-act="setCount" data-n="${n}">${n}</button>`).join('')}</div>` : ''}
    ${L.reasons.length ? `<h3>排版思路</h3><ul>${L.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${nextBtn('caption', '下一步：写文案')}
  </div>` : ''}`;
}
afterRender.layout = () => {
  const g = $('mgrid');
  if (g) {
    let dragId = null;
    g.querySelectorAll('.ph').forEach(el => {
      el.ondragstart = e => { dragId = el.dataset.id; e.dataTransfer.effectAllowed = 'move'; };
      el.ondragover = e => { e.preventDefault(); el.classList.add('drop'); };
      el.ondragleave = () => el.classList.remove('drop');
      el.ondrop = e => {
        e.preventDefault(); el.classList.remove('drop');
        const order = [...app.st.draft.layout.order], a = order.indexOf(dragId), b = order.indexOf(el.dataset.id);
        if (a < 0 || b < 0 || a === b) return;
        order.splice(b, 0, order.splice(a, 1)[0]);
        act(async () => { await api('POST', '/api/layout', { order, drag: true }); await refresh(); });
      };
    });
  }
  const cv = $('cvCollage');
  if (cv) {
    const L = app.st.draft.layout, t = Imaging.TEMPLATES[L.template] || Imaging.TEMPLATES.grid2x2;
    const urls = (L.order.length ? L.order : app.st.draft.pick.selected).slice(0, t.n).map(id => imgUrl('thumb', id));
    Imaging.renderCollage(urls, L.template, app.st.draft.grade.params, 600, 4).then(c => cv.getContext('2d').drawImage(c, 0, 0)).catch(() => {});
  }
};

// 5. 文案
function viewCaption() {
  const d = app.st.draft, c = d.caption;
  const styles = app.st.styles;
  return `<div class="card">
    <h2>第 5 步：写文案</h2>
    <p class="muted">AI 看照片、按场合和风格写 3–5 条。只模仿风格，不照搬原文；不编造照片里看不出、你也没说的事实。</p>
    <div class="kv" style="margin-top:12px">
      <span>场合（可选）</span><input type="text" id="capOccasion" data-live="1" value="${esc(c.occasion)}" placeholder="例如：和大学室友毕业旅行">
      <span>风格</span><div class="row">${styles.map(s => `<button class="chip ${c.styleId === s.id ? 'on' : ''}" data-act="capStyle" data-id="${s.id}" title="${esc(s.builtin ? '' : '我的风格卡')}">${esc(s.name)}${s.builtin ? '' : ' ★'}</button>`).join('')}<button class="chip ${c.styleId === 'ref' ? 'on' : ''}" data-act="capStyle" data-id="ref">复刻同款文案</button></div>
    </div>
    ${c.styleId === 'ref' ? `<p style="margin-top:8px">粘贴一段你喜欢的文案，AI 会分析出一张风格卡：</p><textarea id="capRef" data-live="1" placeholder="直接复制粘贴文案文字（本版不从链接抓取）">${esc(c.refText)}</textarea>${aiOn() ? '' : '<div class="banner warn">复刻同款文案需要 AI：请先在 AI 设置里配置。</div>'}` : ''}
    ${c.styleCard && c.styleId === 'ref' ? `<div class="banner">风格卡「${esc(c.styleCardName || '')}」：${esc(Object.entries(app.st.cardFields).map(([k, n]) => c.styleCard[k] ? `${n} ${Array.isArray(c.styleCard[k]) ? c.styleCard[k].join('–') : c.styleCard[k]}` : '').filter(Boolean).join('；'))}
      <div class="row" style="margin-top:6px"><input type="text" id="styleName" value="${esc(c.styleCardName || '')}" style="width:160px"><button data-act="saveStyle">存为我的风格</button></div></div>` : ''}
    <div class="row" style="margin-top:12px"><button class="primary big" data-act="runCaption" ${isRunning('write-caption') || (c.styleId === 'ref' && !aiOn()) ? 'disabled' : ''}>✍️ ${c.options.length ? '重新生成' : '生成文案'}</button></div>
    ${needAi('现在只有离线模板；配置 AI 后可以看图写文案')}
    ${staleBanner(c.stale)}
  </div>
  ${c.options.length ? `<div class="card">
    <h3 style="margin-top:0">选一条</h3>
    <div class="opts">${c.options.map((t, i) => `<div class="opt ${c.chosen === i ? 'on' : ''}" data-act="capChoose" data-i="${i}"><input type="radio" ${c.chosen === i ? 'checked' : ''}><span>${esc(t)}</span></div>`).join('')}</div>
    ${c.chosen != null ? `<h3>可以直接修改</h3><textarea id="capText" data-live="1" rows="4">${esc(c.text)}</textarea>
      <div class="row" style="margin-top:8px"><button data-act="capCopy">📋 一键复制</button><span class="muted small">${[...(c.text || '')].length} 字</span></div>` : ''}
    ${c.chosen != null ? nextBtn('export', '下一步：导出') : ''}
  </div>` : ''}`;
}

// 6. 导出
function exportPlan() {
  const d = app.st.draft, L = d.layout;
  const order = L.order.length ? L.order : d.pick.selected;
  if (L.form === 'grid9') return { count: 9, order: order.slice(0, 1) };
  if (L.form === 'collage') return { count: 1, order: order.slice(0, (Imaging.TEMPLATES[L.template] || Imaging.TEMPLATES.grid2x2).n) };
  return { count: order.length, order };
}
function viewExport() {
  const d = app.st.draft, E = d.export, ph = app.st.phone.export;
  const plan = exportPlan();
  const form = { multi: '普通多图', grid9: '九宫格切图', collage: '拼图' }[d.layout.form];
  const prog = app.exportProgress;
  return `<div class="card">
    <h2>第 6 步：导出发布包</h2>
    <p class="muted">照片按排版顺序命名为 01.jpg、02.jpg……，文案复制到剪贴板并保存为 文案.txt。</p>
    <table style="margin:12px 0"><tr><th>照片</th><td>${plan.order.length ? `${form}，导出 ${plan.count} 张` : '<span class="muted">还没有排版</span>'}${d.layout.stale ? ' <span class="muted small">（排版需要重新生成）</span>' : ''}</td></tr>
      <tr><th>调色</th><td>${esc(d.grade.presetName || '原图')}</td></tr>
      <tr><th>文案</th><td style="white-space:pre-wrap">${d.caption.text ? esc(d.caption.text) : '<span class="muted">没有选文案（可以只导出照片）</span>'}</td></tr></table>
    <label class="row"><input type="checkbox" id="stripGps" ${E.stripGps !== false ? 'checked' : ''}> 去掉照片里的定位信息（推荐）</label>
    <div class="row" style="margin-top:12px"><button class="primary big" data-act="runExport" ${!plan.order.length || prog || isRunning('export') ? 'disabled' : ''}>📦 生成发布包</button></div>
    ${prog ? `<p>${esc(prog.text)}</p><div class="progress"><i style="width:${prog.done / prog.total * 100}%"></i></div>` : ''}
  </div>
  ${E.done ? `<div class="card">
    <div class="banner ok">✓ 发布包已生成：${E.files.length} 张${d.caption.text ? '，文案已复制到剪贴板' : ''}</div>
    ${ph && ph.active && ph.draftId === d.id ? `<div class="qr"><div class="code">${ph.qr}</div><div class="grow"><p><b>扫码存回手机（推荐）</b></p><p class="muted small">手机和电脑连同一个 Wi-Fi，扫码后按顺序长按保存到相册。10 分钟内有效。</p><button data-act="stopSave">关闭二维码</button></div></div>` : ''}
    <div class="row"><button data-act="openFolder">📂 打开文件夹</button><span class="muted small">也可以用微信「文件传输助手」把照片发到手机</span></div>
    <div class="grid" style="margin-top:12px">${E.files.map((f, i) => `<div class="ph"><img src="${app.engine.base}/api/img/export/${i + 1}?t=${encodeURIComponent(app.engine.token)}&v=${app.ver}" alt=""><span class="tag">${esc(f)}</span></div>`).join('')}</div>
    <p class="muted small" style="margin-top:12px">本次的选择（照片、调色、排版、文案）已写入「我的偏好」，下次会更懂你。</p>
    <div class="row end"><button data-act="newDraft">开始下一条 →</button></div>
  </div>` : ''}`;
}

// 我的偏好
function viewPrefs() {
  const M = app.st.memory;
  const drafts = app.draftsList;
  const kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  return `${M.needsOnboarding ? `<div class="card"><h2>先了解一下你（可以跳过）</h2><p class="muted">回答 3 个问题，或者上传几张自己以前的朋友圈截图让 AI 分析。以后 AI 写文案、挑图都会参考。</p>
    <div class="kv" style="margin-top:12px">${M.questions.map(q => `<span>${esc(q.q)}</span><select id="ob_${q.key}"><option value="">（跳过）</option>${q.options.map(o => `<option>${esc(o)}</option>`).join('')}</select>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="primary" data-act="obSave">保存</button><button data-act="obShots" ${aiOn() ? '' : 'disabled'}>上传朋友圈截图让 AI 分析</button><button class="link" data-act="obSkip">跳过</button></div>${aiOn() ? '' : '<p class="muted small">截图分析需要先配置 AI。</p>'}</div>` : ''}
  <div class="card">
    <div class="row"><h2 class="grow">我的偏好</h2><button data-act="runPrefs" ${isRunning('preferences') ? 'disabled' : ''}>刷新</button></div>
    <p class="muted">AI 记住的全部内容都在这里，只存在本机，不上传。每条都可以修改或删除。</p>
    <h3>偏好摘要（每次调用 AI 时附上，不超过 300 字）</h3>
    <textarea id="memSummary" data-live="1" rows="3" maxlength="300" placeholder="还没有偏好。用几次后会自动生成">${esc(M.summary)}</textarea>
    <div class="row" style="margin-top:6px"><button data-act="memSummary">保存修改</button>${M.summaryOverride != null ? '<button class="link" data-act="memSummaryAuto">恢复自动生成</button>' : '<span class="muted small">现在是自动生成的</span>'}</div>
    <h3>记住的内容</h3>
    ${M.items.length ? `<table>${M.items.map(x => `<tr><td class="muted small" style="width:100px">${esc(x.kind)}</td><td>${esc(x.text)}</td><td style="width:110px;text-align:right">${x.editable ? `<button class="link small" data-act="memEdit" data-key="${x.key}">修改</button>` : ''}<button class="link small" data-act="memDelete" data-key="${x.key}">删除</button></td></tr>`).join('')}</table>` : '<p class="muted">还没有记忆。</p>'}
    <h3>调色预设</h3>${listUser(app.st.presets.filter(p => !p.builtin), 'delPreset')}
    <h3>文案风格卡</h3>${listUser(app.st.styles.filter(s => !s.builtin), 'delStyle')}
    <h3>挑图权重</h3><p class="small">${app.st.criteria.map(c => `${c.name} ${Math.round((M.weights[c.key] || c.weight) * 100)}%`).join(' · ')}</p>
    <p class="muted small">每导出 5 次会根据你的换图习惯重新计算，每项最多偏离默认值 ±50%。${Object.keys(M.catBias || {}).length ? '类型偏好：' + Object.entries(M.catBias).map(([k, v]) => `${app.st.categories[k]} ${v > 0 ? '+' : ''}${Math.round(v * 100)}%`).join('，') : ''}</p>
    <div class="row" style="margin-top:12px"><button data-act="memClear">一键清空记忆</button></div>
  </div>
  <div class="card">
    <div class="row"><h2 class="grow">草稿</h2><button data-act="loadDrafts">${drafts ? '刷新' : '查看草稿'}</button></div>
    <p class="muted">草稿默认保留 30 天。清理前会弹窗确认，并显示能释放多少空间。</p>
    ${drafts ? `<table><tr><th>草稿</th><th>进度</th><th>照片</th><th>大小</th><th></th></tr>${drafts.map(x => `<tr><td>${esc(x.id)}${x.id === app.st.draft.id ? ' <span class="muted small">（当前）</span>' : ''}${x.expired ? ' <span class="small" style="color:var(--warn)">超过 30 天</span>' : ''}</td><td>${esc((STEP_LIST.find(s => s[0] === x.step) || [0, x.broken ? '损坏' : ''])[1])}${x.exported ? ' ✓' : ''}</td><td>${x.photos || 0}</td><td>${kb(x.bytes)}</td>
      <td style="text-align:right">${x.id !== app.st.draft.id && !x.broken ? `<button class="link small" data-act="openDraft" data-id="${x.id}">继续</button>` : ''}<button class="link small" data-act="delDraft" data-id="${x.id}">删除</button></td></tr>`).join('')}</table>
      <div class="row" style="margin-top:8px"><button data-act="cleanDrafts" ${drafts.some(x => x.expired) ? '' : 'disabled'}>清理超过 30 天的草稿</button></div>` : ''}
  </div>`;
}
function listUser(list, delAct) {
  return list.length ? `<div class="row">${list.map(x => `<span class="chip" style="border:1px solid var(--line);border-radius:999px;padding:2px 4px 2px 10px">${esc(x.name)}<button class="link small" data-act="${delAct}" data-id="${x.id}">✕</button></span>`).join('')}</div>` : '<p class="muted small">还没有。在调色 / 文案页面点「存为我的…」就会出现在这里。</p>';
}

// AI 设置
function viewAi() {
  const A = app.st.ai;
  const f = app.aiForm || (app.aiForm = { provider: A.provider || 'anthropic', baseUrl: A.baseUrl || A.providers[A.provider || 'anthropic'].baseUrl, model: A.model || A.providers[A.provider || 'anthropic'].model });
  return `<div class="card">
    <h2>AI 设置</h2>
    <p>${A.configured ? `<span class="dot"></span>已配置：${esc(A.providers[A.provider] ? A.providers[A.provider].name : A.provider)} / ${esc(A.model)}` : '<span class="dot off"></span>还没有配置'}</p>
    <div class="banner">🔒 发给 AI 的只有<b>压缩后的缩略图</b>（长边 1024 像素）和文字，<b>不发原图</b>。API key 加密保存在本机，不上传到别处。</div>
    <div class="kv" style="margin-top:12px">
      <span>接口类型</span><select id="aiProvider">${Object.entries(A.providers).map(([k, p]) => `<option value="${k}" ${f.provider === k ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <span>接口地址</span><input type="text" id="aiBase" data-live="1" value="${esc(f.baseUrl)}">
      <span>API key</span><input type="password" id="aiKey" data-live="1" placeholder="${A.configured ? '已保存（不显示），不改就留空' : '粘贴 API key'}" autocomplete="off">
      <span>模型名</span><input type="text" id="aiModel" data-live="1" value="${esc(f.model)}" placeholder="必须是能看图的模型">
    </div>
    <p class="muted small" style="margin-top:6px">${f.provider === 'anthropic' ? 'Claude 默认用 claude-opus-5-5。' : f.provider === 'ark' ? '火山方舟控制台 →「API Key 管理」创建 key；模型名填控制台里开通的模型 ID（需要支持图片理解），也可以填推理接入点 ID（ep- 开头）。' : 'OpenAI 兼容接口：例如通义千问 https://dashscope.aliyuncs.com/compatible-mode/v1 + qwen-vl-max，智谱 https://open.bigmodel.cn/api/paas/v4 + glm-4v-plus。'}</p>
    <div class="row" style="margin-top:12px"><button class="primary" data-act="aiTest" ${isRunning('ai-settings') ? 'disabled' : ''}>测试连接并保存</button>${A.configured ? '<button data-act="aiClear">清除配置</button>' : ''}</div>
    <p class="muted small">「测试连接」会发一张测试图片，确认模型能看图后才保存。</p>
    <h3>用量</h3><p>本次草稿已调用 AI <b>${app.st.draft.aiCalls || 0}</b> 次，累计 <b>${A.totalCalls}</b> 次。</p>
    <h3>没有配置 AI 时</h3><p class="muted">导入、本地预筛、预设滤镜、参考图本地颜色迁移、手动排版、导出都能正常用；一句话调色用离线规则，文案只有离线模板。</p>
  </div>`;
}

// ── 交互 ────────────────────────────────────────────────
document.addEventListener('click', e => {
  const stepBtn = e.target.closest('[data-step]');
  if (stepBtn) { app.view = stepBtn.dataset.step; app.swapFrom = null; app.detail = null; renderAll(); window.scrollTo(0, 0); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = handlers[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});
$('navPrefs').onclick = () => { app.view = 'prefs'; renderAll(); };
$('navAi').onclick = () => { app.view = 'ai'; app.aiForm = null; renderAll(); };
$('btnNewDraft').onclick = () => handlers.newDraft();
const val = id => $(id) ? $(id).value : '';
const handlers = {
  goAi: () => { app.view = 'ai'; app.aiForm = null; renderAll(); },
  newDraft: () => act(async () => { app.st = await api('POST', '/api/draft/new'); app.view = 'import'; app.ref = null; app.ver = Date.now(); renderAll(); }),
  importPhone: () => act(async () => { hostRun('import-phone'); setTimeout(() => refresh().catch(() => {}), 800); }),
  stopPhone: () => act(async () => { await api('POST', '/api/phone/stop', { kind: 'import' }); await refresh(); }),
  importFolder: () => runStep('import-folder'),
  removePhoto: el => act(async () => { await api('POST', `/api/photos/${el.dataset.id}/remove`, {}); await refresh(); }),
  runPick: () => act(async () => {
    await api('POST', '/api/pick/options', { local: $('pickLocal') ? $('pickLocal').checked : false, count: val('pickCount') || null });
    app.swapFrom = null; await runStep('pick-photos');
  }),
  pickSel: el => { const id = el.dataset.id; app.detail = id; app.swapFrom = app.swapFrom === id ? null : id; renderAll(); },
  pickAlt: el => act(async () => {
    const id = el.dataset.id; app.detail = id;
    if (app.swapFrom) { await api('POST', '/api/pick/swap', { out: app.swapFrom, in: id }); logLine('[OK] 已换图，换图记录已写入记忆'); app.swapFrom = null; await refresh(); }
    else if (app.st.draft.pick.selected.length < 9) { await api('POST', '/api/pick/swap', { in: id }); await refresh(); }
    else renderAll();
  }),
  includePhoto: el => act(async () => { await api('POST', `/api/photos/${el.dataset.id}/manual`, { manual: 'include' }); logLine('[OK] 已放回候选，点「重新挑选」生效'); await refresh(); }),
  rescore: () => act(async () => {
    const weights = {}; document.querySelectorAll('[data-w]').forEach(r => { weights[r.dataset.w] = Number(r.value) / 100; });
    await api('POST', '/api/pick/rescore', { weights, count: val('pickCount') || null }); logLine('[OK] 已按新权重重新挑选'); await refresh();
  }),
  resetWeights: () => act(async () => { await api('POST', '/api/pick/rescore', { resetWeights: true }); await refresh(); }),
  gradeFocus: el => { app.gradeFocus = el.dataset.id; renderAll(); },
  preset: el => act(async () => { await api('POST', '/api/grade', { preset: el.dataset.id }); await refresh(); }),
  gradeUndo: () => act(async () => { await api('POST', '/api/grade', { undo: true }); await refresh(); }),
  gradeReset: () => act(async () => { await api('POST', '/api/grade', { params: Grade.defaults() }); await refresh(); }),
  savePreset: () => act(async () => { const n = val('presetName').trim(); if (!n) throw new Error('请先给预设起个名字'); await api('POST', '/api/presets', { name: n }); logLine('[OK] 已存为预设「' + n + '」，下次可以一键套用'); await refresh(); }),
  gradeText: () => act(async () => {
    const t = val('gradeText').trim(); if (!t) throw new Error('请先输入一句话');
    await api('POST', '/api/grade/request', { type: 'text', text: t });
    $('gradeText').value = '';
    await runStep('color-grade');
  }),
  refClear: () => { app.ref = null; renderAll(); },
  refApply: () => act(async () => {
    const ref = app.ref; if (!ref) return;
    const rect = ref.rect || { x: 0, y: 0, w: ref.canvas.width, h: ref.canvas.height };
    const refStats = Imaging.statsOf(ref.canvas, rect);
    const targets = gradeTargets().slice(0, 6);
    const srcStats = [];
    for (const p of targets) srcStats.push(Imaging.statsOf(Imaging.drawScaled(await Imaging.loadImage(imgUrl('thumb', p.id)), 256)));
    const local = Grade.statsToParams(refStats, Grade.averageStats(srcStats));
    const crop = Imaging.canvasOf(rect.w, rect.h); crop.getContext('2d').drawImage(ref.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    await api('PUT', '/api/grade/reference', await Imaging.toJpeg(crop, 0.88), true);
    await api('POST', '/api/grade/request', { type: 'reference', params: local });
    await runStep('color-grade');
  }),
  runLayout: () => act(async () => {
    await api('POST', '/api/layout', { wantCount: val('layoutCount') || null, local: $('layoutLocal') ? $('layoutLocal').checked : false });
    await runStep('layout');
  }),
  setCount: el => act(async () => {
    const n = Number(el.dataset.n), d = app.st.draft;
    let order = d.layout.order.slice(0, n);
    for (const id of d.pick.selected) if (order.length < n && !order.includes(id)) order.push(id);
    await api('POST', '/api/layout', { order, drag: true }); await refresh();
  }),
  capStyle: el => act(async () => { await api('POST', '/api/caption', { styleId: el.dataset.id, occasion: val('capOccasion') }); await refresh(); }),
  runCaption: () => act(async () => {
    await api('POST', '/api/caption', { occasion: val('capOccasion'), ...($('capRef') ? { refText: val('capRef') } : {}) });
    await runStep('write-caption');
  }),
  capChoose: el => act(async () => { await api('POST', '/api/caption', { choose: Number(el.dataset.i) }); await refresh(); }),
  capCopy: () => act(async () => { await api('POST', '/api/caption', { text: val('capText') }); await api('POST', '/api/caption/copy', {}); logLine('[OK] 文案已复制到剪贴板'); }),
  saveStyle: () => act(async () => { await api('POST', '/api/styles', { name: val('styleName') }); logLine('[OK] 已存为我的风格'); await refresh(); }),
  runExport: () => exportNow(),
  openFolder: () => act(() => api('POST', '/api/export/open', {})),
  stopSave: () => act(async () => { await api('POST', '/api/phone/stop', { kind: 'export' }); await refresh(); }),
  obSave: () => act(async () => { const b = {}; for (const q of app.st.memory.questions) b[q.key] = val('ob_' + q.key); if (!Object.values(b).some(Boolean)) b.skip = true; await api('POST', '/api/memory/onboarding', b); await refresh(); }),
  obSkip: () => act(async () => { await api('POST', '/api/memory/onboarding', { skip: true }); app.view = 'import'; await refresh(); }),
  obShots: () => $('fileShots').click(),
  runPrefs: () => runStep('preferences'),
  memSummary: () => act(async () => { await api('POST', '/api/memory/edit', { key: 'summary', value: val('memSummary') }); logLine('[OK] 偏好摘要已保存'); await refresh(); }),
  memSummaryAuto: () => act(async () => { await api('POST', '/api/memory/delete', { key: 'summary' }); await refresh(); }),
  memDelete: el => act(async () => { await api('POST', '/api/memory/delete', { key: el.dataset.key }); logLine('[OK] 已删除，后续生成不再体现这条偏好'); await refresh(); }),
  memEdit: el => { const row = el.closest('tr'); const td = row.children[1]; const old = td.textContent.replace(/^[^：]*：/, ''); td.innerHTML = `<div class="row"><input type="text" id="memEditVal" value="${esc(old)}" class="grow"><button data-act="memEditSave" data-key="${el.dataset.key}">保存</button></div>`; $('memEditVal').focus(); },
  memEditSave: el => act(async () => { await api('POST', '/api/memory/edit', { key: el.dataset.key, value: val('memEditVal') }); await refresh(); }),
  memClear: () => act(async () => { const r = await api('POST', '/api/memory/clear', {}); if (r.cleared) logLine('[OK] 记忆已清空，回到第一次使用的状态'); await refresh(); }),
  delPreset: el => act(async () => { await api('POST', '/api/presets/delete', { id: el.dataset.id }); await refresh(); }),
  delStyle: el => act(async () => { await api('POST', '/api/styles/delete', { id: el.dataset.id }); await refresh(); }),
  loadDrafts: () => act(async () => { app.draftsList = (await api('GET', '/api/drafts')).drafts; renderAll(); }),
  openDraft: el => act(async () => { app.st = await api('POST', '/api/draft/open', { id: el.dataset.id }); app.ref = null; app.ver = Date.now(); app.view = app.st.draft.step; renderAll(); queueAnalysis(); }),
  delDraft: el => act(async () => { const r = await api('POST', '/api/drafts/delete', { ids: [el.dataset.id] }); logLine(r.message); app.draftsList = (await api('GET', '/api/drafts')).drafts; await refresh(); }),
  cleanDrafts: () => act(async () => { const r = await api('POST', '/api/drafts/delete', { expired: true }); logLine(r.message); app.draftsList = (await api('GET', '/api/drafts')).drafts; await refresh(); }),
  aiTest: () => act(async () => {
    const f = { provider: val('aiProvider'), baseUrl: val('aiBase').trim(), apiKey: val('aiKey').trim(), model: val('aiModel').trim() };
    app.aiForm = { ...f, apiKey: '' };
    await api('POST', '/api/ai/pending', f);
    if ($('aiKey')) $('aiKey').value = '';
    await runStep('ai-settings');
  }),
  aiClear: () => act(async () => { await api('POST', '/api/ai/clear', {}); app.aiForm = null; await refresh(); })
};
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'aiProvider') { const p = app.st.ai.providers[t.value]; app.aiForm = { provider: t.value, baseUrl: p.baseUrl, model: p.model }; renderAll(); }
  if (t.id === 'layoutForm' || t.id === 'layoutTpl') act(async () => { await api('POST', '/api/layout', t.id === 'layoutForm' ? { form: t.value } : { template: t.value }); await refresh(); });
  if (t.id === 'stripGps') app.st.draft.export.stripGps = t.checked;
  if (t.id === 'capOccasion') act(() => api('POST', '/api/caption', { occasion: t.value }));
  if (t.id === 'capRef') act(() => api('POST', '/api/caption', { refText: t.value }));
  if (t.id === 'capText') act(() => api('POST', '/api/caption', { text: t.value }));
  if (t.dataset.g) act(async () => {
    const r = await api('POST', '/api/grade', { params: previewParams, manual: true });
    app.st.draft.grade.params = r.params; await refresh();
  });
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.w) t.nextElementSibling.textContent = t.value + '%';
  if (t.dataset.g) {
    t.nextElementSibling.textContent = t.value;
    previewParams = Grade.merge(previewParams || app.st.draft.grade.params, { [t.dataset.g]: Number(t.value) });
    clearTimeout(previewTimer); previewTimer = setTimeout(drawCompare, 60);
  }
});
$('fileShots').onchange = () => act(async () => {
  const files = [...$('fileShots').files].slice(0, 6); $('fileShots').value = '';
  if (!files.length) return;
  for (let i = 0; i < files.length; i++) {
    const url = URL.createObjectURL(files[i]);
    try { await api('PUT', '/api/memory/screen/' + i, await Imaging.toJpeg(Imaging.drawScaled(await Imaging.loadImage(url), 1024), 0.85), true); }
    finally { URL.revokeObjectURL(url); }
  }
  await api('POST', '/api/memory/onboarding', { skip: true });
  await runStep('preferences');
});

/** 导出：在界面里按排版和调色参数处理原图，逐张上传，再运行「导出发布包」动作 */
async function exportNow() {
  const d = app.st.draft, plan = exportPlan(), params = d.grade.params;
  const stripGps = $('stripGps') ? $('stripGps').checked : true;
  app.exportProgress = { text: '准备中…', done: 0, total: plan.count };
  renderAll();
  try {
    await api('POST', '/api/export/begin', { count: plan.count, stripGps });
    const upload = async (canvas, n) => {
      await api('PUT', '/api/export/file/' + n, await Imaging.toJpeg(canvas, 0.92), true);
      app.exportProgress = { text: `处理第 ${n} / ${plan.count} 张`, done: n, total: plan.count }; renderAll();
    };
    if (d.layout.form === 'grid9') {
      const tiles = await Imaging.renderGrid9(imgUrl('orig', plan.order[0]), params);
      for (let i = 0; i < 9; i++) await upload(tiles[i], i + 1);
    } else if (d.layout.form === 'collage') {
      await upload(await Imaging.renderCollage(plan.order.map(id => imgUrl('orig', id)), d.layout.template, params), 1);
    } else {
      for (let i = 0; i < plan.order.length; i++) {
        app.exportProgress.text = `处理第 ${i + 1} / ${plan.count} 张…`; renderAll();
        await upload(await Imaging.renderSingle(imgUrl('orig', plan.order[i]), params, i + 1), i + 1);
      }
    }
    app.exportProgress = null;
    app.ver = Date.now();
    await runStep('export');
  } catch (e) {
    app.exportProgress = null; toast('导出失败：' + e.message, 'err'); renderAll();
  }
}

window.addEventListener('resize', () => { if (app.view === 'grade' && $('compare')) { $('cvAfter').style.width = $('compare').clientWidth + 'px'; setSplit($('split').value); } });
post({ type: 'ready' });
