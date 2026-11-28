'use strict';
// 手机扫码后打开的网页（由电脑在局域网内提供）。只有两种：选照片上传、按顺序保存照片。
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HEAD = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1d2129;padding:20px 16px 40px}
h1{font-size:20px;margin:8px 0 4px}p{margin:6px 0;color:#4e5969}.btn{display:block;width:100%;padding:16px;border:0;border-radius:12px;font-size:18px;font-weight:600;margin:16px 0 8px}
.primary{background:#07c160;color:#fff}.ghost{background:#fff;color:#1d2129;border:1px solid #e5e6eb}.btn:disabled{opacity:.5}
.bar{height:8px;background:#e5e6eb;border-radius:4px;overflow:hidden;margin:12px 0 4px}.bar i{display:block;height:100%;width:0;background:#07c160;transition:width .2s}
ul{list-style:none;padding:0;margin:12px 0}li{background:#fff;border-radius:8px;padding:8px 12px;margin:6px 0;font-size:14px;display:flex;justify-content:space-between;gap:8px}
li span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ok{color:#07c160}.err{color:#f53f3f}.muted{color:#86909c;font-size:13px}
.photo{background:#fff;border-radius:12px;padding:8px;margin:12px 0}.photo img{width:100%;display:block;border-radius:8px}.photo b{display:block;margin:4px 4px 0;font-size:14px}
.caption{background:#fff;border-radius:12px;padding:12px;white-space:pre-wrap;user-select:all}
</style>`;

function expiredPage(reason) {
  return `${HEAD}<title>二维码已失效</title></head><body><h1>二维码已失效</h1><p>${esc(reason || '这个二维码已经过期或已经完成导入。')}</p><p>请回到电脑上的「朋友圈助手」重新生成二维码。</p></body></html>`;
}

function uploadPage({ max, maxMb }) {
  return `${HEAD}<title>传照片到电脑</title></head><body>
<h1>📷 把照片传到电脑</h1>
<p>点下面的按钮，从相册里选照片（可以多选）。照片只在你家里的 Wi-Fi 里传给电脑，不经过外网。</p>
<p class="muted">一次最多 ${max} 张，单张不超过 ${maxMb} MB。</p>
<input id="f" type="file" accept="image/*" multiple hidden>
<button class="btn primary" id="pick">选择照片</button>
<div id="prog" hidden><div class="bar"><i id="bar"></i></div><p id="stat"></p></div>
<ul id="list"></ul>
<button class="btn ghost" id="done">完成导入</button>
<script>
const q=id=>document.getElementById(id),base=location.pathname.replace(/\\/$/,'');let sent=0,total=0,busy=false;
q('pick').onclick=()=>q('f').click();
q('f').onchange=async()=>{const files=[...q('f').files];q('f').value='';if(!files.length||busy)return;busy=true;q('pick').disabled=true;total+=files.length;q('prog').hidden=false;
for(const file of files){const li=document.createElement('li');li.innerHTML='<span></span><span class="muted">等待</span>';li.firstChild.textContent=file.name||'照片';q('list').prepend(li);
try{const r=await up(file,p=>{li.lastChild.textContent=Math.round(p*100)+'%';q('bar').style.width=((sent+p)/total*100)+'%'});li.lastChild.textContent=r.warning?'已收到（'+r.warning+'）':'✓';li.lastChild.className=r.warning?'err':'ok'}
catch(e){li.lastChild.textContent=e.message;li.lastChild.className='err';if(/失效/.test(e.message)){alert(e.message);break}}
sent++;q('stat').textContent='已传 '+sent+' / '+total;q('bar').style.width=(sent/total*100)+'%'}
busy=false;q('pick').disabled=false};
function up(file,onp){return new Promise((res,rej)=>{const x=new XMLHttpRequest();x.open('POST',base+'/upload?name='+encodeURIComponent(file.name||'photo.jpg'));
x.setRequestHeader('content-type',file.type||'application/octet-stream');x.upload.onprogress=e=>e.lengthComputable&&onp(e.loaded/e.total);
x.onload=()=>{let j={};try{j=JSON.parse(x.responseText)}catch(_){}x.status===200?res(j):rej(new Error(j.error||('失败 '+x.status)))};x.onerror=()=>rej(new Error('网络中断，请确认手机和电脑在同一个 Wi-Fi'));x.send(file)})}
q('done').onclick=async()=>{if(busy&&!confirm('还有照片在上传，确定结束吗？'))return;try{await fetch(base+'/done',{method:'POST'})}catch(_){}document.body.innerHTML='<h1>✓ 导入完成</h1><p>回到电脑上继续挑照片吧。</p>'};
</script></body></html>`;
}

function savePage({ files, caption, base }) {
  const imgs = files.map((f, i) => `<div class="photo"><b>第 ${i + 1} 张</b><img src="${esc(base + '/' + (i + 1))}" alt="第 ${i + 1} 张"></div>`).join('');
  return `${HEAD}<title>保存到相册</title></head><body>
<h1>📥 按顺序保存到相册</h1><p>长按每张图片，选「保存图片」/「存储到照片」。发朋友圈时按这个顺序选就行。</p>
${caption ? `<p><b>文案</b>（长按全选复制）</p><div class="caption">${esc(caption)}</div>` : ''}
${imgs}</body></html>`;
}

module.exports = { uploadPage, savePage, expiredPage };
