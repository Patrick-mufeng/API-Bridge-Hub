/* trae-free console behaviour.
 *
 * Served as a static asset (GET /console/app.js) rather than inlined into the
 * server-rendered document. The historical version lived inside a Python
 * f-string, so every JavaScript brace had to be doubled and every backslash
 * re-escaped; a single slip produced a document whose script could not parse,
 * i.e. a blank console. As a real file it is parsed directly by the browser.
 *
 * Server-provided runtime values arrive as window.__CONSOLE__.
 */
'use strict';
var CFG = window.__CONSOLE__ || {};
function cfg(key, fallback) {
  var v = CFG[key];
  return (v === undefined || v === null || v === '') ? fallback : v;
}

function applyTheme(theme,persist){
  var t=theme==='dark'?'dark':'light';
  document.documentElement.setAttribute('data-theme',t);
  var cb=document.getElementById('theme-toggle');
  if(cb) cb.checked=(t==='dark');
  if(persist){
    try{ localStorage.setItem('relay-theme',t); }catch(e){}
    var root=document.documentElement; root.classList.add('theme-anim');
    clearTimeout(applyTheme.timer); applyTheme.timer=setTimeout(function(){ root.classList.remove('theme-anim'); },360);
  }
}
applyTheme(document.documentElement.getAttribute('data-theme')||'light',false);
function switchTab(name){
  document.querySelectorAll('.nav-item').forEach(function(b){
    var on=b.getAttribute('data-tab')===name;
    b.classList.toggle('active',on);
    b.setAttribute('aria-selected',on?'true':'false');
    if(on){ var t=document.getElementById('page-title'); if(t) t.textContent=b.getAttribute('data-title')||''; }
  });
  document.querySelectorAll('.tab-page').forEach(function(p){ p.classList.toggle('active', p.getAttribute('data-page')===name); });
  try{ history.replaceState(null,'','#'+name); }catch(e){}
  syncSelection();
  if(name==='overview') refreshOverview();
  if(name==='logs') loadLogs();
  if(name==='usage') refreshUsage();
  if(name==='models') refreshModels();
}
// Sliding highlights for the nav and segmented controls. The first placement
// skips the transition so elements don't fly in from the corner.
function placeSel(el,x,y,w,h){
  if(!w||!h) return;
  var first=!el.dataset.placed;
  if(first) el.classList.remove('ready');
  el.style.width=w+'px'; el.style.height=h+'px';
  el.style.transform='translate('+x+'px,'+y+'px)'; el.style.opacity='1';
  if(first){ el.dataset.placed='1'; void el.offsetWidth; el.classList.add('ready'); }
}
function syncSelection(){
  var nav=document.querySelector('.nav-list');
  if(nav){
    var ind=nav.querySelector('.nav-indicator');
    if(!ind){ ind=document.createElement('span'); ind.className='nav-indicator'; ind.setAttribute('aria-hidden','true'); nav.insertBefore(ind,nav.firstChild); nav.classList.add('has-indicator'); }
    var a=nav.querySelector('.nav-item.active');
    if(a) placeSel(ind,a.offsetLeft,a.offsetTop,a.offsetWidth,a.offsetHeight);
  }
  document.querySelectorAll('.segmented').forEach(function(seg){
    var th=seg.querySelector('.seg-thumb');
    if(!th){
      th=document.createElement('span'); th.className='seg-thumb'; th.setAttribute('aria-hidden','true');
      seg.insertBefore(th,seg.firstChild); seg.classList.add('has-thumb');
      seg.addEventListener('change',syncSelection);
    }
    var c=seg.querySelector('input:checked');
    var sp=c?c.nextElementSibling:null;
    if(sp){ var lab=sp.parentElement; placeSel(th,lab.offsetLeft+sp.offsetLeft,lab.offsetTop+sp.offsetTop,sp.offsetWidth,sp.offsetHeight); }
    else th.style.opacity='0';
  });
}
function setStatePill(id,text,on){
  var el=document.getElementById(id);
  if(!el) return;
  el.textContent=text;
  el.classList.toggle('on',!!on);
}
// Overview numbers are derived from the rendered rows so every partial
// refresh (single check-in, credits query, claim-all) keeps them in sync.
function refreshStats(){
  var rows=Array.from(document.querySelectorAll('tr[data-account-id]'));
  var checked=0, sum=0, known=false, unlimited=false;
  rows.forEach(function(row){
    var st=row.querySelector('.checkin-state');
    if(st&&st.textContent.trim()==='已签到') checked++;
    var cv=row.querySelector('.credit-value');
    var text=cv?cv.textContent:'';
    if(text.indexOf('无限')>=0) unlimited=true;
    var m=text.match(/剩(-?[0-9.]+)/);
    if(m){ sum+=Number(m[1]); known=true; }
  });
  var set=function(id,v){ var el=document.getElementById(id); if(el) el.textContent=v; };
  set('stat-total',rows.length);
  set('stat-checked',checked);
  set('stat-credits',unlimited?'无限':(known?sum.toFixed(2):'-'));
}
const state = { traceId: null, win: null };
let currentCodeVerifier = '';
function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16)}) }
function randomHex(n) { var a=new Uint8Array(n);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('') }
function randomDigits(n) { var s='';while(s.length<n)s+=Math.floor(Math.random()*1e10).toString();return s.slice(0,n) }
function randomBase64Url(n) { var a=new Uint8Array(n); if(window.crypto&&crypto.getRandomValues){ crypto.getRandomValues(a) } else { for(var i=0;i<n;i++)a[i]=Math.floor(Math.random()*256) } return btoa(String.fromCharCode.apply(null,a)).replace(/[+]/g,'-').split('/').join('_').replace(/=+$/,'') }
function buildChallenge() { currentCodeVerifier=randomBase64Url(32); return sha256Base64Url(currentCodeVerifier) }
async function buildAuthUrl() {
  // Trae 授权页强制要求回调为 http://127.0.0.1:<port>/authorize，
  // 因此由 relay 进程内的回调监听器接管该端口并把凭据写入账号库。
  var cb = 'http://127.0.0.1:'+cfg('listenerPort',8765)+'/authorize';
  var mid = randomHex(32), did = randomDigits(19), tid = state.traceId;
  var p = new URLSearchParams({
    login_version:'1',auth_from:'solo',login_channel:'native_ide',plugin_version:'2.3.24254',
    auth_type:'local',client_id:cfg('clientId',''),redirect:'0',login_trace_id:tid,
    auth_callback_url:cb,machine_id:mid,device_id:did,x_device_id:did,x_machine_id:mid,
    x_device_brand:'ASUS TUF Gaming A15 FA507RM_FA507RM',x_device_type:'windows',x_os_version:'Windows 10 Pro',x_env:'',
    x_app_version:'3.3.65',x_app_type:'stable',hide_saas_login:'true',
  });
  return cfg('authUrl','https://www.trae.cn/authorization')+'?'+p.toString();
}
/* Login runs entirely in-process: the relay itself listens on
 * 127.0.0.1:<listenerPort> for the Trae authorization callback and writes the
 * credentials. The operator never downloads or runs a helper script. */
var webLoginPolling = null;
function setLoginBusy(busy, text) {
  var btn = document.getElementById('auth-btn');
  var loading = document.getElementById('loading');
  if (btn) btn.disabled = !!busy;
  if (loading) {
    loading.classList.toggle('on', !!busy);
    if (text) loading.textContent = text;
  }
}
async function refreshWebLoginStatus() {
  try {
    // requestJSON resolves to {ok, status, data}; the payload is under .data.
    var result = await requestJSON('/api/web-login/status');
    var d = (result && result.data) || {};
    var el = document.getElementById('listener-state');
    var on = !!d.listenerRunning;
    if (el) {
      el.textContent = on ? ('监听中 · 端口 ' + d.port) : ('未监听' + (d.lastError ? '（' + d.lastError + '）' : ''));
      el.className = 'state-pill' + (on ? ' on' : '');
    }
    return d;
  } catch (e) { return null; }
}
async function startAuth() {
  try {
    setLoginBusy(true, '正在启动本机授权监听…');
    var status = await refreshWebLoginStatus();
    if (!status || !status.listenerRunning) {
      showMsg('auth-msg', '本机授权监听未启动：' + ((status && status.lastError) || '端口可能被占用') + '，可改用下方手动填写凭证。', false);
      setLoginBusy(false);
      return;
    }
    var started = await postJSON('/api/web-login/state', {});
    if (!started || !started.url) {
      showMsg('auth-msg', (started && started.error) || '无法发起授权', false);
      setLoginBusy(false);
      return;
    }
    state.traceId = started.state;
    var w = window.open(started.url, 'trae-relay-oauth', 'width=560,height=760');
    if (!w) { showMsg('auth-msg', '浏览器已拦截弹窗，请允许后重试', false); setLoginBusy(false); return; }
    state.win = w;
    setLoginBusy(true, '等待浏览器授权完成…');
    clearInterval(webLoginPolling);
    webLoginPolling = setInterval(async function () {
      if (w.closed && !state.traceId) { clearInterval(webLoginPolling); setLoginBusy(false); }
    }, 700);
  } catch (e) {
    showMsg('auth-msg', String(e), false);
    setLoginBusy(false);
  }
}
// The callback page posts back to its opener; refresh the account list here.
window.addEventListener('message', function (ev) {
  if (!ev.data || ev.data.type !== 'trae-relay-web-login') return;
  if (state.traceId && ev.data.loginTraceId && ev.data.loginTraceId !== state.traceId) return;
  if (ev.data.success) {
    showMsg('auth-msg', '授权成功，凭证已写入服务器', true);
    state.traceId = null;
    clearInterval(webLoginPolling);
    setLoginBusy(false);
    setTimeout(function () { location.reload(); }, 800);
  } else {
    showMsg('auth-msg', ev.data.error || '授权失败', false);
    setLoginBusy(false);
  }
});
let usageRefreshing = false;
function usageRecordsFromPayload(payload){
  // Keep the console compatible with both the historical bare-array endpoint
  // and deployments that wrap records in an object for metadata/versioning.
  if(Array.isArray(payload)) return payload;
  if(!payload || typeof payload!=='object') return null;
  if(Array.isArray(payload.records)) return payload.records;
  if(Array.isArray(payload.data)) return payload.data;
  if(payload.data && typeof payload.data==='object' && Array.isArray(payload.data.records)) return payload.data.records;
  return null;
}
function usageRecordField(record, keys){
  if(!record || typeof record!=='object') return null;
  for(var i=0;i<keys.length;i++){
    var value=record[keys[i]];
    if(value!==undefined && value!==null && value!=='') return value;
  }
  return null;
}
function usageBoolean(value){
  if(value===true || value===1) return true;
  if(value===false || value===0) return false;
  if(typeof value==='string'){
    var text=value.trim().toLowerCase();
    if(['true','1','yes','on','enabled','是','有'].indexOf(text)>=0) return true;
    if(['false','0','no','off','disabled','否','无'].indexOf(text)>=0) return false;
  }
  return null;
}
function usageEffortLabel(value){
  if(value===undefined || value===null || value==='') return '';
  var text=String(value).trim().toLowerCase().replace(/[\s-]+/g,'_');
  if(text==='none' || text==='minimal' || text==='min') return '最低';
  if(text==='low' || text==='light') return '低';
  if(text==='medium' || text==='mid' || text==='normal' || text==='default') return '中';
  if(text==='high') return '高';
  if(text==='xhigh' || text==='extra_high' || text==='very_high' || text==='max' || text==='maximum') return '极高';
  return escapeHtml(String(value));
}
function usageReasoningMeta(record){
  var requested=usageRecordField(record,[
    'requested_reasoning_effort','reasoning_effort_requested','thinking_effort',
    'thinking_level','reasoning_effort'
  ]);
  var thinking=record && record.thinking;
  if(requested===null && thinking && typeof thinking==='object'){
    requested=thinking.effort || thinking.level || thinking.budget_tokens || thinking.budgetTokens || null;
  }
  var applied=usageRecordField(record,[
    'reasoning_effort_applied','applied_reasoning_effort','native_reasoning_effort'
  ]);
  var requestedLabel=usageEffortLabel(requested);
  var appliedLabel=usageEffortLabel(applied);
  if(requestedLabel && appliedLabel && requestedLabel!==appliedLabel){
    return {
      text: requestedLabel+'<span class="usage-arrow">→</span>'+appliedLabel,
      title: '请求: '+String(requested)+'；生效: '+String(applied),
      unknown: false
    };
  }
  var label=appliedLabel || requestedLabel;
  return {
    text: label || '--',
    title: label ? '思考强度: '+String(applied || requested) : '未记录思考强度',
    unknown: !label
  };
}
function usageContextMeta(record){
  var requested=usageRecordField(record,['context_mode_requested','requested_context_mode']);
  var value=usageRecordField(record,['context_mode_actual','actual_context_mode','context_mode','contextMode','context_window_mode']);
  var raw=value;
  var boolMax=usageBoolean(usageRecordField(record,['max_mode_applied','max_mode']));
  var size=Number(usageRecordField(record,['context_window_tokens','max_context_tokens','prompt_max_tokens']) || 0);
  if(value===null && boolMax===true) value='max';
  if(value===null && size>=1000000) value='1m';
  if(value===null && boolMax===false) value='standard';
  // Older rows often persisted only the requested context.  Treat an
  // explicit standard request as the visible context label while preserving
  // the separate Max column for actual activation evidence.
  if(value===null && requested!==null) value=requested;
  if(value===null) return {text:'--',title:'未记录上下文模式'+(requested!==null?'；请求: '+String(requested):''),unknown:true};
  var text=String(value).trim().toLowerCase().replace(/[\s_-]+/g,'');
  var label;
  if(['max','max1m','1m','1000000','agent','agentmax','maxmode'].indexOf(text)>=0 || size>=1000000) label='1M Max';
  else if(['standard','default','work','dev','200k','200000','normal'].indexOf(text)>=0) label='标准';
  else label=String(raw===null?value:raw);
  var requestedText='';
  if(requested!==null && String(requested)!==String(value)){
    requestedText='请求: '+String(requested)+'；';
  }
  return {text:label,title:requestedText+'实际上下文模式: '+String(value)+(size?'；窗口: '+size.toLocaleString()+' tokens':''),unknown:false};
}
function usageMaxMeta(record){
  var requested=usageBoolean(usageRecordField(record,['max_mode_requested','requested_max_mode']));
  var enabled=usageBoolean(usageRecordField(record,['max_mode_enabled','max_mode_applied','max_mode']));
  if(requested===null){
    var requestedContext=usageRecordField(record,['context_mode_requested','requested_context_mode']);
    if(requestedContext!==null){
      var normalized=String(requestedContext).trim().toLowerCase().replace(/[\s_-]+/g,'');
      requested=['max','max1m','1m','1000000','agentmax','maxmode'].indexOf(normalized)>=0;
    }
  }
  if(enabled===null){
    var actualContext=usageRecordField(record,['context_mode_actual','actual_context_mode','context_mode']);
    if(actualContext!==null){
      var actual=String(actualContext).trim().toLowerCase().replace(/[\s_-]+/g,'');
      enabled=['max','max1m','1m','1000000','agentmax','maxmode'].indexOf(actual)>=0;
    }
  }
  if(enabled===null && requested===false) enabled=false;
  if(enabled===true) return {text:'已开启',title:'本次请求实际启用 1M Max',unknown:false,requested:requested,enabled:true};
  if(enabled===false && requested===true) return {text:'未生效',title:'请求开启 Max，但上游本次未实际启用',unknown:false,requested:requested,enabled:false};
  if(enabled===false) return {text:'未开启',title:'本次请求未启用 1M Max',unknown:false,requested:requested,enabled:false};
  if(requested===true) return {text:'请求 / 未知',title:'请求开启 Max，但没有上游实际生效证据',unknown:true,requested:requested,enabled:null};
  return {text:'--',title:'未记录 Max 模式',unknown:true,requested:requested,enabled:enabled};
}
function usageToolMeta(record){
  var requested=usageBoolean(usageRecordField(record,['tools_requested','tool_protocol_requested']));
  var used=usageBoolean(usageRecordField(record,['tool_called','tool_used','tool_calls_returned','tool_call_returned','tool']));
  if(requested===null && used===true) requested=true;
  if(requested===null && record && Array.isArray(record.tools)) requested=record.tools.length>0;
  if(requested===null && record && record.tools!==undefined) requested=!!record.tools;
  if(requested===null && record && record.tool_choice!==undefined && record.tool_choice!=='none') requested=true;
  var state=requested;
  if(state===null) return {text:'--',title:'未记录是否携带 tools 参数',unknown:true,requested:null,called:used};
  var title=state?'请求携带 tools 参数':'请求未携带 tools 参数';
  if(used===true) title+='；模型返回了工具调用';
  else if(used===false) title+='；模型未返回工具调用';
  var text=state?'已携带':'未携带';
  if(state && used===true) text+=' / 本轮调用';
  else if(state && used===false) text+=' / 未调用';
  return {text:text,title:title,unknown:false,requested:state,called:used};
}
function usageModelFlags(maxMode,tool){
  var maxText=maxMode.enabled===true?'1M':(maxMode.enabled===false?'标准':(maxMode.requested===true?'请求':'--'));
  var maxClass=maxMode.enabled===true?' max':(maxMode.unknown?' unknown':'');
  var toolText=tool.requested===true?'是':(tool.requested===false?'否':'--');
  var toolClass=tool.requested===true?' tool':(tool.unknown?' unknown':'');
  return '<span class="usage-flag'+maxClass+'" title="'+escapeHtml(maxMode.title)+'">Max: '+maxText+'</span>'
    + '<span class="usage-flag'+toolClass+'" title="'+escapeHtml(tool.title)+'">Tool: '+toolText+'</span>';
}
// Daily aggregation for the usage chart. Records carry epoch timestamps and
// per-request tokens; the chart needs them rolled up by local calendar day.
var usageRecordsCache=[];
var usageRange=14;
var usageChartDay='';
function usageDailySeries(records,days){
  var buckets={};
  var start=new Date(); start.setHours(0,0,0,0);
  for(var i=0;i<days;i++){
    var d=new Date(start.getTime()-i*86400000);
    var key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    buckets[key]={date:key,input_tokens:0,output_tokens:0,cached_tokens:0,total_tokens:0,requests:0,credits:0};
  }
  records.forEach(function(r){
    var ts=Number(r.timestamp||0);
    if(!ts) return;
    var d=new Date(ts*1000);
    var key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    var b=buckets[key];
    if(!b) return;
    b.requests++;
    b.input_tokens+=Number(r.prompt_tokens||r.input_tokens||0);
    b.output_tokens+=Number(r.completion_tokens||r.output_tokens||0);
    b.cached_tokens+=Number(r.cached_tokens||0);
    b.total_tokens+=Number(r.total_tokens||0);
    b.credits+=Number(r.credits_consumed||0);
  });
  return Object.keys(buckets).sort().map(function(k){ return buckets[k]; });
}
function setUsageRange(days){ usageRange=Number(days)||14; renderUsageChart(); }
if(!window.__usageChartBound) {
  window.__usageChartBound=true;
  document.addEventListener('click',function(e){
    var col=e.target&&e.target.closest?e.target.closest('#usage-chart .bar-col'):null;
    if(col&&col.getAttribute('data-day')) showUsageChartDay(col.getAttribute('data-day'));
  });
}
function renderUsageChart(){
  var chart=document.getElementById('usage-chart'), axis=document.getElementById('usage-chart-axis');
  var empty=document.getElementById('usage-chart-empty'), wrap=document.getElementById('usage-chart-wrap');
  var meta=document.getElementById('usage-chart-meta');
  if(!chart||!axis) return;
  var rows=usageDailySeries(usageRecordsCache,usageRange);
  var peak=0, total=0;
  rows.forEach(function(r){ peak=Math.max(peak,(r.input_tokens||0)+(r.output_tokens||0)); total+=r.total_tokens||0; });
  var hasData=peak>0;
  if(wrap) wrap.hidden=!hasData;
  if(empty) empty.hidden=hasData;
  if(meta) meta.textContent=hasData?(fmtInt(total)+' Token / '+usageRange+' 天'):'';
  if(!hasData){ chart.innerHTML=''; axis.innerHTML=''; return; }
  var scale=niceCeil(peak);
  setOv('usage-y-max',fmtCompact(scale));
  setOv('usage-y-mid',fmtCompact(scale/2));
  var rebuild=chart.children.length!==rows.length;
  if(rebuild){
    chart.innerHTML=rows.map(function(){
      return '<div class="bar-col" tabindex="0" role="button"><div class="bar-stack">'
        +'<span class="bar-seg seg-out"></span><span class="bar-seg seg-in"></span><span class="bar-seg seg-cache"></span>'
        +'</div></div>';
    }).join('');
    var step=Math.ceil(rows.length/8);
    axis.innerHTML=rows.map(function(r,i){
      var show=(rows.length-1-i)%step===0;
      return '<span>'+(show?escapeHtml(r.date.slice(5)):'')+'</span>';
    }).join('');
  }
  function apply(){
    rows.forEach(function(r,i){
      var col=chart.children[i]; if(!col) return;
      var cache=Math.min(r.cached_tokens||0,r.input_tokens||0);
      var segs=col.firstChild.children;
      segs[0].style.height=((r.output_tokens||0)/scale*100)+'%';
      segs[1].style.height=(((r.input_tokens||0)-cache)/scale*100)+'%';
      segs[2].style.height=(cache/scale*100)+'%';
      col.setAttribute('data-day',r.date);
      col.setAttribute('aria-label',r.date+' 总计 '+fmtInt(r.total_tokens)+' Token，'+r.requests+' 次请求');
    });
  }
  if(rebuild) requestAnimationFrame(function(){ requestAnimationFrame(apply); }); else apply();
  // Default the readout to the newest day so the legend is never blank;
  // clicking a bar moves it. Without this the box kept only its min-height.
  if(!usageChartDay || !rows.some(function(r){ return r.date===usageChartDay; })){
    usageChartDay=rows[rows.length-1].date;
  }
  showUsageChartDay(usageChartDay);
}
function showUsageChartDay(day){
  var rows=usageDailySeries(usageRecordsCache,usageRange);
  var row=null;
  for(var i=0;i<rows.length;i++){ if(rows[i].date===day) row=rows[i]; }
  if(!row) return;
  usageChartDay=day;
  renderChartReadout('usage-chart-readout',day,row);
  var chart=document.getElementById('usage-chart');
  if(chart){
    Array.prototype.forEach.call(chart.children,function(col){
      col.classList.toggle('sel',col.getAttribute('data-day')===day);
    });
  }
}
async function refreshUsage() {
  if(usageRefreshing) return;
  usageRefreshing=true;
  var tbody=document.getElementById('usage-records-body');
  var empty=document.getElementById('usage-empty');
  var msg=document.getElementById('usage-msg');
  try {
    var result=await requestJSON('/api/usage/records',{method:'GET'},15000);
    if(!result.ok) throw new Error(apiError(result.data,result.status));
    var records=usageRecordsFromPayload(result.data);
    usageRecordsCache=records;
    renderUsageChart();
    if(records===null) throw new Error(apiError(result.data,result.status));
    if(!tbody) return;
    if(records.length===0) {
      tbody.innerHTML='';
      if(empty) empty.style.display='block';
    } else {
      if(empty) empty.style.display='none';
      tbody.innerHTML=records.map(function(record) {
        var stamp=Number(record.timestamp||0);
        var when=stamp?new Date(stamp*1000).toLocaleString():'--';
        var account=record.account_id?String(record.account_id).slice(-12):'--';
        var model=record.model||'--';
         var reasoning=usageReasoningMeta(record);
         var context=usageContextMeta(record);
         var maxMode=usageMaxMeta(record);
         var tool=usageToolMeta(record);
        var input=Number(record.input_tokens!==undefined?record.input_tokens:(record.prompt_tokens||0));
        var output=Number(record.output_tokens!==undefined?record.output_tokens:(record.completion_tokens||0));
        var total=Number(record.total_tokens!==undefined?record.total_tokens:(input+output));
        var tokenText=record.tokens_source==='unknown'?'--':(input+' / '+output+' / '+total);
        var credits=record.credits_consumed;
        var creditText=credits===null||credits===undefined?'--':Number(credits).toFixed(2);
        var source=record.credits_source||'unknown';
        var status=record.status||'completed';
        var statusText=status==='completed'?'完成':(status==='cancelled'?'已取消':(status==='error'?'失败':status));
        var badge=status==='completed'?'badge-ok':(status==='error'?'badge-expired':'badge-none');
        return '<tr>'
          + '<td>'+escapeHtml(when)+'</td>'
          + '<td><code>'+escapeHtml(account)+'</code></td>'
          + '<td class="usage-model-cell"><div title="'+escapeHtml(model)+'">'+escapeHtml(model)+'</div><div class="usage-model-flags">'+usageModelFlags(maxMode,tool)+'</div></td>'
          + '<td class="usage-meta'+(reasoning.unknown?' unknown':'')+'" title="'+escapeHtml(reasoning.title)+'">'+reasoning.text+'</td>'
          + '<td class="usage-meta'+(context.unknown?' unknown':'')+'" title="'+escapeHtml(context.title)+'">'+escapeHtml(context.text)+'</td>'
          + '<td class="usage-meta'+(maxMode.unknown?' unknown':'')+'" title="'+escapeHtml(maxMode.title)+'">'+escapeHtml(maxMode.text)+'</td>'
          + '<td class="usage-meta usage-tool'+(tool.unknown?' unknown':'')+'" title="'+escapeHtml(tool.title)+'">'+escapeHtml(tool.text)+'</td>'
          + '<td class="numeric">'+escapeHtml(tokenText)+'</td>'
          + '<td class="numeric" title="'+escapeHtml(source)+'">'+escapeHtml(creditText)+'</td>'
          + '<td class="usage-status"><span class="badge '+badge+'">'+escapeHtml(statusText)+'</span></td>'
          + '</tr>';
      }).join('');
    }
    var updated=document.getElementById('usage-updated');
    if(updated) updated.textContent='更新于 '+new Date().toLocaleTimeString()+' · '+records.length+' 条';
    if(msg){ msg.textContent=''; msg.className='msg'; }
  } catch(e) {
    if(msg){ msg.textContent=String(e); msg.className='msg msg-err'; }
  } finally { usageRefreshing=false; }
}
setInterval(refreshUsage, 5000);
refreshUsage();
// Overview dashboard. Data comes from /api/overview (persistent daily
// buckets); the chart reuses its bar nodes so refreshes animate heights.
var ovData=null, ovRange=14, ovDay='', ovLoading=false;
function fmtInt(n){ return Number(n||0).toLocaleString('en-US'); }
function fmtCompact(n){
  n=Number(n||0); var a=Math.abs(n);
  if(a>=1e9) return (n/1e9).toFixed(2)+'B';
  if(a>=1e6) return (n/1e6).toFixed(2)+'M';
  if(a>=1e4) return (n/1e3).toFixed(1)+'K';
  return fmtInt(n);
}
function fmtPct(part,whole){ return whole?(part/whole*100).toFixed(1)+'%':'--'; }
function fmtUptime(s){
  s=Math.max(0,Math.floor(s||0));
  var d=Math.floor(s/86400), h=Math.floor(s%86400/3600), m=Math.floor(s%3600/60);
  return d?(d+' 天 '+h+' 小时'):(h?(h+' 小时 '+m+' 分'):(m+' 分'));
}
function setOv(id,value,title){
  var el=document.getElementById(id); if(!el) return;
  el.textContent=value;
  if(title!==undefined) el.title=title;
}
function setOvPill(id,on,label){
  var el=document.getElementById(id); if(!el) return;
  el.innerHTML='<span class="state-pill'+(on?' on':'')+'">'+escapeHtml(label)+'</span>';
}
function niceCeil(v){
  if(v<=0) return 1;
  var p=Math.pow(10,Math.floor(Math.log10(v))), f=v/p;
  return (f<=1?1:f<=2?2:f<=5?5:10)*p;
}
function ovRows(){ return ovData?ovData.usage.daily.slice(0,ovRange).reverse():[]; }
function ovFind(day){
  if(!ovData) return null;
  var rows=ovData.usage.daily;
  for(var i=0;i<rows.length;i++){ if(rows[i].date===day) return rows[i]; }
  return null;
}
async function refreshOverview(){
  if(ovLoading) return;
  ovLoading=true;
  var msg=document.getElementById('ov-msg');
  try{
    var r=await requestJSON('/api/overview?days=30',{method:'GET'},15000);
    if(!r.ok||!r.data||!r.data.success) throw new Error(apiError(r.data,r.status));
    ovData=r.data;
    renderOverview();
    setOv('ov-updated','更新于 '+new Date().toLocaleTimeString());
    if(msg){ msg.textContent=''; msg.className='msg'; }
  }catch(e){
    if(msg){ msg.textContent=String(e&&e.message||e); msg.className='msg msg-err'; }
  }finally{ ovLoading=false; }
}
function renderOverview(){
  if(!ovData) return;
  var u=ovData.usage, t=u.totals, td=u.today, a=ovData.accounts, s=ovData.service;
  setOv('ov-total',fmtCompact(t.total_tokens),fmtInt(t.total_tokens));
  // Short enough to stay on one line in a ~186px card; the full range is in
  // the tooltip. A wrapped annotation took as much height as the value.
  setOv('ov-total-sub',u.first_day?(fmtInt(t.requests)+' 次请求'):'暂无记录',u.first_day?('自 '+u.first_day):'');
  setOv('ov-input',fmtCompact(t.input_tokens),fmtInt(t.input_tokens));
  setOv('ov-input-sub','占总量 '+fmtPct(t.input_tokens,t.total_tokens));
  setOv('ov-output',fmtCompact(t.output_tokens),fmtInt(t.output_tokens));
  setOv('ov-output-sub','占总量 '+fmtPct(t.output_tokens,t.total_tokens));
  setOv('ov-cache',fmtCompact(t.cached_tokens),fmtInt(t.cached_tokens));
  setOv('ov-cache-sub','输入命中率 '+fmtPct(t.cached_tokens,t.input_tokens));
  setOv('ov-today',fmtCompact(td.total_tokens),fmtInt(td.total_tokens));
  setOv('ov-today-sub',fmtInt(td.requests)+' 次请求'+(td.failed?' · '+td.failed+' 失败':''));
  setOv('ov-accounts',a.valid+' / '+a.total);
  setOv('ov-accounts-sub','今日签到 '+a.checked_in+' / '+a.total);
  setOvPill('ov-token',s.token_ok,s.token_ok?'有效':'失效');
  setOv('ov-version','v'+s.version);
  setOv('ov-uptime',fmtUptime(s.uptime_seconds));
  setOv('ov-upstream',s.auto_route?'自动路由':s.upstream_mode);
  setOvPill('ov-polling',s.polling,s.polling?(s.polling_mode==='credit-priority'?'积分优先':'顺序轮询'):'关');
  setOvPill('ov-max',s.max_mode,s.max_mode?'开':'关');
  var ac=s.auto_checkin||{};
  setOvPill('ov-autocheckin',ac.enabled,ac.enabled?('每日 '+(ac.time||'')):'关');
  setOv('ov-inflight',String(s.in_flight||0));
  var cr=a.credits_remaining;
  setOv('ov-credits',cr==='unlimited'?'无限':(cr===null||cr===undefined?'--':Number(cr).toFixed(2)));
  renderOverviewChart();
  renderOverviewDays();
  showOverviewDay(ovDay);
}
function renderOverviewChart(){
  var chart=document.getElementById('ov-chart'), axis=document.getElementById('ov-axis');
  if(!chart||!axis) return;
  var rows=ovRows(), max=0;
  rows.forEach(function(r){ max=Math.max(max,(r.input_tokens||0)+(r.output_tokens||0)); });
  var scale=niceCeil(max);
  setOv('ov-y-max',max?fmtCompact(scale):'0');
  setOv('ov-y-mid',max?fmtCompact(scale/2):'0');
  var rebuild=chart.children.length!==rows.length;
  if(rebuild){
    chart.innerHTML=rows.map(function(){
      return '<div class="bar-col" tabindex="0" role="button"><div class="bar-stack">'
        +'<span class="bar-seg seg-out"></span><span class="bar-seg seg-in"></span><span class="bar-seg seg-cache"></span>'
        +'</div></div>';
    }).join('');
    var step=Math.ceil(rows.length/8);
    axis.innerHTML=rows.map(function(r,i){
      var show=(rows.length-1-i)%step===0;
      return '<span>'+(show?escapeHtml(r.date.slice(5)):'')+'</span>';
    }).join('');
  }
  function apply(){
    rows.forEach(function(r,i){
      var col=chart.children[i]; if(!col) return;
      var cache=Math.min(r.cached_tokens||0,r.input_tokens||0);
      var segs=col.firstChild.children;
      segs[0].style.height=((r.output_tokens||0)/scale*100)+'%';
      segs[1].style.height=(((r.input_tokens||0)-cache)/scale*100)+'%';
      segs[2].style.height=(cache/scale*100)+'%';
      col.setAttribute('data-day',r.date);
      col.setAttribute('aria-label',r.date+' 总计 '+fmtInt(r.total_tokens)+' Token');
      col.classList.toggle('sel',r.date===ovDay);
    });
  }
  // Fresh bars start at zero height and grow on the next frame.
  if(rebuild) requestAnimationFrame(function(){ requestAnimationFrame(apply); }); else apply();
}
function renderOverviewDays(){
  var body=document.getElementById('ov-days-body'), foot=document.getElementById('ov-days-foot');
  if(!body||!foot||!ovData) return;
  var hide=document.getElementById('ov-hide-empty');
  var today=ovData.usage.today.date;
  var rows=ovData.usage.daily.slice(0,ovRange);
  var sum={requests:0,failed:0,input_tokens:0,output_tokens:0,cached_tokens:0,total_tokens:0,max_mode_requests:0,max_mode_enabled_requests:0,tool_requests:0,tool_calls:0,credits:0};
  rows.forEach(function(r){ for(var k in sum) sum[k]+=Number(r[k]||0); });
  var shown=rows.filter(function(r){ return !(hide&&hide.checked&&!r.requests); });
  body.innerHTML=shown.length?shown.map(function(r){
    var cls=(r.requests?'':'zero')+(r.date===ovDay?' sel':'');
    var top=(r.models||[]).slice(0,3).map(function(m){ return m.model+' '+fmtInt(m.total_tokens); }).join('，');
    return '<tr class="'+cls+'" data-day="'+escapeHtml(r.date)+'" title="'+escapeHtml(top)+'">'
      +'<td>'+escapeHtml(r.date)+(r.date===today?'<span class="badge badge-active">今日</span>':'')+'</td>'
      +'<td>'+fmtInt(r.requests)+'</td>'
      +'<td>'+fmtInt(r.failed)+'</td>'
      +'<td>'+fmtInt(r.input_tokens)+'</td>'
      +'<td>'+fmtInt(r.output_tokens)+'</td>'
      +'<td>'+fmtInt(r.cached_tokens)+'</td>'
      +'<td>'+fmtInt(r.total_tokens)+'</td>'
      +'<td>'+fmtInt(r.max_mode_requests||0)+' / '+fmtInt(r.max_mode_enabled_requests||0)+'</td>'
      +'<td>'+fmtInt(r.tool_requests||0)+' / '+fmtInt(r.tool_calls||0)+'</td>'
      +'<td>'+Number(r.credits||0).toFixed(2)+'</td>'
      +'</tr>';
  }).join(''):'<tr class="zero"><td colspan="10">所选范围内没有请求</td></tr>';
  foot.innerHTML='<td>合计 '+ovRange+' 天</td>'
    +'<td>'+fmtInt(sum.requests)+'</td><td>'+fmtInt(sum.failed)+'</td>'
    +'<td>'+fmtInt(sum.input_tokens)+'</td><td>'+fmtInt(sum.output_tokens)+'</td>'
    +'<td>'+fmtInt(sum.cached_tokens)+'</td><td>'+fmtInt(sum.total_tokens)+'</td>'
    +'<td>'+fmtInt(sum.max_mode_requests)+' / '+fmtInt(sum.max_mode_enabled_requests)+'</td>'
    +'<td>'+fmtInt(sum.tool_requests)+' / '+fmtInt(sum.tool_calls)+'</td>'
    +'<td>'+sum.credits.toFixed(2)+'</td>';
  var active=rows.filter(function(r){ return r.requests; }).length;
  setOv('ov-days-meta',active+' / '+ovRange+' 天有请求');
}
// One definition of the chart legend/readout, shared by the overview and usage
// charts so the swatch colours cannot drift apart between them. The swatches
// are the legend: they map each stacked segment to its label and value.
function chartReadoutItems(row){
  function item(sw,name,value){
    return '<span class="readout-item">'+(sw?'<span class="swatch '+sw+'"></span>':'')+name+' <strong>'+value+'</strong></span>';
  }
  return item('sw-in','输入',fmtInt(row.input_tokens||0))
    +item('sw-cache','缓存',fmtInt(row.cached_tokens||0))
    +item('sw-out','输出',fmtInt(row.output_tokens||0))
    +item('','总计',fmtInt(row.total_tokens||0))
    +item('','请求',fmtInt(row.requests||0));
}
function renderChartReadout(id,label,row){
  var box=document.getElementById(id);
  if(!box) return;
  box.innerHTML='<span class="readout-date">'+escapeHtml(label)+'</span>'+chartReadoutItems(row);
}
function showOverviewDay(day){
  if(!ovData) return;
  var r=ovFind(day)||ovData.usage.today;
  var label=r.date===ovData.usage.today.date?r.date+' 今日':r.date;
  renderChartReadout('ov-readout',label,r);
}
function selectOverviewDay(day){
  ovDay=day||'';
  document.querySelectorAll('#ov-chart .bar-col').forEach(function(c){ c.classList.toggle('sel',c.getAttribute('data-day')===ovDay); });
  document.querySelectorAll('#ov-days-body tr[data-day]').forEach(function(tr){
    var on=tr.getAttribute('data-day')===ovDay;
    tr.classList.toggle('sel',on);
    if(on&&tr.scrollIntoView) tr.scrollIntoView({block:'nearest'});
  });
  showOverviewDay(ovDay);
}
function setOverviewRange(value){
  ovRange=Number(value)||14;
  renderOverviewChart();
  renderOverviewDays();
}
(function(){
  var chart=document.getElementById('ov-chart');
  if(chart){
    var pick=function(e){ var c=e.target.closest&&e.target.closest('.bar-col'); return c?c.getAttribute('data-day'):null; };
    chart.addEventListener('mouseover',function(e){ var d=pick(e); if(d) showOverviewDay(d); });
    chart.addEventListener('focusin',function(e){ var d=pick(e); if(d) showOverviewDay(d); });
    chart.addEventListener('mouseleave',function(){ showOverviewDay(ovDay); });
    chart.addEventListener('click',function(e){ var d=pick(e); if(d) selectOverviewDay(d); });
    chart.addEventListener('keydown',function(e){
      if(e.key!=='Enter'&&e.key!==' ') return;
      var d=pick(e); if(d){ e.preventDefault(); selectOverviewDay(d); }
    });
  }
  var body=document.getElementById('ov-days-body');
  if(body) body.addEventListener('click',function(e){
    var tr=e.target.closest&&e.target.closest('tr[data-day]');
    if(tr) selectOverviewDay(tr.getAttribute('data-day'));
  });
})();
setInterval(function(){
  if(document.hidden) return;
  if(document.querySelector('.tab-page.active[data-page="overview"]')) refreshOverview();
},10000);
refreshOverview();

let messageTimers = {};
let toastTimer = null;
function showToast(title,text,ok,timeout){
  var toast=document.getElementById('toast');
  var titleEl=document.getElementById('toast-title');
  var textEl=document.getElementById('toast-text');
  if(!toast) return;
  clearTimeout(toastTimer);
  titleEl.textContent=title||'';
  textEl.textContent=text||'';
  toast.className='toast visible '+(ok?'ok':'error');
  var delay=timeout===undefined?(ok?3000:9000):timeout;
  if(delay>0) toastTimer=setTimeout(function(){ toast.className='toast'; },delay);
}
function showMsg(id,text,ok,timeout){
  var el=document.getElementById(id);
  if(!el) return;
  clearTimeout(messageTimers[id]);
  if(!text){ el.textContent=''; el.className='msg'; return; }
  el.textContent=text;
  el.className='msg '+(ok?'msg-ok':'msg-err');
  var delay=timeout===undefined?(ok?3000:9000):timeout;
  if(delay>0) messageTimers[id]=setTimeout(function(){ el.textContent=''; el.className='msg'; },delay);
  showToast(ok?'成功':'操作失败',text,ok,delay);
}
function endpointDiagnosticText(data){
  if(!data||(!data.fallback_used&&!data.fallback_reason&&!data.failed_endpoint)) return '';
  var requested=String(data.requested_endpoint||data.requested_mode||'').trim();
  var actual=String(data.actual_endpoint||data.actual_mode||'').trim();
  var target=String(data.fallback_target||actual||'').trim();
  var failed=String(data.failed_endpoint||requested||'').trim();
  var reason=String(data.fallback_reason||'').trim();
  var parts=[];
  if(failed) parts.push('失败端点='+failed);
  if(target) parts.push('回落目标='+target);
  if(reason) parts.push('原因='+reason);
  return parts.join(' | ');
}
function showEndpointDiagnostic(data,title){
  var text=endpointDiagnosticText(data);
  if(!text) return '';
  showToast(
    title||'端点诊断',
    text,
    !data.fallback_used&&!data.fallback_reason,
    9000
  );
  return text;
}
function escapeHtml(value){
  return String(value===undefined||value===null?'':value).replace(/[&<>"']/g,function(ch){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]; });
}
function responseCode(data){
  if(!data) return '';
  var body=data.data||data;
  return body && body.code!==undefined && body.code!==null ? String(body.code) : '';
}
function apiError(data,status){
  var code=responseCode(data);
  var message=(data&&data.error)||(data&&data.message)||(data&&data.data&&(data.data.message||data.data.error))||('HTTP '+(status||'未知'));
  var prefix=status&&status!==200?'HTTP '+status:'';
  if(code) prefix+=(prefix?'，':'')+'业务码 '+code;
  return (prefix?prefix+'：':'')+String(message);
}
async function requestJSON(url,options,timeoutMs){
  var controller=new AbortController();
  var timeout=setTimeout(function(){ controller.abort(); },timeoutMs||45000);
  var requestOptions=Object.assign({cache:'no-store'},options||{},{signal:controller.signal});
  try{
    var response=await fetch(url,requestOptions);
    var text=await response.text();
    var data={};
    if(text){
      try{ data=JSON.parse(text); }catch(e){ data={error:'服务返回了无效 JSON'}; }
    }
    return {ok:response.ok,status:response.status,data:data};
  }catch(e){
    if(e&&e.name==='AbortError') throw new Error('请求超时，请检查上游连接后重试');
    throw new Error('网络请求失败：'+String(e));
  }finally{ clearTimeout(timeout); }
}
async function postJSON(url,payload,timeoutMs){
  try{
    var result=await requestJSON(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload||{})},timeoutMs||45000);
    var d=result.data;
    if(!d||typeof d!=='object'||Array.isArray(d)) d={};
    d._http_status=result.status; d._http_ok=result.ok;
    return d;
  }catch(e){ return {success:false,error:String(e),_http_status:0,_http_ok:false}; }
}
let checkinGlobalBusy=false;
let checkinAccountBusy=new Set();
function syncCheckinBusyUI(){
  var anyBusy=checkinGlobalBusy||checkinAccountBusy.size>0;
  ['checkin-status-refresh-btn','credits-refresh-btn','checkin-claim-btn'].forEach(function(id){
    var el=document.getElementById(id); if(el){ el.disabled=anyBusy; el.classList.toggle('busy',anyBusy); }
  });
  document.querySelectorAll('[data-action="checkin"]').forEach(function(el){
    var row=el.closest('tr[data-account-id]');
    var id=row&&row.getAttribute('data-account-id');
    var busy=checkinGlobalBusy||checkinAccountBusy.has(String(id||''));
    el.disabled=busy;
    el.classList.toggle('busy',busy);
  });
  var indicator=document.getElementById('checkin-busy');
  if(indicator){ indicator.classList.toggle('visible',anyBusy); indicator.textContent=anyBusy?'正在查询/签到...':''; }
}
function setBusy(busy){
  checkinGlobalBusy=!!busy;
  syncCheckinBusyUI();
}
function setAccountCheckinBusy(id,busy){
  id=String(id);
  if(busy) checkinAccountBusy.add(id); else checkinAccountBusy.delete(id);
  var row=document.getElementById('row-'+id);
  if(row) row.classList.toggle('checkin-row-busy',busy);
  var detail=document.getElementById('checkin-detail-'+id);
  if(detail&&busy){ detail.textContent='正在签到该账号...'; detail.style.color=''; }
  syncCheckinBusyUI();
}
function setCredits(id,data){
  var values=[['general-credits-',data&&data.account_credits]];
  values.forEach(function(pair){
    var el=document.getElementById(pair[0]+id), value=pair[1];
    if(!el) return;
    if(value===undefined||value===null) return;
    if(value.unlimited) el.textContent='☆ 无限';
    else if(value.remaining!==undefined&&value.remaining!==null) el.textContent='剩'+Number(value.remaining).toFixed(2)+'/总'+(value.total_limit===undefined?'?':Number(value.total_limit).toFixed(2));
    else el.textContent='-';
  });
}
function setCheckinState(id,checked,detail,error){
  var el=document.getElementById('checkin-'+id), detailEl=document.getElementById('checkin-detail-'+id);
  if(el){
    var badge=checked===true?'<span class="badge badge-ok">已签到</span>':(checked===false?'<span class="badge badge-active">未签到</span>':'<span class="badge badge-none">未知</span>');
    el.innerHTML=badge;
  }
  if(detailEl){ detailEl.textContent=error||detail||''; detailEl.style.color=error?'var(--danger)':''; }
}
function updateAccountRow(account){
  if(!account||!account.id) return;
  updateAccountCreditsRow(account);
  updateAccountCheckinRow(account);
}
function updateAccountCreditsRow(account){
  if(!account||!account.id) return;
  setCredits(account.id,account);
  refreshStats();
}
function updateAccountCheckinRow(account){
  if(!account||!account.id) return;
  var payload=account.data||account.checkin||{};
  var code=payload&&payload.code!==undefined?'业务码 '+payload.code:'';
  var detail=account.error||code||'';
  setCheckinState(account.id,account.checked_in,detail,account.error);
  var labelEl=document.getElementById('label-'+account.id);
  if(labelEl&&account.label) labelEl.textContent=account.label;
  var row=document.getElementById('row-'+account.id);
  if(row) row.classList.toggle('row-failed',!!account.error||account.success===false);
  refreshStats();
}
function setActiveAccount(id,account){
  document.querySelectorAll('tr[data-account-id]').forEach(function(row){
    var active=row.getAttribute('data-account-id')===String(id);
    row.classList.toggle('active-row',active);
    var badge=row.querySelector('[data-account-active]');
    if(badge) badge.hidden=!active;
    var button=row.querySelector('[data-action="switch-account"]');
    if(button) button.disabled=active;
  });
  // The header no longer shows a user id: it duplicated the account pool and
  // grew a chip per account.
}
function setSwitchBusy(busy){
  document.querySelectorAll('[data-action="switch-account"]').forEach(function(button){
    if(busy){ button.disabled=true; }
    else {
      var row=button.closest('tr[data-account-id]');
      button.disabled=!!(row&&row.classList.contains('active-row'));
    }
  });
}
function updateCheckinSummary(accounts,action){
  var list=Array.isArray(accounts)?accounts:[];
  var ok=list.filter(function(a){ return a.checked_in===true; }).length;
  var failed=list.filter(function(a){ return !!a.error||a.success===false; }).length;
  var summary=document.getElementById('checkin-summary');
  if(summary) summary.textContent=(action||'已更新')+'：'+ok+' 已签到 / '+list.length+' 个账号'+(failed?'，'+failed+' 个异常':'');
  var updated=document.getElementById('checkin-updated');
  if(updated) updated.textContent='更新于 '+new Date().toLocaleTimeString();
  return {ok:ok,failed:failed,total:list.length};
}
function updateVisibleCheckinSummary(action){
  var rows=Array.from(document.querySelectorAll('tr[data-account-id]'));
  var ok=rows.filter(function(row){
    var state=row.querySelector('.checkin-state');
    return !!state&&state.textContent.trim()==='已签到';
  }).length;
  var failed=rows.filter(function(row){ return row.classList.contains('row-failed'); }).length;
  var summary=document.getElementById('checkin-summary');
  if(summary) summary.textContent=(action||'已更新')+'：'+ok+' 已签到 / '+rows.length+' 个账号'+(failed?'，'+failed+' 个异常':'');
  var updated=document.getElementById('checkin-updated');
  if(updated) updated.textContent='更新于 '+new Date().toLocaleTimeString();
  return {ok:ok,failed:failed,total:rows.length};
}
function checkinFailureText(account){
  var code=responseCode(account&&account.data);
  var message=(account&&account.error)||((account&&account.data&&account.data.message)||'未知错误');
  return (account&&account.label||account&&account.id||'账号')+'：'+(code?'业务码 '+code+'，':'')+message;
}
const CONN_PRESET = ['glm-5.3','glm-5.2','kimi-k2.7-code','kimi-k3','qwen3.8-max','DeepSeek-V4-Pro-Official','DeepSeek-V4-Flash-Official'];
function fillConnPreset(){
  document.getElementById('conn-models').value = CONN_PRESET.join(', ');
}
function connModelList(){
  var raw = document.getElementById('conn-models').value || '';
  // Keep the newline escape intact when this script is rendered from the
  // Python f-string.  A literal line break makes the whole inline script
  // invalid JavaScript and disables every account/usage control on the page.
  var items = raw.split(/[\n,]+/).map(function(s){ return s.trim(); }).filter(Boolean);
  return items.length ? items : CONN_PRESET.slice();
}
function connModes(){
  var modes = [];
  if(document.getElementById('conn-mode-text').checked) modes.push('text');
  if(document.getElementById('conn-mode-tool').checked) modes.push('tool');
  return modes;
}
function connRow(model, mode){
  var tr = document.createElement('tr');
  var label = mode === 'tool' ? '工具调用' : '文本回复';
  [model, label, '排队中', '-', '-'].forEach(function(text, idx){
    var td = document.createElement('td');
    td.textContent = text;
    if(idx === 2) td.className = 'conn-status pending';
    if(idx === 3) td.className = 'conn-time';
    if(idx === 4) td.className = 'conn-detail';
    tr.appendChild(td);
  });
  return tr;
}
async function runConnTest(){
  var btn = document.getElementById('conn-run-btn');
  var table = document.getElementById('conn-table');
  var tbody = document.getElementById('conn-tbody');
  var summary = document.getElementById('conn-summary');
  var models = connModelList();
  var modes = connModes();
  if(!modes.length){ showMsg('conn-msg','请至少选择一种测试内容',false); return; }
  var timeout = parseInt(document.getElementById('conn-timeout').value,10) || 120;
  var endpoint = document.getElementById('conn-endpoint').value || 'remote';
  var effort = document.getElementById('conn-effort').value || '';
  var thinking = document.getElementById('conn-thinking').checked;
  var maxMode = document.getElementById('conn-max').checked;
  btn.disabled = true;
  table.hidden = false;
  // The instruction is replaced by the results table it stood in for.
  var empty = document.getElementById('conn-empty');
  if(empty) empty.hidden = true;
  tbody.innerHTML = '';
  showMsg('conn-msg','');
  var jobs = [];
  models.forEach(function(model){
    modes.forEach(function(mode){
      var tr = connRow(model, mode);
      tbody.appendChild(tr);
      jobs.push({model: model, mode: mode, row: tr});
    });
  });
  var passed = 0, done = 0, endpointWarnings = [];
  summary.textContent = '0/' + jobs.length + ' 完成';
  for(var i = 0; i < jobs.length; i++){
    var job = jobs[i];
    var statusCell = job.row.querySelector('.conn-status');
    var timeCell = job.row.querySelector('.conn-time');
    var detailCell = job.row.querySelector('.conn-detail');
    statusCell.textContent = '测试中...';
    statusCell.className = 'conn-status pending';
    try{
      var d = await postJSON('/api/model-test',
        {model: job.model, mode: job.mode, timeout: timeout, endpoint: endpoint,
          reasoning_effort: effort, thinking: thinking, max_mode: maxMode,
          // This page compares one endpoint at a time.  Do not hide a native
          // endpoint failure behind the API runtime's production fallback.
          disable_fallback: true}, (timeout + 20) * 1000);
      timeCell.textContent = (d.elapsed_ms !== undefined ? d.elapsed_ms + ' ms' : '-');
      if(d.success){
        passed++;
        statusCell.textContent = '通过';
        statusCell.className = 'conn-status ok';
        var endpointDiagnostic=endpointDiagnosticText(d);
        if(job.mode === 'tool'){
          var names = (d.tool_calls || []).map(function(c){ return c.name; }).join(', ');
          detailCell.textContent = (d.auto_route ? 'auto -> ' : '') + 'endpoint=' + (d.actual_endpoint || d.actual_mode || '-')
            + (d.fallback_used ? ' (fallback)' : '') + ' | tool=' + (names || '-')
            + (d.provider_model_name ? ' | ' + d.provider_model_name : '');
        } else {
          detailCell.textContent = (d.auto_route ? 'auto -> ' : '') + 'endpoint=' + (d.actual_endpoint || d.actual_mode || '-')
            + (d.fallback_used ? ' (fallback)' : '') + ' | ' + JSON.stringify(d.reply || '')
            + (d.provider_model_name ? ' | ' + d.provider_model_name : '');
        }
        if(endpointDiagnostic) detailCell.textContent += ' | ' + endpointDiagnostic;
        if(endpointDiagnostic) endpointWarnings.push(endpointDiagnostic);
        var extra = [];
        if(d.requested_reasoning_effort){
          extra.push('强度=' + d.requested_reasoning_effort + ' -> '
            + (d.reasoning_effort_applied || ('未生效: ' + (d.reasoning_effort_note || '模型不支持'))));
        }
        if(maxMode){
          extra.push('Max=' + (d.max_mode_applied ? '已生效 ' + formatContext(d.max_context_tokens) : '未生效'));
        }
        if(d.usage && d.usage.reasoning_tokens !== undefined && d.usage.reasoning_tokens !== null){
          extra.push('reasoning_tokens=' + d.usage.reasoning_tokens);
        }
        if(extra.length) detailCell.textContent += ' | ' + extra.join(' | ');
        if(d.reasoning){
          var rd = document.createElement('div');
          rd.className = 'conn-reasoning';
          rd.textContent = '思考: ' + d.reasoning;
          detailCell.appendChild(rd);
        }
      } else {
        statusCell.textContent = '失败';
        statusCell.className = 'conn-status fail';
        var endpointDiagnostic=endpointDiagnosticText(d);
        detailCell.textContent = String(d.error || 'unknown')
          + (endpointDiagnostic ? ' | ' + endpointDiagnostic : '');
        if(endpointDiagnostic) endpointWarnings.push(endpointDiagnostic);
      }
    }catch(e){
      statusCell.textContent = '失败';
      statusCell.className = 'conn-status fail';
      timeCell.textContent = '-';
      detailCell.textContent = String(e);
    }
    done++;
    summary.textContent = done + '/' + jobs.length + ' 完成，通过 ' + passed;
  }
  btn.disabled = false;
  var allOk = passed === jobs.length;
  showMsg('conn-msg', '测试结束：' + passed + '/' + jobs.length + ' 通过', allOk);
  if(endpointWarnings.length) showToast('端点回落/失败诊断',
    endpointWarnings.slice(0,3).join('\n'),false,12000);
}
var modelCatalog = [];
function fmtTokens(n){
  n=Number(n||0);
  if(!n) return '--';
  if(n>=1000000) return (Math.round(n/100000)/10)+'M';
  return Math.round(n/1000)+'K';
}
function modelContextCell(m){
  // max is the 1M tier and is 0 on most models, so the headline must be the
  // largest *usable* window or a 256K model renders as "--".
  var dev=Number(m.context_dev||0), max=Number(m.context_max||0);
  var best=max>dev? max : dev;
  if(!best) return '<span class="rate-none">--</span>';
  var text='<span class="ctx-main">'+fmtTokens(best)+'</span>';
  // Only worth a sub-line when the Max tier actually exceeds the dev window.
  if(max>dev && dev>0) text+='<span class="ctx-sub">dev '+fmtTokens(dev)+'</span>';
  return text;
}
function modelFlagChips(m){
  var chips=[];
  if(m.max_mode) chips.push(['1M Max','max','该模型支持 1M 长上下文档位']);
  if(m.multimodal) chips.push(['多模态','tool','支持图片输入']);
  if(m.supports_video) chips.push(['视频','tool','支持视频输入']);
  if(m.supports_thinking) chips.push(['思考','unknown','支持返回思考内容']);
  if(m.is_default) chips.push(['默认','max','账号当前默认模型']);
  if(m.is_new) chips.push(['新','tool','上游标记为新模型']);
  if(m.is_beta) chips.push(['Beta','unknown','上游标记为测试模型']);
  if(m.is_preset) chips.push(['预设','','上游预设模型（非自定义）']);
  if(!chips.length) return '<span class="usage-flag unknown">--</span>';
  return chips.map(function(c){
    return '<span class="usage-flag '+c[1]+'" title="'+escapeHtml(c[2])+'">'+escapeHtml(c[0])+'</span>';
  }).join('');
}
function modelRateCell(m){
  if(m.consumption_rate===null || m.consumption_rate===undefined)
    return '<span class="rate-none" title="上游未提供该模型的积分倍率">--</span>';
  var now=Number(m.consumption_rate);
  var text='<span class="rate-now">'+now.toFixed(2)+'x</span>';
  if(m.discount_percent){
    // Upstream already applied the reduction, so recover the list price for
    // context. Shown as a sub-line: a strikethrough through monospace digits
    // at this size reads like a minus sign.
    var was=now/(1-(Number(m.discount_percent)/100));
    var sub=[];
    if(isFinite(was) && was>now) sub.push('原 '+was.toFixed(2));
    sub.push('-'+Number(m.discount_percent)+'%');
    sub.push(escapeHtml(m.discount_kind||'discount'));
    text+='<span class="ctx-sub">'+sub.join(' · ')+'</span>';
  }
  return text;
}
function modelRow(m){
  var tr=document.createElement('tr');
  if(m.is_default) tr.className='row-default';
  var ctx=modelContextCell(m);
  var thinking=m.supports_thinking
    ? '<span class="thinking">'+(m.reasoning_options||[]).map(escapeHtml).join(' / ')
      +'<span class="lvl">默认 '+escapeHtml(m.reasoning_default||'--')+'</span></span>'
    : '<span class="rate-none">不支持</span>';
  var source=m.provider
    ? escapeHtml(m.provider)+(m.custom_model_id?'<span class="model-sub">id '+escapeHtml(m.custom_model_id)+'</span>':'')
    : '<span class="rate-none">内置</span>';
  tr.innerHTML='<td><span class="model-name">'+escapeHtml(m.name)+'</span>'
    +(m.display_name&&m.display_name!==m.name?'<span class="model-sub">'+escapeHtml(m.display_name)+'</span>':'')
    +'</td>'
    +'<td>'+source+'</td>'
    +'<td>'+ctx+'</td>'
    +'<td class="numeric rate">'+modelRateCell(m)+'</td>'
    +'<td><span class="flags">'+modelFlagChips(m)+'</span></td>'
    +'<td>'+thinking+'</td>';
  return tr;
}
function renderModels(){
  var tbody=document.getElementById('models-tbody');
  var summary=document.getElementById('models-summary');
  var empty=document.getElementById('models-empty');
  var wrap=document.getElementById('models-table-wrap');
  var filter=document.getElementById('models-filter');
  if(!tbody||!wrap) return;
  var needle=(filter&&filter.value||'').trim().toLowerCase();
  var rows=modelCatalog.filter(function(m){
    if(!needle) return true;
    return (m.name+' '+m.display_name+' '+m.provider).toLowerCase().indexOf(needle)>=0;
  });
  wrap.hidden=false;
  if(empty) empty.hidden=true;
  tbody.innerHTML='';
  rows.forEach(function(m){ tbody.appendChild(modelRow(m)); });
  if(summary) summary.textContent=(needle? rows.length+' / '+modelCatalog.length : String(modelCatalog.length))+' 个模型';
  if(needle && !rows.length){
    tbody.innerHTML='<tr><td colspan="6" class="empty-hint">没有匹配 “'+escapeHtml(needle)+'” 的模型</td></tr>';
  }
}
function filterModels(){ renderModels(); }
async function refreshModels(){
  var msg=document.getElementById('models-msg');
  var empty=document.getElementById('models-empty');
  var wrap=document.getElementById('models-table-wrap');
  if(empty) empty.textContent='加载中...';
  if(wrap) wrap.hidden=true;
  try{
    var result=await requestJSON('/api/models/detail',{method:'GET'},60000);
    var d=result.data;
    if(!result.ok || !d || !d.success || !Array.isArray(d.models)){
      throw new Error((d && d.error) || ('HTTP '+result.status));
    }
    modelCatalog=d.models;
    renderModels();
    showMsg('models-msg','成功获取 '+d.models.length+' 个模型（'+d.max_mode_count+' 个支持 1M Max）',true);
  }catch(e){
    modelCatalog=[];
    if(wrap) wrap.hidden=true;
    if(empty){ empty.hidden=false; empty.textContent='获取失败：'+String(e.message||e); }
    showMsg('models-msg',String(e.message||e),false);
  }
}
async function logout(){
  var d=await postJSON('/api/logout',{});
  showMsg('auth-msg',d.success?'已登出':(d.error||'登出失败'),d.success);
  if(d.success) setTimeout(function(){ location.reload(); },600);
}
async function switchAccount(id){
  setSwitchBusy(true);
  try{
    var d=await postJSON('/api/accounts/switch',{account_id:id},30000);
    if(!d.success){ showMsg('account-msg',d.error||'切换失败',false); return; }
    setActiveAccount(d.active||id,d.account||{id:id});
    showMsg('account-msg','已切换到账号 '+String((d.account&&(d.account.label||d.account.user_id))||id),true,3000);
  }finally{ setSwitchBusy(false); }
}
var accountModelDraft={};
function setAccountModelVisual(id,enabled){
  var row=document.getElementById('row-'+id);
  var input=row&&row.querySelector('input[data-action="model-toggle"]');
  if(input) input.checked=!!enabled;
  var state=document.getElementById('model-state-wrap-'+id);
  if(state){
    state.innerHTML='<span class="badge '+(enabled?'badge-ok':'badge-none')+'">'+(enabled?'已开启':'已关闭')+'</span>';
  }
}
function updateAccountModelSaveButton(){
  var btn=document.getElementById('account-model-save-btn');
  if(btn) btn.disabled=Object.keys(accountModelDraft).length===0;
}
function toggleAccountModel(id,input){
  if(!input) return;
  var row=document.getElementById('row-'+id);
  var baseline=row&&row.getAttribute('data-model-enabled')==='1';
  var wanted=!!input.checked;
  if(wanted===baseline) delete accountModelDraft[String(id)];
  else accountModelDraft[String(id)]=wanted;
  setAccountModelVisual(id,wanted);
  updateAccountModelSaveButton();
  showMsg('account-msg',Object.keys(accountModelDraft).length
    ? '账号模型开关已修改，请点击“保存模型开关”后生效'
    : '',true,4000);
}
function markAccountModelDirty(id,input){
  // Account model switches are drafts; the toolbar Save button performs the
  // actual writes in one batch so changing a switch never changes the server.
  toggleAccountModel(id,input);
}
async function saveAccountModelSettings(){
  var ids=Object.keys(accountModelDraft);
  if(!ids.length) return;
  var btn=document.getElementById('account-model-save-btn');
  if(btn) btn.disabled=true;
  var failed=[];
  try{
    for(var i=0;i<ids.length;i++){
      var id=ids[i], wanted=!!accountModelDraft[id];
      var d=await postJSON('/api/accounts/model-enabled',{account_id:id,enabled:wanted},30000);
      if(!d.success){ failed.push(id); continue; }
      setAccountModelVisual(id,!!d.model_enabled);
      var savedRow=document.getElementById('row-'+id);
      if(savedRow) savedRow.setAttribute('data-model-enabled',!!d.model_enabled?'1':'0');
      delete accountModelDraft[id];
    }
    if(failed.length){
      failed.forEach(function(id){
        var row=document.getElementById('row-'+id);
        setAccountModelVisual(id,row&&row.getAttribute('data-model-enabled')==='1');
      });
      showMsg('account-msg','部分账号保存失败：'+failed.join(', '),false,8000);
    }else showMsg('account-msg','账号模型请求开关已保存，每日签到不受影响',true,4000);
  }finally{
    updateAccountModelSaveButton();
  }
}
async function removeAccount(id){
  if(!confirm('确定删除该账号？')) return;
  var d=await postJSON('/api/accounts/remove',{account_id:id});
  if(d.success) location.reload(); else showMsg('auth-msg',d.error||'删除失败',false);
}
function markPollingDirty(){
  var btn=document.getElementById('poll-save-btn');
  if(btn) btn.disabled=false;
  showMsg('poll-msg','轮询设置已修改，点击“保存轮询设置”后生效',true,0);
}
async function savePollingSettings(){
  var on=!!document.getElementById('poll-toggle').checked;
  var mode=document.querySelector('input[name=poll-mode]:checked');
  var modeVal=mode?mode.value:'round-robin';
  var d=await postJSON('/api/polling',{enabled:on,mode:modeVal});
  if(d.success){
    var btn=document.getElementById('poll-save-btn'); if(btn) btn.disabled=true;
    var status=document.getElementById('poll-status');
    var countMatch=status&&status.textContent.match(/当前账号数:\s*(\d+)/);
    var accountCount=countMatch?countMatch[1]:'0';
    if(status) status.textContent='当前账号数: '+(d.account_count||accountCount)+'，轮询: '+(d.enabled?'开':'关')+'（'+(d.mode||modeVal)+'）';
    showMsg('poll-msg','轮询设置已保存',true,3000);
  }else showMsg('poll-msg',d.error||'保存失败',false);
}
// Kept as a compatibility wrapper for older inline callers; changing a
// setting must never persist it implicitly.
function togglePolling(){ markPollingDirty(); }
// Endpoint changes stay in the browser draft until the explicit Save button.
// Serialize explicit writes so a slower, older request cannot finish after a
// newer save and overwrite the current selection.
let endpointSaveSerial=0;
let endpointSaveQueue=Promise.resolve();
let endpointLastGoodState=null;
let endpointDirty=false;
function markEndpointDirty(){
  endpointDirty=true;
  var btn=document.getElementById('settings-save-btn'); if(btn) btn.disabled=false;
  var msg=document.getElementById('settings-msg');
  if(msg){ msg.textContent='端点设置已修改，点击“保存设置”后生效'; msg.className='msg msg-pending'; }
}
function readEndpointSelection(){
  var selector=document.getElementById('settings-endpoint-preset');
  var input=document.getElementById('settings-web');
  var preset=selector?selector.value:'';
  var map=(typeof ENDPOINT_PRESET_MAP !== 'undefined') ? ENDPOINT_PRESET_MAP : {};
  var entry=map[preset]||null;
  return {
    preset:preset,
    endpoint_id:(entry&&preset)?preset:'',
    web_base_url:input?(input.value||'').trim():'',
    upstream_mode:entry?entry.mode:''
  };
}
function restoreEndpointSelection(state){
  state=state||{};
  var selector=document.getElementById('settings-endpoint-preset');
  var input=document.getElementById('settings-web');
  var map=(typeof ENDPOINT_PRESET_MAP !== 'undefined') ? ENDPOINT_PRESET_MAP : {};
  var endpointId=String(state.endpoint_id||'').toLowerCase();
  if(selector){
    if(endpointId&&map[endpointId]) selector.value=endpointId;
    else if(state.preset==='__saved') selector.value='__saved';
    else selector.value='';
  }
  if(input&&state.web_base_url!==undefined&&state.web_base_url!==null){
    input.value=String(state.web_base_url);
  }
}
async function saveSettings(){
  var serial=++endpointSaveSerial;
  var state=readEndpointSelection();
  var payload={
    web_base_url:state.web_base_url,
    upstream_mode:state.upstream_mode,
    endpoint_id:state.endpoint_id
  };
  var task=endpointSaveQueue.then(async function(){
    var d=await postJSON('/api/settings',payload);
    // A newer selection happened while this request was in flight.  The
    // queued newer write owns the UI.
    if(serial!==endpointSaveSerial) return d;
    if(d&&d.success){
      var canonical=(d.settings&&typeof d.settings==='object')?d.settings:{};
      var canonicalId=String(canonical.endpoint_id||state.endpoint_id||'').toLowerCase();
      var canonicalUrl=canonical.web_base_url;
      var map=(typeof ENDPOINT_PRESET_MAP !== 'undefined') ? ENDPOINT_PRESET_MAP : {};
      if(canonicalId&&map[canonicalId]) canonicalUrl=map[canonicalId].base_url;
      restoreEndpointSelection({
        preset:canonicalId?canonicalId:state.preset,
        endpoint_id:canonicalId,
        web_base_url:(canonicalUrl===undefined||canonicalUrl===null)?state.web_base_url:canonicalUrl
      });
      endpointLastGoodState=readEndpointSelection();
      endpointDirty=false;
      var saveButton=document.getElementById('settings-save-btn'); if(saveButton) saveButton.disabled=true;
      var endpointDiagnostic=endpointDiagnosticText(d);
      showMsg('settings-msg',(d.note||'设置已保存')
        + (endpointDiagnostic ? '\n'+endpointDiagnostic : ''),true);
      if(endpointDiagnostic) showEndpointDiagnostic(d,'端点设置');
    }else{
      restoreEndpointSelection(endpointLastGoodState||state);
      var endpointDiagnostic=endpointDiagnosticText(d);
      showMsg('settings-msg',((d&&d.error)||'保存失败')
        + (endpointDiagnostic ? '\n'+endpointDiagnostic : ''),false);
      if(endpointDiagnostic) showEndpointDiagnostic(d,'端点设置失败');
    }
    return d;
  }).catch(function(error){
    if(serial===endpointSaveSerial){
      restoreEndpointSelection(endpointLastGoodState||state);
      endpointDirty=false;
      var saveButton=document.getElementById('settings-save-btn'); if(saveButton) saveButton.disabled=true;
      showMsg('settings-msg',String(error||'保存失败'),false);
    }
    return {success:false,error:String(error||'保存失败')};
  });
  // Keep the queue alive after a failed request, while still returning this
  // request's result to the caller that initiated the save.
  endpointSaveQueue=task.catch(function(){});
  return task;
}
async function saveRelayServiceSettings(){
  var input=document.getElementById('settings-port');
  var port=(input&&input.value||'').trim();
  var value=Number(port);
  if(!/^\d+$/.test(port)||value<1||value>65535){
    showMsg('relay-service-msg','请输入 1-65535 的端口号',false);
    return;
  }
  var d=await postJSON('/api/settings',{relay_port:value});
  if(d.success){
    var saveButton=document.getElementById('relay-service-save-btn');
    if(saveButton) saveButton.disabled=true;
    showMsg('relay-service-msg',d.note||'服务设置已保存，重启容器后生效',true,6000);
  }else showMsg('relay-service-msg',d.error||'保存失败',false);
}
function markRelayServiceDirty(){
  var button=document.getElementById('relay-service-save-btn');
  if(button) button.disabled=false;
  showMsg('relay-service-msg','服务设置已修改，点击“保存服务设置”后生效',true,0);
}
function markAutoRouteDirty(){
  var button=document.getElementById('auto-route-save-btn');
  if(button) button.disabled=false;
  showMsg('auto-route-msg','自动路由设置已修改，点击“保存自动路由”后生效',true,0);
}
async function saveAutoRoute(){
  var toggle=document.getElementById('auto-route-toggle');
  var d=await postJSON('/api/auto-route',{enabled:toggle.checked});
  if(d.success){
    toggle.checked=!!d.enabled;
    var button=document.getElementById('auto-route-save-btn');
    if(button) button.disabled=true;
    setStatePill('auto-route-state',d.enabled?'已开启':'已关闭',d.enabled);
    showMsg('auto-route-msg',d.enabled?'自动路由已开启，下一个请求生效':'自动路由已关闭，使用预设端点',true,3000);
  } else {
    showMsg('auto-route-msg',d.error||'保存失败',false);
  }
}
function markMaxModeDirty(){
  var button=document.getElementById('max-mode-save-btn');
  if(button) button.disabled=false;
  showMsg('max-mode-msg','Max 模式设置已修改，点击“保存”后生效',true,0);
}
async function saveMaxMode(){
  var enabled=document.getElementById('max-mode-toggle').checked;
  var models=document.getElementById('max-mode-models').value.trim();
  var d=await postJSON('/api/max-mode',{enabled:enabled,models:models});
  if(d.success){
    document.getElementById('max-mode-toggle').checked=!!d.enabled;
    document.getElementById('max-mode-models').value=d.models||'';
    var button=document.getElementById('max-mode-save-btn');
    if(button) button.disabled=true;
    setStatePill('max-mode-state',d.enabled?'已开启':'已关闭',d.enabled);
    showMsg('max-mode-msg',d.enabled?'Max 模式已开启，新会话生效':'Max 模式已关闭',true,3000);
  } else showMsg('max-mode-msg',d.error||'保存失败',false);
}
function formatContext(n){
  if(!n) return '';
  return n>=1000000 ? (Math.round(n/100000)/10)+'M' : Math.round(n/1000)+'K';
}
function addMaxModel(name){
  var input=document.getElementById('max-mode-models');
  var items=input.value.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  var lower=items.map(function(s){ return s.toLowerCase(); });
  if(lower.indexOf(name.toLowerCase())<0){
    items.push(name);
    input.value=items.join(', ');
    markMaxModeDirty();
  }
}
async function detectMaxModels(){
  var btn=document.getElementById('max-mode-detect-btn');
  var out=document.getElementById('max-mode-models-out');
  btn.disabled=true;
  try{
    var result=await requestJSON('/api/max-mode/models',{method:'GET'},45000);
    var d=result.data;
    if(!result.ok||!d||!d.success) throw new Error(apiError(d,result.status));
    out.textContent='';
    var list=d.models||[];
    if(!list.length) out.textContent='当前账号没有支持 Max 的模型';
    list.forEach(function(m){
      var chip=document.createElement('button');
      chip.type='button';
      chip.className='model-chip';
      chip.textContent=m.name+(m.max_context?' · '+formatContext(m.max_context):'');
      chip.title='加入生效模型';
      chip.onclick=function(){ addMaxModel(m.name); };
      out.appendChild(chip);
    });
    out.hidden=false;
  }catch(e){ showMsg('max-mode-msg',String(e),false,8000); }
  finally{ btn.disabled=false; }
}
var ENDPOINT_PRESET_MAP = cfg('endpointMap', {});
endpointLastGoodState=readEndpointSelection();
function applyEndpointPreset(){
  var selector=document.getElementById('settings-endpoint-preset');
  var input=document.getElementById('settings-web');
  if(!selector||!input) return;
  var map=ENDPOINT_PRESET_MAP;
  var entry=map[selector.value]||null;
  var value=entry?entry.base_url:'';
  if(value) input.value=value;
  // Selecting a preset only updates the draft URL.  The explicit Save button
  // is the sole path that persists endpoint settings.
  markEndpointDirty();
}
async function checkinRefreshAll(){
  setBusy(true);
  try{
    var result=await requestJSON('/api/checkin/accounts',{method:'GET'},90000);
    var d=result.data;
    if(!result.ok||!d||!d.success){ throw new Error(apiError(d,result.status)); }
    var accounts=d.accounts||[];
    accounts.forEach(updateAccountCheckinRow);
    var summary=updateCheckinSummary(accounts,'签到状态查询完成');
    var failures=accounts.filter(function(a){ return a.error; });
    if(failures.length){
      showMsg('checkin-msg','签到状态查询完成，但有 '+failures.length+' 个账号失败：\n'+failures.slice(0,3).map(checkinFailureText).join('\n'),false,12000);
    }else{
      showMsg('checkin-msg','签到状态查询成功，已刷新 '+summary.total+' 个账号',true,3000);
    }
  }catch(e){ showMsg('checkin-msg',String(e),false,12000); }
  finally{ setBusy(false); }
}
async function creditsRefreshAll(){
  setBusy(true);
  try{
    var result=await requestJSON('/api/checkin/credits/accounts',{method:'GET'},90000);
    var d=result.data;
    if(!result.ok||!d||!d.success){ throw new Error(apiError(d,result.status)); }
    var accounts=d.accounts||[];
    accounts.forEach(updateAccountCreditsRow);
    var failures=accounts.filter(function(a){ return a.error; });
    var summary=document.getElementById('checkin-summary');
    if(summary) summary.textContent='积分查询完成：'+(accounts.length-failures.length)+' / '+accounts.length+' 个账号'+(failures.length?'，'+failures.length+' 个异常':'');
    var updated=document.getElementById('checkin-updated');
    if(updated) updated.textContent='更新于 '+new Date().toLocaleTimeString();
    if(failures.length){
      showMsg('checkin-msg','积分查询完成，但有 '+failures.length+' 个账号失败：\n'+failures.slice(0,3).map(checkinFailureText).join('\n'),false,12000);
    }else{
      showMsg('checkin-msg','积分查询成功，已刷新 '+accounts.length+' 个账号',true,3000);
    }
  }catch(e){ showMsg('checkin-msg',String(e),false,12000); }
  finally{ setBusy(false); }
}
async function checkinAccount(id){
  setAccountCheckinBusy(id,true);
  try{
    var result=await requestJSON('/api/checkin/account/'+encodeURIComponent(id),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},90000);
    var d=result.data||{};
    var account={id:id,data:d.data,checked_in:d.checked_in,account_credits:d.account_credits,success:d.success,error:d.success?'':apiError(d,result.status)};
    updateAccountRow(account);
    if(!result.ok||!d||!d.success){ showMsg('checkin-msg','账号 '+id+' 签到失败：'+apiError(d,result.status),false,12000); return; }
    account.checked_in=true;
    account.error='';
    updateAccountRow(account);
    updateVisibleCheckinSummary('签到完成');
    showMsg('checkin-msg',d.skipped?'账号 '+id+' 已签到，无需重复操作':'账号 '+id+' 签到成功（业务码 '+(responseCode(d)||'0')+'）',true,3000);
  }catch(e){ showMsg('checkin-msg',String(e),false,12000); }
  finally{ setAccountCheckinBusy(id,false); }
}
async function checkinClaimAll(){
  if(!confirm('确定按顺序逐个对所有账号签到？')) return;
  setBusy(true);
  try{
    var accountCount=document.querySelectorAll('tr[data-account-id]').length;
    var timeoutMs=Math.max(900000,(accountCount+1)*(Number(cfg('checkinInterval',60))+5)*1000);
    var result=await requestJSON('/api/checkin/claim-all',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},timeoutMs);
    var d=result.data;
    if(!result.ok||!d||!d.success){ throw new Error(apiError(d,result.status)); }
    var accounts=d.accounts||[];
    accounts.forEach(updateAccountRow);
    var summary=updateCheckinSummary(accounts,'轮询完成');
    if(summary.failed){
      showMsg('checkin-msg','轮询完成：'+summary.failed+' 个账号失败\n'+accounts.filter(function(a){return a.error||a.success===false;}).slice(0,5).map(checkinFailureText).join('\n'),false,12000);
    }else{
      showMsg('checkin-msg','轮询签到成功，'+summary.ok+' 个账号已签到',true,3000);
    }
  }catch(e){ showMsg('checkin-msg',String(e),false,12000); }
  finally{ setBusy(false); }
}
function formatCheckinTime(iso){
  if(!iso) return '-';
  var m=String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? (m[2]+'-'+m[3]+' '+m[4]+':'+m[5]) : String(iso);
}
let autoCheckinDirty=false;
function markAutoCheckinDirty(){
  autoCheckinDirty=true;
  var button=document.getElementById('auto-checkin-save-btn');
  if(button) button.disabled=false;
  showMsg('auto-checkin-msg','自动签到设置已修改，点击“保存”后生效',true,0);
}
function renderAutoCheckin(d){
  if(!d||!d.success) return;
  var toggle=document.getElementById('auto-checkin-toggle');
  var timeInput=document.getElementById('auto-checkin-time');
  // A background status refresh must not overwrite edits that have not been
  // saved yet.  It may still update the read-only execution status below.
  if(!autoCheckinDirty){
    if(toggle) toggle.checked=!!d.enabled;
    if(timeInput&&d.time) timeInput.value=d.time;
  }
  setStatePill('auto-checkin-state',d.running?'正在执行...':(d.enabled?('每天 '+d.time+' 自动签到'):'已关闭'),d.enabled||d.running);
  document.getElementById('auto-checkin-next').textContent=d.enabled?(formatCheckinTime(d.next_run)+(d.due_now?'（已到时间，等待执行）':'')):'未启用';
  document.getElementById('auto-checkin-last').textContent=d.last_run_at
    ? formatCheckinTime(d.last_run_at)+(d.last_trigger==='manual'?'（手动）':'（定时）') : '-';
  var s=d.summary;
  document.getElementById('auto-checkin-result').textContent=s
    ? ('成功 '+s.ok+' / 跳过 '+s.skipped+' / 失败 '+s.failed+(s.no_token?(' / 无凭证 '+s.no_token):'')) : '-';
  var runBtn=document.getElementById('auto-checkin-run-btn');
  if(runBtn) runBtn.disabled=!!d.running;
}
async function loadAutoCheckin(){
  try{
    var result=await requestJSON('/api/auto-checkin',{method:'GET'},15000);
    renderAutoCheckin(result.data);
    return result.data;
  }catch(e){ return null; }
}
async function saveAutoCheckin(){
  var toggle=document.getElementById('auto-checkin-toggle');
  var timeValue=document.getElementById('auto-checkin-time').value;
  if(!/^\d{2}:\d{2}$/.test(timeValue||'')){ showMsg('auto-checkin-msg','请填写有效的签到时间（HH:MM）',false); return; }
  var d=await postJSON('/api/auto-checkin',{enabled:toggle.checked,time:timeValue});
  if(d.success){
    autoCheckinDirty=false;
    var button=document.getElementById('auto-checkin-save-btn');
    if(button) button.disabled=true;
    renderAutoCheckin(d);
    showMsg('auto-checkin-msg',d.enabled?('已开启，每天 '+d.time+' 自动签到所有账号'):'自动签到已关闭',true,3000);
  } else showMsg('auto-checkin-msg',d.error||'保存失败',false);
}
var autoCheckinPoll=null;
async function runAutoCheckinNow(){
  if(!confirm('立即按顺序签到所有未签到账号？已签到账号会自动跳过。')) return;
  var d=await postJSON('/api/auto-checkin/run',{});
  if(!d.success){ showMsg('auto-checkin-msg',d.error||'启动失败',false); return; }
  renderAutoCheckin(d);
  showMsg('auto-checkin-msg',d.started?'已开始执行，账号之间按签到间隔依次处理':'已有签到任务在执行',true,4000);
  clearInterval(autoCheckinPoll);
  autoCheckinPoll=setInterval(async function(){
    var latest=await loadAutoCheckin();
    if(latest&&!latest.running){
      clearInterval(autoCheckinPoll);
      if(typeof checkinRefreshAll==='function'&&latest.summary&&latest.summary.ok) showMsg('auto-checkin-msg','执行完成，可点击“查询签到状态”刷新列表',true,5000);
    }
  },5000);
}
loadAutoCheckin();
setInterval(loadAutoCheckin,60000);
(function(){
  var initial=(location.hash||'').replace('#','');
  if(initial&&document.querySelector('.tab-page[data-page="'+initial+'"]')) switchTab(initial);
})();
syncSelection();
window.addEventListener('resize',syncSelection);
if(document.fonts&&document.fonts.ready) document.fonts.ready.then(syncSelection);
var manualForm=document.getElementById('manual-form');
if(manualForm) manualForm.addEventListener('submit',async function(e){
  e.preventDefault();var fd=new FormData(e.target);
  var payload={};
  for(var[k,v]of fd.entries())if(v)payload[k]=v;
  var d=await postJSON('/api/web-auth',payload);
  showMsg('manual-msg',d.success?'账号已添加':d.error||'提交失败',d.success);
  if(d.success) setTimeout(function(){ location.reload(); },600);
});

/* ── Runtime logs ─────────────────────────────────────────────────────── */
var logChannel = 'all';
var logFollow = true;
var logTimer = null;
function logChannelLabel(ch) {
  return ch === 'chat' ? '对话' : ch === 'task' ? '任务' : '系统';
}
function setLogChannel(ch) {
  logChannel = ch || 'all';
  document.querySelectorAll('.chips .chip[data-log-channel]').forEach(function (b) {
    b.classList.toggle('on', b.getAttribute('data-log-channel') === logChannel);
  });
  loadLogs();
}
function toggleLogFollow() {
  logFollow = !logFollow;
  var b = document.getElementById('logs-follow-btn');
  if (b) b.textContent = logFollow ? '暂停跟随' : '继续跟随';
  if (logFollow) loadLogs();
}
async function loadLogs() {
  var body = document.getElementById('logs-body');
  var empty = document.getElementById('logs-empty');
  if (!body) return;
  try {
    var q = '/api/logs?limit=500';
    if (logChannel !== 'all') q += '&channel=' + encodeURIComponent(logChannel);
    // requestJSON resolves to {ok, status, data}; the payload is under .data.
    var result = await requestJSON(q);
    var d = (result && result.data) || {};
    var entries = d.entries || [];
    if (!entries.length) {
      body.innerHTML = '';
      if (empty) empty.hidden = false;
    } else {
      if (empty) empty.hidden = true;
      body.innerHTML = entries.map(function (e) {
        var t = new Date((e.ts || 0) * 1000);
        var hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
        return '<div class="ln"><span class="lts">' + hh + '</span><i class="lch c-' + escapeHtml(e.ch) + '">' + logChannelLabel(e.ch) + '</i><span>' + escapeHtml(e.text) + '</span></div>';
      }).join('');
      if (logFollow) body.scrollTop = body.scrollHeight;
    }
    var c = document.getElementById('logs-count');
    if (c) c.textContent = entries.length + ' 条';
    var u = document.getElementById('logs-updated');
    if (u) u.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
  } catch (e) {
    if (empty) { empty.hidden = false; empty.textContent = '日志读取失败：' + e.message; }
  }
}
function initLogsAutoRefresh() {
  clearInterval(logTimer);
  logTimer = setInterval(function () {
    var page = document.querySelector('.tab-page[data-page="logs"]');
    if (page && page.classList.contains('active')) loadLogs();
  }, 4000);
}
refreshWebLoginStatus();
initLogsAutoRefresh();
