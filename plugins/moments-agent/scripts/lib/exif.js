'use strict';
// 图片格式识别 + JPEG EXIF 读取（拍摄时间、方向、是否带定位）+ 导出时回填 EXIF。
// 纯 Node，不依赖第三方库。

function detectFormat(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf.length < 12) return null;
  if (buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12).toLowerCase();
    if (/^(heic|heix|heif|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
    if (/^avi[fs]$/.test(brand)) return 'avif';
  }
  return null;
}
// Chromium 能直接解码的格式（界面用 canvas 处理照片）
const DECODABLE = new Set(['jpeg', 'png', 'webp', 'gif', 'avif']);
const EXT = { jpeg: '.jpg', png: '.png', webp: '.webp', gif: '.gif', heic: '.heic', avif: '.avif' };

/** 找到 JPEG 里的 Exif APP1 段：返回 { start, end, tiff }（start 指向 0xFF 标记） */
function findExifSegment(buf) {
  if (detectFormat(buf) !== 'jpeg') return null;
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xFF) return null;
    const marker = buf[p + 1];
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { p += 2; continue; }
    if (marker === 0xDA || marker === 0xD9) return null; // 图像数据开始，后面不会再有 EXIF
    const len = buf.readUInt16BE(p + 2);
    if (marker === 0xE1 && buf.toString('ascii', p + 4, p + 10) === 'Exif\0\0') {
      return { start: p, end: p + 2 + len, tiff: p + 10 };
    }
    p += 2 + len;
  }
  return null;
}

function tiffReader(buf, tiff) {
  const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
  const u16 = o => le ? buf.readUInt16LE(tiff + o) : buf.readUInt16BE(tiff + o);
  const u32 = o => le ? buf.readUInt32LE(tiff + o) : buf.readUInt32BE(tiff + o);
  const w16 = (o, v) => le ? buf.writeUInt16LE(v, tiff + o) : buf.writeUInt16BE(v, tiff + o);
  function entries(ifd) {
    const out = [];
    if (!ifd || tiff + ifd + 2 > buf.length) return out;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (tiff + e + 12 > buf.length) break;
      out.push({ tag: u16(e), type: u16(e + 2), count: u32(e + 4), valueOffset: e + 8 });
    }
    return out;
  }
  return { u16, u32, w16, entries, le };
}

/** 读 EXIF：{ orientation, takenAt(ISO 字符串或 null), hasGps } */
function readExif(buf) {
  const info = { orientation: 1, takenAt: null, hasGps: false };
  const seg = findExifSegment(buf);
  if (!seg) return info;
  try {
    const r = tiffReader(buf, seg.tiff);
    const ifd0 = r.u32(4);
    let exifIfd = 0;
    for (const e of r.entries(ifd0)) {
      if (e.tag === 0x0112) info.orientation = r.u16(e.valueOffset) || 1;
      if (e.tag === 0x8769) exifIfd = r.u32(e.valueOffset);
      if (e.tag === 0x8825) info.hasGps = r.u32(e.valueOffset) > 0;
      if (e.tag === 0x0132 && !info.takenAt) info.takenAt = asciiDate(buf, seg.tiff, r, e);
    }
    for (const e of r.entries(exifIfd)) {
      if (e.tag === 0x9003) { const d = asciiDate(buf, seg.tiff, r, e); if (d) info.takenAt = d; }
    }
  } catch (_) { /* 损坏的 EXIF：按没有处理 */ }
  return info;
}
function asciiDate(buf, tiff, r, e) {
  const off = e.count > 4 ? r.u32(e.valueOffset) : e.valueOffset;
  const s = buf.toString('ascii', tiff + off, tiff + off + Math.min(e.count, 19));
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m || m[1] === '0000') return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

/**
 * 把原图的 EXIF 段放进新生成的 JPEG（界面用 canvas 导出的 JPEG 不含 EXIF）。
 * 方向改成 1（像素已经按方向转正了），避免看图软件再转一次。
 */
function injectExif(target, original) {
  const seg = findExifSegment(original);
  if (!seg || detectFormat(target) !== 'jpeg') return target;
  const app1 = Buffer.from(original.slice(seg.start, seg.end));
  try {
    const r = tiffReader(app1, 10);
    for (const e of r.entries(r.u32(4))) if (e.tag === 0x0112) r.w16(e.valueOffset, 1);
  } catch (_) { /* 改不了方向就原样放 */ }
  const old = findExifSegment(target);
  const body = old ? Buffer.concat([target.slice(0, old.start), target.slice(old.end)]) : target;
  return Buffer.concat([body.slice(0, 2), app1, body.slice(2)]);
}

module.exports = { detectFormat, DECODABLE, EXT, readExif, injectExif, findExifSegment };
