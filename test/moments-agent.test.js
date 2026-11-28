/**
 * P6 朋友圈助手（plugins/moments-agent）测试：清单、各模块逻辑、引擎接口和步骤（不启动 Electron、不联网）。
 * 跑法：node --test test/moments-agent.test.js
 * 界面回归见 npm run test:electron:moments。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PKG = path.join(__dirname, '..', 'plugins', 'moments-agent');
const lib = name => require(path.join(PKG, 'scripts', 'lib', name));
const { boot } = require('./lib/harness');
const exif = lib('exif'), qr = lib('qr'), Grade = lib('grade'), S = lib('select'), C = lib('caption'), ai = lib('ai'), { encodePng } = lib('png');
const { createMemory } = lib('memory');
const { createEngine } = require(path.join(PKG, 'scripts', 'engine.js'));

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'moments-中文 '));
const ACTIONS = ['import-phone', 'import-folder', 'pick-photos', 'color-grade', 'layout', 'write-caption', 'export', 'preferences', 'ai-settings', 'engine', 'engine-info'];

// ── 清单 ─────────────────────────────────────────────────
test('清单：宿主装载 11 个动作，脚本和界面都在包里', async t => {
  const raw = fs.readFileSync(path.join(PKG, 'manifest.json'));
  assert.ok(!(raw[0] === 0xEF && raw[1] === 0xBB), 'manifest.json 不应带 BOM');
  const host = boot();
  t.after(() => fs.rmSync(host.userData, { recursive: true, force: true }));
  assert.ifError(host.loadError);
  fs.cpSync(PKG, path.join(host.userData, 'workspaces', 'moments-agent'), { recursive: true });
  await host.ready();
  const ws = (await host.invoke('wb:listWorkspaces')).find(w => w.id === 'moments-agent');
  assert.ok(ws, '没有装载 moments-agent');
  assert.strictEqual(path.basename(ws.dir), 'moments-agent');
  assert.deepStrictEqual(ws.actions.map(a => a.id), ACTIONS);
  assert.deepStrictEqual(ws.actions.filter(a => a.mode === 'service').map(a => a.id), ['engine']);
  for (const a of ws.actions) {
    assert.strictEqual(a.cwd, undefined);
    assert.ok(fs.existsSync(path.join(PKG, a.script)), a.script);
    assert.deepStrictEqual(a.args, [a.id]);
  }
  assert.ok(fs.existsSync(path.join(PKG, ws.ui.entry)));
  const html = fs.readFileSync(path.join(PKG, ws.ui.entry), 'utf8');
  assert.ok(!/https?:\/\/(?!127)/.test(html), '界面只用包内文件，不从网络加载资源');
  for (const src of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])) assert.ok(fs.existsSync(path.join(PKG, 'ui', src)), src);
  assert.ok(fs.existsSync(path.join(PKG, 'README.md')));
});

// ── EXIF ─────────────────────────────────────────────────
function jpegWithExif({ date = '2026:05:01 10:20:30', gps = true, orientation = 6 } = {}) {
  // TIFF（小端）：IFD0 = [方向, ExifIFD 指针, GPS 指针]，ExifIFD = [DateTimeOriginal]
  const t = Buffer.alloc(200);
  t.write('II', 0); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  const n0 = gps ? 3 : 2; t.writeUInt16LE(n0, 8);
  let e = 10;
  const entry = (tag, type, count, val) => { t.writeUInt16LE(tag, e); t.writeUInt16LE(type, e + 2); t.writeUInt32LE(count, e + 4); t.writeUInt32LE(val, e + 8); e += 12; };
  const exifIfd = 10 + n0 * 12 + 4;
  entry(0x0112, 3, 1, orientation);
  entry(0x8769, 4, 1, exifIfd);
  if (gps) entry(0x8825, 4, 1, 150);
  t.writeUInt16LE(1, exifIfd); e = exifIfd + 2;
  entry(0x9003, 2, 20, exifIfd + 2 + 12 + 4);
  t.write(date + '\0', exifIfd + 18, 'ascii');
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), t]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1Body.length + 2);
  return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]), len, app1Body, Buffer.from([0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9])]);
}
test('EXIF：识别格式；读出拍摄时间、方向、是否带定位；回填时方向改为 1', () => {
  const j = jpegWithExif();
  assert.strictEqual(exif.detectFormat(j), 'jpeg');
  assert.strictEqual(exif.detectFormat(encodePng(2, 2, () => [0, 0, 0])), 'png');
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
  assert.strictEqual(exif.detectFormat(heic), 'heic');
  assert.ok(!exif.DECODABLE.has('heic'));
  assert.deepStrictEqual(exif.readExif(j), { orientation: 6, takenAt: '2026-05-01T10:20:30', hasGps: true });
  assert.strictEqual(exif.readExif(jpegWithExif({ gps: false })).hasGps, false);
  const canvasJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]);
  const merged = exif.injectExif(canvasJpeg, j);
  const r = exif.readExif(merged);
  assert.strictEqual(r.orientation, 1);
  assert.strictEqual(r.takenAt, '2026-05-01T10:20:30');
  assert.strictEqual(exif.readExif(canvasJpeg).hasGps, false, 'canvas 导出的 JPEG 没有定位');
});

// ── 二维码 ───────────────────────────────────────────────
test('二维码：Reed-Solomon 纠错码与标准示例一致；矩阵尺寸 = 版本 × 4 + 17；SVG 可生成', () => {
  // "HELLO WORLD" 1-M 的数据码字与纠错码字（ISO/IEC 18004 教程示例）
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepStrictEqual(qr.rsRemainder(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  const url = 'http://192.168.1.23:51234/u/Ab3dEf9hJkLmNpQr';
  const { version } = qr.encodeCodewords([...Buffer.from(url)]);
  assert.strictEqual(qr.qrMatrix(url).length, version * 4 + 17);
  assert.match(qr.qrSvg(url), /^<svg [^>]*viewBox/);
  assert.throws(() => qr.qrMatrix('x'.repeat(400)), /太长/);
});

// ── 调色 ─────────────────────────────────────────────────
test('一句话调色（离线规则）："暖一点"变暖，"再暖一点"在此基础上继续变暖，"别太黄"往回调', () => {
  const a = Grade.parseInstruction('暖一点', Grade.defaults());
  assert.ok(a.understood && a.params.temperature > 0);
  const b = Grade.parseInstruction('再暖一点', a.params);
  assert.ok(b.params.temperature > a.params.temperature);
  const c = Grade.parseInstruction('日系通透一点，别太黄', b.params);
  assert.ok(c.params.temperature < b.params.temperature && c.params.highlights < 0 && c.params.shadows > 0);
  const sky = Grade.parseInstruction('天空再蓝一点', Grade.defaults());
  assert.ok(sky.params.hsl.blue.s > 0 && sky.params.temperature === 0);
  assert.strictEqual(Grade.parseInstruction('今天天气不错', Grade.defaults()).understood, false);
});
test('调色：参数会被夹到范围内；变暖让灰色偏红；查找表结果与逐点计算一致；黑白去色', () => {
  const p = Grade.normalize({ exposure: 9, contrast: -500, hsl: { red: { s: 300 } }, split: { highlightHue: 400 } });
  assert.strictEqual(p.exposure, 2); assert.strictEqual(p.contrast, -100); assert.strictEqual(p.hsl.red.s, 100); assert.strictEqual(p.split.highlightHue, 40);
  const warm = Grade.colorFunction({ temperature: 40 })(0.5, 0.5, 0.5);
  assert.ok(warm[0] > warm[2] + 0.05);
  const params = Grade.presetParams('film');
  const fn = Grade.colorFunction(params), table = Grade.buildLut(params, 33);
  const px = new Uint8ClampedArray([200, 120, 60, 255, 30, 90, 160, 255]);
  Grade.applyLut(px, table);
  for (const [i, rgb] of [[0, [200, 120, 60]], [4, [30, 90, 160]]]) {
    const exp = fn(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255).map(v => v * 255);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(px[i + c] - exp[c]) < 3, `LUT 误差过大：${px[i + c]} vs ${exp[c]}`);
  }
  const bw = Grade.colorFunction(Grade.presetParams('bw'))(0.8, 0.3, 0.2);
  assert.ok(Math.abs(bw[0] - bw[1]) < 0.01 && Math.abs(bw[1] - bw[2]) < 0.01);
  assert.strictEqual(Grade.PRESETS.length, 6);
  assert.ok(Grade.presetParams('auto', 60).exposure > 0 && Grade.presetParams('auto', 200).exposure < 0);
});
test('复刻滤镜（本地颜色迁移）：参考图偏暖、偏亮、低饱和 → 参数朝这些方向走', () => {
  const pixels = (fn, n = 400) => { const d = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) { const [r, g, b] = fn(i / n); d.set([r, g, b, 255], i * 4); } return d; };
  const src = Grade.colorStats(pixels(t => [30 + t * 200, 90 + t * 90, 220 - t * 150]));      // 偏冷、较暗、颜色鲜
  const ref = Grade.colorStats(pixels(t => [130 + t * 110, 122 + t * 104, 108 + t * 92]));    // 偏暖、亮、低饱和
  const p = Grade.statsToParams(ref, src);
  assert.ok(p.temperature > 10, '应变暖');
  assert.ok(p.exposure > 0, '应变亮');
  assert.ok(p.saturation < 0, '应降饱和');
});

// ── 挑照片 ───────────────────────────────────────────────
const m = (sharp, hash, extra = {}) => ({ sharp, dark: 0.02, bright: 0.02, mean: 120, hash, w: 4000, h: 3000, ...extra });
const H = i => (BigInt(i) * 0x9E3779B97F4A7C15n & 0xFFFFFFFFFFFFFFFFn).toString(16).padStart(16, '0');
function samplePhotos() {
  const photos = [];
  for (let i = 0; i < 8; i++) photos.push({ id: 'a' + i, metrics: m(300 + i * 10, H(i + 1)) });               // 8 张不同场景的清晰照片
  for (let i = 0; i < 3; i++) photos.push({ id: 'blur' + i, metrics: m(5 + i, H(100 + i)) });               // 3 张拍糊
  const burst = H(500);
  for (let i = 0; i < 5; i++) photos.push({ id: 'burst' + i, metrics: m(200 + i * 30, burst.slice(0, 15) + ((parseInt(burst[15], 16) ^ i) & 15).toString(16)) });  // 一组 5 张连拍
  photos.push({ id: 'dark', metrics: m(250, H(900), { dark: 0.8, mean: 15 }) });
  photos.push({ id: 'heic', unsupported: true, metrics: null });
  return photos;
}
test('本地预筛：3 张糊片被标出；5 张连拍只留最清晰的 1 张；过暗标为曝光问题；不支持的格式不参与', () => {
  const photos = samplePhotos();
  const r = S.prefilter(photos);
  for (let i = 0; i < 3; i++) assert.ok(r.flags['blur' + i].blurry);
  assert.ok(!r.candidates.some(id => id.startsWith('blur')));
  const burstIn = r.candidates.filter(id => id.startsWith('burst'));
  assert.deepStrictEqual(burstIn, ['burst4'], '连拍组只剩最清晰的一张');
  assert.strictEqual(r.flags.burst0.groupSize, 5);
  assert.ok(r.flags.dark.exposure && !r.candidates.includes('dark'));
  assert.ok(!('heic' in r.flags));
  // 手动放回候选
  photos.find(p => p.id === 'blur0').manual = 'include';
  assert.ok(S.prefilter(photos).candidates.includes('blur0'));
});
test('组合挑选：同一场景最多 2 张；照顾不同类型；给出入选理由和 6 张候补', () => {
  const items = [];
  for (let i = 0; i < 6; i++) items.push({ id: 's' + i, score: 9.5 - i * 0.01, category: 'portrait', scene: 'same' });   // 同一场景 6 张高分自拍
  for (let i = 0; i < 10; i++) items.push({ id: 'o' + i, score: 7 - i * 0.1, category: ['landscape', 'food', 'detail'][i % 3], scene: 'x' + i });
  const r = S.chooseSet(items, { count: 9 });
  assert.strictEqual(r.selected.length, 9);
  assert.ok(r.selected.filter(id => id.startsWith('s')).length <= 2);
  assert.ok(new Set(r.selected.map(id => items.find(x => x.id === id).category)).size >= 3);
  assert.strictEqual(r.alternates.length, 6);
  for (const id of r.selected) assert.ok(r.reasons[id]);
});
test('总分：加权求和；没有人物时人物状态不计分，权重按比例分给其他项', () => {
  const sc = { composition: 8, subject: 8, people: 2, color: 8, aesthetic: 8 };
  assert.ok(S.totalScore(sc, S.DEFAULT_WEIGHTS, true) < 8);
  assert.strictEqual(S.totalScore(sc, S.DEFAULT_WEIGHTS, false), 8);
  const w = S.normalizeWeights({ composition: 1, subject: 0, people: 0, color: 0, aesthetic: 0 }, 0.5);
  assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 0.01);
});
test('排版规则：张数只能是 1/3/4/6/9；9 张时第 5 张是第二吸引人的；同一场景不相邻；封面保持', () => {
  assert.strictEqual(S.allowedCount(8), 6); assert.strictEqual(S.allowedCount(2), 1); assert.strictEqual(S.allowedCount(9, 4), 4); assert.strictEqual(S.allowedCount(9, 5), 4);
  assert.strictEqual(S.gridColumns(4), 2); assert.strictEqual(S.gridColumns(9), 3);
  const ids = ['c', 'a1', 'a2', 'b1', 'b2', 'x', 'y', 'z', 'w'];
  const meta = { c: { scene: 'C', rank: 0 }, a1: { scene: 'A', rank: 3 }, a2: { scene: 'A', rank: 1 }, b1: { scene: 'B', rank: 4 }, b2: { scene: 'B', rank: 5 }, x: { scene: 'X', rank: 2 }, y: { scene: 'Y', rank: 6 }, z: { scene: 'Z', rank: 7 }, w: { scene: 'W', rank: 8 } };
  const r = S.applyLayoutRules(ids, meta);
  assert.strictEqual(r.count, 9);
  assert.strictEqual(r.order[0], 'c');
  assert.strictEqual(r.order[4], 'a2');
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(S.applyLayoutRules(ids.slice(0, 5), meta).count, 4);
});

// ── 记忆 ─────────────────────────────────────────────────
test('记忆：连续 5 次把人像换成风景后，下一次推荐里风景比例上升；权重不超过默认值 ±50%', () => {
  const dir = tmpDir(), mem = createMemory(dir);
  const items = [];
  for (let i = 0; i < 6; i++) items.push({ id: 'p' + i, score: 8, category: 'portrait', scene: 'p' + i });
  for (let i = 0; i < 6; i++) items.push({ id: 'l' + i, score: 7.2, category: 'landscape', scene: 'l' + i });
  const ratio = r => r.selected.filter(id => id.startsWith('l')).length / r.selected.length;
  const before = ratio(S.chooseSet(items, { count: 6, catBias: mem.load().catBias }));
  for (let k = 0; k < 5; k++) {
    mem.record('swap', { outCat: 'portrait', inCat: 'landscape' });
    const due = mem.recordExport({ count: 6, cats: { landscape: 4, portrait: 2 }, preset: '胶片', style: '简短' });
    assert.strictEqual(due, k === 4, '第 5 次导出时重新计算');
  }
  const M = mem.load();
  assert.ok(M.catBias.landscape > 0 && M.catBias.portrait < 0);
  assert.ok(M.weights.people < S.DEFAULT_WEIGHTS.people && M.weights.people >= S.DEFAULT_WEIGHTS.people * 0.5 - 0.001);
  const after = ratio(S.chooseSet(items, { count: 6, catBias: M.catBias }));
  assert.ok(after > before, `风景比例应上升：${before} → ${after}`);
  const summary = mem.summary();
  assert.match(summary, /风景/); assert.match(summary, /胶片/);
  assert.ok(summary.length <= 300);
});
test('记忆：删除一条后摘要不再体现；改写摘要；一键清空回到冷启动；预设和风格卡可存可删', () => {
  const dir = tmpDir(), mem = createMemory(dir);
  mem.update(x => { x.onboarding = { tone: '胶片复古', length: '一句话' }; });
  for (let i = 0; i < 5; i++) { mem.record('swap', { outCat: 'portrait', inCat: 'food' }); mem.recordExport({ count: 4, cats: { food: 4 } }); }
  assert.match(mem.summary(), /美食/);
  mem.deleteItem('swap');
  assert.doesNotMatch(mem.summary(), /美食/);
  assert.deepStrictEqual(mem.load().catBias, {});
  mem.deleteItem('onboarding.tone');
  assert.doesNotMatch(mem.summary(), /胶片复古/);
  mem.editItem('summary', '喜欢冷色调、文案短');
  assert.strictEqual(mem.summary(), '喜欢冷色调、文案短');
  const pid = mem.presets.save('小红书那个青橙色', { params: Grade.defaults() });
  mem.styles.save('我的风格', { card: C.normalizeCard({}) });
  assert.strictEqual(mem.presets.list()[0].name, '小红书那个青橙色');
  mem.presets.remove(pid);
  assert.strictEqual(mem.presets.list().length, 0);
  mem.clearAll();
  const M = mem.load();
  assert.strictEqual(M.onboarding, null); assert.strictEqual(M.events.length, 0); assert.strictEqual(mem.styles.list().length, 0);
});

// ── 文案 ─────────────────────────────────────────────────
test('文案：连续 8 个字以上相同算照搬（忽略标点空白）；风格卡规范化；离线模板不编造', () => {
  const ref = '海风很温柔，日落也是，今天的快乐有点超标了。';
  assert.ok(C.copiesReference('我觉得今天的快乐有点超标了呀', ref));
  assert.ok(!C.copiesReference('今天的快乐，刚刚好', ref));
  assert.ok(C.copiesReference('海风很温柔 日落也是！', ref), '去掉标点后连续 8 字相同');
  assert.deepStrictEqual(C.normalizeCard({ length: [50, 10] }).length, [10, 50]);
  for (const s of C.BUILTIN_STYLES) for (const t of C.offlineCaptions('', s.id)) assert.ok(!/北京|上海|旅行|同学/.test(t));
  assert.ok(C.offlineCaptions('毕业旅行', 'short').some(t => t.includes('毕业旅行')));
});

// ── AI 客户端（本机模拟接口）──────────────────────────────
function mockServer(handler) {
  return new Promise(resolve => {
    const reqs = [];
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', c => { b += c; });
      req.on('end', () => { const r = { url: req.url, headers: req.headers, body: b ? JSON.parse(b) : null }; reqs.push(r); handler(r, res, reqs.length); });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, reqs, url: 'http://127.0.0.1:' + srv.address().port }));
  });
}
test('AI：Claude 请求格式（看图块、版本头、拒绝时自动换模型）；不认识 fallbacks 时去掉重试；只取文字块', async () => {
  const { srv, reqs, url } = await mockServer((r, res, n) => {
    if (n === 1) { res.writeHead(400); return res.end('{"error":{"message":"fallbacks: unknown field"}}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '```json\n{"ok": "红"}\n```' }] }));
  });
  try {
    const out = await ai.chat({ provider: 'anthropic', baseUrl: url, model: 'claude-opus-5-5', apiKey: 'k1' }, { system: 'S', text: 'T', images: [ai.testImage()] });
    assert.deepStrictEqual(ai.parseJson(out), { ok: '红' });
    const [first, second] = reqs;
    assert.strictEqual(first.url, '/v1/messages');
    assert.strictEqual(first.headers['x-api-key'], 'k1');
    assert.strictEqual(first.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(first.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.strictEqual(first.body.fallbacks, 'default');
    assert.strictEqual(first.body.model, 'claude-opus-5-5');
    assert.deepStrictEqual(first.body.messages[0].content[0].source.type, 'base64');
    assert.strictEqual(first.body.messages[0].content[1].text, 'T');
    assert.strictEqual(second.body.fallbacks, undefined);
  } finally { srv.close(); }
});
test('AI：豆包 Seed（火山方舟）预设按 OpenAI 格式请求 /api/v3/chat/completions，带图片和 Bearer key', async () => {
  assert.strictEqual(ai.PROVIDERS.ark.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.strictEqual(ai.PROVIDERS.ark.model, 'doubao-seed-2-1-lite-260915');
  const { srv, reqs, url } = await mockServer((r, res) => { res.writeHead(200); res.end(JSON.stringify({ choices: [{ message: { content: '红色' } }] })); });
  try {
    const r = await ai.testConnection({ provider: 'ark', baseUrl: url + '/api/v3', model: ai.PROVIDERS.ark.model, apiKey: 'ark-key' });
    assert.ok(r.ok);
    assert.strictEqual(reqs[0].url, '/api/v3/chat/completions');
    assert.strictEqual(reqs[0].headers.authorization, 'Bearer ark-key');
    assert.strictEqual(reqs[0].body.model, 'doubao-seed-2-1-lite-260915');
    assert.ok(reqs[0].body.max_tokens >= 8192, '会思考的模型需要足够的输出上限');
    assert.match(reqs[0].body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  } finally { srv.close(); }
});
test('AI：OpenAI 兼容格式；401 / 连不上 翻译成中文；拒绝时给出中文说明', async () => {
  const { srv, reqs, url } = await mockServer((r, res) => {
    if (r.headers.authorization === 'Bearer bad') { res.writeHead(401); return res.end('{}'); }
    if (r.body.model === 'refuse') { res.writeHead(200); return res.end(JSON.stringify({ stop_reason: 'refusal', content: [] })); }
    res.writeHead(200); res.end(JSON.stringify({ choices: [{ message: { content: '红色' } }] }));
  });
  try {
    const cfg = { provider: 'openai', baseUrl: url + '/v1/', model: 'qwen-vl', apiKey: 'good' };
    assert.deepStrictEqual(await ai.testConnection(cfg), { ok: true, answer: '红色' });
    assert.strictEqual(reqs[0].url, '/v1/chat/completions');
    assert.match(reqs[0].body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
    await assert.rejects(ai.chat({ ...cfg, apiKey: 'bad' }, { text: 'x' }), /API key 不对/);
    await assert.rejects(ai.chat({ provider: 'anthropic', baseUrl: url, model: 'refuse', apiKey: 'k' }, { text: 'x' }), /拒绝/);
  } finally { srv.close(); }
  await assert.rejects(ai.chat({ provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k' }, { text: 'x' }), /连不上 AI 接口/);
  await assert.rejects(ai.chat(null, { text: 'x' }), /AI 设置/);
});

// ── 引擎：接口 + 步骤 + 局域网传图 ──────────────────────────
function startEngine(dataDir, extra = {}) {
  const clip = [];
  const confirms = [];
  const sdk = { request: async (method, params) => { confirms.push({ method, params }); return extra.confirm !== undefined ? extra.confirm : true; } };
  const e = createEngine({ dataDir, sdk, lanHost: '127.0.0.1', clipboard: t => clip.push(t), ...extra.opts });
  return e.listen().then(port => {
    const H = { 'x-token': e.token, 'content-type': 'application/json' };
    const call = async (method, url, body, raw) => {
      const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: raw ? { 'x-token': e.token, 'content-type': 'image/jpeg' } : H, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status });
      return j;
    };
    const step = async (name, body = {}) => {
      const text = await (await fetch(`http://127.0.0.1:${port}/api/step/${name}`, { method: 'POST', headers: H, body: JSON.stringify(body) })).text();
      return { text, code: Number(/@@EXIT (\d+)/.exec(text)[1]) };
    };
    return { e, port, call, step, clip, confirms };
  });
}
const fakeJpeg = () => Buffer.concat([jpegWithExif(), Buffer.alloc(64, 1)]);

test('引擎：口令校验、CORS 预检；从文件夹导入（跳过非图片、标出不支持格式、按拍摄时间排序）', async () => {
  const dir = tmpDir(), photos = tmpDir();
  fs.writeFileSync(path.join(photos, 'b.png'), encodePng(8, 8, () => [10, 200, 30]));
  fs.writeFileSync(path.join(photos, 'a.jpg'), fakeJpeg());
  fs.writeFileSync(path.join(photos, 'c.heic'), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(16)]));
  fs.writeFileSync(path.join(photos, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(photos, 'fake.jpg'), 'not an image');
  const { e, port, call, step } = await startEngine(dir);
  try {
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 403);
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'x-token': 'wrong' } })).status, 403);
    const pre = await fetch(`http://127.0.0.1:${port}/api/state`, { method: 'OPTIONS' });
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(pre.headers.get('access-control-allow-private-network'), 'true');
    const r = await step('import-folder', { folder: photos });
    assert.strictEqual(r.code, 0, r.text);
    assert.match(r.text, /导入 3 张，跳过 1 张/);
    assert.match(r.text, /c\.heic：这张照片格式不支持/);
    const st = await call('GET', '/api/state');
    assert.deepStrictEqual(st.draft.photos.map(p => p.name), ['a.jpg', 'b.png', 'c.heic'], '有拍摄时间的排前面');
    assert.strictEqual(st.draft.photos[0].hasGps, true);
    assert.strictEqual(st.draft.photos[2].unsupported, true);
    assert.ok(fs.readFileSync(path.join(photos, 'a.jpg')).equals(fakeJpeg()), '原图不被修改');
    const img = await fetch(`http://127.0.0.1:${port}/api/img/orig/${st.draft.photos[1].id}?t=${e.token}`);
    assert.strictEqual(img.headers.get('content-type'), 'image/png');
  } finally { e.close(); }
});

test('引擎：扫码传图——一次性口令、只收图片、格式不支持给提示、完成后失效；10 分钟无上传失效', async () => {
  const dir = tmpDir();
  const { e, call } = await startEngine(dir);
  try {
    await e.ensureLan();
    const s = e.startSession('import', e.draft());
    const base = `http://127.0.0.1:${e.lanPort}/u/${s.token}`;
    const page = await (await fetch(base)).text();
    assert.match(page, /accept="image\/\*" multiple/);
    assert.strictEqual((await fetch(`http://127.0.0.1:${e.lanPort}/u/wrongtoken`)).status, 410);
    const up = (buf, type, name) => fetch(base + '/upload?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'content-type': type }, body: buf });
    assert.strictEqual((await up(encodePng(4, 4, () => [1, 2, 3]), 'image/png', 'IMG_1.png')).status, 200);
    assert.strictEqual((await up(Buffer.from('hello'), 'text/plain', 'a.txt')).status, 400);
    assert.strictEqual((await up(Buffer.from('hello'), 'image/jpeg', 'fake.jpg')).status, 400);
    const heic = await (await up(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheif'), Buffer.alloc(16)]), 'image/heif', 'x.heif')).json();
    assert.match(heic.warning, /格式不支持/);
    assert.strictEqual(s.received, 2);
    const st = await call('GET', '/api/state');
    assert.strictEqual(st.draft.photos.length, 2);
    assert.ok(st.phone.import.active && st.phone.import.received === 2);
    await fetch(base + '/done', { method: 'POST' });
    assert.strictEqual(await s.done, 'done');
    const again = await fetch(base);
    assert.strictEqual(again.status, 410);
    assert.match(await again.text(), /已失效|已经完成/);
    // 10 分钟无上传
    const s2 = e.startSession('import', e.draft());
    s2.last -= 11 * 60 * 1000;
    const r2 = await fetch(`http://127.0.0.1:${e.lanPort}/u/${s2.token}`);
    assert.strictEqual(r2.status, 410);
    assert.match(await r2.text(), /二维码已失效/);
  } finally { e.close(); }
});

test('引擎：不配置 AI 时，预筛 → 挑图 → 换图写入记忆 → 一句话调色 → 规则排版 → 离线文案 → 导出（默认去定位、文案进剪贴板）都能完成', async () => {
  const dir = tmpDir();
  const { e, call, step, clip } = await startEngine(dir);
  try {
    const d = e.draft();
    const list = samplePhotos().filter(p => !p.unsupported);
    for (const p of list) {
      const rec = e.drafts.addPhoto(d, fakeJpeg(), p.id + '.jpg', 'folder');
      rec.metrics = p.metrics;
      fs.mkdirSync(path.join(e.drafts.dirOf(d.id), 'thumbs'), { recursive: true });
      fs.writeFileSync(path.join(e.drafts.dirOf(d.id), 'thumbs', rec.id + '.jpg'), fakeJpeg());
      rec.thumb = true;
    }
    e.drafts.save(d);
    const byName = name => d.photos.find(p => p.name === name + '.jpg');

    let r = await step('pick-photos');
    assert.strictEqual(r.code, 0, r.text);
    assert.match(r.text, /可能拍糊 3 张/);
    assert.match(r.text, /没有配置 AI/);
    let st = await call('GET', '/api/state');
    const sel = st.draft.pick.selected;
    assert.strictEqual(sel.length, 9);
    assert.ok(!sel.some(id => /^blur|^dark/.test(st.draft.photos.find(p => p.id === id).name)));
    assert.ok(sel.every(id => st.draft.pick.reasons[id]));

    const outId = sel[0], inId = st.draft.pick.alternates[0] || byName('blur0').id;
    await call('POST', '/api/pick/swap', { out: outId, in: inId });
    st = await call('GET', '/api/state');
    assert.ok(st.draft.pick.selected.includes(inId) && !st.draft.pick.selected.includes(outId));
    assert.strictEqual(e.memory.load().events.filter(x => x.type === 'swap').length, 1, '换图记录写入记忆');

    await call('POST', '/api/grade/request', { type: 'text', text: '暖一点' });
    r = await step('color-grade');
    assert.strictEqual(r.code, 0, r.text);
    const t1 = (await call('GET', '/api/state')).draft.grade.params.temperature;
    await call('POST', '/api/grade/request', { type: 'text', text: '再暖一点' });
    await step('color-grade');
    assert.ok((await call('GET', '/api/state')).draft.grade.params.temperature > t1 && t1 > 0);
    await assert.rejects(call('POST', '/api/grade/request', { type: 'text', text: 'https://www.xiaohongshu.com/abc' }), /截图/);
    await call('POST', '/api/grade', { preset: 'film' });
    assert.strictEqual((await call('GET', '/api/state')).draft.grade.presetName, '胶片');

    r = await step('layout');
    assert.strictEqual(r.code, 0, r.text);
    st = await call('GET', '/api/state');
    assert.strictEqual(st.draft.layout.count, 9);
    await assert.rejects(call('POST', '/api/layout', { order: st.draft.layout.order.slice(0, 5) }), /1 \/ 3 \/ 4 \/ 6 \/ 9/);
    await call('POST', '/api/layout', { order: [...st.draft.layout.order].reverse(), drag: true });

    await call('POST', '/api/caption', { occasion: '周末爬山', styleId: 'short' });
    r = await step('write-caption');
    assert.strictEqual(r.code, 0, r.text);
    await call('POST', '/api/caption', { choose: 1 });
    await call('POST', '/api/caption', { text: '周末爬山，很开心！' });

    assert.strictEqual((await step('export')).code, 1, '没生成照片时导出失败');
    await call('POST', '/api/export/begin', { count: 9, stripGps: true });
    for (let n = 1; n <= 9; n++) await call('PUT', '/api/export/file/' + n, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xD9]), true);
    r = await step('export');
    assert.strictEqual(r.code, 0, r.text);
    const outDir = path.join(e.drafts.dirOf(d.id), '发布包');
    assert.deepStrictEqual(fs.readdirSync(outDir).sort(), ['01.jpg', '02.jpg', '03.jpg', '04.jpg', '05.jpg', '06.jpg', '07.jpg', '08.jpg', '09.jpg', '文案.txt']);
    assert.strictEqual(fs.readFileSync(path.join(outDir, '文案.txt'), 'utf8').trim(), '周末爬山，很开心！');
    assert.deepStrictEqual(clip, ['周末爬山，很开心！']);
    assert.strictEqual(exif.readExif(fs.readFileSync(path.join(outDir, '01.jpg'))).hasGps, false);
    assert.match(r.text, /扫码存回相册/);
    const M = e.memory.load();
    assert.strictEqual(M.totalExports, 1);
    assert.ok(M.events.some(x => x.type === 'caption' && x.edited === true));
    assert.ok(M.events.some(x => x.type === 'layout' && x.drags === 1));
    // 手机存回：按顺序列出照片
    st = await call('GET', '/api/state');
    const save = await (await fetch(st.phone.export.url.replace(/\/\/[^/:]+:/, '//127.0.0.1:'))).text();
    assert.match(save, /第 9 张/);
    // 保留定位时把原图 EXIF 放回去（方向改为 1）
    await call('POST', '/api/export/begin', { count: 9, stripGps: false });
    for (let n = 1; n <= 9; n++) await call('PUT', '/api/export/file/' + n, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xD9]), true);
    r = await step('export');
    assert.match(r.text, /保留了照片里的拍摄信息|已保留照片里的拍摄信息/);
    const kept = exif.readExif(fs.readFileSync(path.join(outDir, '01.jpg')));
    assert.ok(kept.hasGps && kept.orientation === 1);
  } finally { e.close(); }
});

test('引擎：AI 步骤在断网时给出中文失败原因，不影响已完成的步骤和草稿；需要 AI 的步骤先检查前置条件', async () => {
  const dir = tmpDir();
  const { e, call, step } = await startEngine(dir);
  try {
    // 写入一个指向不可达地址的 AI 配置
    fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
    await call('POST', '/api/ai/pending', { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: 'k' });
    const r = await step('ai-settings');
    assert.strictEqual(r.code, 1);
    assert.match(r.text, /连不上 AI 接口/);
    assert.strictEqual((await call('GET', '/api/state')).ai.configured, false, '测试不通过不保存');
    assert.match((await step('layout')).text, /还没有挑照片/);
    assert.match((await step('color-grade')).text, /请先在界面里输入/);
    await assert.rejects(call('POST', '/api/ai/pending', { provider: 'openai', baseUrl: 'ftp://x', model: 'm' }), /http/);
  } finally { e.close(); }
});

test('引擎：AI 打分（模拟接口）——分批调用、记录用量、按权重算总分、已打分的不重复调用；API key 加密保存', async () => {
  let calls = 0;
  const { srv, url } = await mockServer((r, res) => {
    calls++;
    const text = r.body.messages[r.body.messages.length - 1].content.find(c => c.type === 'text').text;
    let content;
    if (/方块是什么颜色/.test(text)) content = '红';
    else {
      const n = Number(/下面有 (\d+) 张照片/.exec(text)[1]);
      content = JSON.stringify({ photos: Array.from({ length: n }, (_, i) => ({ index: i + 1, scores: { composition: 9 - i, subject: 7, people: null, color: 6, aesthetic: 8 - i }, reasons: { composition: '构图稳' }, hasPeople: false, category: i % 2 ? 'food' : 'landscape' })) });
    }
    res.writeHead(200); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const dir = tmpDir();
  const { e, call, step } = await startEngine(dir);
  try {
    await call('POST', '/api/ai/pending', { provider: 'openai', baseUrl: url + '/v1', model: 'vl', apiKey: 'sk-secret-123' });
    assert.strictEqual((await step('ai-settings')).code, 0);
    const saved = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
    assert.ok(!saved.includes('sk-secret-123'), 'key 不能明文保存');
    assert.ok((await call('GET', '/api/state')).ai.configured);
    const d = e.draft();
    for (const p of samplePhotos().filter(x => !x.unsupported)) {
      const rec = e.drafts.addPhoto(d, fakeJpeg(), p.id + '.jpg', 'folder'); rec.metrics = p.metrics;
      fs.mkdirSync(path.join(e.drafts.dirOf(d.id), 'thumbs'), { recursive: true });
      fs.writeFileSync(path.join(e.drafts.dirOf(d.id), 'thumbs', rec.id + '.jpg'), fakeJpeg()); rec.thumb = true;
    }
    e.drafts.save(d);
    calls = 0;
    const r = await step('pick-photos');
    assert.strictEqual(r.code, 0, r.text);
    assert.match(r.text, /将调用 AI 约 3 次/);       // 9 张候选，每批 4 张
    assert.strictEqual(calls, 3);
    const st = await call('GET', '/api/state');
    assert.ok(st.draft.pick.usedAi && st.draft.aiCalls === 3);
    assert.ok(st.draft.photos.filter(p => p.ai).length === 9);
    assert.ok(Object.values(st.draft.pick.reasons).some(t => /构图稳/.test(t)));
    calls = 0;
    await step('pick-photos');
    assert.strictEqual(calls, 0, '已打过分的照片不重复调用');
  } finally { e.close(); srv.close(); }
});

test('引擎：清理草稿前弹窗确认并显示释放空间；取消则不删', async () => {
  const dir = tmpDir();
  const a = await startEngine(dir, { confirm: false });
  try {
    const id = a.e.draft().id;
    let r = await a.call('POST', '/api/drafts/delete', { ids: [id] });
    assert.strictEqual(r.deleted, 0);
    assert.match(a.confirms[0].params.message, /释放 .* MB/);
  } finally { a.e.close(); }
  const b = await startEngine(dir, { confirm: true });
  try {
    const id = b.e.draft().id;
    const r = await b.call('POST', '/api/drafts/delete', { ids: [id] });
    assert.strictEqual(r.deleted, 1);
    assert.strictEqual((await b.call('GET', '/api/drafts')).drafts.some(x => x.id === id), false);
  } finally { b.e.close(); }
});

test('动作入口：步骤动作通过本机接口执行并原样输出进度、返回退出码；引擎没运行时给出中文提示', async () => {
  const dir = tmpDir();
  const { e, port } = await startEngine(dir);
  const run = (arg, dataDir) => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(PKG, 'scripts', 'main.js'), arg], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, WB_SDK_PATH: path.join(__dirname, '..', 'lib', 'plugin-sdk.js'), WB_DATA_DIR: dataDir } });
    let out = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
    const messages = [];
    child.on('message', message => {
      messages.push(message);
      child.send({ type: 'wb:reply', id: message.id });
    });
    child.on('close', code => resolve({ code, out, messages }));
  });
  try {
    let r = await run('preferences', dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /引擎没有运行/);
    fs.writeFileSync(path.join(dir, 'engine.json'), JSON.stringify({ port, token: e.token, pid: process.pid }));
    r = await run('preferences', dir);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /== AI 记住的偏好 ==/);
    assert.doesNotMatch(r.out, /@@EXIT/);
    r = await run('pick-photos', dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /草稿里还没有照片/);
    r = await run('engine-info', dir);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.messages.some(m => m.method === 'publish' && m.params.name === 'engine-ready' && m.params.data.port === port));
    assert.ok(!r.out.includes(e.token));
  } finally { e.close(); }
});
