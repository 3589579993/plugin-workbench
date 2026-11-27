/**
 * AI 助手启动器测试（不会弹窗、不会联网、不会安装）
 * 跑法：node test/ai-assistant.test.js
 *
 * 启动器是 PowerShell 脚本，不依赖 Node.js——这样用户电脑上没装 Node
 * 也能在第一次点击时完成“检测 / 下载 / 安装”引导。
 * 这里用 -DryRun -Missing 模拟“本机没装 AI”，验证文案与下载地址。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WS_DIR = path.join(ROOT, 'workspaces', 'AI助手');
const SCRIPT = path.join(WS_DIR, 'open-ai.ps1');
const MANIFEST = path.join(WS_DIR, 'manifest.json');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
function runPs(args) {
  return spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT].concat(args),
    { cwd: ROOT, encoding: 'utf8' });
}

console.log('AI 助手启动器测试（PowerShell）');

t('启动器不依赖 Node.js', function () {
  assert.ok(fs.existsSync(SCRIPT), '缺少 open-ai.ps1');
  assert.ok(!fs.existsSync(path.join(WS_DIR, 'open-ai.js')), '旧的 open-ai.js 应已移除');
});

t('list 能列出 6 个模型', function () {
  const r = runPs(['list']);
  assert.strictEqual(r.status, 0, r.stderr);
  for (const key of ['claude', 'deepseek', 'gemini', 'doubao', 'chatgpt', 'qwen']) {
    assert.ok(r.stdout.indexOf(key) >= 0, '缺少模型：' + key);
  }
});

t('Claude 未安装时提供“自动下载并安装”和官方直链', function () {
  const r = runPs(['claude', '-DryRun', '-Missing', '-Choice', 'install']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('自动下载并安装') >= 0, r.stdout);
  assert.ok(r.stdout.indexOf('Claude-Setup-x64.exe') >= 0, r.stdout);
  assert.ok(r.stdout.indexOf('https://storage.googleapis.com/') >= 0, r.stdout);
  assert.ok(/已下载|自动下载并安装：/.test(r.stdout), r.stdout);
  assert.ok(r.stdout.indexOf('打开官方下载页') >= 0, r.stdout);
  assert.ok(r.stdout.indexOf('https://claude.ai/download') >= 0, r.stdout);
  assert.ok(r.stdout.indexOf('https://claude.ai/new') >= 0, r.stdout);
});

t('Claude 选择“打开官方下载页”时计划正确', function () {
  const r = runPs(['claude', '-DryRun', '-Missing', '-Choice', 'page']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('已选择：打开官方下载页：https://claude.ai/download') >= 0, r.stdout);
});

t('没有直链的模型（通义千问）改为打开官方下载页', function () {
  const r = runPs(['qwen', '-DryRun', '-Missing']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('打开官方下载页') >= 0, r.stdout);
  assert.ok(r.stdout.indexOf('https://tongyi.aliyun.com/qianwen/') >= 0, r.stdout);
  assert.ok(r.stdout.indexOf('安装命令行版') >= 0, r.stdout);
});

t('DeepSeek 未安装时可用网页版', function () {
  const r = runPs(['deepseek', '-DryRun', '-Missing', '-Choice', 'web']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('已选择：打开网页版：https://chat.deepseek.com/') >= 0, r.stdout);
});

t('未知模型返回非 0 并提示可用模型', function () {
  const r = runPs(['not-a-model', '-DryRun']);
  assert.notStrictEqual(r.status, 0);
  assert.ok(r.stderr.indexOf('未知的模型') >= 0, r.stderr);
});

t('manifest 全部改用 PowerShell，不再调用 node', function () {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.strictEqual(m.actions.length, 6);
  for (const a of m.actions) {
    assert.ok(/^powershell /i.test(a.command), '命令没有用 powershell：' + a.command);
    assert.ok(a.command.indexOf('open-ai.ps1') >= 0, '命令没有指向 open-ai.ps1：' + a.command);
    assert.ok(!/\bnode\b/i.test(a.command), '命令仍然依赖 node：' + a.command);
  }
});

t('打包时保留真实工作区文件（asar=false）', function () {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.build.asar, false,
    'asar 必须是 false，否则安装包里的工作区脚本路径不是真实目录，命令无法从工作区目录启动');
});

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
