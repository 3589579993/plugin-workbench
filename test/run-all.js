/**
 * 一键跑完全部测试套件
 * ------------------------------------------------------------------
 * 运行：node test/run-all.js
 * 退出码：0 = 全绿；1 = 有失败
 *
 * 说明：每个套件单独起一个 node 进程——因为它们会替换 require
 * （桩掉 electron / child_process），串在一个进程里会互相污染。
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const SUITES = [
  ['单元测试：运行目录规则（原有）', 'test/resolve-run.test.js'],
  ['黑盒①：等价类划分 + 边界值分析', 'test/bb-equivalence.test.js'],
  ['黑盒②：因果图 + 决策表', 'test/bb-decision-table.test.js'],
  ['白盒：逻辑覆盖 + 基本路径', 'test/wb-resolve-run.test.js'],
  ['集成测试：桩 + 驱动', 'test/integration.test.js'],
  ['AI 助手：安装引导（dry-run）', 'test/ai-assistant.test.js'],
  ['集成测试：真实起进程（原有）', 'test/run-in-package.test.js']
];

let failed = 0;
const rows = [];

for (const [label, file] of SUITES) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8' });
  const ms = Date.now() - t0;
  const out = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const summary = out.filter(function (l) {
    return /通过|pass|失败|结果/.test(l);
  }).slice(-1)[0] || (out.slice(-1)[0] || '');
  const ok = r.status === 0;
  if (!ok) failed++;
  rows.push({ label: label, file: file, ok: ok, ms: ms, summary: summary });
  console.log((ok ? '  ✓ ' : '  ✗ ') + label.padEnd(34) + String(ms).padStart(6) + 'ms   ' + summary);
  if (!ok) {
    console.log('    —— 该套件的完整输出 ——');
    console.log((r.stdout || '').split(/\r?\n/).filter(function (l) { return /✗/.test(l); })
      .map(function (l) { return '    ' + l; }).join('\n'));
    if (r.stderr) console.log('    ' + r.stderr.trim().split(/\r?\n/).slice(-6).join('\n    '));
  }
}

console.log('\n════════════════════════════════════════════');
if (failed) {
  console.log('结果：' + (SUITES.length - failed) + ' / ' + SUITES.length + ' 个套件通过，' + failed + ' 个失败');
} else {
  console.log('结果：全部 ' + SUITES.length + ' 个套件通过 ✓');
  console.log('建议接着跑覆盖率：node test/coverage.js test/bb-equivalence.test.js test/bb-decision-table.test.js test/integration.test.js');
}
process.exitCode = failed ? 1 : 0;
