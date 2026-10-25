/**
 * 可插件化工作台 · 主进程（软件后台）
 * ---------------------------------------------------------------
 * 职责：开窗口、读工作区包、**真正执行命令**、把输出流式回传给界面。
 * 安全：窗口（渲染进程）没有本机权限，只能通过下面这些 IPC 通道请求后台做事。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { resolveRun } = require('./lib/resolve-run');

// ── 自定义协议：只为「工作区目录」提供文件访问 ──────────────────
// 用途：L3（自定义界面）的沙箱 iframe 需要加载工作区自带的 HTML；
//       在沙箱里用 file:// 不可靠，因此由主进程按"白名单目录"读取文件。
// 地址形式：wsp://local/<url编码的工作区id>/<包内相对路径>
//          例：wsp://local/%E5%9F%BA%E7%A1%80%E5%B7%A5%E4%BD%9C/ui/index.html
protocol.registerSchemesAsPrivileged([
  { scheme: 'wsp', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8'
};
function mimeOf(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

// ── 状态 ────────────────────────────────────────────────────────
let win = null;
const runs = new Map();              // runId -> { child, pid, actionId, startedAt, stopped }
let installed = [];                  // 老的「导入记录」（绝对路径列表，保留用于兼容旧版本）

const BUILTIN_DIR = path.join(__dirname, 'workspaces');
/** 工作区文件夹：用户自己把工作区包复制进来的地方（像 Minecraft 的 mods 目录） */
const MANAGED_DIR = () => path.join(app.getPath('userData'), 'workspaces');
const storePath = () => path.join(app.getPath('userData'), 'installed.json');

/** 把工作区包整份复制进软件目录（跳过开发残留目录，避免复制一堆无用文件） */
function copyPackageInto(srcDir, wsId) {
  const root = MANAGED_DIR();
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, wsId);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(srcDir, target, {
    recursive: true,
    filter: (src) => {
      const b = path.basename(src);
      return b !== 'node_modules' && b !== '.git' && b !== '.DS_Store'
          && b !== '__MACOSX' && b !== '.vscode';
    }
  });
  return target;
}

// ── 清单校验与读取 ──────────────────────────────────────────────
function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest.json 不是一个对象');
  if (!m.name || typeof m.name !== 'string') throw new Error('缺少 name（工作区名称）');
  if (!Array.isArray(m.actions) || !m.actions.length) throw new Error('缺少 actions（至少要有一个动作）');
  m.actions.forEach((a, i) => {
    if (!a || typeof a !== 'object') throw new Error(`第 ${i + 1} 个动作格式错误`);
    if (!a.title) throw new Error(`第 ${i + 1} 个动作缺少 title（按钮名）`);
    if (!a.command) throw new Error(`第 ${i + 1} 个动作缺少 command（要执行的命令）`);
  });
  if (!m.icon) m.icon = '📦';
  if (!m.permissions) m.permissions = ['exec'];
  if (!m.version) m.version = '1.0.0';
  // cwd 允许写成相对路径（相对工作区包目录），统一转成字符串
  m.actions.forEach(a => { if (a.cwd !== undefined) a.cwd = String(a.cwd); });
  // 自定义界面（L3）：允许写成字符串或对象，统一成 { entry }
  if (m.ui) {
    if (typeof m.ui === 'string') m.ui = { entry: m.ui };
    if (!m.ui || typeof m.ui.entry !== 'string' || !m.ui.entry.trim()) delete m.ui;
    else m.ui.entry = m.ui.entry.trim().replace(/^[/\\]+/, '');
  }
  return m;
}

/** 读取一个工作区包目录（要求里面有 manifest.json） */
function readPackage(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return { ok: false, error: '这个文件夹里没有 manifest.json' };
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');   // 容忍记事本存出的 BOM
    const m = validateManifest(JSON.parse(raw));
    if (!m.id) m.id = path.basename(dir);
    return { ok: true, manifest: m, dir: dir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 扫描一个目录：里面每个子目录 = 一个工作区包（含 manifest.json） */
function scanDir(dir, isBuiltin) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const name of names) {
    const sub = path.join(dir, name);
    try { if (!fs.statSync(sub).isDirectory()) continue; } catch (e) { continue; }
    const r = readPackage(sub);
    if (r.ok) out.push({ ...r.manifest, dir: sub, builtin: isBuiltin });
    else console.warn('[' + (isBuiltin ? '内置工作区' : '工作区文件夹') + '读取失败]', name, r.error);
  }
  return out;
}

/** 读取用户导入记录 */
function loadStore() {
  try {
    if (fs.existsSync(storePath())) {
      const arr = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
      if (Array.isArray(arr)) installed = arr.filter(p => typeof p === 'string');
    }
  } catch (e) { installed = []; }
}
function saveStore() {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(installed, null, 2), 'utf8');
  } catch (e) { console.warn('保存导入记录失败', e.message); }
}

/** 汇总：内置工作区 + 工作区文件夹里用户自己复制进来的包
 *  每次调用都重新扫描两个目录 → 新复制进去的工作区不用重启软件，点「刷新」即可出现。
 *  同名冲突：内置的优先，其次工作区文件夹里排在前面的那个。 */
function allWorkspaces() {
  const out = scanDir(BUILTIN_DIR, true);
  const seen = new Set(out.map(w => w.id));

  for (const w of scanDir(MANAGED_DIR(), false)) {
    if (seen.has(w.id)) continue;       // 与内置工作区同 id → 内置优先
    seen.add(w.id);
    out.push(w);
  }

  // 兼容旧版本的「导入记录」：目录还存在、且没被上面收进来的，也列出来
  for (const dir of installed) {
    const r = readPackage(dir);
    if (!r.ok) continue;
    if (seen.has(r.manifest.id)) continue;
    seen.add(r.manifest.id);
    out.push({ ...r.manifest, dir: dir, builtin: false });
  }
  return out;
}

// ── 执行引擎 ────────────────────────────────────────────────────
function send(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('wb:event', msg);
}

/** Windows 上杀掉整棵进程树（只杀父进程常常留下子进程） */
function killTree(pid) {
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${pid} /T /F`, () => {});
  } else {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
  }
}

function runAction(spec) {
  const runId = 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

  // 找这个工作区包在哪 → 它所在的目录就是命令的**默认工作目录**
  const ws = allWorkspaces().find(w => w.id === spec.workspaceId);
  const resolved = resolveRun({
    command: spec.command,
    cwd: spec.cwd,
    pkgDir: (ws && ws.dir) || '',
    exists: p => { try { return fs.existsSync(p); } catch (e) { return false; } }
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const cwd = resolved.cwd;

  // Windows 下强制 UTF-8，避免中文输出乱码
  const cmd = process.platform === 'win32' ? 'chcp 65001>nul & ' + spec.command : spec.command;

  const child = spawn(cmd, {
    cwd: cwd,
    shell: true,
    windowsHide: true,
    env: process.env
  });

  const rec = { child, pid: child.pid, actionId: spec.actionId, startedAt: Date.now(), stopped: false };
  runs.set(runId, rec);

  send({ type: 'started', runId, actionId: spec.actionId, pid: child.pid,
         command: spec.command, cwd: cwd || null });

  child.stdout.on('data', d => send({ type: 'output', runId, stream: 'stdout', text: d.toString('utf8') }));
  child.stderr.on('data', d => send({ type: 'output', runId, stream: 'stderr', text: d.toString('utf8') }));

  child.on('error', err => {
    send({ type: 'output', runId, stream: 'stderr', text: '启动失败：' + err.message + '\n' });
  });

  child.on('exit', (code, signal) => {
    const dur = ((Date.now() - rec.startedAt) / 1000).toFixed(1);
    send({
      type: 'exit', runId, actionId: spec.actionId,
      code: code, signal: signal, stopped: rec.stopped, duration: dur
    });
    runs.delete(runId);
  });

  return { ok: true, runId, pid: child.pid };
}

function stopRun(runId) {
  const rec = runs.get(runId);
  if (!rec) return { ok: false, error: '这条执行已经结束' };
  rec.stopped = true;
  send({ type: 'output', runId, stream: 'stderr', text: '（用户请求停止，正在结束进程…）\n' });
  killTree(rec.pid);
  return { ok: true };
}

// ── 窗口 ────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#FFFFFF',
    frame: false,             // 无边框：标题栏与窗口按钮由界面自绘（像 VS Code）
    title: '可插件化工作台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // 界面与后台隔离
      nodeIntegration: false,   // 界面拿不到 Node 能力
      sandbox: true             // 界面关进沙箱（安全底线）
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 最大化状态变化时通知界面，好把右上角的 □ / ❐ 图标换掉
  win.on('maximize', () => send({ type: 'maximized', value: true }));
  win.on('unmaximize', () => send({ type: 'maximized', value: false }));
}

// ── IPC（界面 → 后台）────────────────────────────────────────────
ipcMain.handle('wb:listWorkspaces', () => allWorkspaces());

/** 供界面显示/打开"工作区文件夹"（用户自行把工作区包复制进去） */
ipcMain.handle('wb:workspaceDir', () => {
  const dir = MANAGED_DIR();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 忽略 */ }
  return { ok: true, dir };
});

ipcMain.handle('wb:run', (e, spec) => {
  if (!spec || !spec.command) return { ok: false, error: '缺少命令' };
  return runAction(spec);
});

ipcMain.handle('wb:stop', (e, runId) => stopRun(runId));

/** 选一个工作区包目录（只读取、不安装）
 *  说明：界面上的「导入工作区」按钮已移除（安装改为"用户自行复制到工作区文件夹"）。
 *  下面这几个处理器保留着，供将来做"拖拽安装 / .wsp 一键导入"时直接复用。 */
ipcMain.handle('wb:pickPackage', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择工作区包文件夹（含 manifest.json）· 导入后会复制进软件目录',
    properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const dir = r.filePaths[0];
  const pkg = readPackage(dir);
  if (!pkg.ok) return { ok: false, error: pkg.error };
  return { ok: true, dir: dir, manifest: pkg.manifest };
});

/** 确认后真正安装：把工作区包**复制**进软件自己的目录（之后与原始文件夹无关） */
ipcMain.handle('wb:installPackage', (e, dir) => {
  const pkg = readPackage(dir);
  if (!pkg.ok) return { ok: false, error: pkg.error };

  const wsId = pkg.manifest.id || path.basename(dir);
  const target = path.join(MANAGED_DIR(), wsId);

  // 同名已安装 → 询问是否覆盖
  if (fs.existsSync(target)) {
    const btn = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['覆盖安装', '取消'], defaultId: 0, cancelId: 1,
      title: '已存在同名工作区',
      message: `已经安装过「${pkg.manifest.name}」，是否覆盖安装？`,
      detail: '覆盖会替换软件目录里已复制的那一份文件。'
    });
    if (btn !== 0) return { ok: false, canceled: true };
  }

  try {
    const dest = copyPackageInto(dir, wsId);      // ← 复制进软件目录
    const re = readPackage(dest);
    if (!re.ok) return { ok: false, error: '复制后校验失败：' + re.error };

    // 清掉同 id 的旧记录，再登记新目录
    installed = installed.filter(p => {
      if (path.resolve(p) === path.resolve(dest)) return false;
      const r2 = readPackage(p);
      return !(r2.ok && r2.manifest.id === re.manifest.id);
    });
    installed.push(dest);
    saveStore();
    return { ok: true, manifest: re.manifest, dir: dest, copiedTo: dest };
  } catch (err) {
    return { ok: false, error: '复制失败：' + err.message };
  }
});

/** 卸载：移除记录，并删掉**已复制进软件目录**的那份文件（不碰用户原始文件夹） */
ipcMain.handle('wb:uninstall', (e, dir) => {
  installed = installed.filter(d => d !== dir);
  saveStore();
  let deleted = false;
  try {
    const managed = path.resolve(MANAGED_DIR());
    const target = path.resolve(dir);
    if (target.startsWith(managed + path.sep) && fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      deleted = true;
    }
  } catch (err) { /* 忽略删除失败 */ }
  return { ok: true, deleted: deleted };
});

/** 导出一个工作区包（在用户选的目录里写 manifest.json） */
ipcMain.handle('wb:exportPackage', async (e, id) => {
  const w = allWorkspaces().find(x => x.id === id);
  if (!w) return { ok: false, error: '找不到该工作区' };
  const r = await dialog.showOpenDialog(win, {
    title: '选择导出位置（会在这里新建一个工作区文件夹）',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  try {
    const target = path.join(r.filePaths[0], w.id);
    fs.mkdirSync(target, { recursive: true });
    const manifest = {
      id: w.id, name: w.name, icon: w.icon, description: w.description,
      version: w.version, permissions: w.permissions || ['exec'],
      actions: (w.actions || []).map(a => {
        const o = { title: a.title, icon: a.icon, command: a.command };
        if (a.cwd) o.cwd = a.cwd;
        if (a.mode) o.mode = a.mode;
        return o;
      })
    };
    fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    shell.openPath(target);
    return { ok: true, dir: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wb:openPath', (e, p) => { shell.openPath(p); return { ok: true }; });

// ── 窗口控制（因为是无边框窗口，最小化/最大化/关闭由界面按钮触发）──
ipcMain.handle('wb:winMinimize', () => { if (win) win.minimize(); return { ok: true }; });

ipcMain.handle('wb:winToggleMaximize', () => {
  if (!win) return { maximized: false };
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return { maximized: win.isMaximized() };
});

ipcMain.handle('wb:winClose', () => { if (win) win.close(); return { ok: true }; });

ipcMain.handle('wb:winIsMaximized', () => ({ maximized: win ? win.isMaximized() : false }));

// ── wsp:// 协议处理：按白名单目录（工作区目录）读取文件 ───────────
function registerWorkspaceProtocol() {
  protocol.handle('wsp', async (request) => {
    try {
      const u = new URL(request.url);
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (u.hostname !== 'local' || parts.length < 2) {
        return new Response('bad request', { status: 400 });
      }
      const wsId = parts[0];
      const rel = parts.slice(1).join('/');

      const ws = allWorkspaces().find(w => w.id === wsId);
      if (!ws || !ws.dir) return new Response('workspace not found: ' + wsId, { status: 404 });

      const baseDir = path.resolve(ws.dir);
      const target = path.resolve(baseDir, rel);
      // 防目录穿越：必须仍在工作区目录内
      if (target !== baseDir && !target.startsWith(baseDir + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        return new Response('not found: ' + rel, { status: 404 });
      }
      const data = fs.readFileSync(target);
      return new Response(data, { headers: { 'content-type': mimeOf(target) } });
    } catch (e) {
      return new Response('error: ' + e.message, { status: 500 });
    }
  });
}

// ── 生命周期 ────────────────────────────────────────────────────
app.whenReady().then(() => {
  registerWorkspaceProtocol();
  loadStore();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  // 关窗口前，先停掉还在跑的进程，避免留下后台残留
  for (const [runId] of runs) stopRun(runId);
  if (process.platform !== 'darwin') app.quit();
});
