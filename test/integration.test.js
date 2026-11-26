/**
 * 集成测试：桩（stub）+ 驱动（driver）
 * ------------------------------------------------------------------
 * 被测对象：主进程 main.js 与渲染进程之间的接口契约，以及
 *           "工作区扫描 → 执行 → 事件回传 → 停止回收 → 卸载"的完整链路。
 *
 * 为什么需要桩和驱动（题目第 3 题）：
 *   工作台是 Electron 应用，一次真实运行要开窗口、连渲染进程、起真实子进程，
 *   在 CI/命令行里既慢又不可控。于是：
 *     · 驱动（driver）：test/lib/harness.js 里的 boot()，加载真实 main.js，
 *       收集它注册的 ipcMain 通道，用 invoke() 扮演"界面"去调用；
 *     · 桩（stub）：把 electron（窗口/对话框/协议）和 child_process
 *       （spawn/exec）换成可控的假实现——可以随时让"子进程"输出、
 *       以任意退出码结束，或让"用户"在对话框里选覆盖/取消。
 *   这样测的是真实的主进程逻辑 + 真实的文件系统，只有"外部世界"是假的。
 *
 * 运行：node test/integration.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { boot, ROOT } = require('./lib/harness');

let pass = 0, fail = 0;
function check(id, name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + id + '  ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + id + '  ' + name + '\n      ' + e.message); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function main() {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = function () { warnings.push(1); };

  const app = boot();
  await app.ready();

  const pkgDir = app.writePackage('it-demo', {
    name: '集成测试工作区', icon: '🔌',
    actions: [
      { id: 'ok', title: '正常动作', command: 'echo hello' },
      { id: 'badcwd', title: '坏目录动作', command: 'echo x', cwd: 'no-such-dir' }
    ]
  }, { 'tools/keep.txt': 'ok' });

  console.log('═══ 一、接口契约（主进程 ↔ 渲染进程）═══\n');

  check('I-01', '13 个 IPC 通道全部注册', function () {
    const need = ['wb:listWorkspaces', 'wb:workspaceDir', 'wb:run', 'wb:stop',
      'wb:pickPackage', 'wb:installPackage', 'wb:uninstall', 'wb:exportPackage',
      'wb:openPath', 'wb:winMinimize', 'wb:winToggleMaximize', 'wb:winClose',
      'wb:winIsMaximized'];
    const missing = need.filter(function (c) { return !app.has(c); });
    assert.deepStrictEqual(missing, [], '缺失通道：' + missing.join(','));
  });

  check('I-02', "生命周期钩子 window-all-closed 已注册（关窗回收子进程）", function () {
    assert.strictEqual(typeof app.state.appOn['window-all-closed'], 'function');
  });

  check('I-03', 'wsp:// 自定义协议处理器已注册（沙箱界面资源通道）', function () {
    assert.strictEqual(typeof app.state.protocolHandler, 'function');
  });

  const list = await app.invoke('wb:listWorkspaces');
  check('I-04', '扫描链路：内置 4 个 + 用户目录 1 个 = 5 个工作区', function () {
    assert.strictEqual(list.length, 5, '实际 ' + list.map(function (w) { return w.id; }).join(','));
    assert.strictEqual(list.filter(function (w) { return w.builtin; }).length, 4);
  });

  console.log('\n═══ 二、"执行动作"链路：校验 → 启动 → 输出 → 结束 ═══\n');

  app.clear();
  const before = app.state.children.length;
  const r1 = await app.invoke('wb:run', { workspaceId: 'it-demo', actionId: 'ok', command: 'echo hello' });

  check('I-05', 'run 返回 { ok:true, runId, pid }', function () {
    assert.strictEqual(r1.ok, true);
    assert.ok(/^run-/.test(r1.runId), 'runId 格式：' + r1.runId);
    assert.ok(r1.pid > 0, 'pid：' + r1.pid);
  });

  check('I-06', '子进程被启动 1 次，且工作目录为工作区包目录', function () {
    assert.strictEqual(app.state.children.length - before, 1);
    assert.strictEqual(app.lastChild().options.cwd, pkgDir);
  });

  check('I-07', 'Windows 编码保护：命令前缀 chcp 65001>nul &', function () {
    assert.strictEqual(app.lastChild().command, 'chcp 65001>nul & echo hello');
  });

  const started = app.eventsOf('started');
  check('I-08', 'started 事件携带 runId / actionId / command / cwd / pid', function () {
    assert.strictEqual(started.length, 1);
    const e = started[0];
    assert.strictEqual(e.runId, r1.runId);
    assert.strictEqual(e.actionId, 'ok');
    assert.strictEqual(e.command, 'echo hello');
    assert.strictEqual(e.cwd, pkgDir);
    assert.strictEqual(e.pid, r1.pid);
  });

  app.emitStdout('hello\n');
  app.emitStderr('a warning\n');
  const outs = app.eventsOf('output');
  check('I-09', 'stdout / stderr 分别以 stream 字段回传给界面', function () {
    assert.strictEqual(outs.length, 2);
    assert.strictEqual(outs[0].stream, 'stdout');
    assert.strictEqual(outs[0].text, 'hello\n');
    assert.strictEqual(outs[1].stream, 'stderr');
    assert.strictEqual(outs[1].text, 'a warning\n');
  });

  app.emitExit(0);
  await sleep(10);
  const exits = app.eventsOf('exit');
  check('I-10', 'exit 事件带退出码、耗时与"未被停止"标记', function () {
    assert.strictEqual(exits.length, 1);
    assert.strictEqual(exits[0].code, 0);
    assert.strictEqual(exits[0].stopped, false);
    assert.ok(parseFloat(exits[0].duration) >= 0, 'duration：' + exits[0].duration);
  });

  check('I-11', '事件顺序严格为 started → output → exit', function () {
    assert.deepStrictEqual(app.state.events.map(function (e) { return e.type; }),
      ['started', 'output', 'output', 'exit']);
  });

  console.log('\n═══ 三、"停止动作"链路：进程树回收 ═══\n');

  app.clear();
  const execBefore = app.state.execCalls.length;
  const r2 = await app.invoke('wb:run', { workspaceId: 'it-demo', actionId: 'ok', command: 'ping -t 127.0.0.1' });
  const pid2 = app.lastChild().child.pid;
  const stopRes = await app.invoke('wb:stop', r2.runId);

  check('I-12', 'stop 返回 ok:true', function () {
    assert.strictEqual(stopRes.ok, true);
  });

  check('I-13', '停止时发出 taskkill /pid <pid> /T /F（杀整棵进程树）', function () {
    const calls = app.state.execCalls.slice(execBefore);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], 'taskkill /pid ' + pid2 + ' /T /F');
  });

  app.emitExit(1);
  await sleep(10);
  const exits2 = app.eventsOf('exit');
  check('I-14', '被停止的进程在 exit 事件里标记 stopped:true', function () {
    assert.strictEqual(exits2.length, 1);
    assert.strictEqual(exits2[0].stopped, true);
  });

  const stopAgain = await app.invoke('wb:stop', r2.runId);
  check('I-15', '重复停止已结束的动作 → 返回错误而非抛异常', function () {
    assert.strictEqual(stopAgain.ok, false);
    assert.ok(/已经结束/.test(stopAgain.error), '实际：' + stopAgain.error);
  });

  console.log('\n═══ 四、校验先于副作用：坏工作目录不产生任何进程 ═══\n');

  app.clear();
  const childBefore = app.state.children.length;
  const r3 = await app.invoke('wb:run', { workspaceId: 'it-demo', actionId: 'badcwd', command: 'echo x', cwd: 'no-such-dir' });
  check('I-16', 'cwd 不存在 → 返回 { ok:false }，且不 spawn、不发 started', function () {
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(app.state.children.length, childBefore, '不应启动进程');
    assert.strictEqual(app.eventsOf('started').length, 0, '不应发 started 事件');
    assert.ok(/工作目录不存在/.test(r3.error), '实际：' + r3.error);
  });

  console.log('\n═══ 五、安装 / 卸载 往返 ═══\n');

  const src = path.join(app.userData, 'roundtrip-src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({
    id: 'it-roundtrip', name: '往返包', actions: [{ title: 'T', command: 'echo 1' }]
  }), 'utf8');
  const ins = await app.invoke('wb:installPackage', src);
  const dest = path.join(app.userData, 'workspaces', 'it-roundtrip');
  check('I-17', 'installPackage 把包装进软件目录，原始目录仍在', function () {
    assert.strictEqual(ins.ok, true);
    assert.strictEqual(fs.existsSync(path.join(dest, 'manifest.json')), true);
    assert.strictEqual(fs.existsSync(path.join(src, 'manifest.json')), true);
  });

  const list2 = await app.invoke('wb:listWorkspaces');
  check('I-18', '安装后立即可被扫描到（无需重启）', function () {
    assert.ok(list2.some(function (w) { return w.id === 'it-roundtrip'; }));
  });

  const un = await app.invoke('wb:uninstall', dest);
  const list3 = await app.invoke('wb:listWorkspaces');
  check('I-19', '卸载后从列表消失，软件目录里的那份被删除', function () {
    assert.strictEqual(un.deleted, true);
    assert.strictEqual(fs.existsSync(dest), false);
    assert.strictEqual(list3.some(function (w) { return w.id === 'it-roundtrip'; }), false);
  });

  const builtin = list3.find(function (w) { return w.builtin; });
  const unBuiltin = await app.invoke('wb:uninstall', builtin.dir);
  check('I-20', '卸载内置工作区不会删除磁盘文件（保护内置包）', function () {
    assert.strictEqual(unBuiltin.deleted, false);
    assert.strictEqual(fs.existsSync(builtin.dir), true);
  });

  console.log('\n═══ 六、wsp:// 协议（沙箱自定义界面的资源通道）═══\n');

  const base = 'wsp://local/' + encodeURIComponent('霓虹看板');

  const okRes = await app.state.protocolHandler({ url: base + '/ui/index.html' });
  const okBody = await okRes.text();
  check('I-21', '读取工作区内的 ui/index.html → 200 且 content-type 为 text/html', function () {
    assert.strictEqual(okRes.status, 200);
    assert.strictEqual(okRes.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok(okBody.length > 100, '正文长度：' + okBody.length);
  });

  const travRes = await app.state.protocolHandler({ url: base + '/%5C..%5C..%5Cmain.js' });
  check('I-22', '目录穿越（编码反斜杠 %5C..）→ 403 拒绝，读不到包外文件', function () {
    assert.strictEqual(travRes.status, 403);
  });

  const dotRes = await app.state.protocolHandler({ url: base + '/%2e%2e/%2e%2e/main.js' });
  check('I-22b', '目录穿越（%2e%2e）被 URL 规范化削掉 → 退化为 400（第一道防线）', function () {
    assert.strictEqual(dotRes.status, 400);
  });

  const missRes = await app.state.protocolHandler({ url: 'wsp://local/no-such-ws/ui/index.html' });
  check('I-23', '未知工作区 → 404', function () {
    assert.strictEqual(missRes.status, 404);
  });

  const rootRes = await app.state.protocolHandler({ url: 'wsp://local/%E5%9F%BA%E7%A1%80%E5%B7%A5%E4%BD%9C' });
  check('I-24', '路径段不足（没有包内相对路径）→ 400 拒绝', function () {
    assert.strictEqual(rootRes.status, 400);
  });

  console.log('\n═══ 七、导入 / 导出 / 窗口控制 ═══\n');

  const wsDirRes = await app.invoke('wb:workspaceDir');
  check('I-25', 'wb:workspaceDir 返回并创建"工作区文件夹"', function () {
    assert.strictEqual(wsDirRes.ok, true);
    assert.strictEqual(fs.existsSync(wsDirRes.dir), true);
    assert.strictEqual(wsDirRes.dir, path.join(app.userData, 'workspaces'));
  });

  /* 选择目录（对话框是桩）→ 校验清单 */
  app.state.dialog.openDialogResult = [pkgDir];
  const picked = await app.invoke('wb:pickPackage');
  check('I-26', 'wb:pickPackage 选中合法包 → 返回清单交给界面预览', function () {
    assert.strictEqual(picked.ok, true);
    assert.strictEqual(picked.manifest.name, '集成测试工作区');
  });

  app.state.dialog.openDialogResult = [badDir2()];
  const pickedBad = await app.invoke('wb:pickPackage');
  check('I-27', 'wb:pickPackage 选中非法包 → 返回错误而不抛异常', function () {
    assert.strictEqual(pickedBad.ok, false);
    assert.ok(typeof pickedBad.error === 'string' && pickedBad.error.length > 0);
  });

  function badDir2() {
    const d = path.join(app.userData, 'pick-bad');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), '{ "actions": [] }', 'utf8');
    return d;
  }

  const exportTo = fs.mkdtempSync(path.join(app.userData, 'export-'));
  app.state.dialog.openDialogResult = [exportTo];
  const exp = await app.invoke('wb:exportPackage', 'it-demo');
  check('I-28', 'wb:exportPackage 生成可被再次导入的 manifest.json', function () {
    assert.strictEqual(exp.ok, true);
    const file = path.join(exportTo, 'it-demo', 'manifest.json');
    assert.strictEqual(fs.existsSync(file), true);
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(m.id, 'it-demo');
    assert.strictEqual(m.actions.length, 2);
    assert.strictEqual(m.actions[0].command, 'echo hello');
  });

  await app.invoke('wb:openPath', app.userData);
  check('I-29', 'wb:openPath 透传到 shell.openPath（不抛异常）', function () {
    const calls = app.state.shellCalls;
    assert.ok(calls.length >= 1, 'shell.openPath 未被调用');
    assert.strictEqual(calls[calls.length - 1], app.userData);
  });

  const max1 = await app.invoke('wb:winIsMaximized');
  const max2 = await app.invoke('wb:winToggleMaximize');
  const max3 = await app.invoke('wb:winToggleMaximize');
  await app.invoke('wb:winMinimize');
  check('I-30', '窗口控制：最大化/还原/最小化按系统习惯切换', function () {
    assert.strictEqual(max1.maximized, false);
    assert.strictEqual(max2.maximized, true);
    assert.strictEqual(max3.maximized, false);
    assert.strictEqual(app.state.window.minimized, true);
  });

  await app.invoke('wb:winClose');
  check('I-31', 'wb:winClose 关闭窗口', function () {
    assert.strictEqual(app.state.window.destroyed, true);
  });

  console.warn = realWarn;
  console.log('\n────────────────────────────────────────────');
  console.log('集成测试（桩 + 驱动）：' + pass + ' 通过，' + fail + ' 失败（共 ' + (pass + fail) + ' 条）');
  app.cleanup();
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) {
  console.error('测试脚手架异常：', e);
  process.exitCode = 2;
});
