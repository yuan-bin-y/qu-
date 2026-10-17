/* Read-only real BOSS salary inspection in the isolated Edge test profile.
   No START, job-selection, communication click or message-sending operation. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const [port,endpoint]=fs.readFileSync(path.join(root,'.qa-profile','DevToolsActivePort'),'utf8').trim().split(/\r?\n/);
const override=process.argv.find(arg=>arg.startsWith('--port='))?.slice(7);
let socket;
const ready=(async()=>{const address=override?(await (await fetch('http://127.0.0.1:'+Number(override)+'/json/version')).json()).webSocketDebuggerUrl:'ws://127.0.0.1:'+port+endpoint;socket=new WebSocket(address);return socket;})();
const requests=new Map();let sequence=0;
function request(method,params={},sessionId){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{requests.delete(id);reject(Error('只读检查超时：'+method));},15000);requests.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
ready.then(()=>{socket.onmessage=event=>{const msg=JSON.parse(event.data);if(!msg.id)return;const pending=requests.get(msg.id);if(!pending)return;requests.delete(msg.id);clearTimeout(pending.timer);if(msg.error)pending.reject(Error(msg.error.message));else pending.resolve(msg.result);};});
async function evaluate(sessionId,expression){const result=await request('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
(async()=>{await ready;await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});try{
  const targets=(await request('Target.getTargets')).targetInfos;
  const page=targets.find(t=>t.type==='page'&&/^https:\/\/www\.zhipin\.com\/web\/geek\/jobs?(?:[/?]|$)/.test(t.url));
  if(!page)console.log(JSON.stringify(targets.filter(t=>t.type==='page').map(t=>({title:t.title,path:new URL(t.url).pathname})),null,2));
  assert.ok(page,'真实 BOSS 职位页尚未登录或未打开；不会发送消息');
  let options=targets.find(t=>t.url.startsWith('chrome-extension://')&&t.url.includes('/options.html'));
  if(!options){const created=await request('Target.createTarget',{url:'chrome-extension://dhpdhkdieejbjendkbdjfbphldjpaief/options.html#rules'});options={targetId:created.targetId};await new Promise(resolve=>setTimeout(resolve,500));}
  const ext=(await request('Target.attachToTarget',{targetId:options.targetId,flatten:true})).sessionId;
  let view=(await request('Target.attachToTarget',{targetId:page.targetId,flatten:true})).sessionId;
  const call=(type,extra={})=>evaluate(ext,'chrome.runtime.sendMessage('+JSON.stringify({type,...extra})+')');
  const config=await call('GET_CONFIG');assert.ok(config.ok);assert.equal(config.data.clickApply,false,'只读测试要求关闭点击自动投递');
  const state=await call('GET_STATE');assert.ok(!['running','paused','stopping'].includes(state.data?.status),'测试前请停止任务');
  const tabs=await evaluate(ext,'chrome.tabs.query({})');console.log(tabs.map(t=>({id:t.id,window:t.windowId,path:new URL(t.url).pathname,query:new URL(t.url).searchParams.get('query')})));const tabId=tabs.find(t=>t.url===page.url)?.id;assert.ok(tabId);
  const query=process.argv.find(arg=>arg.startsWith('--query='))?.slice(8);
  if(query){await evaluate(view,'(async()=>{const input=[...document.querySelectorAll("input")].find(e=>e.placeholder==="搜索职位、公司");if(!input)throw Error("搜索框未找到");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify(query)+');input.dispatchEvent(new Event("input",{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,80));document.querySelector("a.search-btn").click();return true;})()');await new Promise(resolve=>setTimeout(resolve,1800));const end=Date.now()+25000;while(Date.now()<end){if(await evaluate(view,'new URL(location.href).searchParams.get("query") === '+JSON.stringify(query)+' && document.readyState === "complete" && document.querySelectorAll("li.job-card-box,.job-card-wrapper").length>0 && '+JSON.stringify(!query.includes('实习'))+' || new URL(location.href).searchParams.get("query") === '+JSON.stringify(query)+' && [...document.querySelectorAll("li.job-card-box .job-name,.job-card-wrapper .job-name")].some(e=>/实习/.test(e.textContent))'))break;await new Promise(resolve=>setTimeout(resolve,400));}}
  await new Promise(resolve=>setTimeout(resolve,1000));
  if(query)assert.equal(await evaluate(view,'new URL(location.href).searchParams.get("query")'),query,'搜索页面尚未就绪');
  await request('Target.detachFromTarget',{sessionId:view});const currentTarget=(await request('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url.startsWith('https://www.zhipin.com/web/geek/jobs'));assert.ok(currentTarget);view=(await request('Target.attachToTarget',{targetId:currentTarget.targetId,flatten:true})).sessionId;
  const raw=await evaluate(view,'({path:location.pathname,title:document.title,query:new URL(location.href).searchParams.get("query"),salaries:[...document.querySelectorAll(".salary,.job-salary")].filter(el=>el.getClientRects().length).map(el=>({raw:el.textContent.trim(),font:getComputedStyle(el).fontFamily})),detailTitle:document.querySelector(".job-detail-header .job-name")?.textContent||""})');
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});await request('Page.bringToFront',{},view);try{const before=await request('Page.captureScreenshot',{format:'png'},view);fs.writeFileSync(path.join(root,'artifacts','real-salary-qa.png'),Buffer.from(before.data,'base64'));}catch(error){console.log('Screenshot unavailable: '+error.message);}
  console.log(JSON.stringify({path:raw.path,rawSalaries:raw.salaries.length}));
  const connected=await call('CONNECT_PAGE',{tabId});assert.ok(connected.ok,connected.error);console.log('Connected in read-only mode');
  const scanned=await evaluate(ext,'chrome.tabs.sendMessage('+tabId+',{type:"SCAN",max:30})');assert.ok(scanned.ok,scanned.error);console.log('Read salary values: '+scanned.data.length);
  assert.ok(scanned.data.length,'真实页面暂无可识别岗位；空列表不能算识别通过');
  console.log('After scan',await evaluate(view,'({query:new URL(location.href).searchParams.get("query"),title:document.querySelector(".job-detail-header .job-name")?.textContent})'));
  const results=scanned.data.map(job=>({title:job.title,salaryRaw:job.salaryRaw||job.salary,salary:job.salary,source:job.salarySource||'page_text',monthlySalary:null}));
  for(const item of results)item.monthlySalary=await evaluate(ext,'BossCore.monthlySalary('+JSON.stringify(item.salary)+',30)');
  console.log('Converted monthly salary values');
  const rendered=await evaluate(ext,'chrome.scripting.executeScript({target:{tabId:'+tabId+'},func:async()=>{await Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,1500))]);return [...document.querySelectorAll(".salary,.job-salary")].filter(e=>e.getClientRects().length).map(e=>({raw:e.textContent.trim(),decoded:BossSalary.read(e),font:getComputedStyle(e).fontFamily}))}}).then(r=>r[0].result)');
  assert.ok(results.every(job=>raw.salaries.some(el=>el.raw===job.salaryRaw)),'列表原始薪资与读取结果不属于同一页面');
  const detail=await evaluate(ext,'chrome.scripting.executeScript({target:{tabId:'+tabId+'},func:'+function(jobs){return (async()=>{
    const root=document.querySelector('.job-detail-box'),salaryNode=root?.querySelector('.job-detail-header .job-salary,.job-detail-header .salary');
    if(!root||!salaryNode)return {skipped:'详情尚未显示'};
    const title=root.querySelector('.job-detail-header .job-name')?.textContent.trim();
    const selected=[...document.querySelectorAll('.job-card-wrap.active,.job-card-wrapper.active,li.job-card-box.active')].flatMap(card=>[...card.querySelectorAll('a[href*="/job_detail/"]')].map(a=>BossCore.jobIdentity(a.href)?.id)).filter(Boolean);
    const candidates=jobs.filter(job=>selected.includes(job.id)&&job.title.replace(/\s/g,'').toLowerCase()===title?.replace(/\s/g,'').toLowerCase());
    if(candidates.length!==1)return {skipped:'当前岗位身份尚未唯一确认',title};
    const token=crypto.randomUUID();root.setAttribute('data-zhixiang-salary',token);
    try{const response=await chrome.runtime.sendMessage({type:'READ_NATIVE_SALARIES',items:[{token,id:candidates[0].id}]});if(!response.ok)throw Error(response.error);const salary=response.data[0].salary||BossSalary.read(salaryNode);return {title,raw:salaryNode.textContent.trim(),salary,monthlySalary:BossCore.monthlySalary(salary,30)};}finally{root.removeAttribute('data-zhixiang-salary');}
  })();}.toString() +',args:'+JSON.stringify([scanned.data])+'}).then(r=>r[0].result)');
  assert.ok(detail.monthlySalary,'真实右侧薪资未确认：'+JSON.stringify(detail));
  const report={detail,rendered,version:await evaluate(ext,'chrome.runtime.getManifest().version'),readOnly:true,workDays:30,raw,results};
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts','real-salary-qa.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(root,'artifacts',raw.query?.includes('实习')?'real-salary-internship.json':'real-salary-monthly.json'),JSON.stringify(report,null,2));
  try{const image=await request('Page.captureScreenshot',{format:'png'},view);fs.writeFileSync(path.join(root,'artifacts','real-salary-qa.png'),Buffer.from(image.data,'base64'));}catch(error){console.log('Screenshot unavailable: '+error.message);}
  const after=await call('GET_STATE');assert.equal(after.data?.sent,state.data?.sent);assert.equal(after.data?.status,state.data?.status);
  console.log(JSON.stringify({version:report.version,readOnly:true,detail,cards:results.length,parsed:results.filter(r=>r.monthlySalary).length,unparsed:results.filter(r=>!r.monthlySalary),examples:results.slice(0,6)},null,2));
}finally{socket.close();}})().catch(error=>{console.error(error.message);socket.close();process.exitCode=1;});
