'use strict';
// 各步骤发给 AI 的提示词和结果解析。所有输出都要求 JSON，解析后再按规则校验。
const { CRITERIA, CATEGORIES } = require('./select');
const Grade = require('./grade');
const { cardText, normalizeCard } = require('./caption');

const SYSTEM = '你是"朋友圈助手"，帮用户挑照片、调色、排版、写朋友圈文案。只输出要求的 JSON，不要输出其他文字。';
const pref = summary => summary ? `\n\n用户偏好（来自本机记忆，供参考）：${summary}` : '';
const clampScore = v => { const n = Number(v); return isFinite(n) ? Math.max(1, Math.min(10, Math.round(n * 10) / 10)) : null; };

// ── 挑照片：分项打分 ──
function scorePrompt(n, summary) {
  const items = CRITERIA.map(c => `- ${c.key}（${c.name}）：${c.desc}`).join('\n');
  return `下面有 ${n} 张照片，按顺序编号 1–${n}。请逐张按以下 5 项打分（1–10 分），每项附一句中文理由（不超过 20 字）：
${items}

评分标准（每一项都照这个尺度）：
- 3 分：明显有问题（例如主体被切、画面杂乱、闭眼、颜色灰暗无氛围），一般不会发出去；
- 6 分：合格的普通照片，没大问题但也不出彩；
- 9 分：让人眼前一亮，可以做封面。
请拉开分差，不要所有照片都打 7–8 分；同一组里最好和最差的照片至少差 3 分。
没有人物时 people 填 null。category 从 ${Object.keys(CATEGORIES).join(' / ')} 里选一个（人像/风景/美食/细节/其他）。${pref(summary)}

只输出 JSON：
{"photos":[{"index":1,"scores":{"composition":7,"subject":6,"people":null,"color":8,"aesthetic":7},"reasons":{"composition":"…","subject":"…","people":"","color":"…","aesthetic":"…"},"hasPeople":false,"category":"landscape","comment":"一句话总评"}]}`;
}
function parseScores(json, n) {
  const out = new Array(n).fill(null);
  for (const p of (json && json.photos) || []) {
    const i = Number(p.index) - 1;
    if (!(i >= 0 && i < n)) continue;
    const scores = {};
    for (const c of CRITERIA) scores[c.key] = clampScore(p.scores && p.scores[c.key]);
    const hasPeople = !!p.hasPeople && scores.people != null;
    if (!hasPeople) scores.people = null;
    const reasons = {};
    for (const c of CRITERIA) reasons[c.key] = String((p.reasons && p.reasons[c.key]) || '').slice(0, 40);
    out[i] = { scores, reasons, hasPeople, category: CATEGORIES[p.category] ? p.category : 'other', comment: String(p.comment || '').slice(0, 60) };
  }
  return out;
}

// ── 调色：一句话 / 参考图校正 ──
const PARAM_DOC = `调色参数（JSON，缺省为 0）：exposure 曝光(-2~2 EV)、contrast 对比度、highlights 高光、shadows 阴影、whites 白色、blacks 黑色、temperature 色温(正=暖)、tint 色调(正=偏洋红)、saturation 饱和度、vibrance 自然饱和度（以上 -100~100）、grain 颗粒、vignette 暗角、sharpen 锐化（0~100）、hsl.{red,orange,yellow,green,aqua,blue,purple,magenta}.{h,s,l}（-100~100）、split.{highlightHue,shadowHue}（0~360 色相）与 split.{highlightSat,shadowSat}（0~100）、split.balance（-100~100）。`;
function gradePrompt(current, instruction, summary) {
  return `用户想调整照片的颜色。附图是当前要调的照片缩略图（未调色的原图）。
${PARAM_DOC}
当前参数：${JSON.stringify(Grade.normalize(current))}
用户这次说："${instruction}"
请在当前参数的基础上修改（"再暖一点"表示在当前色温上继续加），只调颜色和明暗，不改变画面内容。${pref(summary)}
只输出 JSON：{"params":{…完整参数…},"explain":"一句话说明改了什么"}`;
}
function referencePrompt(localParams, summary) {
  return `第 1 张是用户喜欢的参考图（别人发的照片截图，已被平台压缩），后面是用户自己的照片。
本地颜色迁移算出的初始参数：${JSON.stringify(localParams)}
${PARAM_DOC}
请分析参考图的风格（例如"低饱和、阴影偏青、高光偏暖、有颗粒"），并校正初始参数，让用户的照片风格接近参考图。不要追求像素一致，只要风格接近；只调颜色和明暗。${pref(summary)}
只输出 JSON：{"style":"风格描述（20 字以内）","params":{…完整参数…}}`;
}
function parseGrade(json) {
  if (!json || typeof json.params !== 'object') throw new Error('AI 没有返回调色参数');
  return { params: Grade.normalize(json.params), explain: String(json.explain || json.style || '').slice(0, 80), style: String(json.style || '').slice(0, 40) };
}

// ── 排版 ──
function layoutPrompt(n, occasion, summary) {
  return `下面 ${n} 张照片是用户准备发朋友圈的候选，按顺序编号 1–${n}。请决定：
1. 发几张：只能是 1 / 3 / 4 / 6 / 9 张（不超过 ${n}）；
2. 封面（第 1 张）：最吸引人的一张；
3. 顺序：颜色、远近景、人物和风景交替，照片之间要有起伏或时间线；同一场景的照片不要挨着。
朋友圈的展示方式：4 张时是 2×2，其余每行 3 张；9 张时正中间（第 5 张）是第二显眼的位置。
另外请按"吸引人程度"给全部照片排个序（rank）。${occasion ? `\n场合：${occasion}` : ''}${pref(summary)}
只输出 JSON：{"count":9,"order":[3,1,…],"rank":[3,5,…],"reasons":["为什么发这么多张","为什么选这张做封面","顺序的思路"]}`;
}
function parseLayout(json, n) {
  const idx = arr => (Array.isArray(arr) ? arr : []).map(Number).filter(i => i >= 1 && i <= n).map(i => i - 1);
  return { count: Number(json && json.count) || null, order: [...new Set(idx(json && json.order))], rank: [...new Set(idx(json && json.rank))],
    reasons: ((json && json.reasons) || []).map(r => String(r).slice(0, 80)).slice(0, 5) };
}

// ── 文案 ──
function captionPrompt({ occasion, styleName, card, refText, summary, avoid }) {
  return `请根据附图为这条朋友圈写 4 条不同的文案。
场合：${occasion || '（用户没说）'}
风格：${styleName || '自定'}${card ? `\n风格卡：${cardText(card)}` : ''}${refText ? `\n用户喜欢的参考文案（只模仿它的风格，绝对不要照搬句子，不能有连续 8 个字以上相同）：\n「${refText}」` : ''}
要求：
- 不编造照片里看不出、用户也没说的事实（地点、人名、事件）；
- 每条在风格卡的字数范围内，可以有换行；${avoid ? `\n- 上次生成的这些和参考文案太像了，不要再这样写：${avoid.join(' / ')}` : ''}${pref(summary)}
只输出 JSON：{"captions":["…","…","…","…"]}`;
}
function parseCaptions(json) {
  return ((json && json.captions) || []).map(c => String(c).trim()).filter(Boolean).slice(0, 5);
}
function stylePrompt(refText) {
  return `分析下面这段朋友圈文案的写作风格，整理成一张"风格卡"。只描述风格，不要复述内容。
文案：「${refText}」
只输出 JSON：{"name":"给这个风格起个 2–6 字的名字","length":[最少字数,最多字数],"lineBreaks":"断句和换行习惯","tone":"语气","emoji":"表情符号用法","punctuation":"标点用法","memes":"是否用梗","ending":"结尾习惯","hashtags":"是否带话题标签"}`;
}
function parseStyle(json) { return { name: String((json && json.name) || '我的风格').slice(0, 12), card: normalizeCard(json) }; }

// ── 冷启动：分析以前的朋友圈截图 ──
function screenshotPrompt(n) {
  return `这是用户以前发的 ${n} 张朋友圈截图。请总结用户的偏好：喜欢的色调、通常发几张、偏爱的内容（人像/风景/美食…）、文案长短和风格。
只输出 JSON：{"prefs":"不超过 100 字的偏好总结","tone":"色调","length":"文案长短","content":"常发内容"}`;
}

module.exports = { SYSTEM, scorePrompt, parseScores, gradePrompt, referencePrompt, parseGrade, layoutPrompt, parseLayout,
  captionPrompt, parseCaptions, stylePrompt, parseStyle, screenshotPrompt };
