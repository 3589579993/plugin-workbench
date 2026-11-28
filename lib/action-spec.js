const fs = require('fs');
const path = require('path');
const PLATFORMS = ['win32', 'darwin', 'linux'];
const LABELS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const nonblank = s => typeof s === 'string' && !!s.trim();

function validateAction(a, index) {
  const prefix = `第 ${index + 1} 个动作`;
  if (a.platforms !== undefined && (!Array.isArray(a.platforms) || !a.platforms.length || a.platforms.some(p => !PLATFORMS.includes(p)))) throw new Error(prefix + ' platforms 必须是 win32 / darwin / linux 的非空数组');
  if (a.script !== undefined) {
    if (!nonblank(a.script) || path.isAbsolute(a.script) || /^[a-zA-Z]:/.test(a.script) || a.script.split(/[\\/]/).includes('..')) throw new Error(prefix + ' script 必须是包内相对路径');
    if (a.args !== undefined && (!Array.isArray(a.args) || a.args.some(x => typeof x !== 'string'))) throw new Error(prefix + ' args 必须是字符串数组');
    return;
  }
  if (nonblank(a.command)) return;
  if (a.command && typeof a.command === 'object' && !Array.isArray(a.command)) {
    const entries = Object.entries(a.command);
    if (entries.length && entries.every(([key, value]) => [...PLATFORMS, 'default'].includes(key) && nonblank(value))) return;
  }
  throw new Error(prefix + '缺少 command（要执行的命令）');
}

function resolveAction(a, platform = process.platform) {
  let command = '';
  if (a.script) command = 'node ' + [a.script, ...(a.args || [])].map(s => JSON.stringify(s)).join(' ');
  else command = typeof a.command === 'string' ? a.command : (a.command && (a.command[platform] || a.command.default)) || '';
  const available = (!a.platforms || a.platforms.includes(platform)) && !!command;
  return { ...a, command, available, unavailableReason: available ? '' : `此动作不支持 ${LABELS[platform] || platform}` };
}

function scriptPath(pkgDir, script) {
  const base = fs.realpathSync(pkgDir);
  const target = fs.realpathSync(path.resolve(base, script.replace(/\\/g, '/')));
  if (!target.startsWith(base + path.sep) || !fs.statSync(target).isFile()) throw new Error('脚本必须位于工作区包内');
  return target;
}

function actionId(ws, action, index) {
  return ws.id + ':' + (action.id || (index + '-' + (action.title || 'action')));
}
function workspaceDataKey(id) {
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) return id;
  return require('crypto').createHash('sha256').update(String(id)).digest('hex').slice(0, 20);
}
module.exports = { PLATFORMS, LABELS, validateAction, resolveAction, scriptPath, actionId, workspaceDataKey };
