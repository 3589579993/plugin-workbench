'use strict';
// 文案：内置风格、风格卡、"不照搬原文"检查、没配 AI 时的离线模板。

const BUILTIN_STYLES = [
  { id: 'short', name: '简短', card: { length: [4, 20], lineBreaks: '一行', tone: '平实', emoji: '不用或只用 1 个', punctuation: '少用标点', memes: '不用', ending: '直接结束', hashtags: '不带' } },
  { id: 'literary', name: '文艺', card: { length: [15, 50], lineBreaks: '可以分两行', tone: '文艺、有画面感', emoji: '不用', punctuation: '用逗号和句号', memes: '不用', ending: '留白、意境', hashtags: '不带' } },
  { id: 'funny', name: '幽默', card: { length: [8, 40], lineBreaks: '一到两行', tone: '自嘲、轻松', emoji: '可以用 1–2 个', punctuation: '可以用感叹号', memes: '可以适度用网络梗', ending: '反转或吐槽', hashtags: '不带' } },
  { id: 'lowkey', name: '低调', card: { length: [2, 12], lineBreaks: '一行', tone: '低调，不想被领导看出在玩，不写地点和活动', emoji: '不用', punctuation: '几乎不用', memes: '不用', ending: '含糊', hashtags: '不带' } },
  { id: 'diary', name: '日记体', card: { length: [30, 90], lineBreaks: '可以分段', tone: '像写给自己的日记，真诚', emoji: '少量', punctuation: '正常', memes: '不用', ending: '一句感受', hashtags: '不带' } }
];
const CARD_FIELDS = { length: '字数范围', lineBreaks: '断句和换行', tone: '语气', emoji: '表情符号', punctuation: '标点用法', memes: '是否用梗', ending: '结尾习惯', hashtags: '话题标签' };

function cardText(card) {
  if (!card) return '';
  return Object.entries(CARD_FIELDS).filter(([k]) => card[k] != null && card[k] !== '')
    .map(([k, n]) => `${n}：${Array.isArray(card[k]) ? card[k].join('–') + ' 字' : card[k]}`).join('；');
}
function normalizeCard(c) {
  const out = {};
  for (const k of Object.keys(CARD_FIELDS)) {
    if (k === 'length') {
      const v = Array.isArray(c && c.length) ? c.length.map(Number).filter(isFinite) : [];
      out.length = v.length === 2 ? [Math.max(1, Math.min(v[0], v[1])), Math.min(500, Math.max(v[0], v[1]))] : [8, 40];
    } else out[k] = String((c && c[k]) || '').slice(0, 60);
  }
  return out;
}

const strip = s => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
/** 两段文字最长的连续相同片段长度（忽略空白、标点、表情） */
function longestCommon(a, b) {
  const x = [...strip(a)], y = [...strip(b)];
  if (!x.length || !y.length) return 0;
  let best = 0, prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) if (x[i - 1] === y[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}
const COPY_LIMIT = 8;
/** 是否照搬了参考文案：连续 8 个字以上相同 */
function copiesReference(text, ref) { return !!ref && longestCommon(text, ref) >= COPY_LIMIT; }

/** 没配 AI 时的离线模板：只用用户写的场合，不编造照片里看不出的事实 */
function offlineCaptions(occasion, styleId) {
  const o = String(occasion || '').trim();
  const T = {
    short: [o || '今日份记录', o ? `${o}，很开心` : '好天气', '存一下'],
    literary: [o ? `${o}，把这一刻留给以后的自己。` : '把这一刻留给以后的自己。', '风很轻，日子很慢。', o ? `关于${o}的一些碎片。` : '一些碎片，一些光。'],
    funny: [o ? `${o}：照片九张，快乐无数` : '照片九张，快乐无数', '营业一下，证明我还活着', '本人已阅，状态良好'],
    lowkey: ['.', '最近', '嗯'],
    diary: [o ? `今天${o}。没什么特别的大事，但想把这些画面记下来，以后翻到会笑吧。` : '没什么特别的大事，但想把这些画面记下来，以后翻到会笑吧。', o ? `记录：${o}。累，但值得。` : '记录一下这几天。累，但值得。', '有些日子，值得被认真保存。']
  };
  return T[styleId] || T.short;
}

module.exports = { BUILTIN_STYLES, CARD_FIELDS, cardText, normalizeCard, longestCommon, copiesReference, COPY_LIMIT, offlineCaptions };
