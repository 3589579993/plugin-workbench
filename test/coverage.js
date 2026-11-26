/**
 * 行覆盖率统计（零依赖，基于 Node 内置的 V8 覆盖率）
 * ------------------------------------------------------------------
 * 用法：
 *   node test/coverage.js                     # 统计白盒用例对 lib/ 的覆盖
 *   node test/coverage.js test/integration.test.js
 *
 * 原理：给子进程设 NODE_V8_COVERAGE=<临时目录>，Node 退出时会把
 * 每个脚本的执行范围（startOffset/endOffset/count）写成 JSON。
 * 这里把 offset 还原成行号，统计"可执行行"里有多少行真的被执行过。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const targets = process.argv.slice(2);
const TEST_FILES = targets.length ? targets : ['test/wb-resolve-run.test.js'];

const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cov-'));

console.log('覆盖率采集：' + TEST_FILES.join(' , '));
for (const f of TEST_FILES) {
  const r = spawnSync(process.execPath, [f], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { NODE_V8_COVERAGE: covDir }),
    encoding: 'utf8'
  });
  const tail = (r.stdout || '').trim().split('\n').slice(-2).join(' | ');
  console.log('  · ' + f + '  exit=' + r.status + '   ' + tail);
}

/* ── 收集 V8 覆盖数据，按脚本 URL 合并（同一脚本可能被多个进程覆盖）── */
const byUrl = {};
for (const file of fs.readdirSync(covDir)) {
  if (!file.endsWith('.json')) continue;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(covDir, file), 'utf8')); }
  catch (e) { continue; }
  for (const script of doc.result || []) {
    if (!script.url || !script.url.startsWith('file://')) continue;
    const p = path.normalize(decodeURIComponent(script.url.replace('file:///', '')));
    const rec = byUrl[p] || (byUrl[p] = []);
    rec.push(script);
  }
}

function lineMask(src, scripts) {
  /* 同一个脚本可能出现在多个测试进程的覆盖文件里：
     每个进程先单独成图，再取"并集"（只要某个进程执行过就算覆盖），
     否则后一个进程的 0 会覆盖前一个进程的 1。 */
  const mask = new Uint8Array(src.length);
  for (const script of scripts) {
    const one = new Uint8Array(src.length);
    for (const fn of script.functions || []) {
      /* V8 的 ranges 是嵌套且按 startOffset 升序的，后写覆盖先写 */
      for (const r of fn.ranges || []) {
        const val = r.count > 0 ? 1 : 0;
        for (let i = r.startOffset; i < Math.min(r.endOffset, one.length); i++) one[i] = val;
      }
    }
    for (let i = 0; i < mask.length; i++) if (one[i]) mask[i] = 1;
  }
  return mask;
}

console.log('\n文件                       可执行行   已覆盖   覆盖率   未覆盖行');
console.log('────────────────────────────────────────────────────────────────');

const report = [];
for (const p of Object.keys(byUrl).sort()) {
  if (p.indexOf('node_modules') >= 0) continue;
  if (p.indexOf(ROOT) !== 0) continue;                       // 只看本项目源文件
  const rel = path.relative(ROOT, p).replace(/\\/g, '/');
  let src;
  try { src = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
  const mask = lineMask(src, byUrl[p]);

  /* 逐行判定：跳过空行与纯注释行，其余算"可执行行" */
  const lines = src.split(/\r?\n/);
  let offset = 0, executable = 0, covered = 0;
  const missed = [];
  lines.forEach(function (text, i) {
    const start = offset;
    offset += text.length + 1;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (/^(\/\/|\*|\/\*)/.test(trimmed)) return;            // 注释行
    let anyCode = false, anyCovered = false;
    for (let k = start; k < start + text.length; k++) {
      if (src[k] === ' ' || src[k] === '\t') continue;
      anyCode = true;
      if (mask[k]) anyCovered = true;
    }
    if (!anyCode) return;
    executable++;
    if (anyCovered) covered++;
    else missed.push(i + 1);
  });
  if (!executable) continue;
  const pct = (covered / executable * 100).toFixed(1);
  report.push({ rel: rel, executable: executable, covered: covered, pct: pct, missed: missed });
  console.log(rel.padEnd(26) + String(executable).padStart(6) +
    String(covered).padStart(9) + (pct + '%').padStart(9) + '   ' +
    (missed.length ? missed.slice(0, 12).join(',') + (missed.length > 12 ? ' …' : '') : '—'));
}

if (!report.length) {
  console.log('（没有采到本项目源码的覆盖数据）');
}

fs.rmSync(covDir, { recursive: true, force: true });
