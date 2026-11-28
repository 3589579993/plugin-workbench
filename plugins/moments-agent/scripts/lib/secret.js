'use strict';
// API key 加密保存。
// Windows：DPAPI（当前用户），换电脑或换用户无法解密——与需求文档 8.11 一致。
// macOS / Linux：AES-256-GCM，密钥文件只有当前用户可读（0600）。能防止配置文件被直接看到或被单独拷走，
//               但不等同于系统钥匙串；这一点在 README 里写明。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function powershell(script, input) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + script],
    { input, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.error || r.status !== 0) throw new Error('Windows 加密服务不可用：' + ((r.stderr || (r.error && r.error.message) || '').trim().slice(0, 200)));
  return r.stdout.trim();
}
const DPAPI = "Add-Type -AssemblyName System.Security;$s=[Console]::In.ReadToEnd();";

function createSecretStore(dir, platform = process.platform) {
  const keyFile = path.join(dir, 'secret.key');
  function aesKey() {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    return fs.readFileSync(keyFile);
  }
  function encrypt(plain) {
    if (platform === 'win32') {
      return 'dpapi:' + powershell(DPAPI + "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,'CurrentUser'))", plain);
    }
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return 'aes:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  }
  function decrypt(blob) {
    if (!blob) return '';
    if (blob.startsWith('dpapi:')) {
      return powershell(DPAPI + "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s.Trim()),$null,'CurrentUser'))", blob.slice(6));
    }
    if (blob.startsWith('aes:')) {
      const raw = Buffer.from(blob.slice(4), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), raw.slice(0, 12));
      d.setAuthTag(raw.slice(12, 28));
      return Buffer.concat([d.update(raw.slice(28)), d.final()]).toString('utf8');
    }
    throw new Error('无法识别的密钥格式');
  }
  return { encrypt, decrypt };
}
module.exports = { createSecretStore };
