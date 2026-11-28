'use strict';
// 挑照片：本地预筛（糊片、曝光、连拍）→ 加权总分 → 组合挑选；排版：规则兜底。
// 指标由界面用 canvas 计算后上传：
//   sharp  拉普拉斯方差（长边 512 灰度图）  dark / bright  过暗 / 过曝像素占比  mean  平均亮度 0–255
//   hash   64 位差值哈希（16 位十六进制）

const CRITERIA = [
  { key: 'composition', name: '构图', weight: 0.20, desc: '主体位置、水平线、画面是否杂乱' },
  { key: 'subject', name: '主体突出', weight: 0.15, desc: '一眼能不能看出拍的是什么' },
  { key: 'people', name: '人物状态', weight: 0.20, desc: '表情、闭眼、姿态（没有人物时不计分）' },
  { key: 'color', name: '色彩与氛围', weight: 0.15, desc: '光线、颜色好不好看，有没有情绪' },
  { key: 'aesthetic', name: '整体审美', weight: 0.30, desc: '整体的主观审美分' }
];
const DEFAULT_WEIGHTS = Object.fromEntries(CRITERIA.map(c => [c.key, c.weight]));
const CATEGORIES = { portrait: '人像', landscape: '风景', food: '美食', detail: '细节', other: '其他' };
const MAX_PER_SCENE = 2;
const MAX_AI_CANDIDATES = 60;
const ALTERNATES = 6;
const ALLOWED_COUNTS = [1, 3, 4, 6, 9];

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}
const median = arr => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const timeOf = p => p.takenAt ? Date.parse(p.takenAt) : NaN;
/** 平均颜色的距离：构图相似但颜色差很多（例如白天和夜晚同一角度）不算连拍。没有颜色信息时视为相近 */
function colorDistance(a, b) {
  if (!a.rgb || !b.rgb) return 0;
  return Math.sqrt(a.rgb.reduce((s, v, i) => s + (v - b.rgb[i]) ** 2, 0));
}

/**
 * 本地预筛。返回 { flags: {id: {blurry, exposure, group, best}}, candidates: [id], groups: n }
 * photos 里只算有 metrics 且能解码的照片；manual==='include' 的强制进候选，'exclude' 的强制不进。
 */
function prefilter(photos) {
  const list = photos.filter(p => p.metrics && !p.unsupported);
  const med = median(list.map(p => p.metrics.sharp));
  const flags = {};
  for (const p of list) {
    const m = p.metrics;
    const exposure = m.dark > 0.6 || m.bright > 0.5 || m.mean < 35 || m.mean > 228;
    // 过暗/过曝时清晰度指标不可靠（整张图都没有细节），只标曝光问题
    const blurry = !exposure && (m.sharp < 12 || (list.length >= 5 && m.sharp < med * 0.25));
    flags[p.id] = { blurry, exposure, group: p.id, best: true };
  }
  // 相似照片归组（并查集）：画面哈希很接近，或者 2 分钟内拍的且画面比较接近
  const parent = Object.fromEntries(list.map(p => [p.id, p.id]));
  const find = x => parent[x] === x ? x : (parent[x] = find(parent[x]));
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j], d = hamming(a.metrics.hash, b.metrics.hash);
    const dt = Math.abs(timeOf(a) - timeOf(b));
    if ((d <= 10 || (dt <= 120000 && d <= 18)) && colorDistance(a.metrics, b.metrics) <= 40) parent[find(a.id)] = find(b.id);
  }
  const groups = {};
  for (const p of list) (groups[find(p.id)] = groups[find(p.id)] || []).push(p);
  let n = 0;
  for (const members of Object.values(groups)) {
    n++;
    const gid = 'g' + n;
    const ok = members.filter(p => !flags[p.id].blurry && !flags[p.id].exposure);
    const pool = ok.length ? ok : members;
    const best = pool.reduce((a, b) => b.metrics.sharp > a.metrics.sharp ? b : a);
    for (const p of members) { flags[p.id].group = gid; flags[p.id].best = p.id === best.id; flags[p.id].groupSize = members.length; }
  }
  const candidates = list.filter(p => {
    if (p.manual === 'include') return true;
    if (p.manual === 'exclude') return false;
    const f = flags[p.id];
    return !f.blurry && !f.exposure && f.best;
  }).map(p => p.id);
  return { flags, candidates, groups: n };
}

/** 本地质量分（0–10）：清晰度相对中位数 + 曝光是否正常。用于没配 AI 时排序、超过 60 张时截取 */
function localQuality(p, med) {
  const m = p.metrics;
  if (!m) return 0;
  const sharp = Math.min(1, Math.log1p(m.sharp) / Math.log1p(Math.max(med, 1) * 2));
  const expo = 1 - Math.min(1, Math.abs(m.mean - 125) / 110) * 0.7 - Math.min(0.3, m.dark + m.bright);
  return Math.round((sharp * 6 + expo * 4) * 10) / 10;
}

/** 权重规范化：总和 1；可以给每项一个上下限（记忆微调时不超过默认值 ±50%） */
function normalizeWeights(w, bound) {
  const out = {};
  for (const c of CRITERIA) {
    let v = Number(w && w[c.key]);
    if (!isFinite(v) || v < 0) v = c.weight;
    if (bound) v = Math.min(c.weight * (1 + bound), Math.max(c.weight * (1 - bound), v));
    out[c.key] = v;
  }
  const sum = Object.values(out).reduce((a, b) => a + b, 0) || 1;
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] / sum * 1000) / 1000;
  return out;
}

/** 总分 = Σ 分项 × 权重；没有人物时"人物状态"不计分，它的权重按比例分给其他项 */
function totalScore(scores, weights, hasPeople) {
  const w = normalizeWeights(weights);
  let sum = 0, wsum = 0;
  for (const c of CRITERIA) {
    if (c.key === 'people' && !hasPeople) continue;
    const v = Number(scores && scores[c.key]);
    if (!isFinite(v)) continue;
    sum += v * w[c.key]; wsum += w[c.key];
  }
  return wsum ? Math.round(sum / wsum * 100) / 100 : 0;
}

/**
 * 组合挑选：按调整后的分数贪心挑；同一场景最多 2 张；同类型越多越扣分（照顾多样性）。
 * items: [{ id, score, category, scene }]，catBias: 记忆里的类型偏好（-0.3 ~ +0.3）
 * 返回 { selected: [id], alternates: [id], reasons: {id: 文字} }
 */
function chooseSet(items, { count = 9, catBias = {}, maxPerScene = MAX_PER_SCENE } = {}) {
  const adj = it => it.score * (1 + (catBias[it.category] || 0));
  const left = [...items];
  const selected = [], sceneCount = {}, catCount = {}, reasons = {};
  while (selected.length < count && left.length) {
    let bestIdx = -1, bestVal = -Infinity;
    left.forEach((it, i) => {
      if ((sceneCount[it.scene] || 0) >= maxPerScene) return;
      const v = adj(it) - 0.5 * (catCount[it.category] || 0);
      if (v > bestVal) { bestVal = v; bestIdx = i; }
    });
    if (bestIdx < 0) break;
    const it = left.splice(bestIdx, 1)[0];
    const parts = [`总分 ${it.score.toFixed(1)}`];
    if (!catCount[it.category] && it.category && it.category !== 'other') parts.push(`补上「${CATEGORIES[it.category] || it.category}」类型`);
    if (catBias[it.category] > 0.05) parts.push('符合你的偏好');
    reasons[it.id] = parts.join('，');
    selected.push(it.id);
    sceneCount[it.scene] = (sceneCount[it.scene] || 0) + 1;
    catCount[it.category] = (catCount[it.category] || 0) + 1;
  }
  const alternates = left.sort((a, b) => adj(b) - adj(a)).slice(0, ALTERNATES).map(it => it.id);
  return { selected, alternates, reasons };
}

/** 选进 AI 打分的候选：最多 60 张，超过时按本地质量分取前 60 */
function capCandidates(photos, ids, max = MAX_AI_CANDIDATES) {
  const byId = Object.fromEntries(photos.map(p => [p.id, p]));
  const med = median(ids.map(id => byId[id].metrics ? byId[id].metrics.sharp : 0));
  return [...ids].sort((a, b) => localQuality(byId[b], med) - localQuality(byId[a], med)).slice(0, max);
}

// ── 排版 ────────────────────────────────────────────────────
function allowedCount(n, wanted) {
  const fit = ALLOWED_COUNTS.filter(c => c <= n);
  if (!fit.length) return 0;
  if (wanted && fit.includes(Number(wanted))) return Number(wanted);
  if (wanted) return fit.reduce((a, b) => Math.abs(b - wanted) < Math.abs(a - wanted) ? b : a);
  return fit[fit.length - 1];
}
/** 朋友圈的展示方式：4 张 2×2，其余每行 3 张 */
function gridColumns(count) { return count === 4 ? 2 : (count === 1 ? 1 : 3); }
function neighbors(i, count) {
  const cols = gridColumns(count), out = [];
  const r = Math.floor(i / cols), c = i % cols;
  if (c > 0) out.push(i - 1);
  if (c < cols - 1 && i + 1 < count) out.push(i + 1);
  if (r > 0) out.push(i - cols);
  if (i + cols < count) out.push(i + cols);
  return out;
}
function conflicts(order, scene) {
  let n = 0;
  order.forEach((id, i) => { for (const j of neighbors(i, order.length)) if (j > i && scene[id] && scene[id] === scene[order[j]]) n++; });
  return n;
}
/**
 * 规则兜底：张数只能是 1/3/4/6/9；第 1 张是封面；9 张时第 5 张（正中间）放第二吸引人的照片；
 * 同一场景的照片在宫格里不相邻（左右、上下）。
 * meta: { id: { scene, rank } }，rank 越小越吸引人（AI 给的吸引力排序，或总分排序）
 */
function applyLayoutRules(order, meta, wantedCount) {
  const ids = [...new Set(order)].filter(id => meta[id]);
  const count = allowedCount(ids.length, wantedCount);
  const byRank = [...ids].sort((a, b) => meta[a].rank - meta[b].rank);
  let out = ids.slice(0, count);
  for (const id of byRank) if (out.length < count && !out.includes(id)) out.push(id);
  if (!out.length) return { order: [], count: 0 };
  // 封面保持作者（AI）给的第 1 张
  if (count === 9) {
    const second = byRank.find(id => id !== out[0] && out.includes(id));
    if (second) { const k = out.indexOf(second); [out[4], out[k]] = [out[k], out[4]]; }
  }
  const fixed = new Set([0]); if (count === 9) fixed.add(4);
  const scene = Object.fromEntries(ids.map(id => [id, meta[id].scene]));
  for (let iter = 0; iter < 50 && conflicts(out, scene) > 0; iter++) {
    let improved = false;
    for (let i = 0; i < out.length && !improved; i++) for (let j = 0; j < out.length && !improved; j++) {
      if (i === j || fixed.has(i) || fixed.has(j)) continue;
      const trial = [...out]; [trial[i], trial[j]] = [trial[j], trial[i]];
      if (conflicts(trial, scene) < conflicts(out, scene)) { out = trial; improved = true; }
    }
    if (!improved) break;
  }
  return { order: out, count, conflicts: conflicts(out, scene) };
}
/** 没有 AI 时的默认排版：封面 = 总分最高；其余按时间，再尽量让类型交替 */
function defaultOrder(items) {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const cover = sorted[0];
  const rest = items.filter(x => x !== cover).sort((a, b) => (a.time || 0) - (b.time || 0));
  const out = [cover];
  while (rest.length) {
    const last = out[out.length - 1];
    let k = rest.findIndex(x => x.category !== last.category && x.scene !== last.scene);
    if (k < 0) k = 0;
    out.push(rest.splice(k, 1)[0]);
  }
  return out.map(x => x.id);
}

module.exports = { CRITERIA, DEFAULT_WEIGHTS, CATEGORIES, MAX_AI_CANDIDATES, ALLOWED_COUNTS, hamming, prefilter, localQuality, median,
  normalizeWeights, totalScore, chooseSet, capCandidates, allowedCount, gridColumns, applyLayoutRules, defaultOrder, conflicts };
