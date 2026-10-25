/**
 * 集成测试：**真的把命令跑起来**，验证"站在工作区包目录里，就能用相对路径找到脚本和同包文件"。
 * 跑法：node test/run-in-package.test.js
 *
 * 这里是一组对照实验，正是这次改动要解决的问题：
 *   A. 不带 cwd（改动之前的行为：目录不确定）→ 相对路径的脚本根本找不到
 *   B. 用 resolve-run 算出"工作区包目录"→ 脚本找得到、还能读到同包的相对数据文件
 *
 * 注意：测试脚本内容全用 ASCII。
 * （Windows PowerShell 5.1 读 .ps1 时，没有 BOM 的非 ASCII 内容会按 ANSI 解码而报错——
 *   这是"用记事本/程序写中文脚本"的经典坑，跟本次改动无关，所以测试里避开它。）
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveRun } = require('../lib/resolve-run');

const tmp = path.join(os.tmpdir(), 'wb-test-' + Date.now());
const pkg = path.join(tmp, 'pkg');
fs.mkdirSync(pkg, { recursive: true });

// 包里放：一个脚本（用相对路径读同包的数据、写出一份结果）
const script = 'probe.ps1';
fs.writeFileSync(path.join(pkg, script), [
  "$d = Get-Content -LiteralPath 'data.txt' -Raw",
  "Set-Content -Path 'result.txt' -Value ('read:' + $d.Trim()) -Encoding ASCII",
  ''
].join('\n'), 'ascii');
fs.writeFileSync(path.join(pkg, 'data.txt'), 'package-data\n', 'ascii');

// 故意换到一个"别的目录"去跑（模拟软件启动时碰巧所在的目录）
const elsewhere = path.join(tmp, 'elsewhere');
fs.mkdirSync(elsewhere, { recursive: true });

const command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + script + '"';
const spawnOpts = { shell: true, windowsHide: true, encoding: 'utf8' };

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

console.log('run-in-package 集成测试');
console.log('  工作区包：' + pkg);

t('A. 目录不对（不带 cwd）→ 相对路径的脚本找不到', () => {
  const r = spawnSync(command, Object.assign({}, spawnOpts, { cwd: elsewhere }));
  assert.notStrictEqual(r.status, 0, '居然成功了？说明这个实验没起到对照作用');
  assert.ok(!fs.existsSync(path.join(elsewhere, 'result.txt')), '结果不该出现在别的目录里');
  console.log('      （真实报错：' + String(r.stderr || '').split('\n')[0].trim() + ' …）');
});

t('B. 用 resolve-run 算出工作区包目录 → 脚本找得到，还能读到同包数据', () => {
  const resolved = resolveRun({ command, pkgDir: pkg, exists: p => fs.existsSync(p) });
  assert.strictEqual(resolved.ok, true, resolved.error);
  assert.strictEqual(resolved.cwd, pkg);
  console.log('      解析出的工作目录：' + resolved.cwd);

  const r = spawnSync(command, Object.assign({}, spawnOpts, { cwd: resolved.cwd }));
  assert.strictEqual(r.status, 0, '退出码 ' + r.status + '：' + (r.stderr || ''));

  const resultFile = path.join(pkg, 'result.txt');
  assert.ok(fs.existsSync(resultFile), '脚本应该把结果写在工作区包目录里');
  const text = fs.readFileSync(resultFile, 'ascii').trim();
  assert.strictEqual(text, 'read:package-data');
  console.log('      结果文件：' + text + '（证明脚本站在包里、且读到了同包的相对文件）');
});

t('C. 作者写了相对 cwd（sub 目录）→ 解析成包里那个子目录', () => {
  const sub = path.join(pkg, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const resolved = resolveRun({ command: 'dir /b', cwd: 'sub', pkgDir: pkg, exists: p => fs.existsSync(p) });
  assert.strictEqual(resolved.ok, true, resolved.error);
  assert.strictEqual(resolved.cwd, sub);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
