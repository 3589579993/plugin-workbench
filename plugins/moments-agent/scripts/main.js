'use strict';
// 朋友圈助手的所有动作都从这里进：
//   engine        启动引擎（常驻服务，界面打开时自动启动；点「■ 停止」关闭）
//   engine-info   界面重新打开时，查询正在运行的引擎地址
//   其他          执行对应步骤：连到引擎，把进度显示在输出区
const fs = require('fs');
const sdk = require(process.env.WB_SDK_PATH);

const action = process.argv[2];
const infoFile = () => sdk.dataFile('engine.json');
const NOT_RUNNING = '[失败] 朋友圈助手引擎没有运行。建议：打开「朋友圈助手」界面（会自动启动引擎），或先点「启动引擎」';

function readInfo() {
  try { return JSON.parse(fs.readFileSync(infoFile(), 'utf8')); } catch (_) { return null; }
}
async function ping(info) {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/ping`, { headers: { 'x-token': info.token }, signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch (_) { return false; }
}

async function runEngine() {
  const old = readInfo();
  if (old && await ping(old)) {
    console.log('[警告] 引擎已经在运行');
    await sdk.request('publish', { name: 'engine-ready', data: { port: old.port, token: old.token } });
    return;
  }
  const { createEngine } = require('./engine');
  // 回归测试时把"复制到剪贴板"改写到文件，避免覆盖测试者自己的剪贴板
  const clip = process.env.MOMENTS_CLIPBOARD_FILE;
  const engine = createEngine({ dataDir: process.env.WB_DATA_DIR, sdk, ...(clip ? { clipboard: t => fs.writeFileSync(clip, t, 'utf8') } : {}) });
  const port = await engine.listen();
  fs.writeFileSync(infoFile(), JSON.stringify({ port, token: engine.token, pid: process.pid }), { encoding: 'utf8', mode: 0o600 });
  console.log(`[OK] 朋友圈助手引擎已启动（只在本机端口 ${port} 上提供给界面使用）`);
  await sdk.request('publish', { name: 'engine-ready', data: { port, token: engine.token } });
  console.log('提示：请在界面里操作。点这个动作的「■ 停止」会关闭引擎');
  const quit = () => {
    try { const i = readInfo(); if (i && i.pid === process.pid) fs.rmSync(infoFile(), { force: true }); } catch (_) {}
    engine.close();
    process.exit(0);
  };
  process.on('SIGTERM', quit); process.on('SIGINT', quit);
  process.on('disconnect', quit);   // 工作台关闭
  const hostPid = Number(process.env.WB_HOST_PID);
  if (hostPid) setInterval(() => { try { process.kill(hostPid, 0); } catch (_) { quit(); } }, 5000).unref();
  await new Promise(() => {});      // 一直运行
}

async function runInfo() {
  const info = readInfo();
  if (!info || !await ping(info)) { console.log(NOT_RUNNING); process.exitCode = 1; return; }
  await sdk.request('publish', { name: 'engine-ready', data: { port: info.port, token: info.token } });
}

async function runStep(step) {
  const info = readInfo();
  if (!info || !await ping(info)) { console.log(NOT_RUNNING); process.exitCode = 1; return; }
  let body = {};
  if (step === 'import-folder') {
    const folder = await sdk.request('folder', { title: '选择照片所在的文件夹' });
    if (!folder) return sdk.cancelled();
    body = { folder };
  }
  const res = await fetch(`http://127.0.0.1:${info.port}/api/step/${step}`, {
    method: 'POST', headers: { 'x-token': info.token, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) { let e = ''; try { e = (await res.json()).error; } catch (_) {} console.log('[失败] ' + (e || '引擎返回错误 ' + res.status)); process.exitCode = 1; return; }
  const decoder = new TextDecoder();
  let buf = '', code = 1;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = /^@@EXIT (\d+)$/.exec(line);
      if (m) code = Number(m[1]); else console.log(line);
    }
  }
  process.exitCode = code;
}

sdk.main(async () => {
  if (action === 'engine') return runEngine();
  if (action === 'engine-info') return runInfo();
  if (!action) throw new Error('缺少动作参数');
  return runStep(action);
});
