/**
 * AI 助手启动器测试（不会弹窗、不会安装）
 * 跑法：node test/ai-assistant.test.js
 *
 * 用 --dry-run + --missing 模拟"本机没装"，验证引导文案和下载地址。
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'workspaces', 'AI助手', 'open-ai.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
function run(args) {
  return spawnSync(process.execPath, [SCRIPT].concat(args), { cwd: ROOT, encoding: 'utf8' });
}

console.log('AI 助手启动器测试');

t('list 能列出 6 个模型', function () {
  const r = run(['list']);
  assert.strictEqual(r.status, 0, r.stderr);
  for (const key of ['claude', 'deepseek', 'gemini', 'doubao', 'chatgpt', 'qwen']) {
    assert.ok(r.stdout.indexOf(key) >= 0, '缺少模型：' + key);
  }
});

t('Claude 未安装时 dry-run 给出安装/下载引导', function () {
  const r = run(['claude', '--dry-run', '--missing']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/将弹窗询问/.test(r.stdout), r.stdout);
  assert.ok(r.stdout.indexOf('https://claude.ai/download') >= 0, r.stdout);
  assert.ok(r.stdout.indexOf('https://claude.ai/new') >= 0, r.stdout);
});

t('DeepSeek 未安装时引导下载或网页版', function () {
  const r = run(['deepseek', '--dry-run', '--missing']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/直接打开网页版/.test(r.stdout), r.stdout);
  assert.ok(r.stdout.indexOf('https://www.deepseek.com/') >= 0, r.stdout);
  assert.ok(r.stdout.indexOf('https://chat.deepseek.com/') >= 0, r.stdout);
});

t('未知模型返回非 0 并提示可用模型', function () {
  const r = run(['not-a-model', '--dry-run']);
  assert.notStrictEqual(r.status, 0);
  assert.ok(r.stderr.indexOf('未知的模型') >= 0, r.stderr);
});

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;