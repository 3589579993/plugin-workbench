/**
 * 演示脚本：说明"黑盒/集成测试在终端里到底做了什么"。
 * 运行：node test/demo-terminal.js
 */
const { boot } = require('./lib/harness');

(async () => {
  const app = boot();
  await app.ready();

  console.log('① 主进程加载成功，注册的 IPC 通道数：', app.channels().length);
  console.log('   通道列表：', app.channels().join(', '));

  const ws = await app.invoke('wb:listWorkspaces');
  console.log('② 扫描工作区：', ws.map(w => w.name).join(' / '));

  const before = app.state.children.length;
  const r = await app.invoke('wb:run', {
    workspaceId: ws[0].id, actionId: 'demo', command: 'echo hello'
  });
  console.log('③ 调用 wb:run 返回：', JSON.stringify(r));
  console.log('   实际被"启动"的子进程命令：', app.lastChild().command);
  console.log('   它的工作目录：', app.lastChild().options.cwd);
  console.log('   真实进程数量变化：', before, '->', app.state.children.length);

  app.emitStdout('hello\n');
  app.emitStderr('oops\n');
  app.emitExit(0);
  await new Promise(x => setTimeout(x, 20));
  console.log('④ 回传给界面的三类事件：',
    app.state.events.map(e => e.type).join(' -> '));

  app.clear();
  const r2 = await app.invoke('wb:run', {
    workspaceId: ws[0].id, actionId: 'demo', command: 'echo hi', cwd: 'not-exist'
  });
  console.log('⑤ 坏目录的用例：', JSON.stringify(r2),
    '| 又起了进程吗？', app.state.children.length === 1 ? '没有' : '有');

  app.cleanup();
})();
