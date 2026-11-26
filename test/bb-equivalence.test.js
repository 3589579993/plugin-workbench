/**
 * 黑盒测试（一）：等价类划分 + 边界值分析
 * ------------------------------------------------------------------
 * 被测对象（SUT）：可插件化工作台 v0.1
 *   功能点 F1 工作区装载与列表   ← 通道 wb:listWorkspaces
 *   功能点 F2 动作执行入口校验   ← 通道 wb:run
 *
 * 方法：
 *   等价类划分 —— 把"manifest.json 的输入"和"wb:run 的入参"划分成
 *                有效等价类（应被接受）与无效等价类（应被拒绝），
 *                每个类取一个代表值。
 *   边界值分析 —— 对每个有序输入域取 下界 / 下界+1 / 上界-1 / 上界 等
 *                边界点（如 actions 长度 0 与 1，空串与单字符）。
 *
 * 判定依据来自需求文档（README §4 清单字段表、§6 已知限制）与
 * 需求分析报告 FR-1/FR-2/NFR-9，不看实现细节（黑盒）。
 *
 * 运行：node test/bb-equivalence.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { boot } = require('./lib/harness');

let pass = 0, fail = 0, caseNo = 0;
function check(id, name, fn) {
  caseNo++;
  try { fn(); pass++; console.log('  ✓ ' + id + ' ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + id + ' ' + name + '\n      ' + e.message); }
}

/* ═══════════════════════════════════════════════════════════════════
   一、等价类划分：工作区清单（manifest.json）
   有效等价类 V1 ~ V4 ／ 无效等价类 I1 ~ I9
   ═══════════════════════════════════════════════════════════════════ */
const EC_CASES = [
  /* id      等价类                           manifest                                      期望 */
  { id: 'V1', cls: '有效-最小完整包', listed: true,
    m: { name: '最小工作区', actions: [{ title: '看时间', command: 'echo %TIME%' }] } },

  { id: 'V2', lookupId: 'v2-full', cls: '有效-全字段包', listed: true,
    m: { id: 'v2-full', name: '全字段', icon: '🧪', description: '说明', version: '2.3.1',
         permissions: ['exec'], actions: [
           { id: 'a1', title: 'A', command: 'echo a', cwd: 'tools', mode: 'service' },
           { id: 'a2', title: 'B', command: 'echo b' }] } },

  { id: 'V3', cls: '有效-BOM 开头的清单', listed: true,
    m: '\uFEFF' + JSON.stringify({ name: '带BOM', actions: [{ title: 'T', command: 'echo 1' }] }) },

  { id: 'V4', cls: '有效-中文与特殊字符', listed: true,
    m: { name: '中文&符号', actions: [{ title: '标题&里有&符号', command: 'echo "a & b"' }] } },

  { id: 'I1', cls: '无效-缺 name', listed: false,
    m: { actions: [{ title: 'T', command: 'echo 1' }] } },

  { id: 'I2', cls: '无效-name 非字符串', listed: false,
    m: { name: 123, actions: [{ title: 'T', command: 'echo 1' }] } },

  { id: 'I3', cls: '无效-缺 actions', listed: false,
    m: { name: '无动作' } },

  { id: 'I4', cls: '无效-actions 是空数组', listed: false,
    m: { name: '空动作', actions: [] } },

  { id: 'I5', cls: '无效-actions 非数组', listed: false,
    m: { name: '动作不是数组', actions: 'run' } },

  { id: 'I6', cls: '无效-动作缺 title', listed: false,
    m: { name: '缺标题', actions: [{ command: 'echo 1' }] } },

  { id: 'I7', cls: '无效-动作缺 command', listed: false,
    m: { name: '缺命令', actions: [{ title: 'T' }] } },

  { id: 'I8', cls: '无效-动作是 null', listed: false,
    m: { name: '空动作对象', actions: [null] } },

  { id: 'I9', cls: '无效-清单不是对象', listed: false,
    m: '[]' }
];

/* ═══════════════════════════════════════════════════════════════════
   二、边界值分析：清单字段的边界点
   ═══════════════════════════════════════════════════════════════════ */
const BV_MANIFEST = [
  { id: 'BV01', cls: 'actions 长度=0（下界外）', listed: false,
    m: { name: 'n', actions: [] } },
  { id: 'BV02', cls: 'actions 长度=1（下界内）', listed: true,
    m: { name: 'n', actions: [{ title: 'T', command: 'echo 1' }] } },
  { id: 'BV03', cls: 'actions 长度=2', listed: true,
    m: { name: 'n', actions: [{ title: 'T1', command: 'echo 1' }, { title: 'T2', command: 'echo 2' }] } },
  { id: 'BV04', cls: 'name 长度=0（空串）', listed: false,
    m: { name: '', actions: [{ title: 'T', command: 'echo 1' }] } },
  { id: 'BV05', cls: 'name 长度=1', listed: true,
    m: { name: 'x', actions: [{ title: 'T', command: 'echo 1' }] } },
  { id: 'BV06', cls: 'title 长度=0（空串）', listed: false,
    m: { name: 'n', actions: [{ title: '', command: 'echo 1' }] } },
  { id: 'BV07', cls: 'title 长度=1', listed: true,
    m: { name: 'n', actions: [{ title: 'x', command: 'echo 1' }] } },
  { id: 'BV08', cls: 'command 长度=0（空串）', listed: false,
    m: { name: 'n', actions: [{ title: 'T', command: '' }] } },
  { id: 'BV09', cls: 'command 长度=1', listed: true,
    m: { name: 'n', actions: [{ title: 'T', command: 'x' }] } },
  { id: 'BV10', cls: '可选字段全部缺省（取默认值）', listed: true,
    defaults: true,
    m: { name: '默认值', actions: [{ title: 'T', command: 'echo 1' }] } }
];

(async function main() {
  /* scanDir 对每个坏包都会 console.warn —— 这些正是预期要被跳过的用例，
     先收集起来，最后统计，避免把测试输出淹掉 */
  const warnings = [];
  const realWarn = console.warn;
  console.warn = function () {
    warnings.push(Array.prototype.slice.call(arguments).join(' '));
  };

  const app = boot();
  await app.ready();

  console.log('\n═══ 一、等价类划分：manifest.json 装载 ═══');
  console.log('  （V=有效等价类应出现在列表；I=无效等价类应被跳过且不崩溃）\n');

  const dirs = {};
  EC_CASES.forEach(function (c) { dirs[c.id] = app.writePackage(c.id, c.m); });
  BV_MANIFEST.forEach(function (c) { dirs[c.id] = app.writePackage(c.id, c.m); });

  /* 额外的等价类：没有 manifest.json 的目录 / 普通文件 */
  fs.mkdirSync(path.join(app.userData, 'workspaces', 'I10'), { recursive: true });
  fs.writeFileSync(path.join(app.userData, 'workspaces', 'I10', 'readme.txt'), 'no manifest', 'utf8');
  EC_CASES.push({ id: 'I10', cls: '无效-目录里没有 manifest.json', listed: false, m: null });
  /* 非法 JSON */
  EC_CASES.push({ id: 'I11', cls: '无效-manifest.json 语法错误', listed: false, m: '{ "name": "坏", ' });
  app.writePackage('I11', '{ "name": "坏", ');

  const list = await app.invoke('wb:listWorkspaces');
  const byId = {};
  list.forEach(function (w) { byId[w.id] = w; });
  const listedIds = Object.keys(byId);

  EC_CASES.forEach(function (c) {
    check(c.id, c.cls, function () {
      const found = !!(byId[c.lookupId || c.id]);
      assert.strictEqual(found, c.listed,
        c.listed ? '期望出现在列表中，实际没有' : '期望被跳过，实际出现了');
    });
  });

  /* 默认值：icon=📦 / permissions=['exec'] / version=1.0.0 / id=目录名 */
  check('BV10-1', '默认 icon = 📦', function () {
    assert.strictEqual(byId['BV10'].icon, '📦');
  });
  check('BV10-2', "默认 permissions = ['exec']", function () {
    assert.deepStrictEqual(byId['BV10'].permissions, ['exec']);
  });
  check('BV10-3', '默认 version = 1.0.0', function () {
    assert.strictEqual(byId['BV10'].version, '1.0.0');
  });
  check('BV10-4', '缺 id 时以目录名为 id', function () {
    assert.strictEqual(byId['BV10'].name, '默认值');
  });
  check('V2-1', '显式 id 被保留', function () {
    assert.strictEqual(byId['v2-full'].name, '全字段');
    assert.strictEqual(byId['v2-full'].version, '2.3.1');
    assert.strictEqual(byId['v2-full'].actions.length, 2);
  });
  check('NFR9', '非法包不影响其它工作区（一个坏包不会拖垮整体）', function () {
    assert.ok(listedIds.indexOf('V1') >= 0, 'V1 应正常出现');
    assert.ok(listedIds.indexOf('BV03') >= 0, 'BV03 应正常出现');
  });

  /* 内置工作区：内置 + 用户目录合并，且同名时内置优先 */
  check('BV11', '内置工作区被装载（至少 3 个）', function () {
    const builtin = list.filter(function (w) { return w.builtin; });
    assert.ok(builtin.length >= 3, '内置工作区数量 = ' + builtin.length);
  });
  const dupDir = path.join(app.userData, 'workspaces', '基础工作');
  fs.mkdirSync(dupDir, { recursive: true });
  fs.writeFileSync(path.join(dupDir, 'manifest.json'), JSON.stringify(
    { name: '冒名的内置工作区', actions: [{ title: 'T', command: 'echo 1' }] }), 'utf8');
  const list2 = await app.invoke('wb:listWorkspaces');
  const dups = list2.filter(function (w) { return w.id === '基础工作'; });
  check('BV12', '同名 id 冲突时内置优先（只留一份且标记为内置）', function () {
    assert.strictEqual(dups.length, 1, '同 id 应只剩一份，实际 ' + dups.length);
    assert.strictEqual(dups[0].builtin, true, '应保留内置那份');
    assert.notStrictEqual(dups[0].name, '冒名的内置工作区');
  });

  console.log('\n═══ 二、边界值分析：manifest 字段边界 ═══\n');
  BV_MANIFEST.forEach(function (c) {
    if (c.defaults) return;                       // BV10 已在上面按字段单独断言
    check(c.id, c.cls, function () {
      const found = !!(byId[c.lookupId || c.id]);
      assert.strictEqual(found, c.listed,
        c.listed ? '期望出现，实际没有' : '期望被跳过，实际出现了');
    });
  });

  console.log('\n═══ 三、边界值分析：wb:run 入参（F2 执行入口）═══\n');

  const anyWs = byId['V1'];
  const wsId = 'V1';
  app.clear();

  const r1 = await app.invoke('wb:run', { workspaceId: wsId, actionId: 'a', command: '' });
  check('BV13', 'command = 空串（下界外）→ 拒绝且不起进程', function () {
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.error, '缺少命令');
    assert.strictEqual(app.state.children.length, 0, '不应 spawn');
  });

  const r2 = await app.invoke('wb:run', { workspaceId: wsId, actionId: 'a', command: '   ' });
  check('BV14', 'command = 3 个空格（去空格后为空的边界）→ 拒绝', function () {
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(app.state.children.length, 0, '不应 spawn');
    assert.ok(/没有声明命令/.test(r2.error), '实际错误：' + r2.error);
  });

  const r3 = await app.invoke('wb:run', { workspaceId: wsId, actionId: 'a', command: 'x' });
  check('BV15', 'command 长度 = 1（下界内）→ 正常启动', function () {
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(app.state.children.length, 1);
  });

  const r4 = await app.invoke('wb:run', { workspaceId: wsId, actionId: 'a', command: 'echo 1', cwd: 'not-exist-dir' });
  check('BV16', 'cwd 指向不存在的目录 → 拒绝并给出中文目录提示', function () {
    assert.strictEqual(r4.ok, false);
    assert.ok(/工作目录不存在/.test(r4.error), '实际错误：' + r4.error);
    assert.strictEqual(app.state.children.length, 1, '不应再 spawn');
  });

  const realDir = path.join(app.userData, 'cwd-ok');
  fs.mkdirSync(realDir, { recursive: true });
  const r5 = await app.invoke('wb:run', { workspaceId: wsId, actionId: 'a', command: 'echo 1', cwd: realDir });
  check('BV17', 'cwd = 绝对路径且存在 → 采用该目录', function () {
    assert.strictEqual(r5.ok, true);
    assert.strictEqual(app.lastChild().options.cwd, realDir);
  });

  const sub = path.join(dirs['V1'], 'tools');
  fs.mkdirSync(sub, { recursive: true });
  const r6 = await app.invoke('wb:run', { workspaceId: wsId, actionId: 'a', command: 'echo 1', cwd: 'tools' });
  check('BV18', 'cwd = 相对路径 "tools" 且存在 → 工作区包目录\\tools', function () {
    assert.strictEqual(r6.ok, true);
    assert.strictEqual(app.lastChild().options.cwd, sub);
  });

  console.log('\n────────────────────────────────────────────');
  console.warn = realWarn;
  console.log('\n扫描时被跳过的坏包共告警 ' + warnings.length + ' 条（均为预期拒绝，未导致崩溃）');
  console.log('等价类 + 边界值：' + pass + ' 通过，' + fail + ' 失败（共 ' + (pass + fail) + ' 条）');
  app.cleanup();
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) {
  console.error('测试脚手架异常：', e);
  process.exitCode = 2;
});
