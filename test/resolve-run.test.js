/**
 * 单元测试：命令到底在哪个目录里跑（lib/resolve-run.js）
 * 跑法：node test/resolve-run.test.js
 */
const assert = require('assert');
const { resolveRun, isAbsolutePath } = require('../lib/resolve-run');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

const PKG = 'C:\\app\\workspaces\\路径示例';
const exists = p => p === PKG || p === 'C:\\Users\\Zhang\\Desktop' || p === PKG + '\\sub\\dir';

console.log('resolve-run 单元测试');

t('没写 cwd → 站在工作区包自己的目录里跑', () => {
  const r = resolveRun({ command: 'dir', pkgDir: PKG, exists });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cwd, PKG);
  assert.strictEqual(r.source, 'package');
});

t('cwd 是绝对路径 → 直接用', () => {
  const r = resolveRun({ command: 'dir', cwd: 'C:\\Users\\Zhang\\Desktop', pkgDir: PKG, exists });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cwd, 'C:\\Users\\Zhang\\Desktop');
  assert.strictEqual(r.source, 'cwd');
});

t('cwd 是相对路径 → 相对工作区包目录拼出来', () => {
  const r = resolveRun({ command: 'dir', cwd: 'sub\\dir', pkgDir: PKG, exists });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cwd, PKG + '\\sub\\dir');
});

t('相对路径前面的反斜杠会被吃掉（写 \\sub\\dir 也行）', () => {
  const any = () => true;
  assert.strictEqual(resolveRun({ command: 'dir', cwd: '\\sub\\dir', pkgDir: PKG, exists: any }).cwd, PKG + '\\sub\\dir');
});

t('以 / 开头的写法按"绝对路径"处理（不拼包目录）——规则要可预测', () => {
  const any = () => true;
  assert.strictEqual(resolveRun({ command: 'dir', cwd: '/sub/dir', pkgDir: PKG, exists: any }).cwd, '/sub/dir');
});

t('目录不存在 → 明确报错（而不是让命令在错误的目录里悄悄跑）', () => {
  const r = resolveRun({ command: 'dir', cwd: 'C:\\不存在的目录', pkgDir: PKG, exists });
  assert.strictEqual(r.ok, false);
  assert.ok(/工作目录不存在/.test(r.error), r.error);
});

t('没写命令 → 报错', () => {
  assert.strictEqual(resolveRun({ command: '   ', pkgDir: PKG, exists }).ok, false);
});

t('cwd 写成空字符串 → 当作没写（回到默认）', () => {
  assert.strictEqual(resolveRun({ command: 'dir', cwd: '  ', pkgDir: PKG, exists }).cwd, PKG);
});

t('绝对路径识别：盘符 / UNC 共享 / 根目录', () => {
  assert.strictEqual(isAbsolutePath('C:\\x'), true);
  assert.strictEqual(isAbsolutePath('c:/x'), true);
  assert.strictEqual(isAbsolutePath('\\\\机器\\共享'), true);
  assert.strictEqual(isAbsolutePath('/usr/bin'), true);
  assert.strictEqual(isAbsolutePath('sub\\dir'), false);
  assert.strictEqual(isAbsolutePath('.\\sub'), false);
});

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
