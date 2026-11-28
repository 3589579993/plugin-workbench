'use strict';
// 记忆：主动保存（预设、风格卡，另存在 presets/ styles/）、行为记录、习惯统计、冷启动问答、偏好摘要。
// 全部存在本机插件数据目录的 memory.json，不上传。
const fs = require('fs');
const path = require('path');
const { CRITERIA, DEFAULT_WEIGHTS, CATEGORIES, normalizeWeights } = require('./select');

const MAX_EVENTS = 500;
const RECALC_EVERY = 5;
const WEIGHT_BOUND = 0.5;   // 权重最多偏离默认值 ±50%
const BIAS_BOUND = 0.3;     // 类型偏好对挑选分数的影响上限 ±30%

const ONBOARDING = [
  { key: 'tone', q: '你喜欢什么色调？', options: ['清新明亮', '日系通透', '暖调', '冷色调', '胶片复古', '黑白', '原图就好'] },
  { key: 'length', q: '文案喜欢多长？', options: ['一句话', '两三句', '可以长一点', '不写文案'] },
  { key: 'content', q: '通常发什么内容？', options: ['旅行风景', '自拍人像', '美食', '日常生活', '和朋友聚会'] }
];

function empty() {
  return { version: 1, onboarding: null, onboardingSkipped: false, screenshotPrefs: null, summaryOverride: null,
    events: [], weights: { ...DEFAULT_WEIGHTS }, catBias: {}, exportsSinceRecalc: 0, totalExports: 0, aiCalls: 0, suppressed: [] };
}

function createMemory(dir) {
  const file = path.join(dir, 'memory.json');
  const presetsDir = path.join(dir, 'presets'), stylesDir = path.join(dir, 'styles');
  function load() {
    try { return { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) { return empty(); }
  }
  function save(m) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
  function update(fn) { const m = load(); const r = fn(m); save(m); return r; }
  function record(type, data) {
    update(m => { m.events.push({ t: new Date().toISOString(), type, ...data }); if (m.events.length > MAX_EVENTS) m.events.splice(0, m.events.length - MAX_EVENTS); });
  }

  // ── 主动保存：预设 / 风格卡 ──
  const safeName = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 40);
  function listDir(d) {
    try {
      return fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => {
        try { return { id: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) }; } catch (_) { return null; }
      }).filter(Boolean);
    } catch (_) { return []; }
  }
  function saveItem(d, name, data) {
    const n = safeName(name);
    if (!n) throw new Error('名字不能为空');
    fs.mkdirSync(d, { recursive: true });
    const id = 'u' + Date.now().toString(36);
    fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify({ name: n, createdAt: new Date().toISOString(), uses: 0, ...data }, null, 2), 'utf8');
    return id;
  }
  function removeItem(d, id) {
    if (!/^u[0-9a-z]+$/.test(id)) throw new Error('无效的编号');
    fs.rmSync(path.join(d, id + '.json'), { force: true });
  }
  function bumpUse(d, id) {
    const f = path.join(d, id + '.json');
    try { const x = JSON.parse(fs.readFileSync(f, 'utf8')); x.uses = (x.uses || 0) + 1; fs.writeFileSync(f, JSON.stringify(x, null, 2)); } catch (_) {}
  }

  // ── 习惯统计 ──
  function stats(m) {
    const ex = m.events.filter(e => e.type === 'export');
    const swaps = m.events.filter(e => e.type === 'swap');
    const count = arr => arr.reduce((acc, x) => { if (x) acc[x] = (acc[x] || 0) + 1; return acc; }, {});
    const top = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);
    const cats = {};
    for (const e of ex) for (const [k, v] of Object.entries(e.cats || {})) cats[k] = (cats[k] || 0) + v;
    return {
      exports: ex.length,
      avgCount: ex.length ? Math.round(ex.reduce((s, e) => s + (e.count || 0), 0) / ex.length) : null,
      occasions: top(count(ex.map(e => e.occasion))).slice(0, 3).map(x => x[0]),
      presets: top(count(ex.map(e => e.preset))).map(x => x[0]),
      styles: top(count(ex.map(e => e.style))).map(x => x[0]),
      cats: top(cats),
      swapOut: count(swaps.map(e => e.outCat)), swapIn: count(swaps.map(e => e.inCat)),
      captionEdits: m.events.filter(e => e.type === 'caption' && e.edited).length,
      captionLen: (() => { const c = m.events.filter(e => e.type === 'caption' && e.length); return c.length ? Math.round(c.reduce((s, e) => s + e.length, 0) / c.length) : null; })(),
      drags: m.events.filter(e => e.type === 'layout' && e.drags > 0).length
    };
  }

  /** 每导出 5 次重新算一次：根据换图记录调整类型偏好和人物权重 */
  function recalc(m) {
    const swaps = m.events.filter(e => e.type === 'swap' && !m.suppressed.includes('swap'));
    const total = swaps.length;
    const bias = {};
    if (total) {
      for (const cat of Object.keys(CATEGORIES)) {
        const net = swaps.filter(e => e.inCat === cat).length - swaps.filter(e => e.outCat === cat).length;
        const b = Math.max(-BIAS_BOUND, Math.min(BIAS_BOUND, net / total * BIAS_BOUND * 2));
        if (Math.abs(b) >= 0.01) bias[cat] = Math.round(b * 100) / 100;
      }
    }
    m.catBias = bias;
    const w = { ...DEFAULT_WEIGHTS };
    if (bias.portrait) w.people = DEFAULT_WEIGHTS.people * (1 + bias.portrait / BIAS_BOUND * WEIGHT_BOUND);
    if (bias.landscape) w.composition = DEFAULT_WEIGHTS.composition * (1 + bias.landscape / BIAS_BOUND * 0.25);
    m.weights = normalizeWeights(normalizeWeights(w, WEIGHT_BOUND), WEIGHT_BOUND);
    m.exportsSinceRecalc = 0;
  }
  function recordExport(data) {
    return update(m => {
      m.events.push({ t: new Date().toISOString(), type: 'export', ...data });
      if (m.events.length > MAX_EVENTS) m.events.splice(0, m.events.length - MAX_EVENTS);
      m.totalExports++; m.exportsSinceRecalc++;
      const due = m.exportsSinceRecalc >= RECALC_EVERY;
      if (due) recalc(m);
      return due;
    });
  }

  /** 偏好摘要：不超过 300 字，每次调用 AI 时附上；用户改过就用用户写的 */
  function summary(m) {
    m = m || load();
    if (m.summaryOverride != null) return m.summaryOverride.slice(0, 300);
    return derivedItems(m).map(x => x.text).join('；').slice(0, 300);
  }
  /** 「我的偏好」页面里能看到、能删除的条目 */
  function derivedItems(m) {
    const s = stats(m), items = [];
    const sup = k => m.suppressed.includes(k);
    if (m.onboarding) {
      for (const q of ONBOARDING) if (m.onboarding[q.key]) items.push({ key: 'onboarding.' + q.key, kind: '冷启动回答', text: `${q.q.replace(/[？?]/, '')}：${m.onboarding[q.key]}`, editable: true });
    }
    if (m.screenshotPrefs && !sup('screens')) items.push({ key: 'screens', kind: '朋友圈截图分析', text: m.screenshotPrefs });
    if (s.avgCount && !sup('count')) items.push({ key: 'count', kind: '习惯统计', text: `通常发 ${s.avgCount} 张` });
    const fav = Object.entries(m.catBias || {}).filter(([, v]) => v > 0).map(([k]) => CATEGORIES[k]);
    const dis = Object.entries(m.catBias || {}).filter(([, v]) => v < 0).map(([k]) => CATEGORIES[k]);
    if ((fav.length || dis.length) && !sup('swap')) items.push({ key: 'swap', kind: '行为记录', text: [fav.length ? `更喜欢${fav.join('、')}照片` : '', dis.length ? `常把${dis.join('、')}照片换掉` : ''].filter(Boolean).join('，') });
    if (s.presets.length && !sup('preset')) items.push({ key: 'preset', kind: '习惯统计', text: `常用滤镜：${s.presets.slice(0, 2).join('、')}` });
    if (s.styles.length && !sup('style')) items.push({ key: 'style', kind: '习惯统计', text: `常用文案风格：${s.styles.slice(0, 2).join('、')}` });
    if (s.captionLen && !sup('captionLen')) items.push({ key: 'captionLen', kind: '行为记录', text: s.captionLen <= 20 ? '文案偏短' : s.captionLen >= 60 ? '文案偏长' : `文案大约 ${s.captionLen} 字` });
    if (s.occasions.length && !sup('occasion')) items.push({ key: 'occasion', kind: '习惯统计', text: `常见场合：${s.occasions.join('、')}` });
    return items;
  }
  /** 删除一条：冷启动回答直接删；统计类条目同时删掉相关的行为记录，以后不再体现 */
  function deleteItem(key) {
    update(m => {
      if (key.startsWith('onboarding.')) { if (m.onboarding) delete m.onboarding[key.slice(11)]; return; }
      if (key === 'summary') { m.summaryOverride = null; return; }
      if (key === 'screens') { m.screenshotPrefs = null; return; }
      const types = { swap: ['swap'], captionLen: ['caption'] }[key];
      if (types) m.events = m.events.filter(e => !types.includes(e.type));
      if (key === 'swap') { m.catBias = {}; m.weights = { ...DEFAULT_WEIGHTS }; }
      if (['count', 'preset', 'style', 'occasion'].includes(key)) {
        const field = { count: 'count', preset: 'preset', style: 'style', occasion: 'occasion' }[key];
        for (const e of m.events) if (e.type === 'export') delete e[field];
      }
    });
  }
  function editItem(key, value) {
    update(m => {
      if (key === 'summary') { m.summaryOverride = String(value || '').slice(0, 300); return; }
      if (key.startsWith('onboarding.')) { m.onboarding = m.onboarding || {}; m.onboarding[key.slice(11)] = String(value || '').slice(0, 40); }
    });
  }
  function clearAll() {
    save(empty());
    for (const d of [presetsDir, stylesDir]) fs.rmSync(d, { recursive: true, force: true });
  }

  return {
    file, load, save, update, record, stats, recalc, recordExport, summary, derivedItems, deleteItem, editItem, clearAll,
    presets: { list: () => listDir(presetsDir).sort((a, b) => (b.uses || 0) - (a.uses || 0)), save: (n, d) => saveItem(presetsDir, n, d), remove: id => removeItem(presetsDir, id), use: id => bumpUse(presetsDir, id) },
    styles: { list: () => listDir(stylesDir).sort((a, b) => (b.uses || 0) - (a.uses || 0)), save: (n, d) => saveItem(stylesDir, n, d), remove: id => removeItem(stylesDir, id), use: id => bumpUse(stylesDir, id) }
  };
}

module.exports = { createMemory, ONBOARDING, RECALC_EVERY, WEIGHT_BOUND, BIAS_BOUND, CRITERIA };
