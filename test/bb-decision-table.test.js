/**
 * 黑盒测试（二）：因果图 + 决策表
 * ------------------------------------------------------------------
 * 被测对象（SUT）：
 *   功能点 F2 动作执行决策   ← 通道 wb:run
 *   功能点 F4 工作区安装决策 ← 通道 wb:installPackage
 *
 * 方法：
 *   1. 先画因果图（原因 → 结果的逻辑关系与约束）；
 *   2. 把因果图转换成决策表（Condition / Action，含"无关"项），
 *      每一列规则对应一条测试用例；
 *   3. 表格驱动执行，逐条断言。
 *
 * 运行：node test/bb-decision-table.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { boot } = require('./lib/harness');

let pass = 0, fail = 0;
function check(id, name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + id + '  ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + id + '  ' + name + '\n      ' + e.message); }
}

/* ═══════════════════════════════════════════════════════════════════
   因果图 1：动作执行决策（wb:run）

      C1 命令非空 ─────────────┬──► E1 「缺少命令」
                               │
      C2 去空格后非空 ─────────┼──► E2 「没有声明命令」
                               │
      C3 声明了 cwd  ──┐       │
                       ├─AND──►│
      C4 cwd 存在 ─────┘       │
          （C3 为假时 C4 无关）├──► E3 「工作目录不存在」
                               │
                               ├──► E4 以「工作区包目录」启动
                               └──► E5 以「声明目录」启动

   约束：
     · C1 是 C2 的必要条件（C1 假 ⇒ C2 必假）——包含约束
     · C3 为假时 C4 取「无关（-）」
     · E1~E5 互斥（O 约束）
   ═══════════════════════════════════════════════════════════════════ */

/* 决策表 1：5 条规则 */
const DT_RUN = [
  { rule: 'R1', C1: 'N', C2: '-', C3: '-', C4: '-', act: 'A1 拒绝：缺少命令',
    spec: { command: undefined } },
  { rule: 'R2', C1: 'Y', C2: 'N', C3: '-', C4: '-', act: 'A2 拒绝：没有声明命令',
    spec: { command: '   ' } },
  { rule: 'R3', C1: 'Y', C2: 'Y', C3: 'N', C4: '-', act: 'A4 以工作区包目录启动',
    spec: { command: 'echo 1' } },
  { rule: 'R4', C1: 'Y', C2: 'Y', C3: 'Y', C4: 'Y', act: 'A3 以声明目录启动',
    spec: { command: 'echo 1', cwd: 'ABS_OK' } },
  { rule: 'R5', C1: 'Y', C2: 'Y', C3: 'Y', C4: 'N', act: 'A5 拒绝：工作目录不存在',
    spec: { command: 'echo 1', cwd: 'no-such-dir-xyz' } }
];

/* ═══════════════════════════════════════════════════════════════════
   因果图 2：工作区安装决策（wb:installPackage）

      C1 目标目录含合法清单 ──┬──────────► E1 返回错误，不安装
                              │
      C2 软件目录已有同 id ───┼─AND──────► E2 弹出「覆盖安装 / 取消」
                              │
      C3 用户选择「覆盖安装」─┘           ├─► E3 取消，保留原样
                                          └─► E4 复制进软件目录并登记

   约束：C2 为假时 C3 取「无关（-）」；E3 与 E4 互斥。
   ═══════════════════════════════════════════════════════════════════ */

/* 决策表 2：4 条规则 */
const DT_INSTALL = [
  { rule: 'S1', C1: 'N', C2: '-', C3: '-', act: 'E1 返回错误，不安装' },
  { rule: 'S2', C1: 'Y', C2: 'N', C3: '-', act: 'E4 复制进软件目录' },
  { rule: 'S3', C1: 'Y', C2: 'Y', C3: 'Y', act: 'E4 覆盖安装' },
  { rule: 'S4', C1: 'Y', C2: 'Y', C3: 'N', act: 'E3 取消，保留原样' }
];

(async function main() {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = function () { warnings.push(1); };

  const app = boot();
  await app.ready();

  /* 准备：一个合法工作区包（含 tools 子目录） */
  const pkgDir = app.writePackage('dt-demo',
    { name: 'DT 演示', icon: '🧪', actions: [{ id: 'a1', title: 'T', command: 'echo 1' }] },
    { 'tools/keep.txt': 'ok' });
  const absCwd = path.join(app.userData, 'abs-cwd');
  fs.mkdirSync(absCwd, { recursive: true });

  /* ── 决策表 1 ─────────────────────────────────────────────── */
  console.log('\n═══ 决策表 1：动作执行决策（wb:run）═══');
  console.log('  规则 | C1 命令非空 | C2 去空格非空 | C3 声明 cwd | C4 cwd 存在 | 动作');
  DT_RUN.forEach(function (r) {
    console.log('  ' + r.rule + '   |     ' + r.C1 + '      |      ' + r.C2 + '      |     ' +
                r.C3 + '      |     ' + r.C4 + '      | ' + r.act);
  });
  console.log('');

  for (const r of DT_RUN) {
    const before = app.state.children.length;
    const spec = Object.assign({ workspaceId: 'dt-demo', actionId: 'a1' }, r.spec);
    if (spec.cwd === 'ABS_OK') spec.cwd = absCwd;
    const res = await app.invoke('wb:run', spec);
    const spawned = app.state.children.length - before;

    check(r.rule, r.act, function () {
      if (r.rule === 'R1') {
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error, '缺少命令');
      } else if (r.rule === 'R2') {
        assert.strictEqual(res.ok, false);
        assert.ok(/没有声明命令/.test(res.error), '实际：' + res.error);
      } else if (r.rule === 'R3') {
        assert.strictEqual(res.ok, true);
        assert.strictEqual(app.lastChild().options.cwd, pkgDir);
      } else if (r.rule === 'R4') {
        assert.strictEqual(res.ok, true);
        assert.strictEqual(app.lastChild().options.cwd, absCwd);
      } else if (r.rule === 'R5') {
        assert.strictEqual(res.ok, false);
        assert.ok(/工作目录不存在/.test(res.error), '实际：' + res.error);
      }
      if (r.rule === 'R1' || r.rule === 'R2' || r.rule === 'R5') {
        assert.strictEqual(spawned, 0, '拒绝时不应启动进程');
      } else {
        assert.strictEqual(spawned, 1, '应启动且只启动 1 个进程');
      }
    });
  }

  /* 补充：因果图里被合并的等价情形 */
  console.log('');
  const extra = [
    { id: 'C1-a', command: null, msg: '缺少命令' },
    { id: 'C1-b', command: '', msg: '缺少命令' },
    { id: 'C2-a', command: ' ', msg: '没有声明命令' },
    { id: 'C2-b', command: '\t\n  ', msg: '没有声明命令' }
  ];
  for (const e of extra) {
    const before = app.state.children.length;
    const res = await app.invoke('wb:run', { workspaceId: 'dt-demo', actionId: 'a1', command: e.command });
    check(e.id, '因果图边界：command = ' + JSON.stringify(e.command), function () {
      assert.strictEqual(res.ok, false);
      assert.ok(new RegExp(e.msg).test(res.error), '实际：' + res.error);
      assert.strictEqual(app.state.children.length - before, 0);
    });
  }

  /* 相对 cwd 存在（C3=Y, C4=Y 的相对子情形） */
  const relBefore = app.state.children.length;
  const relRes = await app.invoke('wb:run',
    { workspaceId: 'dt-demo', actionId: 'a1', command: 'echo 1', cwd: 'tools' });
  check('C4-rel', 'C3=Y,C4=Y（相对路径）→ 以「包目录\\tools」启动', function () {
    assert.strictEqual(relRes.ok, true);
    assert.strictEqual(app.state.children.length - relBefore, 1);
    assert.strictEqual(app.lastChild().options.cwd, path.join(pkgDir, 'tools'));
  });

  /* ── 决策表 2 ─────────────────────────────────────────────── */
  console.log('\n═══ 决策表 2：工作区安装决策（wb:installPackage）═══');
  console.log('  规则 | C1 清单合法 | C2 已有同 id | C3 选覆盖 | 动作');
  DT_INSTALL.forEach(function (r) {
    console.log('  ' + r.rule + '   |     ' + r.C1 + '      |     ' + r.C2 +
                '      |    ' + r.C3 + '    | ' + r.act);
  });
  console.log('');

  /* S1：清单非法 */
  const badDir = path.join(app.userData, 'bad-src');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'manifest.json'), '{ "name": "x" }', 'utf8');
  const s1 = await app.invoke('wb:installPackage', badDir);
  check('S1', 'E1 清单非法 → 返回错误且不安装', function () {
    assert.strictEqual(s1.ok, false);
    assert.ok(/actions/.test(s1.error), '实际：' + s1.error);
    assert.strictEqual(fs.existsSync(path.join(app.userData, 'workspaces', 'bad-src')), false);
  });

  /* S2：首次安装 */
  const srcDir = path.join(app.userData, 'src-pkg');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'manifest.json'),
    JSON.stringify({ id: 'dt-install', name: '第一版', actions: [{ title: 'T', command: 'echo 1' }] }), 'utf8');
  const s2 = await app.invoke('wb:installPackage', srcDir);
  const installedDir = path.join(app.userData, 'workspaces', 'dt-install');
  check('S2', 'E4 无同名 → 复制进软件目录', function () {
    assert.strictEqual(s2.ok, true);
    assert.strictEqual(fs.existsSync(path.join(installedDir, 'manifest.json')), true);
  });

  /* S3：同名 + 用户选「覆盖安装」 */
  fs.writeFileSync(path.join(srcDir, 'manifest.json'),
    JSON.stringify({ id: 'dt-install', name: '第二版', actions: [{ title: 'T', command: 'echo 2' }] }), 'utf8');
  app.state.dialog.messageBoxAnswer = 0;                 // 0 = 覆盖安装
  const s3 = await app.invoke('wb:installPackage', srcDir);
  check('S3', 'E4 同名 + 选覆盖 → 文件被替换', function () {
    assert.strictEqual(s3.ok, true);
    const m = JSON.parse(fs.readFileSync(path.join(installedDir, 'manifest.json'), 'utf8'));
    assert.strictEqual(m.name, '第二版');
  });

  /* S4：同名 + 用户选「取消」 */
  fs.writeFileSync(path.join(srcDir, 'manifest.json'),
    JSON.stringify({ id: 'dt-install', name: '第三版', actions: [{ title: 'T', command: 'echo 3' }] }), 'utf8');
  app.state.dialog.messageBoxAnswer = 1;                 // 1 = 取消
  const s4 = await app.invoke('wb:installPackage', srcDir);
  check('S4', 'E3 同名 + 选取消 → 返回 canceled 且原文件不变', function () {
    assert.strictEqual(s4.ok, false);
    assert.strictEqual(s4.canceled, true);
    const m = JSON.parse(fs.readFileSync(path.join(installedDir, 'manifest.json'), 'utf8'));
    assert.strictEqual(m.name, '第二版', '取消后不应被改动');
  });

  console.warn = realWarn;
  console.log('\n────────────────────────────────────────────');
  console.log('因果图 + 决策表：' + pass + ' 通过，' + fail + ' 失败（共 ' + (pass + fail) + ' 条）');
  app.cleanup();
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) {
  console.error('测试脚手架异常：', e);
  process.exitCode = 2;
});
