// 朋友圈助手的真实 Electron 回归：沙箱界面 ↔ 引擎、照片分析（canvas）、六步流程、扫码传图网页、导出。
// 跑法：npx electron test/electron-moments.js   （使用临时用户数据，文件夹选择框返回生成的测试照片目录，不联网、不调用 AI）
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodePng } = require('../plugins/moments-agent/scripts/lib/png');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-moments-中文 '));
app.setPath('userData', tmp);
fs.cpSync(path.join(__dirname, '..', 'plugins', 'moments-agent'), path.join(tmp, 'workspaces', 'moments-agent'), { recursive: true });
const clipFile = path.join(tmp, 'clipboard.txt');
process.env.MOMENTS_CLIPBOARD_FILE = clipFile;

// 生成测试照片：8 个不同场景（带纹理，清晰）、3 张糊片（平滑渐变）、1 组 4 张连拍、1 张过暗
const photos = path.join(tmp, '测试照片');
fs.mkdirSync(photos);
let seed = 1; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function scene(hue, opts = {}) {
  const W = 960, H = 720, noise = opts.blur ? 0 : 60, dark = opts.dark ? 0.08 : 1, shift = opts.shift || 0;
  const base = [Math.cos(hue) * 90 + 128, Math.cos(hue + 2.1) * 90 + 128, Math.cos(hue + 4.2) * 90 + 128];
  const tex = new Float32Array(64 * 64).map(() => (rnd() - 0.5) * noise);
  return encodePng(W, H, (x, y) => {
    const g = (x + shift) / W, v = y / H, t = tex[((y >> 3) % 64) * 64 + (((x + shift) >> 3) % 64)];
    const k = opts.period || 5, xx = opts.vertical ? y : x + shift, yy = opts.vertical ? x + shift : y;
    const stripe = opts.blur ? 0 : ((xx >> k) + (yy >> (k + 1))) % 2 ? 25 : -25;
    return base.map((c, i) => Math.max(0, Math.min(255, (c * (0.6 + 0.6 * g) + (i === 2 ? v * 40 : 0) + t + stripe) * dark)));
  });
}
for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(photos, `场景${i + 1}.png`), scene(i * 0.8, { period: 3 + (i % 4), vertical: i % 2 === 1 }));
for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(photos, `糊片${i + 1}.png`), scene(10 + i, { blur: true }));
seed = 777; const burstSeed = seed;
for (let i = 0; i < 4; i++) { seed = burstSeed; fs.writeFileSync(path.join(photos, `连拍${i + 1}.png`), scene(20, { shift: i * 2, period: 7 })); }
fs.writeFileSync(path.join(photos, '太暗.png'), scene(30, { dark: true }));

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [photos] });
dialog.showMessageBox = async () => ({ response: 1 });
app.on('browser-window-created', (_e, win) => win.hide());
require('../main');

let finished = false;
const timeout = setTimeout(() => finish(new Error('超时')), 120000);
async function finish(error) {
  if (finished) return; finished = true;
  clearTimeout(timeout);
  console.log(error ? '[FAIL] ' + (error.stack || error) : '[PASS] 朋友圈助手：引擎连接 / 文件夹导入 / canvas 分析 / 预筛挑图 / 换图 / 调色 / 排版 / 文案 / 导出 / 扫码网页');
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} app.exit(error ? 1 : 0); }, 500);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(check, what, ms = 30000) {
  for (let t = 0; t < ms; t += 100) { try { if (await check()) return; } catch (_) {} await sleep(100); }
  throw new Error('等待超时：' + what);
}
app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    const js = code => win.webContents.executeJavaScript(code);
    await wait(() => js("document.querySelectorAll('.ws-item').length > 0"), '工作区列表');
    await js("[...document.querySelectorAll('.ws-item')].find(e => e.querySelector('.nm').textContent === '朋友圈助手').click()");
    let frame;
    await wait(() => (frame = win.webContents.mainFrame.frames.find(f => f.url.includes('moments-agent'))) && true, '界面 iframe');
    const fj = code => frame.executeJavaScript(code);
    await wait(() => fj("document.getElementById('connect').classList.contains('hidden')"), '引擎连接', 20000);
    const shot = async name => fs.writeFileSync(path.join(__dirname, '..', `electron-moments-${name}.png`), (await win.webContents.capturePage()).toPNG());
    const click = sel => fj(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('找不到 ' + ${JSON.stringify(sel)}); el.click(); return true; })()`);
    const state = () => fj('app.st');
    const text = () => fj("document.getElementById('main').innerText");
    const log = () => fj("document.getElementById('log').innerText");

    // 冷启动问答 → 跳过
    if (await fj("app.view === 'prefs'")) await click('[data-act=obSkip]');
    await wait(async () => (await fj('app.view')) === 'import', '回到导入页');

    // 1. 从文件夹导入 + canvas 分析
    await click('[data-act=importFolder]');
    await wait(async () => (await state()).draft.photos.length === 16, '导入 16 张');
    await wait(async () => (await state()).draft.photos.every(p => p.metrics && p.thumb), '照片分析完成', 60000);
    await wait(() => fj("document.querySelectorAll('#main .ph img').length === 16"), '缩略图显示');
    await sleep(300); await shot('1-import');

    // 2. 挑照片（未配置 AI：按本地清晰度）
    await click('[data-step=pick]');
    await fj("document.getElementById('pickCount').value = '8'");
    await click('[data-act=runPick]');
    await wait(async () => (await state()).draft.pick.done && !(await fj("!!app.running['pick-photos']")), '挑照片完成', 30000);
    let st = await state();
    const name = id => st.draft.photos.find(p => p.id === id).name;
    const flags = st.draft.pick.flags;
    const blurry = st.draft.photos.filter(p => flags[p.id] && flags[p.id].blurry).map(p => p.name).sort();
    if (blurry.join() !== '糊片1.png,糊片2.png,糊片3.png') throw new Error('糊片识别不对：' + blurry.join());
    const burstIn = st.draft.pick.candidates.map(name).filter(n => n.startsWith('连拍'));
    if (burstIn.length !== 1) throw new Error('连拍应只剩 1 张进入候选：' + burstIn.join() + ' ' + JSON.stringify(st.draft.photos.map(p => [p.name, p.metrics.hash, Math.round(p.metrics.sharp), flags[p.id].group, flags[p.id].best])));
    if (!flags[st.draft.photos.find(p => p.name === '太暗.png').id].exposure) throw new Error('过暗没有标出');
    if (st.draft.pick.selected.length !== 8 || st.draft.pick.alternates.length !== 1) throw new Error('应挑出 8 张 + 1 张候补，实际 ' + st.draft.pick.selected.length);
    if (!/预筛/.test(await log())) throw new Error('输出区没有挑照片进度');
    // 换图：点入选第 1 张，再点候补第 1 张
    const before = st.draft.pick.selected[0];
    await click('#main .pick-item .ph[data-act=pickSel]');
    await click('#main [data-act=pickAlt]');
    await wait(async () => !(await state()).draft.pick.selected.includes(before), '换图');
    await sleep(300); await shot('2-pick');

    // 3. 调色：预设 + 一句话（离线规则）+ 复刻（本地颜色迁移）
    await click('[data-step=grade]');
    await wait(() => fj("document.getElementById('cvAfter') && document.getElementById('cvAfter').width > 0"), '对比预览');
    await click('[data-act=preset][data-id=film]');
    await wait(async () => (await state()).draft.grade.presetName === '胶片', '套用胶片');
    const t0 = (await state()).draft.grade.params.temperature;
    await fj("document.getElementById('gradeText').value = '再暖一点'");
    await click('[data-act=gradeText]');
    await wait(async () => (await state()).draft.grade.params.temperature > t0, '再暖一点', 15000);
    await sleep(500); await shot('3-grade');

    // 4. 排版（规则）+ 拖动后改张数
    await click('[data-step=layout]');
    await click('[data-act=runLayout]');
    await wait(async () => (await state()).draft.layout.order.length === 6, '排版 6 张（8 张入选 → 最多 6 张）', 15000);
    await wait(() => fj("document.querySelectorAll('#mgrid .ph').length === 6"), '朋友圈预览');
    await click('[data-act=setCount][data-n="4"]');
    await wait(async () => (await state()).draft.layout.order.length === 4, '改成 4 张');
    await wait(() => fj("document.querySelector('#mgrid').classList.contains('c2')"), '4 张 2×2 显示');
    await click('[data-act=setCount][data-n="6"]');
    await wait(async () => (await state()).draft.layout.order.length === 6, '改回 6 张');
    await sleep(300); await shot('4-layout');

    // 5. 文案（离线模板）
    await click('[data-step=caption]');
    await fj("document.getElementById('capOccasion').value = '周末去海边'");
    await click('[data-act=runCaption]');
    await wait(async () => (await state()).draft.caption.options.length >= 3, '生成文案', 15000);
    await click('[data-act=capChoose][data-i="0"]');
    await wait(() => fj("!!document.getElementById('capText')"), '选择文案');
    await sleep(200); await shot('5-caption');

    // 6. 导出（canvas 调色 + 上传 + 导出动作）
    await click('[data-step=export]');
    await click('[data-act=runExport]');
    await wait(async () => (await state()).draft.export.done, '导出完成', 60000);
    st = await state();
    const outDir = path.join(tmp, 'plugin-data', 'moments-agent', 'drafts', st.draft.id, '发布包');
    const files = fs.readdirSync(outDir).sort();
    if (files.join() !== '01.jpg,02.jpg,03.jpg,04.jpg,05.jpg,06.jpg,文案.txt') throw new Error('发布包内容不对：' + files.join());
    const j1 = fs.readFileSync(path.join(outDir, '01.jpg'));
    if (j1[0] !== 0xFF || j1[1] !== 0xD8 || j1.length < 20000) throw new Error('导出的不是正常 JPEG');
    if (fs.readFileSync(clipFile, 'utf8') !== st.draft.caption.text) throw new Error('文案没有复制到剪贴板');
    await wait(() => fj("!!document.querySelector('.qr svg')"), '存回手机二维码');
    const saveUrl = st.phone.export.url.replace(/\/\/[^/:]+:/, '//127.0.0.1:');
    const savePage = await (await fetch(saveUrl)).text();
    if (!/第 6 张/.test(savePage)) throw new Error('存回手机网页没有列出 6 张');
    await sleep(500); await shot('6-export');

    // 扫码传图：二维码显示、手机网页上传、完成后失效
    await click('#btnNewDraft');
    await wait(async () => (await state()).draft.photos.length === 0, '新草稿');
    await click('[data-act=importPhone]');
    await wait(() => fj("!!document.querySelector('.qr svg')"), '传图二维码', 15000);
    st = await state();
    const up = st.phone.import.url.replace(/\/\/[^/:]+:/, '//127.0.0.1:');
    const r = await fetch(up + '/upload?name=' + encodeURIComponent('手机照片.png'), { method: 'POST', headers: { 'content-type': 'image/png' }, body: scene(3) });
    if (r.status !== 200) throw new Error('手机上传失败 ' + r.status);
    await wait(async () => (await state()).draft.photos.length === 1, '电脑上显示手机照片');
    await wait(() => fj("document.querySelectorAll('#main .ph img').length === 1"), '手机照片缩略图', 15000);
    await shot('7-phone');
    await click('[data-act=stopPhone]');
    await wait(async () => !(await fj("!!app.running['import-phone']")), '结束传图', 10000);
    if ((await fetch(up)).status !== 410) throw new Error('完成后二维码应失效');
    finish();
  } catch (e) { finish(e); }
});
