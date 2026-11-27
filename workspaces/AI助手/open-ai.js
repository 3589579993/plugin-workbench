/**
 * AI 助手启动器
 * ---------------------------------------------------------------
 * 用法：node open-ai.js <模型名> [--dry-run] [--missing]
 *
 * 行为：
 *   1. 先在本机 PATH 里找这个模型对应的命令行工具（Claude Code、Gemini CLI 等）；
 *   2. 找到了 → 新开一个命令行窗口运行它；
 *   3. 没找到 → 弹窗让用户选择：
 *        · 自动安装 CLI（npm install -g，需要 Node.js/npm）
 *        · 打开官方下载页（装桌面版/按官方说明安装）
 *        · 取消（直接用网页版）
 *
 *   没有官方 CLI 的模型（DeepSeek / 豆包）直接打开网页版，并打印官方下载地址。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

const NODE_DOWNLOAD = 'https://nodejs.org/en/download';

const MODELS = {
  claude: {
    label: 'Claude（Anthropic）',
    cli: ['claude'],
    cliPkg: '@anthropic-ai/claude-code',
    url: 'https://claude.ai/new',
    downloadUrl: 'https://claude.ai/download'
  },
  deepseek: {
    label: 'DeepSeek（深度求索）',
    cli: ['deepseek'],
    cliPkg: null,
    url: 'https://chat.deepseek.com/',
    downloadUrl: 'https://www.deepseek.com/'
  },
  gemini: {
    label: 'Gemini（Google）',
    cli: ['gemini'],
    cliPkg: '@google/gemini-cli',
    url: 'https://gemini.google.com/app',
    downloadUrl: 'https://github.com/google-gemini/gemini-cli'
  },
  doubao: {
    label: '豆包（字节跳动）',
    cli: ['doubao'],
    cliPkg: null,
    url: 'https://www.doubao.com/chat/',
    downloadUrl: 'https://www.doubao.com/chat/'
  },
  chatgpt: {
    label: 'ChatGPT（OpenAI，本机用 Codex CLI）',
    cli: ['codex', 'chatgpt'],
    cliPkg: '@openai/codex',
    url: 'https://chatgpt.com/',
    downloadUrl: 'https://openai.com/chatgpt/download/'
  },
  qwen: {
    label: '通义千问（阿里）',
    cli: ['qwen'],
    cliPkg: '@qwen-code/qwen-code',
    url: 'https://tongyi.aliyun.com/qianwen/',
    downloadUrl: 'https://tongyi.aliyun.com/qianwen/'
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

function findNpm() {
  const r = spawnSync('where.exe', ['npm'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || null;
}

function launchCli(cliPath) {
  const child = spawn('cmd.exe', ['/k', '"' + cliPath + '"'], {
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

function launchInstall(pkg, label) {
  const line = 'chcp 65001 >nul & npm install -g ' + pkg +
    ' && echo. && echo 安装完成，请回到工作台再点一次 ' + label + '。';
  const child = spawn('cmd.exe', ['/k', line], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
}

/** 用 Windows 原生弹窗询问（不需要 Electron 窗口，也不会被工作台遮挡） */
function showChoice(title, text) {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$r = [System.Windows.Forms.MessageBox]::Show($owner, $env:WB_AI_MSG, $env:WB_AI_TITLE, [System.Windows.Forms.MessageBoxButtons]::YesNoCancel, [System.Windows.Forms.MessageBoxIcon]::Question)',
    '$owner.Dispose()',
    '[Console]::Out.Write($r)'
  ].join('; ');

  const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
    env: Object.assign({}, process.env, { WB_AI_MSG: text, WB_AI_TITLE: title })
  });
  if (r.status !== 0) return null;
  const answer = String(r.stdout || '').trim().toLowerCase();
  if (answer === 'yes') return 'yes';
  if (answer === 'no') return 'no';
  return 'cancel';
}

function missingPlan(model, npmFound) {
  if (npmFound) {
    return {
      text: '未检测到本机的 ' + model.label + ' 命令行工具。\n\n' +
            '点「是」：自动安装 ' + model.cliPkg + '（npm install -g）\n' +
            '点「否」：打开官方下载页面\n' +
            '点「取消」：直接用网页版\n\n' +
            '网页版：' + model.url,
      yes: 'install',
      no: 'download',
      cancel: 'web',
      dry: '自动安装 ' + model.cliPkg + ' / 打开官方下载页 / 用网页版'
    };
  }
  return {
    text: '未检测到本机的 ' + model.label + ' 命令行工具，也没有找到 npm。\n\n' +
          '点「是」：打开 Node.js 下载页（安装 Node.js 后就能用 npm 安装）\n' +
          '点「否」：打开官方下载页面\n' +
          '点「取消」：直接用网页版\n\n' +
          '网页版：' + model.url,
    yes: 'node',
    no: 'download',
    cancel: 'web',
    dry: '打开 Node.js 下载页 / 打开官方下载页 / 用网页版'
  };
}

function doChoice(choice, model) {
  if (choice === 'install') {
    console.log('  正在打开安装窗口：npm install -g ' + model.cliPkg);
    console.log('  安装完成后回到工作台，再点一次「' + model.label + '」。');
    launchInstall(model.cliPkg, model.label);
    return;
  }
  if (choice === 'node') {
    console.log('  没有找到 npm，先打开 Node.js 下载页：' + NODE_DOWNLOAD);
    launchWeb(NODE_DOWNLOAD);
    return;
  }
  if (choice === 'download') {
    const url = model.downloadUrl || model.url;
    console.log('  打开官方下载页：' + url);
    launchWeb(url);
    return;
  }
  if (choice === 'web' || choice === 'cancel') {
    console.log('  打开网页版：' + model.url);
    launchWeb(model.url);
    return;
  }
  console.log('  已取消。');
}

function main() {
  const key = String(process.argv[2] || '').toLowerCase();
  const dryRun = process.argv.includes('--dry-run');
  const forceMissing = process.argv.includes('--missing');   // 演示/测试用：假装本机没装

  if (key === 'list') {
    for (const [k, m] of Object.entries(MODELS)) {
      const cli = findCli(m.cli);
      console.log(`${k.padEnd(9)} ${m.label}   ${cli ? 'CLI: ' + cli.name : '未安装'}` +
        (m.cliPkg ? '   npm: ' + m.cliPkg : ''));
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

  const cli = forceMissing ? null : findCli(model.cli);
  if (cli) {
    console.log('  本机已安装命令行工具：' + cli.path);
    console.log('  正在新窗口启动…');
    if (!dryRun) launchCli(cli.path);
    return;
  }

  console.log('  本机未安装命令行工具' + (forceMissing ? '（模拟）' : '') + '。');
  const npm = findNpm();

  // DeepSeek / 豆包这类没有官方 CLI 的：直接开网页版，并打印官方下载地址
  if (!model.cliPkg) {
    if (dryRun) {
      console.log('  将直接打开网页版：' + model.url);
      console.log('  官方下载：' + (model.downloadUrl || model.url));
      console.log('（dry-run：没有真的启动）');
      return;
    }
    console.log('  这个 AI 没有可自动安装的 CLI，直接打开网页版：' + model.url);
    console.log('  官方下载：' + (model.downloadUrl || model.url));
    launchWeb(model.url);
    return;
  }

  const plan = missingPlan(model, !!npm);

  if (dryRun) {
    console.log('  将弹窗询问：' + plan.dry);
    console.log('  官方下载：' + (model.downloadUrl || model.url));
    console.log('  网页版：' + model.url);
    console.log('（dry-run：没有真的启动或安装）');
    return;
  }

  const choice = showChoice('AI 助手 · ' + model.label, plan.text);
  if (!choice) {
    console.log('  无法弹出安装选择窗口，先打开官方下载页。');
    launchWeb(model.downloadUrl || model.url);
    return;
  }
  const action = choice === 'yes' ? plan.yes : (choice === 'no' ? plan.no : plan.cancel);
  doChoice(action, model);
}

main();