/**
 * 测试脚手架：桩（stub）+ 驱动（driver）
 * ------------------------------------------------------------------
 * 用途：给"可插件化工作台"做黑盒 / 集成的自动化测试。
 *
 * 思路：
 *   1. 桩（stub）—— 把 main.js 依赖的外部模块替换成假的：
 *        · electron        （app / BrowserWindow / ipcMain / dialog / shell / protocol）
 *        · child_process   （spawn 假子进程、exec 记录 killTree 命令）
 *      这样不需要真的开窗口、不需要真的起进程，就能观察主进程的行为。
 *   2. 驱动（driver）—— boot() 加载真正的 main.js，把它注册的 ipcMain 通道
 *      收集起来，测试代码通过 invoke(channel, ...) 调用，等价于界面的调用。
 *   3. 观测点：
 *        · events        主进程推给界面的消息（send → wb:event）
 *        · children      每次 spawn 记录下的命令与工作目录
 *        · execCalls     killTree 发出的 taskkill 命令
 *        · protocolHandler  wsp:// 协议处理器（可直接喂 URL 观察响应）
 *
 * 注意：不改动 main.js 一个字节。用户数据目录被指向临时目录，测完即删。
 */
'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..', '..');          // plugin-workbench/
const MAIN = path.join(ROOT, 'main.js');

function boot(opts) {
  const options = opts || {};
  const userData = options.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'wb-'));
  fs.mkdirSync(path.join(userData, 'workspaces'), { recursive: true });

  const state = {
    userData: userData,
    events: [],          // 主进程 → 界面的消息
    children: [],        // spawn 记录
    execCalls: [],       // taskkill 等
    shellCalls: [],      // shell.openPath 打开过的路径
    window: null,        // 最近创建的假窗口
    handlers: {},        // ipcMain.handle 注册的通道
    appOn: {},           // app.on 注册的生命周期钩子
    protocolHandler: null,
    dialog: {
      messageBoxAnswer: 0,     // showMessageBoxSync 的返回值（0=覆盖安装 / 1=取消）
      openDialogResult: []     // showOpenDialog 返回的 filePaths
    },
    quitCalls: 0
  };

  /* ── 桩：假 electron ─────────────────────────────────────────── */
  const fakeWebContents = { send: function (ch, msg) { state.events.push(msg); } };

  function FakeWindow() {
    this.webContents = fakeWebContents;
    this.destroyed = false;
    this.minimized = false;
    this.maximized = false;
    this.visible = false;
    state.window = this;
  }
  FakeWindow.prototype.loadFile = function () { return Promise.resolve(); };
  FakeWindow.prototype.setMenuBarVisibility = function () {};
  FakeWindow.prototype.on = function () { return this; };
  FakeWindow.prototype.isDestroyed = function () { return this.destroyed; };
  FakeWindow.prototype.isMaximized = function () { return this.maximized; };
  FakeWindow.prototype.maximize = function () { this.maximized = true; };
  FakeWindow.prototype.unmaximize = function () { this.maximized = false; };
  FakeWindow.prototype.minimize = function () { this.minimized = true; };
  FakeWindow.prototype.close = function () { this.destroyed = true; };
  FakeWindow.getAllWindows = function () { return []; };

  const fakeElectron = {
    app: {
      getPath: function (name) {
        if (name === 'userData') return state.userData;
        return path.join(state.userData, name || 'tmp');
      },
      whenReady: function () { return Promise.resolve(); },
      on: function (name, fn) { state.appOn[name] = fn; },
      quit: function () { state.quitCalls++; }
    },
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: function (channel, fn) { state.handlers[channel] = fn; }
    },
    dialog: {
      showMessageBoxSync: function () { return state.dialog.messageBoxAnswer; },
      showOpenDialog: function () {
        return Promise.resolve({
          canceled: state.dialog.openDialogResult.length === 0,
          filePaths: state.dialog.openDialogResult
        });
      }
    },
    shell: {
      openPath: function (p) { state.shellCalls.push(p); return Promise.resolve(''); }
    },
    protocol: {
      registerSchemesAsPrivileged: function () {},
      handle: function (scheme, fn) { if (scheme === 'wsp') state.protocolHandler = fn; }
    }
  };

  /* ── 桩：假 child_process ────────────────────────────────────── */
  const fakeChildProcess = {
    spawn: function (command, spawnOpts) {
      const child = new EventEmitter();
      child.pid = 40000 + state.children.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      const rec = { command: command, options: spawnOpts, child: child };
      state.children.push(rec);
      return child;
    },
    exec: function (command, cb) {
      state.execCalls.push(command);
      if (typeof cb === 'function') cb(null, '', '');
      return { pid: 1 };
    }
  };

  /* ── 拦截 require，把上面两个假模块塞给 main.js ───────────────── */
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request === 'child_process') return fakeChildProcess;
    return originalLoad.apply(this, arguments);
  };

  let loadError = null;
  try {
    delete require.cache[MAIN];
    require(MAIN);
  } catch (e) {
    loadError = e;
  } finally {
    Module._load = originalLoad;
  }

  /* ── 驱动接口 ───────────────────────────────────────────────── */
  const api = {
    state: state,
    loadError: loadError,
    userData: userData,
    /** 等 app.whenReady().then(...) 里注册协议、建窗口都执行完 */
    ready: function () { return new Promise(function (r) { setTimeout(r, 30); }); },
    /** 等价于界面调用 window.wb.xxx() */
    invoke: function (channel) {
      const fn = state.handlers[channel];
      if (!fn) throw new Error('未注册的通道: ' + channel);
      const args = Array.prototype.slice.call(arguments, 1);
      return Promise.resolve(fn.apply(null, [{}].concat(args)));
    },
    has: function (channel) { return !!state.handlers[channel]; },
    channels: function () { return Object.keys(state.handlers); },
    /** 最近一次 spawn 的记录 */
    lastChild: function () { return state.children[state.children.length - 1]; },
    /** 让最近一次 spawn 的假子进程吐输出 / 退出 */
    emitStdout: function (text) { api.lastChild().child.stdout.emit('data', Buffer.from(text, 'utf8')); },
    emitStderr: function (text) { api.lastChild().child.stderr.emit('data', Buffer.from(text, 'utf8')); },
    emitExit: function (code) { api.lastChild().child.emit('exit', code, null); },
    /** 取某个类型的事件 */
    eventsOf: function (type) {
      return state.events.filter(function (e) { return e.type === type; });
    },
    clear: function () { state.events.length = 0; },
    /** 在用户工作区目录里写一个工作区包 */
    writePackage: function (id, manifest, extraFiles) {
      const dir = path.join(state.userData, 'workspaces', id);
      fs.mkdirSync(dir, { recursive: true });
      const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2);
      fs.writeFileSync(path.join(dir, 'manifest.json'), body, 'utf8');
      if (extraFiles) {
        Object.keys(extraFiles).forEach(function (name) {
          const f = path.join(dir, name);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, extraFiles[name], 'utf8');
        });
      }
      return dir;
    },
    cleanup: function () {
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
  };
  return api;
}

module.exports = { boot: boot, ROOT: ROOT };
