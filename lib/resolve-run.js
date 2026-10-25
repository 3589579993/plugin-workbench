/**
 * 运行参数解析（纯函数，不依赖 Electron，可以直接跑测试）
 * ---------------------------------------------------------------
 * 只解决一个问题：**命令要站在哪个目录里跑**。
 *
 * 有些命令完全不在乎目录（开个窗口、开个程序），
 * 有些命令必须站在对的目录里才行（npm / git / 读相对路径的脚本），
 * 而它们出错时的提示常常很难懂（"找不到文件"其实文件就在旁边）。
 * 所以规则必须简单、而且能一眼看懂：
 *
 *   1. 默认 → 站在**工作区包自己的目录**里跑
 *      （作者把脚本和脚本要用的文件一起放进包，就一定找得到；
 *        换到别人电脑上、换到别的位置打开软件，行为都一样）
 *   2. 动作里写了 cwd → 用它
 *      · 绝对路径（C:\... / \\机器\共享 / /xxx）→ 直接用
 *      · 相对路径 → 相对"工作区包目录"算（写 sub\dir 这种更省事，
 *        也方便整个包搬到别处）
 *
 * 不归软件管的事：「脚本要处理哪个文件夹」。
 *   需要用户挑路径，就让脚本自己弹窗（Python 的 tkinter、
 *   PowerShell 的 Shell.Application.BrowseForFolder 都行），
 *   这样脚本在哪跑都一样，通用性最高。
 *   包要能发布，靠的是作者：把文件放包里、路径写成相对的、
 *   需要用户选路径就自己弹窗——软件只保证"站在对的目录里把脚本启动起来"。
 */

/** 判断是不是绝对路径（Windows 盘符 / UNC 共享 / 类 Unix 根目录） */
function isAbsolutePath(p) {
  const s = String(p || '');
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/');
}

/**
 * @param {object} o
 * @param {string} o.command               动作声明的命令
 * @param {string} [o.cwd]                 动作声明的 cwd（可省略）
 * @param {string} [o.pkgDir]              工作区包所在目录（= 默认工作目录）
 * @param {(p:string)=>boolean} [o.exists] 判断目录是否存在（测试时可注入）
 * @returns {{ok:true, cwd:string|undefined, source:string} | {ok:false, error:string}}
 *          source 说明这个目录是怎么来的：package（默认） / cwd（动作声明）
 */
function resolveRun(o) {
  const opts = o || {};
  const command = String(opts.command == null ? '' : opts.command);
  const pkgDir = opts.pkgDir ? String(opts.pkgDir) : '';
  const exists = opts.exists || (() => true);

  if (!command.trim()) return { ok: false, error: '这个动作没有声明命令' };

  let cwd = pkgDir || undefined;
  let source = 'package';

  if (opts.cwd !== undefined && opts.cwd !== null && String(opts.cwd).trim() !== '') {
    const p = String(opts.cwd).trim();
    cwd = isAbsolutePath(p)
      ? p                                                    // 绝对路径：直接用
      : (pkgDir ? pkgDir + '\\' + p.replace(/^[\\/]+/, '')    // 相对路径：相对工作区包目录
                : p);
    source = 'cwd';
  }

  if (cwd && !exists(cwd)) {
    return { ok: false, error: '工作目录不存在：' + cwd };
  }

  return { ok: true, cwd: cwd, source: source };
}

module.exports = { resolveRun, isAbsolutePath };
