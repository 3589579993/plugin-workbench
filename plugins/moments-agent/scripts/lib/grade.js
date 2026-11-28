// 调色参数、内置预设、一句话调色（离线规则）、参考图颜色迁移、颜色查找表（LUT）。
// UMD：引擎（Node）和自带界面（浏览器，<script src="../scripts/lib/grade.js">）共用同一份代码。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Grade = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
  const BAND_HUE = { red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 240, purple: 280, magenta: 320 };
  const BAND_LABEL = { red: '红', orange: '橙', yellow: '黄', green: '绿', aqua: '青', blue: '蓝', purple: '紫', magenta: '洋红' };
  // 每个参数的范围（AI 输出、用户输入都会被夹到这个范围里）
  const RANGE = {
    exposure: [-2, 2], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100],
    whites: [-100, 100], blacks: [-100, 100], temperature: [-100, 100], tint: [-100, 100],
    saturation: [-100, 100], vibrance: [-100, 100], grain: [0, 100], vignette: [0, 100], sharpen: [0, 100]
  };
  const LABEL = {
    exposure: '曝光', contrast: '对比度', highlights: '高光', shadows: '阴影', whites: '白色', blacks: '黑色',
    temperature: '色温', tint: '色调', saturation: '饱和度', vibrance: '自然饱和度', grain: '颗粒', vignette: '暗角', sharpen: '锐化'
  };

  function defaults() {
    const p = {};
    for (const k of Object.keys(RANGE)) p[k] = 0;
    p.hsl = {};
    for (const b of BANDS) p.hsl[b] = { h: 0, s: 0, l: 0 };
    p.split = { highlightHue: 40, highlightSat: 0, shadowHue: 200, shadowSat: 0, balance: 0 };
    return p;
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, d = 0) => (typeof v === 'number' && isFinite(v)) ? v : (typeof v === 'string' && v.trim() && isFinite(+v) ? +v : d);
  const round = (v, step) => Math.round(v / step) * step;

  /** 把任意对象整理成合法的调色参数（缺的补 0，超范围的夹住） */
  function normalize(input) {
    const src = input || {}, p = defaults();
    for (const [k, [lo, hi]] of Object.entries(RANGE)) p[k] = round(clamp(num(src[k]), lo, hi), k === 'exposure' ? 0.05 : 1);
    for (const b of BANDS) {
      const s = (src.hsl && src.hsl[b]) || {};
      p.hsl[b] = { h: round(clamp(num(s.h), -100, 100), 1), s: round(clamp(num(s.s), -100, 100), 1), l: round(clamp(num(s.l), -100, 100), 1) };
    }
    const sp = src.split || {};
    p.split = {
      highlightHue: ((round(num(sp.highlightHue, 40), 1) % 360) + 360) % 360, highlightSat: round(clamp(num(sp.highlightSat), 0, 100), 1),
      shadowHue: ((round(num(sp.shadowHue, 200), 1) % 360) + 360) % 360, shadowSat: round(clamp(num(sp.shadowSat), 0, 100), 1),
      balance: round(clamp(num(sp.balance), -100, 100), 1)
    };
    return p;
  }
  /** 在 base 上叠加修改（patch 里写了的字段覆盖） */
  function merge(base, patch) {
    const b = normalize(base), p = patch || {}, out = JSON.parse(JSON.stringify(b));
    for (const k of Object.keys(RANGE)) if (p[k] !== undefined) out[k] = p[k];
    for (const band of BANDS) if (p.hsl && p.hsl[band]) Object.assign(out.hsl[band], p.hsl[band]);
    if (p.split) Object.assign(out.split, p.split);
    return normalize(out);
  }
  /** 把参数增量加到 base 上 */
  function addDelta(base, delta) {
    const out = normalize(base), d = delta || {};
    for (const k of Object.keys(RANGE)) if (d[k]) out[k] += d[k];
    for (const band of BANDS) if (d.hsl && d.hsl[band]) for (const c of ['h', 's', 'l']) out.hsl[band][c] += d.hsl[band][c] || 0;
    if (d.split) for (const [k, v] of Object.entries(d.split)) out.split[k] = /Hue$/.test(k) ? v : out.split[k] + v;
    return normalize(out);
  }
  function isNeutral(p) { return JSON.stringify(normalize(p)) === JSON.stringify(defaults()); }
  /** 参数的人话描述（只列非零项），用于界面和记忆 */
  function describe(params) {
    const p = normalize(params), parts = [];
    for (const k of Object.keys(RANGE)) if (p[k]) parts.push(`${LABEL[k]}${p[k] > 0 ? '+' : ''}${p[k]}`);
    for (const b of BANDS) for (const [c, n] of [['h', '色相'], ['s', '饱和'], ['l', '明度']]) if (p.hsl[b][c]) parts.push(`${BAND_LABEL[b]}${n}${p.hsl[b][c] > 0 ? '+' : ''}${p.hsl[b][c]}`);
    if (p.split.highlightSat) parts.push(`高光染色 ${p.split.highlightHue}°/${p.split.highlightSat}`);
    if (p.split.shadowSat) parts.push(`阴影染色 ${p.split.shadowHue}°/${p.split.shadowSat}`);
    return parts.length ? parts.join('，') : '原图（未调整）';
  }

  // ── 内置预设 ───────────────────────────────────────────────
  const PRESETS = [
    { id: 'auto', name: '自动增强', auto: true, params: { contrast: 8, vibrance: 15, sharpen: 15 } },
    { id: 'fresh', name: '清新', params: { exposure: 0.2, contrast: -10, highlights: -20, shadows: 20, temperature: -10, saturation: -5, vibrance: 15, hsl: { green: { h: 0, s: -10, l: 10 }, blue: { h: 0, s: 10, l: 0 } } } },
    { id: 'japanese', name: '日系通透', params: { exposure: 0.35, contrast: -20, highlights: -30, shadows: 30, blacks: 15, temperature: -8, tint: 5, saturation: -15, vibrance: 10, hsl: { orange: { h: 0, s: -10, l: 10 }, green: { h: 10, s: -25, l: 0 }, blue: { h: 0, s: -15, l: 10 } } } },
    { id: 'film', name: '胶片', params: { contrast: 10, blacks: 20, whites: -10, saturation: -10, temperature: 8, grain: 30, vignette: 20, split: { highlightHue: 40, highlightSat: 15, shadowHue: 190, shadowSat: 15, balance: 0 } } },
    { id: 'warm', name: '暖调', params: { exposure: 0.1, temperature: 30, tint: 5, vibrance: 10, split: { highlightHue: 35, highlightSat: 10, shadowHue: 200, shadowSat: 0, balance: 0 } } },
    { id: 'bw', name: '黑白', params: { saturation: -100, contrast: 20, grain: 10 } }
  ];
  /** 取预设参数。自动增强按照片的平均亮度算曝光（metrics.mean：0–255） */
  function presetParams(id, avgMean) {
    const pr = PRESETS.find(p => p.id === id);
    if (!pr) return null;
    const p = normalize(pr.params);
    if (pr.auto && typeof avgMean === 'number') {
      p.exposure = round(clamp((118 - avgMean) / 70, -1, 1), 0.05);
      if (avgMean > 150) p.highlights = -20;
      if (avgMean < 90) p.shadows = 25;
    }
    return p;
  }

  // ── 一句话调色（没配 AI 时的离线规则；配了 AI 时由 AI 输出参数）──
  const RULES = [
    { re: /暖|黄一点|偏黄|橙调/, d: { temperature: 12 }, say: '更暖', neg: { temperature: -12 } },
    { re: /黄/, d: { temperature: 10 }, say: '更黄', neg: { temperature: -12 } },
    { re: /冷|冷色|蓝调|青调|偏蓝/, d: { temperature: -12 }, say: '更冷', neg: { temperature: 10 } },
    { re: /通透|清透/, d: { exposure: 0.15, contrast: -10, highlights: -15, shadows: 15, blacks: 5 }, say: '更通透' },
    { re: /亮|明亮|提亮|曝光/, d: { exposure: 0.25 }, say: '更亮', neg: { exposure: -0.25 } },
    { re: /暗|压暗|低调/, d: { exposure: -0.25 }, say: '更暗', neg: { exposure: 0.2 } },
    { re: /对比|反差|立体/, d: { contrast: 15 }, say: '对比更强', neg: { contrast: -12 } },
    { re: /柔和|灰一点|雾|朦胧/, d: { contrast: -12, highlights: -10 }, say: '更柔和' },
    { re: /鲜艳|饱和|浓郁|艳/, d: { saturation: 15 }, say: '更鲜艳', neg: { saturation: -15 } },
    { re: /淡一点|低饱和|素|高级灰|莫兰迪/, d: { saturation: -15 }, say: '更淡', neg: { saturation: 12 } },
    { re: /黑白|单色/, d: { saturation: -100 }, say: '黑白' },
    { re: /胶片|复古/, d: { grain: 20, blacks: 10, split: { highlightHue: 40, highlightSat: 10, shadowHue: 190, shadowSat: 10 } }, say: '胶片感' },
    { re: /颗粒/, d: { grain: 20 }, say: '加颗粒', neg: { grain: -20 } },
    { re: /暗角/, d: { vignette: 20 }, say: '加暗角', neg: { vignette: -20 } },
    { re: /天空|蓝天|海/, d: { hsl: { blue: { h: 0, s: 20, l: -5 }, aqua: { h: 0, s: 10, l: 0 } } }, say: '天空/海更蓝' },
    { re: /绿|树|草|植物/, d: { hsl: { green: { h: 0, s: 15, l: 0 } } }, say: '绿色更浓', neg: { hsl: { green: { h: 0, s: -15, l: 0 } } } },
    { re: /肤色|皮肤|白皙|脸/, d: { hsl: { orange: { h: 0, s: -8, l: 12 } } }, say: '肤色更亮' },
    { re: /锐|清晰|细节/, d: { sharpen: 20 }, say: '更清晰', neg: { sharpen: -20 } },
    { re: /粉|洋红|紫调/, d: { tint: 10 }, say: '偏粉', neg: { tint: -10 } },
    { re: /高光/, d: { highlights: -20 }, say: '压高光' },
    { re: /阴影|暗部/, d: { shadows: 20 }, say: '提阴影' }
  ];
  function scaleDelta(d, f) {
    const out = {};
    for (const [k, v] of Object.entries(d)) {
      if (k === 'hsl') { out.hsl = {}; for (const [b, c] of Object.entries(v)) out.hsl[b] = { h: c.h * f, s: c.s * f, l: c.l * f }; }
      else if (k === 'split') { out.split = {}; for (const [s, x] of Object.entries(v)) out.split[s] = /Hue$/.test(s) ? x : x * f; }
      else out[k] = v * f;
    }
    return out;
  }
  /** 把一句话拆成若干小句，每小句按关键词调整；"别太X / 不要X / 少点X" 反向 */
  function parseInstruction(text, current) {
    let params = normalize(current);
    const notes = [];
    const clauses = String(text || '').split(/[，,。；;、\s]+|但是|但|然后|并且|而且/).filter(Boolean);
    for (const c of clauses) {
      const negative = /别|不要|不想|少点|少一点|减少|降低|去掉|太[^多]*了/.test(c) && !/再/.test(c.replace(/别太|不要太/, ''));
      let f = 1;
      if (/很|超|非常|大幅|明显|多一些|多点/.test(c)) f = 1.8;
      else if (/一点点|稍微|略|微微|轻微/.test(c)) f = 0.5;
      for (const r of RULES) {
        if (!r.re.test(c)) continue;
        const d = negative ? (r.neg || scaleDelta(r.d, -1)) : r.d;
        params = addDelta(params, scaleDelta(d, f));
        notes.push((negative ? '减少：' : '') + r.say);
        break; // 一个小句只匹配第一条规则，避免"天空再蓝"同时命中"冷"
      }
    }
    return { params, notes, understood: notes.length > 0 };
  }

  // ── 参考图颜色迁移：两组颜色统计 → 调色参数 ───────────────────
  // 统计量由界面 canvas 计算（colorStats），这里只做换算，方便测试。
  function srgbToLab(r, g, b) {
    const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const R = lin(r), G = lin(g), B = lin(b);
    const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, y = R * 0.2126 + G * 0.7152 + B * 0.0722, z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  }
  /** data：RGBA 像素数组。返回 L/a/b 均值、亮度分布、饱和度、亮部和暗部的色偏 */
  function colorStats(data, step) {
    step = step || 1;
    let n = 0, sL = 0, sL2 = 0, sA = 0, sB = 0, sSat = 0, hA = 0, hB = 0, hn = 0, dA = 0, dB = 0, dn = 0;
    const hist = new Array(101).fill(0);
    for (let i = 0; i < data.length; i += 4 * step) {
      const [L, a, b] = srgbToLab(data[i], data[i + 1], data[i + 2]);
      n++; sL += L; sL2 += L * L; sA += a; sB += b; sSat += Math.sqrt(a * a + b * b);
      hist[Math.max(0, Math.min(100, Math.round(L)))]++;
      if (L > 65) { hA += a; hB += b; hn++; } else if (L < 35) { dA += a; dB += b; dn++; }
    }
    const pct = q => { let acc = 0; for (let i = 0; i <= 100; i++) { acc += hist[i]; if (acc >= q * n) return i; } return 100; };
    const meanL = sL / n;
    return {
      meanL, stdL: Math.sqrt(Math.max(0, sL2 / n - meanL * meanL)), meanA: sA / n, meanB: sB / n, meanSat: sSat / n,
      highA: hn ? hA / hn : sA / n, highB: hn ? hB / hn : sB / n, shadowA: dn ? dA / dn : sA / n, shadowB: dn ? dB / dn : sB / n,
      p5: pct(0.05), p95: pct(0.95)
    };
  }
  function averageStats(list) {
    const out = {};
    for (const k of Object.keys(list[0])) out[k] = list.reduce((s, x) => s + x[k], 0) / list.length;
    return out;
  }
  // Lab 色相角 → HSL 色相（分段线性：红 0、黄 60、绿 140、蓝 230）
  function labAngleToHue(deg) {
    const pts = [[0, 0], [90, 60], [180, 140], [270, 230], [360, 360]];
    deg = ((deg % 360) + 360) % 360;
    for (let i = 1; i < pts.length; i++) if (deg <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return Math.round(y0 + (y1 - y0) * (deg - x0) / (x1 - x0)) % 360;
    }
    return 0;
  }
  function castToSplit(da, db) {
    const chroma = Math.sqrt(da * da + db * db);
    return { hue: labAngleToHue(Math.atan2(db, da) * 180 / Math.PI), sat: Math.round(clamp(chroma * 2.2, 0, 45)) };
  }
  /** ref：参考图统计；src：用户照片统计（多张取平均）。得到让 src 接近 ref 的参数 */
  function statsToParams(ref, src) {
    const hi = castToSplit((ref.highA - ref.meanA) - (src.highA - src.meanA), (ref.highB - ref.meanB) - (src.highB - src.meanB));
    const sh = castToSplit((ref.shadowA - ref.meanA) - (src.shadowA - src.meanA), (ref.shadowB - ref.meanB) - (src.shadowB - src.meanB));
    return normalize({
      exposure: clamp((ref.meanL - src.meanL) / 28, -1.5, 1.5),
      contrast: clamp((ref.stdL / Math.max(1, src.stdL) - 1) * 90, -60, 60),
      temperature: clamp((ref.meanB - src.meanB) * 2.2, -60, 60),
      tint: clamp((ref.meanA - src.meanA) * 2.2, -50, 50),
      saturation: clamp((ref.meanSat / Math.max(1, src.meanSat) - 1) * 80, -80, 60),
      blacks: clamp((ref.p5 - src.p5) * 1.6, -40, 50),
      whites: clamp((ref.p95 - src.p95) * 1.6, -50, 40),
      split: { highlightHue: hi.hue, highlightSat: hi.sat > 4 ? hi.sat : 0, shadowHue: sh.hue, shadowSat: sh.sat > 4 ? sh.sat : 0, balance: 0 }
    });
  }

  // ── 颜色处理（逐点）+ 3D 查找表 ─────────────────────────────
  function rgbToHsl(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (s <= 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = t => { t = t < 0 ? t + 1 : t > 1 ? t - 1 : t; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  }
  const c01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  /** 返回 (r,g,b ∈ 0..1) → [r,g,b] 的颜色函数（不含颗粒、暗角、锐化这些和位置有关的处理） */
  function colorFunction(params) {
    const p = normalize(params);
    const t = p.temperature / 100, m = p.tint / 100, ev = Math.pow(2, p.exposure);
    const crush = p.blacks < 0 ? -p.blacks / 100 * 0.12 : 0, lift = p.blacks > 0 ? p.blacks / 100 * 0.15 : 0;
    const wGain = p.whites > 0 ? 1 / (1 - p.whites / 100 * 0.18) : 1 + p.whites / 100 * 0.15;
    const k = p.contrast >= 0 ? 1 + p.contrast / 100 * 0.9 : 1 + p.contrast / 100 * 0.6;
    const sh = p.shadows / 100, hl = p.highlights / 100;
    const sat = 1 + p.saturation / 100, vib = p.vibrance / 100;
    const bands = BANDS.map(b => ({ hue: BAND_HUE[b], ...p.hsl[b] })).filter(b => b.h || b.s || b.l);
    const sp = p.split;
    const hiTint = sp.highlightSat ? hslToRgb(sp.highlightHue, 1, 0.5) : null, shTint = sp.shadowSat ? hslToRgb(sp.shadowHue, 1, 0.5) : null;
    const bal = sp.balance / 100;
    return function (r, g, b) {
      r *= 1 + 0.2 * t; b *= 1 - 0.2 * t; g *= 1 - 0.12 * m; r *= 1 + 0.03 * m; b *= 1 + 0.03 * m;
      r *= ev; g *= ev; b *= ev;
      const tone = v => {
        v = (v - crush) / (1 - crush);
        v = v * wGain;
        v = lift + v * (1 - lift);
        return v;
      };
      r = tone(r); g = tone(g); b = tone(b);
      let L = 0.299 * r + 0.587 * g + 0.114 * b;
      const Lc = c01(L);
      const delta = sh * 0.35 * Math.pow(1 - Lc, 3) + hl * 0.35 * Math.pow(Lc, 3);
      r += delta; g += delta; b += delta;
      r = 0.5 + (r - 0.5) * k; g = 0.5 + (g - 0.5) * k; b = 0.5 + (b - 0.5) * k;
      r = c01(r); g = c01(g); b = c01(b);
      if (sat !== 1 || vib || bands.length) {
        let [h, s, l] = rgbToHsl(r, g, b);
        let dh = 0, ds = 0, dl = 0;
        for (const bd of bands) {
          let d = Math.abs(h - bd.hue); if (d > 180) d = 360 - d;
          const w = Math.max(0, 1 - d / 40);
          if (w) { dh += w * bd.h; ds += w * bd.s; dl += w * bd.l; }
        }
        h += dh * 0.3;
        s = s * sat * (1 + ds / 100);
        if (vib) s = s * (1 + vib * (1 - s));
        l = l + dl / 100 * 0.25 * Math.min(1, s * 2);
        [r, g, b] = hslToRgb(h, c01(s), c01(l));
      }
      if (hiTint || shTint) {
        L = 0.299 * r + 0.587 * g + 0.114 * b;
        const pivot = 0.5 - bal * 0.3;
        const wh = c01((L - pivot) / (1 - pivot)), ws = c01((pivot - L) / pivot);
        if (hiTint) { const a = sp.highlightSat / 100 * 0.35 * wh; r += (hiTint[0] - 0.5) * a; g += (hiTint[1] - 0.5) * a; b += (hiTint[2] - 0.5) * a; }
        if (shTint) { const a = sp.shadowSat / 100 * 0.35 * ws; r += (shTint[0] - 0.5) * a; g += (shTint[1] - 0.5) * a; b += (shTint[2] - 0.5) * a; }
      }
      return [c01(r), c01(g), c01(b)];
    };
  }
  /** 3D 查找表：size³ 个格点，每点 RGB（0..255）。整张大图用三线性插值查表，速度比逐点计算快很多 */
  function buildLut(params, size) {
    size = size || 33;
    const fn = colorFunction(params), lut = new Float32Array(size * size * size * 3);
    let o = 0;
    for (let bi = 0; bi < size; bi++) for (let gi = 0; gi < size; gi++) for (let ri = 0; ri < size; ri++) {
      const c = fn(ri / (size - 1), gi / (size - 1), bi / (size - 1));
      lut[o++] = c[0] * 255; lut[o++] = c[1] * 255; lut[o++] = c[2] * 255;
    }
    return { size, lut };
  }
  /** 对 RGBA 像素数组原地套用查找表 */
  function applyLut(data, table) {
    const { size, lut } = table, s1 = size - 1, scale = s1 / 255, s2 = size * size;
    for (let i = 0; i < data.length; i += 4) {
      const rf = data[i] * scale, gf = data[i + 1] * scale, bf = data[i + 2] * scale;
      const r0 = rf | 0, g0 = gf | 0, b0 = bf | 0;
      const r1 = r0 < s1 ? r0 + 1 : r0, g1 = g0 < s1 ? g0 + 1 : g0, b1 = b0 < s1 ? b0 + 1 : b0;
      const dr = rf - r0, dg = gf - g0, db = bf - b0;
      for (let c = 0; c < 3; c++) {
        const v000 = lut[(b0 * s2 + g0 * size + r0) * 3 + c], v100 = lut[(b0 * s2 + g0 * size + r1) * 3 + c];
        const v010 = lut[(b0 * s2 + g1 * size + r0) * 3 + c], v110 = lut[(b0 * s2 + g1 * size + r1) * 3 + c];
        const v001 = lut[(b1 * s2 + g0 * size + r0) * 3 + c], v101 = lut[(b1 * s2 + g0 * size + r1) * 3 + c];
        const v011 = lut[(b1 * s2 + g1 * size + r0) * 3 + c], v111 = lut[(b1 * s2 + g1 * size + r1) * 3 + c];
        const x00 = v000 + (v100 - v000) * dr, x10 = v010 + (v110 - v010) * dr, x01 = v001 + (v101 - v001) * dr, x11 = v011 + (v111 - v011) * dr;
        const y0 = x00 + (x10 - x00) * dg, y1 = x01 + (x11 - x01) * dg;
        data[i + c] = y0 + (y1 - y0) * db;
      }
    }
    return data;
  }

  return { BANDS, BAND_LABEL, RANGE, LABEL, PRESETS, defaults, normalize, merge, addDelta, isNeutral, describe, presetParams,
    parseInstruction, srgbToLab, colorStats, averageStats, statsToParams, colorFunction, buildLut, applyLut };
});
