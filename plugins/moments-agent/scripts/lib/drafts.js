'use strict';
// 草稿：一次发朋友圈 = 一份草稿，存在 <数据目录>/drafts/<yyyyMMdd-HHmmss>/。
//   draft.json   每一步的结果和当前进度
//   photos/      收到的原图（永远不改）
//   thumbs/      界面生成的缩略图（长边 1024，发给 AI 用的也是它）
//   reference.jpg 复刻滤镜的参考图（框选后的区域）
//   发布包/       导出结果
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectFormat, readExif, EXT, DECODABLE } = require('./exif');
const Grade = require('./grade');

const KEEP_DAYS = 30;
const STEPS = ['import', 'pick', 'grade', 'layout', 'caption', 'export'];
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i;
const MAX_PHOTO_BYTES = 30 * 1024 * 1024;

const pad = n => String(n).padStart(2, '0');
function stamp(d = new Date()) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }

function emptyDraft(id) {
  return {
    id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), step: 'import', aiCalls: 0,
    photos: [],
    pick: { candidates: [], selected: [], alternates: [], reasons: {}, flags: {}, count: null, weights: null, initial: [], swaps: [], usedAi: false, done: false },
    grade: { params: Grade.defaults(), preset: null, presetName: '', history: [], request: null, reference: null, explain: '', stale: false },
    layout: { form: 'multi', template: 'grid2x2', order: [], count: 0, reasons: [], suggested: [], drags: 0, stale: false },
    caption: { occasion: '', styleId: 'short', styleCard: null, refText: '', options: [], chosen: null, text: '', original: '', stale: false },
    export: { stripGps: true, files: [], done: false, at: null }
  };
}

function createDrafts(dataDir) {
  const root = path.join(dataDir, 'drafts');
  const dirOf = id => {
    if (!/^\d{8}-\d{6}(-\d+)?$/.test(String(id))) throw new Error('无效的草稿编号');
    return path.join(root, id);
  };
  function create() {
    fs.mkdirSync(root, { recursive: true });
    let id = stamp(), k = 1;
    while (fs.existsSync(path.join(root, id))) id = stamp() + '-' + (k++);
    fs.mkdirSync(path.join(root, id, 'photos'), { recursive: true });
    const d = emptyDraft(id);
    save(d);
    return d;
  }
  function load(id) {
    const d = JSON.parse(fs.readFileSync(path.join(dirOf(id), 'draft.json'), 'utf8'));
    const base = emptyDraft(id);
    for (const k of ['pick', 'grade', 'layout', 'caption', 'export']) d[k] = { ...base[k], ...(d[k] || {}) };
    return d;
  }
  function save(d) {
    d.updatedAt = new Date().toISOString();
    const f = path.join(dirOf(d.id), 'draft.json'), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  }
  function size(dir) {
    let n = 0;
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size; } catch (_) {}
    return n;
  }
  function list() {
    let ids = [];
    try { ids = fs.readdirSync(root).filter(x => /^\d{8}-\d{6}(-\d+)?$/.test(x)); } catch (_) {}
    return ids.map(id => {
      try {
        const d = load(id);
        const age = (Date.now() - Date.parse(d.updatedAt)) / 86400000;
        return { id, createdAt: d.createdAt, updatedAt: d.updatedAt, step: d.step, photos: d.photos.length, exported: d.export.done, bytes: size(dirOf(id)), expired: age > KEEP_DAYS };
      } catch (_) { return { id, broken: true, bytes: size(path.join(root, id)), expired: true }; }
    }).sort((a, b) => b.id.localeCompare(a.id));
  }
  function remove(id) { fs.rmSync(dirOf(id), { recursive: true, force: true }); }

  /** 收下一张照片：校验格式和大小，读 EXIF，复制进 photos/。返回照片记录 */
  function addPhoto(d, buf, originalName, source) {
    if (buf.length > MAX_PHOTO_BYTES) throw new Error('单张照片不能超过 30 MB');
    const format = detectFormat(buf);
    if (!format) throw new Error('不是图片文件');
    const id = 'p' + crypto.randomBytes(5).toString('hex');
    const file = id + EXT[format];
    fs.mkdirSync(path.join(dirOf(d.id), 'photos'), { recursive: true });
    fs.writeFileSync(path.join(dirOf(d.id), 'photos', file), buf);
    const exif = format === 'jpeg' ? readExif(buf) : { orientation: 1, takenAt: null, hasGps: false };
    const photo = {
      id, file, name: String(originalName || file).replace(/[\\/]/g, '_').slice(0, 120), format, size: buf.length, source,
      order: d.photos.length, takenAt: exif.takenAt, hasGps: exif.hasGps, receivedAt: new Date().toISOString(),
      unsupported: !DECODABLE.has(format), metrics: null, thumb: false, ai: null, manual: null
    };
    d.photos.push(photo);
    return photo;
  }
  /** 按拍摄时间排序，没有拍摄时间的按收到的顺序排在后面 */
  function sortPhotos(d) {
    d.photos.sort((a, b) => {
      if (a.takenAt && b.takenAt) return a.takenAt.localeCompare(b.takenAt) || a.order - b.order;
      if (a.takenAt) return -1; if (b.takenAt) return 1;
      return a.order - b.order;
    });
  }
  /** 回退后，后面的结果标为"需要重新生成" */
  function markStale(d, fromStep) {
    const i = STEPS.indexOf(fromStep);
    if (i <= STEPS.indexOf('pick')) { d.layout.stale = d.layout.order.length > 0; d.caption.stale = d.caption.options.length > 0; }
    if (i <= STEPS.indexOf('grade')) d.export.done = false;
    if (i <= STEPS.indexOf('layout')) d.export.done = false;
  }
  return { root, dirOf, create, load, save, list, remove, addPhoto, sortPhotos, markStale, size };
}

module.exports = { createDrafts, emptyDraft, STEPS, IMAGE_EXT, MAX_PHOTO_BYTES, KEEP_DAYS, stamp };
