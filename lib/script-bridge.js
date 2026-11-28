function attachScriptBridge({ child, dialog, shell, getWindow, publish, active }) {
  const handlers = {
    async folder(params) {
      const result = await dialog.showOpenDialog(getWindow(), {
        title: String(params.title || '选择文件夹'), properties: ['openDirectory']
      });
      return result.canceled ? null : result.filePaths[0] || null;
    },
    async confirm(params) {
      const result = await dialog.showMessageBox(getWindow(), {
        type: 'question', title: String(params.title || '请确认'), message: String(params.message || ''),
        buttons: ['取消', '确定'], defaultId: 0, cancelId: 0, noLink: true
      });
      return result.response === 1;
    },
    async openPath(params) {
      const reason = await shell.openPath(String(params.path || ''));
      if (reason) throw new Error(reason);
      return true;
    },
    publish(params) {
      if (typeof params.name !== 'string') throw new Error('缺少工作区消息名称');
      publish(params.name, params.data);
    }
  };
  child.on('message', async msg => {
    if (!active() || msg?.type !== 'wb:request' || !Number.isInteger(msg.id)) return;
    const reply = { type: 'wb:reply', id: msg.id };
    try {
      if (!Object.hasOwn(handlers, msg.method)) throw new Error('不支持的脚本请求');
      reply.value = await handlers[msg.method](msg.params || {});
    } catch (error) { reply.error = error.message; }
    if (child.connected) child.send(reply, () => {});
  });
}
module.exports = { attachScriptBridge };
