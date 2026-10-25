/**
 * 安全桥（preload）
 * ---------------------------------------------------------------
 * 界面（渲染进程）被关在沙箱里、没有本机权限。
 * 这里只把"允许界面调用的几个动作"暴露给它，别的一概不给。
 * 这样即使将来插件自带界面（自定义界面），它能做的也只是这几个受控接口。
 *
 * 注：v0.1 的安装方式改为"用户自己把工作区包复制进工作区文件夹"，
 * 所以「选目录导入 / 导出工作区」这几个接口**没有**暴露给界面；
 * 后台里对应的处理器还留着，等做"拖拽安装 / .wsp 一键导入"时再接上来。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wb', {
  /** 拿到所有工作区（内置 + 已导入） */
  listWorkspaces: () => ipcRenderer.invoke('wb:listWorkspaces'),

  /** 请求后台执行一个动作 */
  run: (spec) => ipcRenderer.invoke('wb:run', spec),

  /** 请求停止一条正在执行的动作 */
  stop: (runId) => ipcRenderer.invoke('wb:stop', runId),

  /** 安装位置（工作区文件夹）：界面只用来显示和打开，安装由用户自己复制完成 */
  workspaceDir: () => ipcRenderer.invoke('wb:workspaceDir'),

  /** 卸载某个已导入的工作区（只删软件目录里的那一份） */
  uninstall: (dir) => ipcRenderer.invoke('wb:uninstall', dir),

  /** 在资源管理器里打开某个路径 */
  openPath: (p) => ipcRenderer.invoke('wb:openPath', p),

  /** 窗口控制（无边框窗口：由界面上的按钮触发，而不是系统标题栏）*/
  winMinimize: () => ipcRenderer.invoke('wb:winMinimize'),
  winToggleMaximize: () => ipcRenderer.invoke('wb:winToggleMaximize'),
  winClose: () => ipcRenderer.invoke('wb:winClose'),
  winIsMaximized: () => ipcRenderer.invoke('wb:winIsMaximized'),

  /** 订阅后台事件（开始/输出/结束/最大化状态） */
  onEvent: (cb) => { ipcRenderer.on('wb:event', (_e, msg) => cb(msg)); }
});
