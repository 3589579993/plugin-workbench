/**
 * AI 助手启动器
 * ---------------------------------------------------------------
 * 用法：node open-ai.js <模型名>
 *
 * 行为：
 *   1. 先在本机 PATH 里找这个模型对应的命令行工具（Claude Code、Gemini CLI 等）；
 *   2. 找到了 → 新开一个命令行窗口运行它；
 *   3. 没找到 → 用默认浏览器打开它的网页版。
 *
 * 这样工作区换到任何一台电脑上都能用：装了 CLI 就走 CLI，没装也不至于报错。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

const MODELS = {
  claude: {
    label: 'Claude（Anthropic）',
    cli: ['claude'],
    url: 'https://claude.ai/new'
  },
  deepseek: {
    label: 'DeepSeek（深度求索）',
    cli: ['deepseek'],
    url: 'https://chat.deepseek.com/'
  },
  gemini: {
    label: 'Gemini（Google）',
    cli: ['gemini'],
    url: 'https://gemini.google.com/app'
  },
  doubao: {
    label: '豆包（字节跳动）',
    cli: ['doubao'],
    url: 'https://www.doubao.com/chat/'
  },
  chatgpt: {
    label: 'ChatGPT（OpenAI，本机用 Codex CLI）',
    cli: ['codex', 'chatgpt'],
    url: 'https://chatgpt.com/'
  },
  qwen: {
    label: '通义千问（阿里）',
    cli: ['qwen'],
    url: 'https://tongyi.aliyun.com/qianwen/'
  }
};

function findCli(candidates) {
  for (const name of candidates) {
    const r = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) continue;
    const first = String(r.stdout || '')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)[0];
    if (first && fs.existsSync(first)) return { name, path: first };
  }
  return null;
}

function launchCli(cliPath) {
  const child = spawn('cmd.exe', ['/k', cliPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
}

function launchWeb(url) {
  const child = spawn('cmd.exe', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

function main() {
  const key = String(process.argv[2] || '').toLowerCase();
  const dryRun = process.argv.includes('--dry-run');

  if (key === 'list') {
    for (const [k, m] of Object.entries(MODELS)) {
      const cli = findCli(m.cli);
      console.log(`${k.padEnd(9)} ${m.label}   ${cli ? 'CLI: ' + cli.name : '网页版'}`);
    }
    return;
  }

  const model = MODELS[key];
  if (!model) {
    console.error('未知的模型：' + (key || '(空)'));
    console.error('可用：' + Object.keys(MODELS).join(', '));
    process.exitCode = 1;
    return;
  }

  console.log('▸ ' + model.label);

  const cli = findCli(model.cli);
  if (cli) {
    console.log('  本机已安装命令行工具：' + cli.path);
    console.log('  正在新窗口启动…');
    if (!dryRun) launchCli(cli.path);
  } else {
    console.log('  本机未安装命令行工具，改开网页版：' + model.url);
    if (!dryRun) launchWeb(model.url);
  }

  if (dryRun) console.log('（dry-run：没有真的启动）');
}

main();
