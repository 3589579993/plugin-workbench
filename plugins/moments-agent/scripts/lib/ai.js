'use strict';
// AI 调用：支持 Claude（Anthropic Messages API）和 OpenAI 兼容接口（火山方舟豆包、通义千问、智谱、Gemini 等的兼容模式）。
// 除 anthropic 外，其余接口类型都走 OpenAI 的 /chat/completions 格式，只是预填的地址和模型不同。
// 插件包不能带 npm 依赖（工作台复制插件时跳过 node_modules），所以直接用内置 fetch 发 HTTP 请求。
// 发给 AI 的只有压缩后的缩略图（长边 1024）和文字，不发原图。
const { encodePng } = require('./png');

const PROVIDERS = {
  anthropic: { name: 'Claude（Anthropic）', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' },
  ark: { name: '豆包 Seed（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-1-lite-260915' },
  openai: { name: 'OpenAI 兼容接口', baseUrl: 'https://api.openai.com/v1', model: '' }
};
const TIMEOUT_MS = 120000;

class AiError extends Error {}

function translate(e, status, body) {
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return new AiError(e.name === 'TimeoutError' ? 'AI 接口超过 2 分钟没有回应。建议：稍后再试，或换一个更快的模型' : '已停止');
  if (e) {
    const code = (e.cause && e.cause.code) || e.code || '';
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|UND_ERR/.test(code) || /fetch failed/.test(e.message))
      return new AiError(`连不上 AI 接口（${code || '网络错误'}）。建议：检查网络是否正常、接口地址是否写对`);
    return new AiError('调用 AI 失败：' + e.message);
  }
  const detail = String(body || '').slice(0, 300).replace(/\s+/g, ' ');
  const hint = {
    400: '请求被拒绝，常见原因是模型不支持看图或参数不对', 401: 'API key 不对或已失效', 403: '这个 key 没有权限使用该模型',
    404: '接口地址或模型名不对', 413: '图片太大', 429: '调用太频繁或额度用完了，请稍后再试', 529: 'AI 服务繁忙，请稍后再试'
  }[status] || (status >= 500 ? 'AI 服务出错，请稍后再试' : '调用失败');
  const err = new AiError(`${hint}（HTTP ${status}）`);
  err.detail = detail;
  return err;
}

function trimSlash(u) { return String(u || '').trim().replace(/\/+$/, ''); }

async function post(url, headers, body, signal) {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  let res;
  try { res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: sig }); }
  catch (e) { throw translate(e); }
  const text = await res.text();
  if (!res.ok) { const err = translate(null, res.status, text); err.status = res.status; throw err; }
  try { return JSON.parse(text); } catch (_) { throw new AiError('AI 接口返回的不是 JSON，请检查接口地址'); }
}

/**
 * 调用一次模型。images：JPEG/PNG 的 base64 字符串数组（{ data, mime }）。返回模型输出的文字。
 */
async function chat(config, { system, text, images = [], maxTokens = 4000, signal }) {
  if (!config || !config.apiKey || !config.model) throw new AiError('请先在「AI 设置」里配置接口');
  if (config.provider === 'anthropic') {
    const content = [
      ...images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mime || 'image/jpeg', data: im.data } })),
      { type: 'text', text }
    ];
    const body = { model: config.model, max_tokens: Math.max(maxTokens, 16000), system, messages: [{ role: 'user', content }], fallbacks: 'default' };
    const headers = { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' };
    const url = trimSlash(config.baseUrl || PROVIDERS.anthropic.baseUrl) + '/v1/messages';
    let data;
    try { data = await post(url, headers, body, signal); }
    catch (e) {
      // 代理或旧模型不认识「拒绝时自动换模型」这个参数时，去掉它重试一次
      if (e.status === 400 && /fallback/i.test(e.detail || '')) {
        delete body.fallbacks; delete headers['anthropic-beta'];
        data = await post(url, headers, body, signal);
      } else throw e;
    }
    if (data.stop_reason === 'refusal') throw new AiError('模型拒绝处理这次请求，可以换几张照片或换个说法再试');
    const out = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!out) throw new AiError('模型没有返回文字' + (data.stop_reason === 'max_tokens' ? '（输出被截断）' : ''));
    return out;
  }
  const content = [{ type: 'text', text }, ...images.map(im => ({ type: 'image_url', image_url: { url: `data:${im.mime || 'image/jpeg'};base64,${im.data}` } }))];
  // 新一代模型（Gemini 3/4、o 系列等）会先思考，思考也计入输出上限；上限给足，避免只思考没输出
  const body = { model: config.model, max_tokens: Math.max(maxTokens, 8192), messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }] };
  const data = await post(trimSlash(config.baseUrl) + '/chat/completions', { authorization: 'Bearer ' + config.apiKey }, body, signal);
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  const out = msg && (typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '');
  if (!out) throw new AiError('模型没有返回文字');
  return out.trim();
}

/** 从模型输出里取出第一个完整的 JSON 对象（模型有时会包在 ```json 里或前后加说明） */
function parseJson(text) {
  const s = String(text || '');
  const start = s.search(/[{[]/);
  if (start < 0) throw new AiError('AI 没有按要求返回结构化结果，请重试');
  const open = s[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { break; }
    }
  }
  throw new AiError('AI 返回的结果格式不对，请重试');
}

/** 测试连接：发一张红色方块图，问它是什么颜色，确认模型能看图 */
function testImage() {
  const png = encodePng(64, 64, (x, y) => (x > 8 && x < 56 && y > 8 && y < 56) ? [220, 20, 30] : [255, 255, 255]);
  return { data: png.toString('base64'), mime: 'image/png' };
}
async function testConnection(config, signal) {
  const out = await chat(config, { text: '图片中间方块是什么颜色？只回答一个颜色词。', images: [testImage()], maxTokens: 50, signal });
  return { ok: /红|red/i.test(out), answer: out.slice(0, 50) };
}

module.exports = { PROVIDERS, AiError, chat, parseJson, testConnection, testImage, translate };
