/**
 * 按 lec8 的边界值分析法（min / min+ / nom / max− / max，单缺陷假设）补测上界点。
 * 运行：node test/bb-bva-check.js
 */
'use strict';

const assert = require('assert');
const { boot } = require('./lib/harness');

let pass = 0, fail = 0;
function check(id, name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + id + '  ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + id + '  ' + name + '\n      ' + e.message); }
}

(async function main() {
  const warn = console.warn;
  console.warn = function () {};

  const app = boot();
  await app.ready();

  const mkActions = n => Array.from({ length: n }, (_, i) => ({ title: 'T' + i, command: 'echo ' + i }));
  const N_ACTIONS = [0, 1, 2, 10, 19, 20];
  const LEN_CMD = [0, 1, 2, 256, 511, 512];
  const LEN_NAME = [0, 1, 2, 20, 39, 40];

  N_ACTIONS.forEach(n => {
    app.writePackage('n-' + n, { name: 'N' + n, actions: mkActions(n) });
  });
  LEN_NAME.forEach(n => {
    app.writePackage('name-' + n, { name: 'x'.repeat(n), actions: [{ title: 'T', command: 'echo 1' }] });
  });

  const list = await app.invoke('wb:listWorkspaces');
  const ids = new Set(list.map(w => w.id));
  console.warn = warn;

  console.log('═══ 边界值分析：动作数量（设计范围 1–20）═══\n');
  check('BV-n0', 'min 越界：0 个动作 → 拒绝', () => assert.ok(!ids.has('n-0')));
  [1, 2, 10, 19, 20].forEach(n => {
    check('BV-n' + n, '动作数 = ' + n + ' → 接受', () => assert.ok(ids.has('n-' + n)));
  });

  console.log('\n═══ 边界值分析：命令长度（设计范围 1–512）═══\n');
  const ws = 'n-1';
  app.clear();
  for (const L of LEN_CMD) {
    const cmd = 'x'.repeat(L);
    const before = app.state.children.length;
    const r = await app.invoke('wb:run', { workspaceId: ws, actionId: 'a', command: cmd });
    if (L === 0) {
      check('BV-L0', '命令长度 = 0 → 拒绝且不起进程', () => {
        assert.strictEqual(r.ok, false);
        assert.strictEqual(app.state.children.length - before, 0);
      });
    } else {
      check('BV-L' + L, '命令长度 = ' + L + ' → 启动', () => {
        assert.strictEqual(r.ok, true);
        assert.strictEqual(app.state.children.length - before, 1);
      });
    }
  }

  console.log('\n═══ 边界值分析：工作区名称长度（设计范围 1–40）═══\n');
  check('BV-N0', '名称长度 = 0 → 拒绝', () => assert.ok(!ids.has('name-0')));
  [1, 2, 20, 39, 40].forEach(n => {
    check('BV-N' + n, '名称长度 = ' + n + ' → 接受', () => assert.ok(ids.has('name-' + n)));
  });

  console.log('\n═══ 边界值分析：工作目录存在性 ═══\n');
  const r1 = await app.invoke('wb:run', { workspaceId: ws, actionId: 'a', command: 'echo 1', cwd: 'no-such' });
  check('BV-cwd0', '目录不存在 → 拒绝', () => assert.strictEqual(r1.ok, false));
  const r2 = await app.invoke('wb:run', { workspaceId: ws, actionId: 'a', command: 'echo 1' });
  check('BV-cwd1', '用默认包目录 → 启动', () => assert.strictEqual(r2.ok, true));

  console.log('\n────────────────────────────────────────────');
  console.log('边界值补充测试：' + pass + ' 通过，' + fail + ' 失败（共 ' + (pass + fail) + ' 条）');
  app.cleanup();
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 2; });
