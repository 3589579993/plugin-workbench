const fs = require('node:fs');
const path = require('node:path');

let nextId = 0;
const pending = new Map();
process.on('message', msg => {
  if (msg?.type !== 'wb:reply') return;
  const request = pending.get(msg.id);
  if (!request) return;
  pending.delete(msg.id);
  if (msg.error) request.reject(new Error(msg.error));
  else request.resolve(msg.value);
});
process.channel?.unref();
process.on('disconnect', () => {
  for (const request of pending.values()) request.reject(new Error('工作台连接已关闭'));
  pending.clear();
});

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!process.connected) return reject(new Error('此脚本需要从可插件化工作台启动'));
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    process.channel?.ref();
    process.send({ type: 'wb:request', id, method, params }, error => {
      if (!error) return;
      pending.delete(id);
      reject(error);
    });
  }).finally(() => {
    if (!pending.size) process.channel?.unref();
  });
}

function dataFile(name) {
  const dir = process.env.WB_DATA_DIR;
  if (!dir) throw new Error('缺少插件数据目录');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function cancelled() { console.log('（已取消）'); }

async function main(fn) {
  try { await fn(); }
  catch (error) { console.error('[失败] ' + error.message); process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
}

module.exports = { request, dataFile, cancelled, main };
