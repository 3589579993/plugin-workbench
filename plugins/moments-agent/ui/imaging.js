// 界面里的图片处理：浏览器自带解码、缩放和 JPEG 编码，像素运算用查找表（见 scripts/lib/grade.js）。
// 对应需求文档的 H4（图片处理）：缩放、清晰度、曝光、感知哈希、调色、切图、拼图。
'use strict';
const Imaging = (() => {
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';           // 引擎返回 CORS 头，canvas 才能读像素
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片无法解码'));
      img.src = url;
    });
  }
  function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  /** 等比缩放到长边不超过 maxEdge（EXIF 方向由浏览器自动转正） */
  function drawScaled(img, maxEdge) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const k = Math.min(1, maxEdge / Math.max(w, h));
    const c = canvasOf(w * k, h * k), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  /** 从图片中按"铺满"方式裁出 w×h（居中） */
  function drawCover(g, img, x, y, w, h) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const k = Math.max(w / iw, h / ih), sw = w / k, sh = h / k;
    g.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  }
  function toJpeg(canvas, q = 0.9) {
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('JPEG 编码失败')), 'image/jpeg', q));
  }

  /** 预筛指标：清晰度（拉普拉斯方差）、过暗/过曝占比、平均亮度、64 位差值哈希 */
  function metrics(img) {
    const c = drawScaled(img, 512), w = c.width, h = c.height;
    const d = c.getContext('2d').getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    let sum = 0, dark = 0, bright = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      gray[j] = v; sum += v; sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
      if (v < 20) dark++; else if (v > 240) bright++;
    }
    let n = 0, m = 0, m2 = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      n++; m += lap; m2 += lap * lap;
    }
    const mean = m / Math.max(1, n);
    // 差值哈希：9×8 灰度，比较左右相邻
    const hc = canvasOf(9, 8), hg = hc.getContext('2d');
    hg.drawImage(c, 0, 0, 9, 8);
    const hd = hg.getImageData(0, 0, 9, 8).data;
    let bits = '';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const a = y * 9 + x, b = a + 1;
      const ga = hd[a * 4] * 0.299 + hd[a * 4 + 1] * 0.587 + hd[a * 4 + 2] * 0.114, gb = hd[b * 4] * 0.299 + hd[b * 4 + 1] * 0.587 + hd[b * 4 + 2] * 0.114;
      bits += ga > gb ? '1' : '0';
    }
    let hash = '';
    for (let i = 0; i < 64; i += 4) hash += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return { sharp: Math.round((m2 / Math.max(1, n) - mean * mean) * 10) / 10, dark: dark / gray.length, bright: bright / gray.length,
      mean: sum / gray.length, hash, rgb: [sr, sg, sb].map(v => Math.round(v / gray.length)), w: img.naturalWidth, h: img.naturalHeight };
  }

  const lutCache = { key: '', table: null };
  function lutFor(params) {
    const key = JSON.stringify(params);
    if (lutCache.key !== key) { lutCache.key = key; lutCache.table = Grade.buildLut(params, 33); }
    return lutCache.table;
  }
  /** 对 canvas 原地调色：颜色查找表 + 暗角 + 颗粒 + 锐化 */
  function applyGrade(canvas, params, opts = {}) {
    const p = Grade.normalize(params);
    if (Grade.isNeutral(p)) return canvas;
    const g = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    const im = g.getImageData(0, 0, w, h), d = im.data;
    Grade.applyLut(d, lutFor(p));
    const scale = Math.max(w, h) / 1024;
    if (p.sharpen) sharpen(d, w, h, p.sharpen / 100 * 0.8);
    if (p.vignette || p.grain) {
      const cx = w / 2, cy = h / 2, rmax = Math.sqrt(cx * cx + cy * cy), vig = p.vignette / 100 * 0.55, gr = p.grain / 100 * 28;
      let seed = opts.seed || 12345;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const cell = Math.max(1, Math.round(scale));   // 颗粒大小随分辨率放大，预览和导出观感一致
      let noise = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let f = 1;
        if (vig) { const r = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / rmax; f = 1 - vig * Math.pow(r, 2.2); }
        if (gr && (x % cell === 0)) noise = (rnd() - 0.5) * gr;
        const add = gr ? noise : 0;
        d[i] = d[i] * f + add; d[i + 1] = d[i + 1] * f + add; d[i + 2] = d[i + 2] * f + add;
      }
    }
    g.putImageData(im, 0, 0);
    return canvas;
  }
  function sharpen(d, w, h, amount) {
    const src = new Uint8ClampedArray(d);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const k = i + c;
        const blur = (src[k - 4] + src[k + 4] + src[k - w * 4] + src[k + w * 4]) / 4;
        d[k] = src[k] + (src[k] - blur) * amount;
      }
    }
  }
  /** 颜色统计（可只统计一个矩形区域，例如参考图上框选的部分） */
  function statsOf(canvas, rect) {
    const r = rect || { x: 0, y: 0, w: canvas.width, h: canvas.height };
    const d = canvas.getContext('2d').getImageData(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h))).data;
    return Grade.colorStats(d, Math.max(1, Math.floor(d.length / 4 / 60000)));
  }

  // ── 导出：普通多图 / 九宫格切图 / 拼图 ──
  const MAX_EXPORT_EDGE = 4096;
  async function renderSingle(url, params, seed) {
    const img = await loadImage(url);
    return applyGrade(drawScaled(img, MAX_EXPORT_EDGE), params, { seed });
  }
  /** 一张图裁成正方形，切成 3×3 共 9 张 */
  async function renderGrid9(url, params) {
    const img = await loadImage(url);
    const edge = Math.min(3600, Math.min(img.naturalWidth, img.naturalHeight));
    const sq = canvasOf(edge, edge);
    drawCover(sq.getContext('2d'), img, 0, 0, edge, edge);
    applyGrade(sq, params, { seed: 7 });
    const t = Math.floor(edge / 3), tiles = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const tile = canvasOf(t, t);
      tile.getContext('2d').drawImage(sq, c * t, r * t, t, t, 0, 0, t, t);
      tiles.push(tile);
    }
    return tiles;
  }
  const TEMPLATES = {
    grid2x2: { name: '田字格（4 张）', n: 4, cells: [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]] },
    bigLeft: { name: '左大右小（3 张）', n: 3, cells: [[0, 0, .62, 1], [.62, 0, .38, .5], [.62, .5, .38, .5]] },
    strip3: { name: '三联竖条（3 张）', n: 3, cells: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
    topBig: { name: '上大下三（4 张）', n: 4, cells: [[0, 0, 1, .6], [0, .6, 1 / 3, .4], [1 / 3, .6, 1 / 3, .4], [2 / 3, .6, 1 / 3, .4]] }
  };
  async function renderCollage(urls, template, params, size = 2048, gap = 8) {
    const t = TEMPLATES[template] || TEMPLATES.grid2x2;
    const c = canvasOf(size, size), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
    for (let i = 0; i < t.cells.length && i < urls.length; i++) {
      const img = await loadImage(urls[i]);
      const [x, y, w, h] = t.cells[i];
      drawCover(g, img, x * size + gap / 2, y * size + gap / 2, w * size - gap, h * size - gap);
    }
    return applyGrade(c, params, { seed: 9 });
  }

  return { loadImage, canvasOf, drawScaled, drawCover, toJpeg, metrics, applyGrade, statsOf, renderSingle, renderGrid9, renderCollage, TEMPLATES };
})();
