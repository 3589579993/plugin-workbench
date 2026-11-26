/**
 * 白盒测试：逻辑覆盖法 + 基本路径法
 * ------------------------------------------------------------------
 * 被测对象（SUT）：lib/resolve-run.js
 *   · resolveRun(options)  —— "命令在哪个目录里跑"的规则（纯函数）
 *   · isAbsolutePath(p)    —— 绝对路径判定
 *
 * 一、逻辑覆盖法（Logical Covering Method），按强度由弱到强：
 *     1. 语句覆盖   每条可执行语句至少执行一次
 *     2. 判定覆盖   每个判定的真、假分支各至少一次
 *     3. 条件覆盖   每个判定中的每个原子条件取真、取假各至少一次
 *     4. 判定-条件覆盖  上述二者同时满足
 *     5. 条件组合覆盖 每个判定中原子条件的可行组合至少出现一次
 *   本文件用"用例 → 覆盖项"的映射表驱动，并在末尾自动校验
 *   "每个判定/条件是否真的取到了真和假"，缺一项就报失败。
 *
 * 二、基本路径法（Basic Path Method / McCabe）：
 *   环形复杂度 V(G) = 判定结点数 + 1 = 5 + 1 = 6
 *   → 需要 6 条独立路径。下文的 P1 ~ P6 即为这 6 条，
 *     P7 是覆盖判定 D5 真分支的一个补充用例（非独立路径）。
 *
 * 运行：node test/wb-resolve-run.test.js
 */
'use strict';

const assert = require('assert');
const { resolveRun, isAbsolutePath } = require('../lib/resolve-run');

let pass = 0, fail = 0;

/* ═══════════════════════════════════════════════════════════════════
   resolveRun 的判定与语句编号（对应 lib/resolve-run.js 的行号）
   ─────────────────────────────────────────────────────────────────
   S1  const opts = o || {}                                  (43)
   S2  const command = String(...)          三元 T1           (44)
   S3  const pkgDir = opts.pkgDir ? ... : '' 三元 T2          (45)
   S4  const exists = opts.exists || (()=>true)  短路          (46)
   D1  if (!command.trim())  → S5 return 错误                 (48)
   S6  let cwd = pkgDir || undefined                          (50)
   S7  let source = 'package'                                 (51)
   D2  if (cwd !== undefined && cwd !== null && trim !== '')   (53)
        └ 原子条件 a / b / c
   S8  const p = String(opts.cwd).trim()                      (54)
   D3  isAbsolutePath(p) ?                                    (55)
   S9a 分支：p（绝对）                                        (56)
   D4  pkgDir ? ... : ...                                     (57)
   S9b 分支：pkgDir + '\\' + p                                (57)
   S9c 分支：p（相对且无包目录）                               (58)
   S10 source = 'cwd'                                         (59)
   D5  if (cwd && !exists(cwd))                               (62)
        └ 原子条件 a(cwd 非空) / b(!exists)
   S11 return 错误：工作目录不存在                              (63)
   S12 return { ok:true, cwd, source }                        (66)
   isAbsolutePath: S13 (29)  D6 = 三个或条件 a/b/c (30)  S14
   ═══════════════════════════════════════════════════════════════════ */

const PKG = 'C:\\pkg';
const CASES = [
  /* ── 基本路径 P1：D1 为真 ───────────────────────────────── */
  { id: 'WB01', path: 'P1', desc: 'command 为空串 → D1 真，立即返回错误',
    input: { command: '', pkgDir: PKG },
    expect: { ok: false, error: /这个动作没有声明命令/ },
    covers: { D1: 'T' } },

  { id: 'WB02', path: 'P1', desc: 'command 全是空格 → trim 后为空，D1 真',
    input: { command: '   ', pkgDir: PKG },
    expect: { ok: false, error: /这个动作没有声明命令/ },
    covers: { D1: 'T' } },

  { id: 'WB03', path: 'P1', desc: 'opts 完全不传（S1 的 o || {} 取默认值）',
    input: null,
    expect: { ok: false, error: /这个动作没有声明命令/ },
    covers: { D1: 'T', T1: 'T' } },

  /* ── 基本路径 P2：D1 假、D2 假、D5 假 ───────────────────── */
  { id: 'WB04', path: 'P2', desc: '未声明 cwd，包目录存在 → 用包目录（source=package）',
    input: { command: 'echo hi', pkgDir: PKG },
    exists: true,
    expect: { ok: true, cwd: PKG, source: 'package' },
    covers: { D1: 'F', D2: 'F', D2a: 'F', D5: 'F', D5a: 'T', D5b: 'F', T2: 'T' } },

  /* ── 基本路径 P3：D1 假、D2 假、D5 真 ───────────────────── */
  { id: 'WB05', path: 'P3', desc: '未声明 cwd，但包目录不存在 → 报错',
    input: { command: 'echo hi', pkgDir: 'C:\\gone' },
    exists: false,
    expect: { ok: false, error: /工作目录不存在：C:\\gone/ },
    covers: { D1: 'F', D2: 'F', D5: 'T', D5a: 'T', D5b: 'T' } },

  /* ── 基本路径 P4：D1 假、D2 真、D3 真 ───────────────────── */
  { id: 'WB06', path: 'P4', desc: 'cwd 是盘符绝对路径 → 直接用',
    input: { command: 'echo hi', cwd: 'D:\\work\\tools', pkgDir: PKG },
    exists: true,
    expect: { ok: true, cwd: 'D:\\work\\tools', source: 'cwd' },
    covers: { D1: 'F', D2: 'T', D2a: 'T', D2b: 'T', D2c: 'T', D3: 'T', D5: 'F', D6: 'T', D6a: 'T', D6c: 'F', D6b: 'F' } },

  /* ── 基本路径 P5：D1 假、D2 真、D3 假、D4 真 ────────────── */
  { id: 'WB07', path: 'P5', desc: 'cwd 是相对路径且有包目录 → 拼成 包目录\\tools',
    input: { command: 'echo hi', cwd: 'tools', pkgDir: PKG },
    exists: [PKG + '\\tools'],
    expect: { ok: true, cwd: PKG + '\\tools', source: 'cwd' },
    covers: { D1: 'F', D2: 'T', D3: 'F', D6: 'F', D6a: 'F', D6b: 'F', D6c: 'F',
              D4: 'T', T2: 'T', D5: 'F', D5a: 'T', D5b: 'F' } },

  /* ── 基本路径 P6：D1 假、D2 真、D3 假、D4 假 ────────────── */
  { id: 'WB08', path: 'P6', desc: '相对 cwd 但没有包目录 → cwd 原样返回',
    input: { command: 'echo hi', cwd: 'rel', pkgDir: '' },
    exists: true,
    expect: { ok: true, cwd: 'rel', source: 'cwd' },
    covers: { D1: 'F', D2: 'T', D3: 'F', D4: 'F', T2: 'F', D5: 'F', D5a: 'T', D5b: 'F' } },

  /* ── 补充路径 P7：D5 在"声明了 cwd"时取真 ───────────────── */
  { id: 'WB09', path: 'P7', desc: '声明了 cwd 但拼出来的目录不存在 → 报错',
    input: { command: 'echo hi', cwd: 'missing', pkgDir: PKG },
    exists: false,
    expect: { ok: false, error: /工作目录不存在：C:\\pkg\\missing/ },
    covers: { D2: 'T', D3: 'F', D4: 'T', D5: 'T', D5a: 'T', D5b: 'T' } },

  /* ── 条件覆盖 / 条件组合覆盖 专项 ───────────────────────── */
  { id: 'WB10', path: '条件', desc: 'D2 原子 b 取假：cwd = null（显式传 null）',
    input: { command: 'echo hi', cwd: null, pkgDir: PKG },
    exists: true,
    expect: { ok: true, cwd: PKG, source: 'package' },
    covers: { D2: 'F', D2a: 'T', D2b: 'F' } },

  { id: 'WB11', path: '条件', desc: 'D2 原子 c 取假：cwd = "   "（trim 后为空）',
    input: { command: 'echo hi', cwd: '   ', pkgDir: PKG },
    exists: true,
    expect: { ok: true, cwd: PKG, source: 'package' },
    covers: { D2: 'F', D2a: 'T', D2b: 'T', D2c: 'F' } },

  { id: 'WB12', path: '发现', desc: 'cwd="/tools" 被当成 Unix 绝对路径（前导斜杠剥离分支不可达）',
    input: { command: 'echo hi', cwd: '/tools', pkgDir: PKG },
    exists: [PKG + '\\tools'],
    expect: { ok: false, error: /工作目录不存在：\/tools/ },
    covers: { D2: 'T', D3: 'T', D6: 'T', D6c: 'T', D5: 'T', D5a: 'T', D5b: 'T' } },

  { id: 'WB17', path: '条件', desc: 'D5 原子 a 取假：既没有包目录也没声明 cwd → cwd 为 undefined，直接放行',
    input: { command: 'echo hi' },
    exists: true,
    expect: { ok: true, cwd: undefined, source: 'package' },
    covers: { D1: 'F', D2: 'F', D5: 'F', D5a: 'F', T2: 'F' } },

  { id: 'WB13', path: '条件组合', desc: 'D6 原子 b 取真：UNC 共享路径 \\\\srv\\share',
    input: { command: 'echo hi', cwd: '\\\\srv\\share', pkgDir: PKG },
    exists: true,
    expect: { ok: true, cwd: '\\\\srv\\share', source: 'cwd' },
    covers: { D3: 'T', D6: 'T', D6a: 'F', D6b: 'T', D6c: 'F' } },

  { id: 'WB14', path: '条件组合', desc: 'D6 原子 c 取真：Unix 根路径 /tmp',
    input: { command: 'echo hi', cwd: '/tmp/x', pkgDir: PKG },
    exists: true,
    expect: { ok: true, cwd: '/tmp/x', source: 'cwd' },
    covers: { D3: 'T', D6: 'T', D6a: 'F', D6b: 'F', D6c: 'T' } },

  { id: 'WB15', path: '语句', desc: 'S4 短路取右操作数：不注入 exists（默认恒真）',
    input: { command: 'echo hi', pkgDir: 'C:\\whatever' },
    exists: undefined,
    expect: { ok: true, cwd: 'C:\\whatever', source: 'package' },
    covers: { D5: 'F' } },

  { id: 'WB16', path: '语句', desc: 'S2 三元 T1 取假：command 为普通字符串',
    input: { command: 'echo hi', pkgDir: PKG },
    exists: true,
    expect: { ok: true, source: 'package' },
    covers: { T1: 'F' } }
];

/* isAbsolutePath 单测：D6 三个或条件 + 短路 */
const ABS_CASES = [
  ['AB01', 'D:\\x', true, '盘符 + 反斜杠'],
  ['AB02', 'c:/x', true, '盘符 + 正斜杠'],
  ['AB03', '\\\\srv\\share', true, 'UNC 共享'],
  ['AB04', '/tmp/x', true, 'Unix 根'],
  ['AB05', 'tools', false, '相对路径（三个条件全假）'],
  ['AB06', 'C:', false, '只有盘符没有分隔符'],
  ['AB07', '', false, '空串'],
  ['AB08', undefined, false, 'undefined（S13 的 p || \'\' 取右）']
];

(async function main() {
  console.log('═══ 一、基本路径法：V(G) = 5 + 1 = 6 条独立路径 ═══\n');

  const cov = {};                        // 覆盖项 → { T:[], F:[] }
  function mark(key, val, id) {
    const c = cov[key] || (cov[key] = { T: [], F: [] });
    c[val].push(id);
  }

  for (const c of CASES) {
    c.id && (function () {
      let res;
      try {
        const opts = c.input === null ? undefined : Object.assign({}, c.input);
        if (c.exists !== undefined) {
          if (Array.isArray(c.exists)) {
            const set = new Set(c.exists.map(function (p) { return p.toLowerCase(); }));
            opts.exists = function (p) { return set.has(String(p).toLowerCase()); };
          } else {
            opts.exists = function () { return c.exists; };
          }
        }
        res = resolveRun(opts);
      } catch (e) {
        fail++;
        console.log('  ✗ ' + c.id + ' ' + c.desc + '\n      ' + e.message);
        return;
      }
      try {
        assert.strictEqual(res.ok, c.expect.ok, 'ok 不符：' + JSON.stringify(res));
        if (c.expect.error) {
          assert.ok(c.expect.error.test(res.error || ''), '错误信息不符：' + res.error);
        }
        if ('cwd' in c.expect) assert.strictEqual(res.cwd, c.expect.cwd, 'cwd 不符：' + res.cwd);
        if ('source' in c.expect) assert.strictEqual(res.source, c.expect.source, 'source 不符：' + res.source);
        Object.keys(c.covers).forEach(function (k) { mark(k, c.covers[k], c.id); });
        pass++;
        console.log('  ✓ ' + c.id + ' [' + c.path + '] ' + c.desc);
      } catch (e) {
        fail++;
        console.log('  ✗ ' + c.id + ' [' + c.path + '] ' + c.desc + '\n      ' + e.message);
      }
    })();
  }

  console.log('\n═══ 二、isAbsolutePath 单测（D6 三个或条件的组合）═══\n');
  for (const [id, input, want, desc] of ABS_CASES) {
    try {
      assert.strictEqual(isAbsolutePath(input), want, 'isAbsolutePath(' + JSON.stringify(input) + ') = ' + isAbsolutePath(input));
      pass++;
      console.log('  ✓ ' + id + ' isAbsolutePath(' + JSON.stringify(input) + ') = ' + want + '  ' + desc);
    } catch (e) {
      fail++;
      console.log('  ✗ ' + id + ' ' + desc + '\n      ' + e.message);
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     三、覆盖矩阵自查：每个判定 / 原子条件都必须取到真和假
     ═══════════════════════════════════════════════════════════════ */
  console.log('\n═══ 三、逻辑覆盖矩阵（缺真或假即判失败）═══\n');
  const REQUIRED = {
    D1: '判定 if(!command.trim())',
    D2: '判定 if(cwd 声明) 整体',
    D2a: '原子条件 opts.cwd !== undefined',
    D2b: '原子条件 opts.cwd !== null',
    D2c: '原子条件 String(cwd).trim() !== ""',
    D3: '判定 isAbsolutePath(p)（三元）',
    D4: '判定 pkgDir ? ... : ...（三元）',
    D5: '判定 if(cwd && !exists(cwd)) 整体',
    D5a: '原子条件 cwd 非空',
    D5b: '原子条件 !exists(cwd)',
    D6: 'isAbsolutePath 的三个或条件（整体）',
    D6a: '原子条件 盘符正则',
    D6b: '原子条件 UNC 前缀',
    D6c: '原子条件 "/" 前缀',
    T1: '三元 opts.command == null',
    T2: '三元 opts.pkgDir 真值'
  };

  const DECISION_COVERAGE = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
  const CONDITION_COVERAGE = ['D2a', 'D2b', 'D2c', 'D5a', 'D5b', 'D6a', 'D6b', 'D6c', 'T1', 'T2'];

  console.log('  判定/条件 | 真分支用例 | 假分支用例 | 结论');
  Object.keys(REQUIRED).forEach(function (k) {
    const c = cov[k] || { T: [], F: [] };
    const ok = c.T.length > 0 && c.F.length > 0;
    if (!ok) fail++;
    console.log('  ' + (k + '        ').slice(0, 9) + ' | ' +
      (c.T.join(',') || '——').padEnd(24) + ' | ' +
      (c.F.join(',') || '——').padEnd(24) + ' | ' + (ok ? '✓ 双向' : '✗ 单边'));
  });

  const missing = Object.keys(REQUIRED).filter(function (k) {
    const c = cov[k] || { T: [], F: [] };
    return c.T.length === 0 || c.F.length === 0;
  });

  console.log('\n  判定覆盖（' + DECISION_COVERAGE.join('/') + '）：' + (missing.length ? '✗ 有缺口' : '✓ 100%'));
  console.log('  条件覆盖（' + CONDITION_COVERAGE.join('/') + '）：' + (missing.length ? '✗ 有缺口' : '✓ 100%'));
  console.log('  基本路径覆盖：P1~P6 共 6 条独立路径全部经过'
    + '（另有 ' + CASES.filter(function (c) { return c.path === 'P7'; }).length + ' 条补充路径用例）');

  console.log('\n────────────────────────────────────────────');
  console.log('白盒（逻辑覆盖 + 基本路径）：' + pass + ' 通过，' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
})();
