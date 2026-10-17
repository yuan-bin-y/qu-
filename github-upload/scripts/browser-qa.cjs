/* Synthetic BOSS tests: use a separate, never-logged-in regression profile. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const profileName = process.env.BOSS_EXTENSION_QA_PROFILE || '.qa-regression-profile';
assert.ok(/^\.qa-[a-z0-9-]+-profile$/.test(profileName), 'Mock tests require a dedicated local QA profile');
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
const portFile = fs.readFileSync(path.join(root, profileName, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
const socket = new WebSocket('ws://127.0.0.1:' + portFile[0] + portFile[1]);
const requests = new Map();
let seq = 0;
const fixture = fs.readFileSync(path.join(root, 'tests', 'fixtures', process.argv.includes('--custom-only') ? 'native-chat.html' : 'boss.html'), 'utf8').replace('/* salary-font-fixture */ null', fs.readFileSync(path.join(root, 'tests', 'fixtures', 'salary-fonts.json'), 'utf8'));
const interceptionErrors = [];
const pageSessions = new Map();
const pageErrors = [], pageRequests = [], attachedPages = [];
let intercepted = 0;
function request(method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const pending = requests.get(message.id); requests.delete(message.id);
    if (!pending) return;
    if (message.error) pending.reject(Error(message.error.message)); else pending.resolve(message.result);
  }
  if (message.method === 'Target.attachedToTarget') {
    (async () => {
      const session = message.params.sessionId;
      attachedPages.push({ id: message.params.targetInfo.targetId, url: message.params.targetInfo.url });
      await request('Fetch.enable', { patterns: [{ urlPattern: 'https://www.zhipin.com/*' }] }, session);
      await request('Runtime.enable', {}, session);
      // chrome.tabs.create with openerTabId is a related target of the source
      // page. Intercept its first request too, before unpausing its renderer.
      await request('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }, { exclude: true }] }, session);
      await request('Runtime.runIfWaitingForDebugger', {}, session);
      pageSessions.set(message.params.targetInfo.targetId, session);
    })().catch(e => interceptionErrors.push(e.message));
  }
  if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  if (message.method === 'Fetch.requestPaused') {
    pageRequests.push(message.params.request.url);
    intercepted++;
    request('Fetch.fulfillRequest', {
      requestId: message.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from(fixture).toString('base64')
    }, message.sessionId).catch(e => interceptionErrors.push(e.message));
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function panelText(id, session, click = false) {
  const doc = await request('DOM.getDocument', { depth: -1, pierce: true }, session);
  const find = node => {
    const attributes = node.attributes || [];
    if (attributes.some((value, index) => index % 2 === 0 && value === 'id' && attributes[index + 1] === id)) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const found = find(child); if (found) return found; }
  };
  const node = find(doc.root); assert.ok(node, 'Expected panel field ' + id);
  const object = (await request('DOM.resolveNode', { backendNodeId: node.backendNodeId }, session)).object.objectId;
  const result = await request('Runtime.callFunctionOn', { objectId: object, functionDeclaration: click ? 'function(){this.click();return true}' : 'function(){return this.value || this.textContent}', returnByValue: true }, session);
  return result.result.value;
}
async function poll(fn, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(150); }
  throw Error('Browser condition timed out');
}
(async () => {
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const commandLine = await request('Browser.getBrowserCommandLine');
  assert.ok(commandLine.arguments.some(arg => arg.startsWith('--user-data-dir=') && path.resolve(arg.slice('--user-data-dir='.length)) === path.join(root, profileName)), 'Mock tests require the dedicated empty regression profile; never clear real user history');
  assert.ok(commandLine.arguments.some(arg => arg.includes('MAP www.zhipin.com ~NOTFOUND')), 'Real BOSS DNS must remain blocked');
  const targets = await request('Target.getTargets');
  assert.ok(!targets.targetInfos.some(t => t.type === 'page' && /^https:\/\/www\.zhipin\.com\//.test(t.url)), 'Start the mock browser without real BOSS tabs');
  const installed = Object.entries(JSON.parse(fs.readFileSync(path.join(root, profileName, 'Default', 'Secure Preferences'), 'utf8')).extensions?.settings || {}).find(([, settings]) => settings.path && path.resolve(settings.path) === root)?.[0];
  const optionsTarget = targets.targetInfos.find(t => t.url.startsWith(installed ? 'chrome-extension://' + installed + '/' : 'chrome-extension://') && t.url.includes('/options.html'));
  assert.ok(optionsTarget, 'Open extension options in the isolated Edge session first');
  const ext = (await request('Target.attachToTarget', { targetId: optionsTarget.targetId, flatten: true })).sessionId;
  const evaluate = async code => {
    const response = await request('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true, userGesture: true }, ext);
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const call = (type, extra = {}) => evaluate('chrome.runtime.sendMessage(' + JSON.stringify({ type, ...extra }) + ')');
  const reloadSettings = async () => {
    const token = await evaluate('globalThis.__qaOptionsDocumentToken ||= crypto.randomUUID()');
    await request('Page.reload', { ignoreCache: true }, ext);
    await poll(async () => {
      try { return await evaluate('(globalThis.__qaOptionsDocumentToken || "") !== ' + JSON.stringify(token) + ' && typeof selectTab === "function" && document.getElementById("title-group-list")?.children.length > 0'); }
      catch { return false; }
    });
  };
  const original = await call('GET_CONFIG');
  assert.ok(original.ok, original.error);
  const priorRecords = await call('GET_RECORDS');
  assert.ok(priorRecords.ok && priorRecords.data.every(record => /^fixture-[a-z0-9-]+$/i.test(record.job?.id || '')), 'Regression tests cannot clear non-fixture delivery history');
  let sourceTarget;
  try {
    if (process.argv.includes('--group-toggle-only')) {
      await reloadSettings();
      await request('Emulation.setDeviceMetricsOverride',{width:900,height:1100,deviceScaleFactor:1,mobile:false},ext);
      const expected=[{terms:['后端','开发'],enabled:true},{terms:['Java','实习'],enabled:false}];
      const ui=await evaluate(`(async()=>{
        await selectTab('rules');populate(BossCore.config({titleGroups:[['Java','实习'],['后端','开发'],['Java','实习']],titleMode:'any',blockedWords:''}));
        const rows=()=>[...document.getElementById('title-group-list').children];
        const toggle=index=>rows()[index].querySelector('[data-toggle-title-group]').click();
        dirty=false;toggle(0);
        const preserved=readConfig().titleGroupRules.length===3&&JSON.stringify(readConfig().titleGroupRules[0])===JSON.stringify({terms:['Java','实习'],enabled:false})&&dirty;
        const duplicateStillWorks=BossCore.titleKeywordRule('Java实习',readConfig());
        toggle(2);const onlyEnabled= !BossCore.titleKeywordRule('Java实习',readConfig())&&BossCore.titleKeywordRule('后端开发',readConfig());
        document.getElementById('titleMode').value='all';renderTitleRule();const allEnabledOnly=BossCore.titleKeywordRule('后端开发',readConfig());
        toggle(1);document.getElementById('title-test-input').value='Java后端开发实习';renderTitleRule();
        const allDisabled=!BossCore.filters({title:'Java后端开发实习'},readConfig()).match&&document.getElementById('title-rule-preview').textContent.includes('不匹配任何岗位');
        toggle(1);rows()[0].querySelector('[data-remove-group]').click();
        const deletionKeepsState=JSON.stringify(readConfig().titleGroupRules)===${JSON.stringify(JSON.stringify(expected))};
        document.getElementById('save-config').click();for(let n=0;n<100&&document.getElementById('save-config').disabled;n++)await new Promise(r=>setTimeout(r,20));
        return {preserved,duplicateStillWorks,onlyEnabled,allEnabledOnly,allDisabled,deletionKeepsState};
      })()`);
      for(const [name,value]of Object.entries(ui))assert.equal(value,true,name);
      await reloadSettings();assert.deepEqual(await evaluate('readConfig().titleGroupRules'),expected);
      assert.equal(await evaluate('document.querySelectorAll(".title-group-row.is-disabled").length'),1);
      const desktop=await request('Page.captureScreenshot',{format:'png'},ext);fs.writeFileSync(path.join(root,'artifacts','title-groups-disabled.png'),Buffer.from(desktop.data,'base64'));
      await request('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:1,mobile:false},ext);
      assert.ok(await evaluate('document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth && [...document.querySelectorAll("[data-toggle-title-group]")].every(button=>{const box=button.getBoundingClientRect();return box.width>0&&box.right<=innerWidth;})'));
      const mobile=await request('Page.captureScreenshot',{format:'png'},ext);fs.writeFileSync(path.join(root,'artifacts','title-groups-disabled-mobile.png'),Buffer.from(mobile.data,'base64'));
      console.log('PASS Edge group toggles: preserved terms, independent duplicate states, any/all matching, all-disabled rejection, deletion, save/reload and compact controls');
      await request('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'page'},{exclude:true}]});
      sourceTarget=(await request('Target.createTarget',{url:'about:blank'})).targetId;const session=await poll(()=>pageSessions.get(sourceTarget));
      await request('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false},session);
      const view=async expression=>{const r=await request('Runtime.evaluate',{expression,returnByValue:true},session);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
      const url='https://www.zhipin.com/web/geek/jobs';await request('Page.navigate',{url},session);await poll(()=>view('window.__fixtureDocumentToken'));
      const tabId=(await evaluate('chrome.tabs.query({url:"https://www.zhipin.com/web/geek/jobs*"})'))[0].id;
      for(const enabled of [false,true]){
        await view('sessionStorage.setItem("fixture-mode","title-groups");sessionStorage.setItem("fixture-title","Java实习");true');
        await request('Page.navigate',{url},session);await poll(()=>view('window.__fixtureDocumentToken'));await call('CLEAR_RECORDS');
        assert.ok((await call('SAVE_CONFIG',{config:{...original.data,titleGroupRules:[{terms:['Java','实习'],enabled}],greetingMode:'boss_default',blockedWords:'',blockedCompanies:'',cities:'',education:[],experience:[],salaryMin:0,salaryMax:0,hrMaxDays:0,maxJobs:1,maxScan:1,intervalSeconds:3}})).ok);
        const started=await call('START',{tabId});
        if(!enabled){assert.equal(started.ok,false);assert.match(started.error,/所有标题关键词组已停用/);assert.equal(await view('window.__fixtureCommunications||0'),0);console.log('PASS Edge all groups disabled: refused before scanning');continue;}
        assert.ok(started.ok,started.error);const state=await poll(async()=>{const s=(await call('GET_STATE')).data;return ['completed','error'].includes(s.status)?s:null;});
        assert.equal(state.status,'completed',state.message);assert.equal(state.sent,1);assert.equal(await view('window.__fixtureCommunications||0'),1);
        console.log('PASS Edge group restored: confirmed='+state.sent);
      }
      assert.equal(interceptionErrors.length,0,interceptionErrors.join('; '));console.log('All BOSS requests intercepted locally; no real access or messages.');return;
    }
    if (process.argv.includes('--custom-only')) {
      await reloadSettings();
      const template='您好，{company}，我想了解{title}岗位。';
      await request('Emulation.setDeviceMetricsOverride',{width:900,height:1100,deviceScaleFactor:1,mobile:false},ext);
      const ui=await evaluate(`(async()=>{
        await selectTab('rules');populate(BossCore.config({greetingMode:'custom',greetingTemplate:${JSON.stringify(template)}}));
        const input=document.getElementById('greetingTemplate'),fields=document.getElementById('custom-greeting-fields'),mode=document.getElementById('greetingMode');
        const customVisible=!fields.hidden&&document.getElementById('greeting-editor').getAttribute('aria-required')==='true'&&!input.disabled&&input.maxLength===300;
        mode.value='boss_default';mode.dispatchEvent(new Event('change',{bubbles:true}));
        const defaultHidden=fields.hidden&&!input.required&&input.disabled;
        mode.value='custom';mode.dispatchEvent(new Event('change',{bubbles:true}));
        document.getElementById('save-config').click();for(let n=0;n<100&&document.getElementById('save-config').disabled;n++)await new Promise(r=>setTimeout(r,20));
        return {customVisible,defaultHidden,mode:readConfig().greetingMode,template:readConfig().greetingTemplate};
      })()`);
      assert.deepEqual(ui,{customVisible:true,defaultHidden:true,mode:'custom',template});
      await reloadSettings();assert.equal(await evaluate('readConfig().greetingMode'),'custom');assert.equal(await evaluate('readConfig().greetingTemplate'),template);
      await evaluate('document.getElementById("greetingMode").scrollIntoView({block:"center"});true');
      const shot=await request('Page.captureScreenshot',{format:'png'},ext);fs.writeFileSync(path.join(root,'artifacts','custom-greeting-settings.png'),Buffer.from(shot.data,'base64'));
      await request('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:1,mobile:false},ext);
      await evaluate('document.getElementById("greetingMode").scrollIntoView({block:"start"});true');
      assert.ok(await evaluate('document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth'));
      const compact=await request('Page.captureScreenshot',{format:'png'},ext);fs.writeFileSync(path.join(root,'artifacts','custom-greeting-settings-mobile.png'),Buffer.from(compact.data,'base64'));
      console.log('PASS Edge custom settings: mode selection, required text, 300-character limit, save/reload and compact layout');
      let cityBindingUi = null;
      if(process.argv.includes('--city-binding-ui'))cityBindingUi=await require('./city-binding-ui-qa.cjs')({evaluate,request,ext,reloadSettings,root});
      if(process.argv.includes('--speed-settings-ui'))await require('./speed-settings-ui-qa.cjs')({evaluate,request,ext,reloadSettings,root});
      await request('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'page'},{exclude:true}]});
      sourceTarget=(await request('Target.createTarget',{url:'about:blank'})).targetId;const session=await poll(()=>pageSessions.get(sourceTarget));
      await request('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false},session);
      const view=async expression=>{const r=await request('Runtime.evaluate',{expression,returnByValue:true},session);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
      const url='https://www.zhipin.com/web/geek/jobs';await request('Page.navigate',{url},session);await poll(()=>view('window.__fixtureDocumentToken'));
      const tabId=(await evaluate('chrome.tabs.query({url:"https://www.zhipin.com/web/geek/jobs*"})'))[0].id;
      const deliveryView=async expression=>{
        const targets=(await request('Target.getTargets')).targetInfos;
        const target=targets.find(t=>t.type==='page'&&t.url.startsWith('https://www.zhipin.com/')&&(t.url.includes('/job_detail/')||t.url.includes('/web/geek/chat')));
        if(!target)return null;const attached=await poll(()=>pageSessions.get(target.targetId));
        const r=await request('Runtime.evaluate',{expression,returnByValue:true},attached);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;
      };
      const tabsBefore=await evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id).sort())');
      for(const scenario of [
        {mode:'native-follow-speed-quick',sent:1,maxScan:6,browseIntervalSeconds:0.2,intervalSeconds:1,timeout:30000},
        {mode:'native-follow-speed-quick-slow',sent:1,maxScan:6,browseIntervalSeconds:0.2,intervalSeconds:1,timeout:35000},
        {mode:'native-follow-speed-wrong-detail',sent:1,maxScan:6,browseIntervalSeconds:0.2,intervalSeconds:1,wrongDetail:true,timeout:45000},
        {mode:'native-follow-speed-default',sent:1,maxScan:6,browseIntervalSeconds:2,intervalSeconds:5,timeout:40000},
        {mode:'native-follow-speed-slow',sent:1,maxScan:6,browseIntervalSeconds:2,intervalSeconds:5,timeout:40000},
        {mode:'native-speed-greetings',sent:3,maxScan:3,browseIntervalSeconds:1,intervalSeconds:7,timeout:60000},
        {mode:'native-follow-filtered',sent:1,maxScan:6,timeout:50000},
        {mode:'native-follow-slow',sent:1,maxScan:6,timeout:55000},
        {mode:'native-follow-preview',sent:0,maxScan:3,preview:true,timeout:25000},
        {mode:'native-city-hefei',sent:2,cityFilters:'杭州,合肥'},
        {mode:'native-city-batch',sent:2}, {mode:'native-city-unknown',sent:0,error:true,beforeContact:true}, {mode:'native-city-conflict',sent:0,error:true,beforeContact:true},
        {mode:'native-list-reset',sent:2,maxScan:200,timeout:90000},
        {mode:'native-list-virtual',sent:2,maxScan:200,timeout:90000},
        {mode:'native-list-reorder',sent:2},
        {mode:'native-list-exhausted',sent:1,targetJobs:2},
        {mode:'native-list-pause',sent:2,maxScan:200,timeout:90000,catchupAction:'PAUSE'},
        {mode:'native-list-stop',sent:1,targetJobs:2,maxScan:200,timeout:90000,catchupAction:'STOP'},
        {mode:'native-receipt-delivered',sent:1}, {mode:'native-receipt-batch',sent:2},
        {mode:'native-receipt-editor-rerender',sent:1}, {mode:'native-receipt-reused-node',sent:1},
        {mode:'native-receipt-opaque',sent:1,proof:'native_editor_cleared'},
        {mode:'native-receipt-opaque-pending',sent:0,error:true,texts:1},
        {mode:'native-receipt-failed',sent:0,error:true,texts:1}, {mode:'native-receipt-opaque-failed',sent:0,error:true,texts:1},
        {mode:'native-receipt-no-clear',sent:0,error:true,texts:1}, {mode:'native-receipt-default-before',sent:0,error:true,defaults:1},
        {mode:'native-direct',sent:1}, {mode:'native-nav-assign',sent:1}, {mode:'native-nav-async-open',sent:1}, {mode:'native-nav-history',sent:1}, {mode:'native-nav-plain',sent:1}, {mode:'native-nav-anchor-plain',sent:1}, {mode:'native-route',sent:1}, {mode:'native-window-open',sent:1},
        {mode:'native-boss-only',sent:1}, {mode:'native-secondary',sent:1}, {mode:'native-batch',sent:3},
        {mode:'native-preserved-incremental',sent:3,maxScan:1}, {mode:'native-steady-five',sent:5,maxScan:2,timeout:90000},
        {mode:'native-source-reset',sent:1,targetJobs:2,error:true,sourceReset:true,confirmedError:true},
        {mode:'native-status-name',sent:1}, {mode:'native-split-pane',sent:1},
        {mode:'native-reference-no-header',sent:1}, {mode:'native-reference-textarea',sent:1},
        {mode:'native-reference-enter',sent:1}, {mode:'native-reference-split-editor',sent:1},
        {mode:'native-reference-keypress',sent:1},
        {mode:'native-reference-stale-vue',sent:1},
        {mode:'native-reference-default',sent:0,error:true,defaults:1},
        {mode:'native-reference-ambiguous',sent:0,error:true}, {mode:'native-reference-disabled',sent:0,error:true},
        {mode:'native-default',sent:0,error:true,defaults:1}, {mode:'native-same-default',sent:0,error:true,defaults:1},
        {mode:'native-late-default',sent:0,error:true,defaults:1}, {mode:'native-draft',sent:0,error:true},
        {mode:'native-pending',sent:0,error:true,texts:1}, {mode:'native-reload',sent:0,error:true,texts:1},
        {mode:'native-stop',sent:0,stop:true}, {mode:'native-pause',sent:1,pause:true}, {mode:'native-preview',sent:0,preview:true}
      ].filter(scenario=>!process.env.BOSS_QA_CUSTOM_CASES||process.env.BOSS_QA_CUSTOM_CASES.split(',').includes(scenario.mode))){
        const oldToken=await view('window.__fixtureDocumentToken');
        await view('localStorage.setItem("fixture-mode",'+JSON.stringify(scenario.mode)+');localStorage.removeItem("native-metrics");localStorage.removeItem("native-active-job");true');
        await request('Page.navigate',{url},session);await poll(async()=>{try{return await view('window.__fixtureDocumentToken && window.__fixtureDocumentToken !== '+JSON.stringify(oldToken));}catch{return false;}});
        await call('CLEAR_RECORDS');
        const messageTemplate=scenario.mode==='native-city-hefei'?(cityBindingUi?.personalGreeting||'您好，我想了解开发实习岗位，{city}有常住地。'):scenario.mode.startsWith('native-city-')?'您好，{company}，我关注{title}，{city}有常住地。':scenario.mode.startsWith('native-receipt-')?'您好，{company}，我对{title}感兴趣，熟悉 Spring Boot / MySQL / Redis，希望进一步沟通。':template;
        assert.ok((await call('SAVE_CONFIG',{config:{...original.data,greetingMode:'custom',greetingTemplate:messageTemplate,clickApply:false,titleGroups:[['Java']],titleGroupRules:null,titleMode:'any',blockedWords:'',blockedCompanies:'',cities:scenario.cityFilters||'',education:[],experience:[],salaryMin:0,salaryMax:0,hrMaxDays:0,maxJobs:scenario.targetJobs||scenario.sent||1,maxScan:scenario.maxScan||scenario.sent||1,browseIntervalSeconds:scenario.browseIntervalSeconds??3,intervalSeconds:scenario.intervalSeconds??3}})).ok);
        assert.ok((await call('START',{tabId,preview:scenario.preview})).ok);
        const runId=(await call('GET_STATE')).data.id;
        const sourceDocument=await view('window.__fixtureDocumentToken');
        if(scenario.followControl){
          await poll(async()=>((await call('GET_STATE')).data.scanned||0)===1);
          assert.ok((await call(scenario.followControl)).ok);
          const before=await view('({selected:JSON.parse(localStorage.getItem("native-metrics")).sourceSelections,detail:document.querySelector(".job-detail-box").dataset.jobId,scroll:scrollY})');
          await sleep(1200);
          assert.deepEqual(await view('({selected:JSON.parse(localStorage.getItem("native-metrics")).sourceSelections,detail:document.querySelector(".job-detail-box").dataset.jobId,scroll:scrollY})'),before,'Pause/stop must freeze native selection and scroll during a rejected job interval');
          if(scenario.followControl==='PAUSE')assert.ok((await call('RESUME')).ok);
        }
        if(process.argv.includes('--highlight-ui')&&scenario.mode==='native-batch'){
          const id=await poll(()=>view('document.querySelector("[data-zhixiang-current]")?.getAttribute("data-zhixiang-current")'));
          assert.ok((await call('PAUSE')).ok);
          const before=await view('({scroll:scrollY,clicks:JSON.parse(localStorage.getItem("native-metrics")).clicks})');
          await view('(()=>{const card=document.querySelector("[data-zhixiang-current]");window.__qaOriginalCard=card;const copy=card.cloneNode(true);copy.removeAttribute("data-zhixiang-current");card.replaceWith(copy);return true;})()');
          await poll(()=>view('document.querySelector("[data-zhixiang-current]")?.getAttribute("data-zhixiang-current")==='+JSON.stringify(id)));
          assert.deepEqual(await view('({scroll:scrollY,clicks:JSON.parse(localStorage.getItem("native-metrics")).clicks})'),before,'Restoring a highlight must not scroll or communicate');
          await view('document.querySelector("[data-zhixiang-current]").replaceWith(window.__qaOriginalCard);delete window.__qaOriginalCard;true');
          await poll(()=>view('document.querySelector("[data-zhixiang-current]")?.getAttribute("data-zhixiang-current")==='+JSON.stringify(id)));
          assert.ok((await call('RESUME')).ok);
          console.log('PASS Edge highlight: regenerated card restores the same ID without scrolling or communicating');
        }
        if(scenario.catchupAction){
          await poll(async()=>{const state=(await call('GET_STATE')).data;return state.sent===1;},scenario.timeout);
          assert.ok((await call(scenario.catchupAction)).ok);await sleep(2000);
          if(scenario.catchupAction==='PAUSE')assert.equal((await call('GET_STATE')).data.status,'paused');
          assert.equal((await call('GET_STATE')).data.sent,1);
          assert.equal(await view('JSON.parse(localStorage.getItem("native-metrics")).texts.length'),1);
          if(scenario.catchupAction==='PAUSE')assert.ok((await call('RESUME')).ok);
        }
        if(scenario.stop||scenario.pause){
          await poll(()=>deliveryView('window.__fixtureChatLoaded'));
          assert.ok((await call('PAUSE')).ok);await sleep(2300);
          assert.deepEqual(await view('JSON.parse(localStorage.getItem("native-metrics")).texts'),[]);
          assert.ok((await call(scenario.stop?'STOP':'RESUME')).ok);
        }
        const state=await poll(async()=>{const s=(await call('GET_STATE')).data;return ['completed','error','stopped'].includes(s.status)?s:null;},scenario.timeout||40000);
        if(state.status==='error'&&!scenario.error)console.log('Local browser failure diagnostics',JSON.stringify({state,pageErrors,pageRequests,attachedPages}));
        assert.equal(state.status,scenario.stop||scenario.catchupAction==='STOP'||scenario.followControl==='STOP'?'stopped':scenario.error?'error':'completed',state.message);assert.equal(state.sent,scenario.sent,scenario.mode);
        assert.equal(state.id,runId,'Returning to the list must continue the same run');
        if(['native-status-name','native-wrong-text-hr','native-split-pane','native-split-wrong-hr'].includes(scenario.mode))assert.equal(state.pendingDelivery.recipient.name,'测试招聘者','Activity/VIP badges must never become the recruiter name');
        const actual=await view('({...JSON.parse(localStorage.getItem("native-metrics")),url:location.href,topLevel:window.top===window})');
        actual.draft=await deliveryView('document.getElementById("chat-input")?.innerText');
        assert.equal((await view('window.__fixtureDocumentToken'))===sourceDocument,!scenario.sourceReset,'The controller never replaces the original list');
        assert.equal(actual.sourceVisits,scenario.sourceReset?2:1,'No automatic list reopening');
        assert.equal(actual.url,url);
        assert.equal(actual.topLevel,true);assert.equal(actual.defaults,scenario.defaults||0);
        assert.equal(actual.texts.length,scenario.texts??scenario.sent,scenario.mode);if(scenario.preview)assert.equal(actual.clicks,0);
        assert.equal(actual.enterSends||0,['native-reference-enter','native-reference-keypress'].includes(scenario.mode)?1:0,'No Enter retry after a button click');
        assert.equal(actual.detailVisits||0,0,'Never open an extra job detail page');
        if(scenario.sent){assert.equal(state.queuePosition,state.scanned);assert.ok(state.trace.some(e=>e.event==='send_complete'));assert.equal(actual.url,url,'Return to the same source list');assert.equal(actual.chatVisits,scenario.sent);assert.equal(actual.clicks,scenario.sent);}
        if(scenario.mode==='native-draft')assert.equal(actual.draft,'用户已有的草稿，请保留');
        const records=(await call('GET_RECORDS')).data,sent=records.filter(r=>r.status==='sent');assert.equal(sent.length,scenario.sent);
        assert.equal(new Set(sent.map(record=>record.job.id)).size,sent.length,'No duplicate greetings');
        if(scenario.mode.startsWith('native-follow-')){
          const expected=scenario.preview?[]:['fixture-follow-5'];
          const views=actual.selectionViews||[];
          assert.deepEqual(actual.sourceSelections||[],expected,'Rejected cards must not be clicked');
          assert.deepEqual(views.map(item=>item.id),expected);
          for(const item of views){
            if(scenario.wrongDetail)assert.notEqual(item.detailId,item.id);else assert.equal(item.detailId,item.id);
            assert.equal(item.highlightId,item.id);
            assert.ok(item.top>=75&&item.bottom<=item.viewport-24);
            if(scenario.mode.includes('slow'))assert.ok(item.renderedAt-item.at>=650);
          }
          const rejected=scenario.preview?3:5;
          assert.equal(records.filter(record=>record.status==='filtered').length,rejected);
          assert.ok(records.filter(record=>record.status==='filtered').every(record=>record.reason.includes('标题关键词组不匹配')&&!record.job.description));
          assert.equal(state.trace.filter(item=>item.event==='card_filtered').length,rejected);
          assert.equal(state.trace.filter(item=>item.event==='display_ready').length,0);
          if(scenario.sent)assert.deepEqual(sent.map(record=>record.job.id),['fixture-follow-5']);
          if(scenario.wrongDetail){assert.equal(actual.clicks,0);assert.equal(actual.texts.length,0);assert.match(state.message,/岗位标识/);}
          fs.writeFileSync(path.join(root,'artifacts',scenario.mode+'-metrics.json'),JSON.stringify({state,actual},null,2));
          const screenshot=await request('Page.captureScreenshot',{format:'png'},session);fs.writeFileSync(path.join(root,'artifacts',scenario.mode+'.png'),Buffer.from(screenshot.data,'base64'));
          console.log('PASS Edge card-first: '+rejected+' local rejects, '+views.length+' native candidate details');
        }
        if(scenario.mode==='native-speed-greetings'){
          assert.equal(actual.communicationsAt.length,3);assert.equal(actual.textSentAt.length,3);
          for(let i=1;i<3;i++)assert.ok(actual.communicationsAt[i]-actual.textSentAt[i-1]>=6900,'A fast browse setting cannot bypass the separately configured greeting interval');
          fs.writeFileSync(path.join(root,'artifacts','speed-settings-greeting-metrics.json'),JSON.stringify({state,actual},null,2));
          console.log('PASS Edge greeting speed: browse=1s, greeting=7s, three confirmed messages with independent cooldown');
        }
        if(scenario.mode==='native-list-reset'||scenario.mode==='native-list-virtual'||scenario.mode==='native-list-pause'){
          assert.deepEqual(sent.map(record=>record.job.id).sort(),['fixture-140','fixture-141']);
          assert.equal(actual.reloadBatches||0,0,'Sending must not reload any already loaded batches');
          assert.equal(actual.detailVisits||0,0);assert.equal(state.completionReason,'target');
          assert.equal(state.scanned,142,'Previously filtered jobs are never analyzed again');
          const screenshot=await request('Page.captureScreenshot',{format:'png'},session);fs.writeFileSync(path.join(root,'artifacts',scenario.mode+'-complete.png'),Buffer.from(screenshot.data,'base64'));
        }
        if(scenario.mode==='native-list-reorder')assert.deepEqual(sent.map(record=>record.job.id).sort(),['fixture-1','fixture-123']);
        if(scenario.mode==='native-list-exhausted'){assert.equal(state.completionReason,'list_exhausted');assert.match(state.message,/1 \/ 2/);}
        if(scenario.catchupAction==='STOP')assert.equal(records.some(record=>record.status==='uncertain'),false,'A confirmed greeting remains confirmed when stopping list recovery');
        if(scenario.mode.startsWith('native-receipt-')&&scenario.sent)assert.ok(sent.every(r=>r.deliveryProof===(scenario.proof||'outgoing_message')),'Receipt proof must distinguish rendered text from native editor feedback');
        assert.ok(sent.every(r=>r.deliveryKind==='custom'&&actual.texts.includes(r.greeting)&&(scenario.mode==='native-city-hefei'||r.greeting.includes(r.job.company)&&r.greeting.includes(r.job.title))));
        if(scenario.mode==='native-city-hefei'){
          const expected=messageTemplate.replace('{city}','杭州');assert.equal(actual.texts[0],expected);
          assert.equal(actual.texts[1],messageTemplate.replace('{city}','合肥'));
          assert.equal(actual.texts[1].includes('杭州有常住地'),false);
        }
        if(scenario.error)assert.ok(records.some(r=>r.status===(scenario.beforeContact||scenario.confirmedError?'error':'uncertain')));
        if(scenario.sourceReset){assert.ok(state.trace.some(e=>e.event==='source_changed'));assert.match(state.message,/不会从首屏重新扫描/);assert.equal(actual.texts.length,1);assert.equal(records.some(r=>r.status==='uncertain'),false);}
        if(scenario.sourceReset){
          await evaluate('chrome.scripting.executeScript({target:{tabId:'+tabId+'},func:()=>{if(navigator.clipboard)Object.defineProperty(navigator.clipboard,"writeText",{configurable:true,value:async()=>{throw Error("Local QA clipboard fallback");}});}})');
          await panelText('diagnostics',session,true);
          const diagnostic=await poll(async()=>{const text=await panelText('diagnostic-text',session);try{return JSON.parse(text);}catch{return null;}});
          assert.equal(diagnostic.version,state.version);assert.equal(diagnostic.contentVersion,state.version);assert.equal(diagnostic.runVersion,state.version);
          assert.equal(diagnostic.progress.sourceTabId,tabId);assert.equal(diagnostic.progress.queuePosition,1);assert.notEqual(diagnostic.progress.sourcePageId,diagnostic.progress.currentPageId);
          assert.ok(diagnostic.trace.some(e=>e.event==='source_changed'));
          fs.writeFileSync(path.join(root,'artifacts','stable-controller-source-diagnostic.json'),JSON.stringify(diagnostic,null,2));
          console.log('PASS Edge live diagnostics: versions, source/chat tabs, changed page instance and queue cursor, without using the system clipboard');
        }
        if(scenario.mode==='native-nav-async-open')assert.ok(state.trace.some(e=>e.event==='chat_open'&&e.method==='window.open'));
        if(scenario.beforeContact){assert.equal(actual.clicks,0);assert.match(state.message,scenario.wrongDetail?/岗位标识/:/城市|地点/);}
        if(scenario.mode==='native-city-batch'){
          assert.ok(actual.texts[0].includes('杭州有常住地'));assert.ok(actual.texts[1].includes('苏州有常住地'));
          assert.ok(actual.texts.every(text=>!text.includes('{city}')));
        }
        if(scenario.defaults){
          assert.match(state.message,/关闭 BOSS/);assert.ok(records[0].observedGreeting,'Keep the actual auto-greeting as evidence');
          const ax=await request('Accessibility.getFullAXTree',{},session);assert.ok(ax.nodes.some(node=>!node.ignored&&node.role?.value==='alert'),'Auto-greeting stop must have a visible alert');
          if(scenario.mode==='native-same-default')assert.match(state.message,/内容与插件文案相同/);
          if(scenario.mode==='native-default'){const screenshot=await request('Page.captureScreenshot',{format:'png'},session);fs.writeFileSync(path.join(root,'artifacts','greeting-guard-stopped.png'),Buffer.from(screenshot.data,'base64'));}
        }
        if(state.reviewTabId&&state.reviewTabId!==tabId){
          assert.ok(!tabsBefore.includes(state.reviewTabId),'Only the temporary chat page may be retained for review');
          assert.equal((await evaluate('chrome.tabs.get('+state.reviewTabId+')')).id,state.reviewTabId);
          await evaluate('chrome.tabs.remove('+state.reviewTabId+')');
        }
        assert.deepEqual(await evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id).sort())'),tabsBefore);
        console.log('PASS Edge '+scenario.mode+': preserved list=1, full-page visits='+actual.chatVisits+', custom clicks='+actual.texts.length+', confirmed='+state.sent+', '+state.status);
      }
      assert.equal(interceptionErrors.length,0,interceptionErrors.join('; '));console.log('All BOSS requests intercepted locally; no real account, messages or external API calls.');return;
    }
    if (process.argv.includes('--settings-only')) {
      await reloadSettings();
      const blockedWords='外派,付费培训,收费培训,包就业,招生顾问,课程顾问,电话销售';
      await request('Emulation.setDeviceMetricsOverride',{width:900,height:1100,deviceScaleFactor:1,mobile:false},ext);
      const ui=await evaluate(`(async()=>{
        await selectTab('rules');
        populate(BossCore.config({titleGroups:[['Java','实习']],titleMode:'any',blockedGroups:[['外派'],['付费培训'],['收费培训'],['包就业'],['招生顾问'],['课程顾问'],['电话销售']],cities:'北京市，杭州;自定义区',}));
        const legacy=document.getElementById('blockedWords').value;
        const blockedInputs=()=>[...document.querySelectorAll('#blocked-word-list [data-blocked-word]')];
        const oneArea=document.querySelectorAll('.blocked-word-editor').length===1&&!document.querySelector('.blocked-word-editor fieldset')&&!document.getElementById('blocked-group-list')&&!document.getElementById('blockedMode');
        const loadedTokens=blockedInputs().map(el=>el.value).join(',')===legacy&&blockedInputs().every(el=>el.getAttribute('aria-label'));
        const localOnly=!chrome.runtime.getManifest().optional_host_permissions;
        dirty=false;blockedInputs()[0].value='外包';blockedInputs()[0].dispatchEvent(new Event('input',{bubbles:true}));
        const edit=readConfig().blockedWords.startsWith('外包,')&&dirty;
        document.getElementById('add-blocked-word').click();const added=blockedInputs().at(-1);added.value='面试收费';added.dispatchEvent(new Event('input',{bubbles:true}));
        const add=blockedInputs().length===8&&document.activeElement===added&&readConfig().blockedWords.endsWith(',面试收费');
        added.nextElementSibling.click();const remove=blockedInputs().length===7&&!readConfig().blockedWords.includes('面试收费');
        const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});blockedInputs().at(-1).dispatchEvent(enter);
        const blankIgnored=enter.defaultPrevented&&blockedInputs().length===8&&BossCore.words(readConfig().blockedWords).length===7;
        while(blockedInputs().length>1||blockedInputs()[0].value)blockedInputs()[0].nextElementSibling.click();
        const clear=readConfig().blockedWords===''&&readConfig().blockedGroups===null;
        document.getElementById('save-config').click();for(let n=0;n<100&&document.getElementById('save-config').disabled;n++)await new Promise(r=>setTimeout(r,20));
        const cleared=(await chrome.runtime.sendMessage({type:'GET_CONFIG'})).data;
        populateBlockedWords(BossCore.words(cleared.blockedWords));
        const clearSaved=cleared.blockedWords===''&&blockedInputs().length===1&&blockedInputs()[0].value==='';
        populateBlockedWords(BossCore.words(${JSON.stringify(blockedWords)}));blockedWordsChanged();
        const initialCities=selectedCities().length;
        document.getElementById('open-city-picker').click();
        const tabs=[...document.querySelectorAll('#city-tabs [data-city-tab]')].map(el=>el.textContent);
        const allCount=document.querySelectorAll('#city-picker-results [data-city]').length;
        const noTiers=!document.body.textContent.includes('一线')&&!document.body.textContent.includes('二线')&&!document.body.textContent.includes('三线');
        document.querySelector('[data-city-tab="hot"]').click();
        const hot=[...document.querySelectorAll('#city-picker-results [data-city]')].map(el=>el.dataset.city);
        const nationwideFirst=document.querySelector('#city-picker-results button').textContent==='全国';
        document.querySelector('[data-city-unlimited]').click();
        const draftOnly=cityDraft.length===0&&document.getElementById('cities').value==='北京市，杭州;自定义区';
        const covered=[];let correctLetters=true;
        for(const letters of ['ABCDE','FGHJ','KLMN','PQRST','WXYZ']){
          document.querySelector('[data-city-tab="'+letters+'"]').click();
          const shown=[...document.querySelectorAll('#city-picker-results [data-city]')].map(el=>el.dataset.city);covered.push(...shown);
          correctLetters=correctLetters&&shown.every(city=>letters.includes(BossCities.pinyin[city][0].toUpperCase()));
        }
        const letterMatch=Boolean(document.querySelector('[data-city="西安"]'))&&Boolean(document.querySelector('[data-city="武汉"]'))&&!document.querySelector('[data-city="北京"]');
        document.querySelector('[data-city-tab="ABCDE"]').click();document.getElementById('select-visible-cities').click();const bulkCount=cityDraft.length;
        document.getElementById('select-visible-cities').click();const bulkUnique=cityDraft.length===bulkCount&&cityDraft.includes('北京')&&cityDraft.includes('成都');
        document.getElementById('cancel-city-picker').click();const cancel=document.getElementById('cities').value==='北京市，杭州;自定义区';
        document.getElementById('open-city-picker').click();document.querySelector('[data-city-tab="hot"]').click();document.querySelector('[data-city-unlimited]').click();document.getElementById('confirm-city-picker').click();
        const nationwideSaved=readConfig().cities===''&&selectedCities().length===0;
        document.getElementById('open-city-picker').click();const search=document.getElementById('city-search');
        search.value='wulumuqi';search.dispatchEvent(new Event('input'));const pinyin=Boolean(document.querySelector('[data-city="乌鲁木齐"]'))&&document.querySelectorAll('#city-picker-results [data-city]').length===1;
        document.querySelector('[data-city="乌鲁木齐"]').click();search.value='taizhou';search.dispatchEvent(new Event('input'));
        const bothTaizhou=Boolean(document.querySelector('[data-city="台州"]'))&&Boolean(document.querySelector('[data-city="泰州"]'));
        search.value='';search.dispatchEvent(new Event('input'));document.querySelector('[data-city-tab="hot"]').click();document.querySelector('[data-city="北京"]').click();document.querySelector('[data-city="上海"]').click();
        document.querySelector('[data-city-tab="KLMN"]').click();document.querySelector('[data-city="兰州"]').click();document.getElementById('confirm-city-picker').click();
        document.querySelector('[aria-label="移除兰州"]').click();document.getElementById('cities').value+=',杭州,自定义区';document.getElementById('cities').dispatchEvent(new Event('input',{bubbles:true}));
        document.getElementById('save-config').click();for(let n=0;n<100&&document.getElementById('save-config').disabled;n++)await new Promise(r=>setTimeout(r,20));
        const saved=(await chrome.runtime.sendMessage({type:'GET_CONFIG'})).data;
        return {legacy,oneArea,loadedTokens,localOnly,edit,add,remove,blankIgnored,clear,clearSaved,initialCities,tabs,allCount,noTiers,hot,nationwideFirst,draftOnly,correctLetters,coverage:covered.length,unique:new Set(covered).size,letterMatch,bulkUnique,cancel,nationwideSaved,pinyin,bothTaizhou,saved:{blockedWords:saved.blockedWords,blockedGroups:saved.blockedGroups,cities:BossCore.words(saved.cities)}};
      })()`);
      for(const [name,value]of Object.entries(ui))if(!['legacy','tabs','hot','saved','initialCities','allCount','coverage','unique'].includes(name))assert.equal(value,true,name);
      assert.equal(ui.legacy,blockedWords);assert.equal(ui.initialCities,3);assert.equal(ui.allCount,119);assert.equal(ui.coverage,119);assert.equal(ui.unique,119);
      assert.deepEqual(ui.tabs,['全部','热门城市','ABCDE','FGHJ','KLMN','PQRST','WXYZ']);
      assert.deepEqual(ui.hot,['北京','上海','广州','深圳','杭州','天津','西安','苏州','武汉','厦门','长沙','成都','郑州','重庆']);
      assert.equal(ui.saved.blockedWords,blockedWords);assert.equal(ui.saved.blockedGroups,null);assert.equal(ui.saved.cities.length,5);
      assert.ok(ui.saved.cities.includes('乌鲁木齐')&&ui.saved.cities.includes('自定义区')&&!ui.saved.cities.includes('兰州')&&!ui.saved.cities.includes('全国'));
      await reloadSettings();assert.equal(await evaluate('document.getElementById("blockedWords").value'),blockedWords);assert.equal(await evaluate('selectedCities().length'),5);
      assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-blocked-word]")].map(el=>el.value)'),blockedWords.split(','));
      await evaluate('document.getElementById("blocked-word-list").scrollIntoView({block:"center"});true');
      const box=await request('Page.captureScreenshot',{format:'png'},ext);fs.writeFileSync(path.join(root,'artifacts','blocked-word-tokens.png'),Buffer.from(box.data,'base64'));
      await request('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:1,mobile:false},ext);
      await evaluate('document.getElementById("blocked-word-list").scrollIntoView({block:"center"});true');
      assert.ok(await evaluate('document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth && [...document.querySelectorAll("[data-blocked-word]")].every(input=>input.getBoundingClientRect().width>=80 && input.parentElement.getBoundingClientRect().right<=innerWidth)'),'Blocked-word inputs overflow or are too narrow');
      const tokensCompact=await request('Page.captureScreenshot',{format:'png'},ext);fs.writeFileSync(path.join(root,'artifacts','blocked-word-tokens-mobile.png'),Buffer.from(tokensCompact.data,'base64'));
      await request('Emulation.setDeviceMetricsOverride',{width:900,height:1100,deviceScaleFactor:1,mobile:false},ext);
      await evaluate('document.getElementById("open-city-picker").click();document.querySelector("[data-city-tab=hot]").click();true');
      const hotShot=await request('Page.captureScreenshot',{format:'png'},ext);fs.writeFileSync(path.join(root,'artifacts','city-hot-letters.png'),Buffer.from(hotShot.data,'base64'));
      await request('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:1,mobile:false},ext);
      assert.ok(await evaluate('document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth && document.getElementById("city-picker").getBoundingClientRect().bottom <= innerHeight'),'City picker overflows');
      const compact=await request('Page.captureScreenshot',{format:'png'},ext);fs.writeFileSync(path.join(root,'artifacts','city-hot-letters-mobile.png'),Buffer.from(compact.data,'base64'));
      await evaluate('document.getElementById("close-city-picker").click();true');
      console.log('PASS Edge settings: one area of editable blocked-word tokens, add/remove/clear, save/reload, exact city tabs, 119 retained cities, nationwide, multi-select and compact layout');
      await request('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'page'},{exclude:true}]});
      sourceTarget=(await request('Target.createTarget',{url:'about:blank'})).targetId;const session=await poll(()=>pageSessions.get(sourceTarget));
      await request('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false},session);
      const view=async expression=>{const result=await request('Runtime.evaluate',{expression,returnByValue:true},session);if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
      const url='https://www.zhipin.com/web/geek/jobs';await request('Page.navigate',{url},session);await poll(()=>view('window.__fixtureDocumentToken'));
      const tabId=(await evaluate('chrome.tabs.query({url:"https://www.zhipin.com/web/geek/jobs*"})'))[0].id;
      for(const [suffix,blocked]of [['需参加收费培训',true],['负责电话销售',true],['提供免费培训',false],['提到收费以及电话客服',false]]){
        await view('sessionStorage.setItem("fixture-mode","blocked-groups");sessionStorage.setItem("fixture-description",'+JSON.stringify('负责 Java 后端业务开发和系统维护，参与接口设计和代码测试。'+suffix+'。')+');true');
        await request('Page.navigate',{url},session);await poll(()=>view('window.__fixtureDocumentToken'));
        await call('CLEAR_RECORDS');
        assert.ok((await call('SAVE_CONFIG',{config:{...original.data,titleGroups:[['Java','实习']],titleMode:'any',blockedWords,blockedGroups:null,blockedMode:'any',clickApply:false,cities:'',education:[],experience:[],salaryMin:0,salaryMax:0,hrMaxDays:0,blockedCompanies:'',maxScan:1,maxJobs:1,intervalSeconds:3}})).ok);
        await evaluate('chrome.tabs.update('+tabId+',{active:true})');await request('Page.bringToFront',{},session);assert.ok((await call('START',{tabId})).ok);
        const state=await poll(async()=>{const state=(await call('GET_STATE')).data;return ['completed','error'].includes(state.status)?state:null;});
        assert.equal(state.status,'completed',state.message);assert.equal(state.sent,blocked?0:1,suffix);
        const record=(await call('GET_RECORDS')).data[0];assert.equal(record.status,blocked?'filtered':'sent');
        if(blocked)assert.match(record.reason,/命中屏蔽词/);else assert.equal(record.deliveryKind,'boss_default');
        assert.equal(await view('window.__fixtureCommunications||0'),blocked?0:1);assert.deepEqual(await view('window.__fixtureCustomTexts||[]'),[]);
        console.log('PASS Edge plain blocker: '+suffix+' => '+(blocked?'blocked without greeting':'one confirmed default greeting'));
      }
      assert.equal(interceptionErrors.length,0,interceptionErrors.join('; '));console.log('All BOSS requests were intercepted locally; no real access or messages.');return;
    }
    if (process.argv.includes('--title-groups-only')) {
      const expected = [['Java','实习'],['后端','开发','实习'],['Java','开发','实习'],['Java','全栈','开发','实习'],['软件','开发','实习']];
      await reloadSettings();
      await poll(()=>evaluate('typeof readTitleGroups === "function" && document.getElementById("title-group-list").children.length > 0'));
      await request('Emulation.setDeviceMetricsOverride', { width: 900, height: 1140, deviceScaleFactor: 1, mobile: false }, ext);
      const ui = await evaluate(`(async()=>{
        await selectTab('rules');
        populate(BossCore.config({titleKeywords:'Java实习，后端开发实习，Java开发实习，java全栈开发实习，软件开发实习，java 实习',titleMode:'any',blockedWords:''}));
        const legacy=readTitleGroups();
        const setTitle=title=>{const input=document.getElementById('title-test-input');input.value=title;input.dispatchEvent(new Event('input',{bubbles:true}));return document.getElementById('title-test-result').classList.contains('matches');};
        const examples=['java 实习生','实习-JAVA开发','后端开发实习生','软件开发实习'].every(setTitle);
        const rejects=['Java开发工程师','JavaScript实习生','全栈开发（偏JAVA）--周末双休'].every(title=>!setTitle(title));
        document.getElementById('titleMode').value='all';document.getElementById('titleMode').dispatchEvent(new Event('change',{bubbles:true}));
        const allRejects=!setTitle('实习-JAVA开发');
        populate(BossCore.config({titleGroups:[['Java','实习'],['后端','开发']],titleMode:'any'}));
        const noMixing=!setTitle('Java后端工程师');
        document.getElementById('add-title-group').click();
        const row=document.getElementById('title-group-list').lastElementChild;
        row.querySelector('[data-title-term]').value='软件';
        row.querySelector('.title-term-add').click();row.querySelectorAll('[data-title-term]')[1].value='开发';
        row.querySelector('.title-term-add').click();row.querySelectorAll('[data-title-term]')[2].value='实习';
        row.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}));
        const addWorks=setTitle('软件开发实习生');
        row.querySelectorAll('.title-keyword button')[1].click();
        const removeTerm=readTitleGroups()[2].join(',')==='软件,实习';
        row.querySelector('[data-remove-group]').click();const removeGroup=readTitleGroups().length===2;
        document.getElementById('add-title-group').click();const blankIgnored=!setTitle('Java后端工程师');
        document.getElementById('clear-title-groups').click();const cleared=readConfig().titleGroups.length===0&&readConfig().titleKeywords===''&&setTitle('任意岗位');
        const numbered=addTitleGroup(['Java','实习']);titleRuleChanged();setTitle('Java实习');
        const actualNumber=document.getElementById('title-test-result').textContent.includes('第 2 组');
        const enterOnly=!document.getElementById('title-test-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
        populate(BossCore.config({titleGroups:${JSON.stringify(expected)},titleMode:'any',blockedWords:'',maxScan:1,maxJobs:1,intervalSeconds:3}));
        setTitle('实习-JAVA开发');
        dirty=false;setTitle('java 实习生');const testOnly=!dirty;
        document.getElementById('save-config').click();
        for(let n=0;n<100&&document.getElementById('save-config').disabled;n++)await new Promise(resolve=>setTimeout(resolve,20));
        const saved=(await chrome.runtime.sendMessage({type:'GET_CONFIG'})).data;
        return {legacy,examples,rejects,allRejects,noMixing,addWorks,removeTerm,removeGroup,blankIgnored,cleared,actualNumber,enterOnly,testOnly,saved:saved.titleGroups};
      })()`);
      for (const [name, value] of Object.entries(ui)) if (!['legacy','saved'].includes(name)) assert.equal(value, true, name);
      assert.deepEqual(ui.legacy, expected.map(group=>group.map(term=>term.toLowerCase())).concat([['java','实习']]));
      assert.deepEqual(ui.saved, expected);
      await reloadSettings();
      await poll(()=>evaluate('typeof readTitleGroups === "function" && JSON.stringify(readTitleGroups()) === '+JSON.stringify(JSON.stringify(expected))));
      await evaluate('document.getElementById("title-test-input").value="实习-JAVA开发";renderTitleRule();true');
      const visibleTerms = 'Array.from(document.querySelectorAll("[data-title-term]")).every(input=>{const r=input.getBoundingClientRect(),group=input.closest("fieldset").getBoundingClientRect();return r.width>=80 && r.left>=group.left && r.right<=group.right;})';
      assert.ok(await evaluate(visibleTerms), 'Desktop keyword inputs must remain readable inside their group');
      const desktop = await request('Page.captureScreenshot', { format: 'png' }, ext);
      fs.writeFileSync(path.join(root,'artifacts','title-keyword-groups.png'),Buffer.from(desktop.data,'base64'));
      await request('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: false }, ext);
      assert.ok(await evaluate('document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth'), 'Keyword group editor overflows a narrow window');
      assert.ok(await evaluate(visibleTerms), 'Narrow keyword inputs must remain readable inside their group');
      const mobile = await request('Page.captureScreenshot', { format: 'png' }, ext);
      fs.writeFileSync(path.join(root,'artifacts','title-keyword-groups-mobile.png'),Buffer.from(mobile.data,'base64'));
      console.log('PASS Edge title groups: legacy conversion, term/group editing, OR/AND, no cross-group mixing, empty groups, title preview, save/reload and narrow layout');
      await request('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'page'},{exclude:true}]});
      sourceTarget=(await request('Target.createTarget',{url:'about:blank'})).targetId;
      const session=await poll(()=>pageSessions.get(sourceTarget));
      await request('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false},session);
      const view=async expression=>{
        const response=await request('Runtime.evaluate',{expression,returnByValue:true},session);
        if(response.exceptionDetails)throw Error(JSON.stringify(response.exceptionDetails));return response.result.value;
      };
      const url='https://www.zhipin.com/web/geek/jobs';
      await request('Page.navigate',{url},session);await poll(()=>view('window.__fixtureDocumentToken'));
      const tabId=(await evaluate('chrome.tabs.query({url:"https://www.zhipin.com/web/geek/jobs*"})'))[0].id;
      const cases=[['java 实习生',true],['实习-JAVA开发',true],['后端开发实习生',true],['软件开发实习',true],['Java开发工程师',false],['JavaScript实习生',false],['全栈开发（偏JAVA）--周末双休',false]];
      for (const [title, accepted] of cases) {
        await view('sessionStorage.setItem("fixture-mode","title-groups");sessionStorage.setItem("fixture-title",'+JSON.stringify(title)+');true');
        await request('Page.navigate',{url},session);const token=await poll(()=>view('window.__fixtureDocumentToken'));
        assert.ok((await call('CLEAR_RECORDS')).ok);
        assert.ok((await call('SAVE_CONFIG',{config:{...original.data,titleGroups:expected,titleMode:'any',clickApply:false,customGreeting:false,blockedWords:'',blockedCompanies:'',cities:'',salaryMin:0,salaryMax:0,hrMaxDays:0,education:[],experience:[],maxScan:1,maxJobs:1,intervalSeconds:3}})).ok);
        await evaluate('chrome.tabs.update('+tabId+',{active:true})');await request('Page.bringToFront',{},session);
        assert.ok((await call('START',{tabId})).ok);
        const state=await poll(async()=>{const state=(await call('GET_STATE')).data;return ['completed','error'].includes(state.status)?state:null;});
        assert.equal(state.status,'completed',state.message);assert.equal(state.sent,accepted?1:0,title);
        const record=(await call('GET_RECORDS')).data[0];assert.equal(record.status,accepted?'sent':'filtered',title);
        if(accepted)assert.equal(record.deliveryKind,'boss_default');
        const actual=await view('({token:window.__fixtureDocumentToken,contacts:window.__fixtureCommunications||0,custom:window.__fixtureCustomTexts||[]})');
        assert.equal(actual.token,token);assert.equal(actual.contacts,accepted?1:0);assert.deepEqual(actual.custom,[]);
        console.log('PASS Edge title filter: '+title+' => '+(accepted?'one confirmed default greeting':'filtered without greeting'));
      }
      assert.equal(interceptionErrors.length,0,interceptionErrors.join('; '));
      console.log('Title group tests used only intercepted local fixtures; no real BOSS access or messages.');
      return;
    }
    if (process.argv.includes('--default-only')) {
      await request('Target.setAutoAttach', {autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'page'},{exclude:true}]});
      sourceTarget=(await request('Target.createTarget',{url:'about:blank'})).targetId;
      const session=await poll(()=>pageSessions.get(sourceTarget));
      await request('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false},session);
      const view=async expression=>{
        const result=await request('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);
        if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;
      };
      const url='https://www.zhipin.com/web/geek/jobs';
      await request('Page.navigate',{url},session);
      await poll(()=>view('window.__fixtureDocumentToken'));
      const tabId=(await evaluate('chrome.tabs.query({url:"https://www.zhipin.com/web/geek/jobs*"})'))[0].id;
      const tabsBefore=await evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id).sort())');
      const worker=(await request('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url.includes('/background.js'));
      const workerSession=(await request('Target.attachToTarget',{targetId:worker.targetId,flatten:true})).sessionId;
      const workerEval=async expression=>{
        const result=await request('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},workerSession);
        if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;
      };
      await workerEval('globalThis.__qaNativeFetch=fetch;globalThis.__qaPermission=chrome.permissions.contains;globalThis.__qaRequests=[];chrome.permissions.contains=async()=>true;globalThis.fetch=async()=>{globalThis.__qaRequests.push(true);throw Error("Unexpected network request");};true;');
      try {
        for(const mode of ['default-metadata-missing','default-legacy-settings','default-preview','default-already-contacted','receipt-reactive-batch','receipt-unconfirmed']) {
          await view('sessionStorage.setItem("fixture-mode",'+JSON.stringify(mode)+');true');
          await request('Page.navigate',{url},session);
          await poll(()=>view('window.__fixtureDocumentToken'));
          await call('CLEAR_RECORDS');
          const count=mode==='receipt-reactive-batch'?5:1;
          if(count>1)await view('window.__fixtureEnableBatch();true');
          const preview=mode==='default-preview';
          const skip=mode==='default-already-contacted';
          const unconfirmed=mode==='receipt-unconfirmed';
          await call('SAVE_CONFIG',{config:{...original.data,greetingMode:'boss_default',clickApply:false,titleKeywords:'Java',blockedWords:'',cities:'',salaryMin:0,salaryMax:0,hrMaxDays:0,education:[],experience:[],maxScan:count,maxJobs:count,intervalSeconds:3}});
          const token=await view('window.__fixtureDocumentToken');
          const started=await call('START',{tabId,preview});assert.ok(started.ok,started.error);
          const state=await poll(async()=>{const s=(await call('GET_STATE')).data;return ['completed','error'].includes(s.status)?s:null;},40000);
          const expected=preview||skip||unconfirmed?0:count;
          assert.equal(state.status,unconfirmed?'error':'completed',state.message);assert.equal(state.sent,expected);
          const actual=await view('({token:window.__fixtureDocumentToken,defaults:window.__fixtureCommunications||0,texts:window.__fixtureCustomTexts||[],stays:window.__fixtureStays||0,continues:window.__fixtureContinues||0,url:location.href,frames:document.querySelectorAll("iframe").length})');
          assert.equal(actual.token,token);assert.equal(actual.url,url);
          assert.equal(actual.defaults,preview||skip?0:count);assert.equal(actual.stays,expected);assert.equal(actual.continues,0);
          assert.deepEqual(actual.texts,[]);assert.equal(actual.frames,0);
          const records=(await call('GET_RECORDS')).data,receipts=records.filter(r=>r.status==='sent');
          assert.equal(receipts.length,expected);assert.ok(records.every(r=>!r.greeting&&!r.analysis?.greeting));
          assert.ok(receipts.every(r=>r.deliveryKind==='boss_default'));
          assert.deepEqual(await evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id).sort())'),tabsBefore);
          console.log('PASS Edge default-only '+mode+': native clicks='+actual.defaults+', confirmed='+state.sent+', custom messages=0, same list document');
        }
        const requests=await workerEval('globalThis.__qaRequests');assert.equal(requests.length,0);
        assert.equal(await evaluate('document.getElementById("custom-greeting-fields").hidden'),true);
        assert.ok(await evaluate('document.body.textContent.includes("只发送 BOSS 默认招呼")'));
      } finally {await workerEval('globalThis.fetch=globalThis.__qaNativeFetch;chrome.permissions.contains=globalThis.__qaPermission;true;');}
      assert.equal(interceptionErrors.length,0,interceptionErrors.join('; '));
      console.log('All BOSS requests intercepted locally; no real messages or external requests.');
      return;
    }
    if (process.argv.includes('--clicked-detail-only') || process.argv.includes('--identity-only') || process.argv.includes('--salary-only') || process.argv.includes('--delivery-only') || process.argv.includes('--inline-only') || process.argv.includes('--receipt-only') || process.argv.includes('--receipt-regression-only')) {
      const inlineOnly = process.argv.includes('--inline-only');
      const clickedDetailOnly = process.argv.includes('--clicked-detail-only');
      const identityOnly = process.argv.includes('--identity-only') || clickedDetailOnly;
      await request('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }, { exclude: true }] });
      sourceTarget = (await request('Target.createTarget', { url: 'about:blank' })).targetId;
      const session = await poll(async () => pageSessions.get(sourceTarget));
      await request('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false},session);
      const view = async expression => {
        const result = await request('Runtime.evaluate', { expression, returnByValue: true }, session);
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      const url = 'https://www.zhipin.com/web/geek/jobs?city=101210100';
      await request('Page.navigate', { url }, session);
      await poll(async () => view('window.__fixtureDocumentToken'));
      const tabId = (await evaluate('chrome.tabs.query({url:"https://www.zhipin.com/web/geek/jobs*"})'))[0].id;
      assert.ok((await call('SAVE_CONFIG', { config: { ...original.data, clickApply: false, customGreeting: false, titleKeywords: 'Java', jdKeywords: 'Spring Boot', blockedWords: '', cities: '', education: [], experience: [], maxScan: 1, maxJobs: 1, intervalSeconds: 3 } })).ok);
      for (const mode of clickedDetailOnly ? ['title-suffix-home','title-suffix-insufficient','title-suffix-wrong-id'] : identityOnly ? ['title-suffix-id','title-suffix-native','title-suffix-secondary','title-suffix-brackets','title-suffix-id-duplicates','title-suffix-ambiguous','title-suffix-wrong-company','title-suffix-wrong-salary','title-suffix-wrong-city','title-suffix-insufficient','title-suffix-wrong-id'] : process.argv.includes('--salary-only') ? ['salary-font','salary-native-data','salary-card-data','salary-card-conflict','salary-monthly','salary-wrong-data','salary-unknown-font'] : process.argv.includes('--receipt-regression-only') ? ['receipt-reactive-batch'] : process.argv.includes('--receipt-tail-only') ? ['receipt-preexisting','receipt-unconfirmed','receipt-exhausted'] : process.argv.includes('--receipt-only') ? ['receipt-reactive-batch', 'receipt-reactive-replaced', 'receipt-reactive-wrong-id', 'receipt-native', 'receipt-batch', 'receipt-preexisting', 'receipt-unconfirmed', 'receipt-exhausted'] : process.argv.includes('--native-switch-only') ? ['modern-native-switch'] : process.argv.includes('--native-only') ? ['modern-native-structure', 'modern-native-switch', 'modern-native-blocked', 'modern-native-stale', 'modern-native-labels-only'] : process.argv.includes('--diagnostics-only') ? ['modern-wrong-id'] : inlineOnly ? ['modern-alias', 'modern-no-metadata', 'modern-semantic', 'modern-benefits', 'modern-wrong-id'] : ['normal', 'replaced-detail', 'wrong-detail-after-click']) {
        if (mode !== 'normal') {
          await view('sessionStorage.setItem("fixture-mode",' + JSON.stringify(mode) + ')');
          await view('sessionStorage.setItem("fixture-batch",' + JSON.stringify(['receipt-batch','receipt-reactive-batch'].includes(mode) ? 'yes' : 'no') + ')');
          await request('Page.navigate', { url }, session);
        }
        const token = await poll(async () => view('window.__fixtureDocumentToken'));
        const windows = await evaluate('chrome.windows.getAll().then(w=>w.map(x=>x.id).sort())');
        const tabs = await evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id).sort())');
        assert.ok((await call('CONNECT_PAGE', { tabId })).ok);
        if (inlineOnly) assert.ok((await call('SAVE_CONFIG', { config: { ...original.data, clickApply: false, customGreeting: false, titleKeywords: 'Java,实习', titleMode: 'all', jdKeywords: 'Spring Boot', blockedWords: '外包,派遣', cities: '北京', education: ['本科'], experience: [], salaryMin: 5000, salaryMax: 7000, salaryWorkDays: 30, hrMaxDays: 3, maxScan: 1, maxJobs: 1, intervalSeconds: 3 } })).ok);
        if (identityOnly) assert.ok((await call('SAVE_CONFIG', { config: { ...original.data, clickApply: false, customGreeting: false, greetingMode: 'boss_default', titleKeywords: '', titleGroups: [['Java','实习']], titleGroupRules: null, titleMode: 'any', blockedWords: '', cities: '', education: [], experience: [], salaryMin: 0, salaryMax: 0, hrMaxDays: 0, maxScan: 1, maxJobs: 1, intervalSeconds: 3 } })).ok);
        if (mode.startsWith('receipt-')) assert.ok((await call('SAVE_CONFIG', { config: { ...original.data, customGreeting: false, clickApply: false, titleKeywords: 'Java', blockedWords: '', cities: '', salaryMin: 0, salaryMax: 0, hrMaxDays: 0, education: [], experience: [], intervalSeconds: 3, maxScan: mode === 'receipt-batch' ? 2 : 1, maxJobs: mode === 'receipt-reactive-batch' ? 5 : mode === 'receipt-batch' ? 6 : mode === 'receipt-exhausted' ? 3 : 1 } })).ok);
        if(mode.startsWith('salary-')) assert.ok((await call('SAVE_CONFIG',{config:{...original.data,customGreeting:false,clickApply:false,titleKeywords:'Java',blockedWords:'',cities:'上海',education:['本科'],experience:[],hrMaxDays:0,salaryWorkDays:30,salaryMin:mode==='salary-monthly'?13000:6000,salaryMax:mode==='salary-monthly'?24000:7500,maxScan:1,maxJobs:1,intervalSeconds:3}})).ok);
        if (mode === 'receipt-preexisting') await view('(()=>{const old=document.createElement("div");old.className="notice-layer";old.innerHTML="<h3>已向BOSS发送消息</h3><div class=btn-stay>留在此页</div><div class=btn-next>继续沟通</div>";old.querySelector(".btn-stay").onclick=()=>{window.__fixtureOldDismissed=true;old.remove()};document.body.append(old);return true})()');
        assert.ok((await call('CLEAR_RECORDS')).ok);
        await evaluate('chrome.tabs.update('+tabId+', {active:true})');
        await request('Page.bringToFront',{},session);
        const started = await call('START', { tabId }); assert.ok(started.ok, started.error);
        const observedSends = new Set();
        const stopped = await poll(async () => { const state = (await call('GET_STATE')).data; observedSends.add(state.sent || 0); return ['error', 'completed'].includes(state.status) ? state : null; }, ['receipt-batch','receipt-reactive-batch'].includes(mode) ? 60000 : 35000);
        const records = (await call('GET_RECORDS')).data;
        const wrong = mode === 'modern-native-labels-only' || mode === 'receipt-unconfirmed';
        const blocked = mode === 'modern-native-blocked' || mode === 'salary-wrong-data' || mode === 'salary-unknown-font' || mode === 'salary-card-conflict';
        assert.equal(stopped.status, wrong ? 'error' : 'completed', stopped.message);
        const expectedSent = wrong || blocked ? 0 : mode === 'receipt-reactive-batch' ? 5 : mode === 'receipt-batch' ? 6 : 1;
        assert.equal(stopped.sent, expectedSent);
        assert.equal(records.filter(r => r.status === 'sent').length, stopped.sent);
        if (stopped.sent) assert.equal(records.find(r => r.status === 'sent').deliveryKind, 'boss_default');
        else assert.ok(records.some(r => r.status === (blocked ? 'filtered' : ['wrong-detail-after-click', 'receipt-unconfirmed', 'receipt-reactive-wrong-id'].includes(mode) ? 'uncertain' : 'error')));
        if(identityOnly && !wrong) {
          const sent=records.find(r=>r.status==='sent');
          assert.equal(sent.job.title,mode==='title-suffix-home'?'java实习-居家办公':mode==='title-suffix-brackets'?'java实习（双休）':'java实习-双休');
          assert.equal(sent.job.detailTitle,'java实习');assert.equal(sent.job.company,mode==='title-suffix-wrong-company'?'另一家公司':'绍兴扬瑾网络科技');
          if(mode!=='title-suffix-insufficient'){assert.equal(sent.job.daysPerWeek,4);assert.equal(sent.job.internshipMonths,12);}
          assert.equal(await view('window.__fixtureStays||0'),1);
        }
        if(mode.startsWith('salary-')) {
          const record=records.find(r=>r.status===(blocked?'filtered':'sent'));assert.ok(record,JSON.stringify(records));
          if(blocked) {assert.match(record.reason||record.reasons?.join(' ')||'',/字体编码未解析/);assert.equal(stopped.matched,0);}
          else {
            assert.equal(record.job.salary,mode==='salary-monthly'?'13–24K·14薪':'200–250元/天');
            assert.equal(record.job.salarySource,['salary-native-data','salary-card-data'].includes(mode)?'native_job':'rendered_font');
            assert.equal(record.job.monthlySalary.min,mode==='salary-monthly'?13000:6000);assert.equal(record.job.monthlySalary.max,mode==='salary-monthly'?24000:7500);
            assert.match(record.job.salaryRaw,/[\uE000-\uF8FF]/);assert.ok(!JSON.stringify(records).includes('never-export'));
          }
          if(mode==='salary-font') {
            const decoded=await evaluate('chrome.scripting.executeScript({target:{tabId:'+tabId+'},func:async()=>{await document.fonts.ready;return [BossSalary.read(document.getElementById("font-a")),BossSalary.read(document.getElementById("font-b"))]}}).then(r=>r[0].result)');
            assert.deepEqual(decoded,['3–7K','2–9K']);
          }
          console.log('PASS Edge salary: '+mode+', accurate monthly bounds, private glyph handling, no cross-job salary or navigation');
        }
        if (inlineOnly && !wrong && !blocked) {
          const sent = records.find(r => r.status === 'sent');
          assert.equal(sent.job.monthlySalary.min, 5400); assert.equal(sent.job.monthlySalary.max, 6300);
          assert.equal(sent.job.hrActivity, mode.startsWith('modern-native-') ? '刚刚活跃' : '今日活跃'); assert.equal(sent.job.education, '本科'); assert.equal(sent.job.location, '北京');
          assert.match(sent.job.description, /Springboot/);
          console.log('PASS Edge fixture: internship title, Beijing, bachelor, daily salary × 30, recruiter activity and differently worded JD pass all filters');
        }
        if (mode.startsWith('modern-native-')) {
          assert.ok((await evaluate('chrome.tabs.sendMessage(' + tabId + ',{type:"SCAN",max:100})')).data.length === 5, 'Mixed wrappers and li cards are scanned once each');
          assert.equal(stopped.matched, wrong || blocked ? 0 : 1);
          if (!wrong && !blocked) {
            const description=records.find(r=>r.status==='sent').job.description;
            assert.ok(description.length>100);assert.match(description,/岗位职责：开发 Java/);assert.ok(!description.includes('Golang'));
          }
          if (blocked) assert.ok(records.some(r=>r.status==='filtered' && /外包|派遣/.test(r.reason||r.reasons?.join(' ')||'')), JSON.stringify(records));
          console.log('PASS Edge native DOM: labels excluded from JD, mixed cards, wrapper selection, ' + mode);
        }
        if (mode === 'modern-wrong-id') {
          await evaluate('chrome.scripting.executeScript({target:{tabId:' + tabId + '},func:()=>{navigator.clipboard.writeText=async()=>{throw Error("fixture clipboard unavailable")};}})');
          await view('(()=>{const input=document.createElement("textarea");input.value="private-draft-sentinel";document.body.append(input);return true})()');
          await sleep(3200); // Allow the real panel refresh to expose diagnostics.
          const doc = await request('DOM.getDocument', { depth: -1, pierce: true }, session);
          const find = node => {
            const attrs = node.attributes || [];
            if (attrs.some((v,i)=>i%2===0 && v==='id' && attrs[i+1]==='diagnostics')) return node;
            for (const child of [...(node.children||[]),...(node.shadowRoots||[])]) {const found=find(child);if(found)return found;}
          };
          const node=find(doc.root);assert.ok(node);
          const object=(await request('DOM.resolveNode',{backendNodeId:node.backendNodeId},session)).object.objectId;
          const report=await request('Runtime.callFunctionOn',{objectId:object,functionDeclaration:'async function(){if(this.hidden)throw Error("Diagnostics hidden");this.click();await new Promise(r=>setTimeout(r,100));return this.getRootNode().getElementById("diagnostic-text").value}',awaitPromise:true,returnByValue:true,userGesture:true},session);
          assert.ok(!report.exceptionDetails,JSON.stringify(report.exceptionDetails));
          const diagnostic=JSON.parse(report.result.value);assert.equal(diagnostic.expectedTitle,'java实习生');assert.equal(diagnostic.listCards,5);assert.ok(diagnostic.buttons.length);
          assert.ok(!report.result.value.includes('private-draft-sentinel'));
          console.log('PASS Edge fixture: visible diagnostics button exports structure, title and JD length without chat draft values');
        }
        if (mode.startsWith('receipt-')) {
          const native = await view('({dialogs:document.querySelectorAll(".notice-layer").length,stays:window.__fixtureStays||0,next:window.__fixtureContinues||0,dismissVisibility:window.__fixtureDismissVisibility,oldDismissed:window.__fixtureOldDismissed||false})');
          assert.equal(native.next, 0); assert.equal(native.stays, expectedSent);
          assert.equal(native.dialogs, wrong ? 1 : 0);
          if (!wrong) assert.equal(native.dismissVisibility, 'hidden');
          if (mode === 'receipt-preexisting') assert.equal(native.oldDismissed, true);
          if (mode.startsWith('receipt-reactive-')) assert.ok(records.every(r=>!r.job.description.includes('qa-decoy')&&!r.job.description.includes('隐藏内容')), 'Read only the visible JD, excluding dynamic CSS and decoys');
          if (mode === 'receipt-reactive-batch') {assert.equal(stopped.completionReason,'target');assert.equal(stopped.sent,5);assert.equal(stopped.targetJobs,5);assert.deepEqual([...observedSends].sort(),[0,1,2,3,4,5]);
            const doc=await request('DOM.getDocument',{depth:-1,pierce:true},session);
            const find=node=>{const a=node.attributes||[];if(a.some((v,i)=>i%2===0&&v==='id'&&a[i+1]==='sent'))return node;for(const child of [...(node.children||[]),...(node.shadowRoots||[])]){const result=find(child);if(result)return result;}};
            const node=find(doc.root);assert.ok(node);const object=(await request('DOM.resolveNode',{backendNodeId:node.backendNodeId},session)).object.objectId;
            await poll(async()=>{const r=await request('Runtime.callFunctionOn',{objectId:object,functionDeclaration:'function(){return this.textContent}',returnByValue:true},session);return r.result.value==='5 / 5';},4000);
            const screenshot=await request('Page.captureScreenshot',{format:'png'},session);fs.writeFileSync(path.join(root,'artifacts','delivery-five-complete.png'),Buffer.from(screenshot.data,'base64'));
            console.log('PASS live count sequence: 0 → 1 → 2 → 3 → 4 → 5, panel 5 / 5, five native dialogs dismissed');
          }
          if (mode === 'receipt-batch') { assert.equal(stopped.completionReason,'target');assert.equal(stopped.scanned,6);assert.equal(stopped.targetJobs,6); }
          if (mode === 'receipt-exhausted') { assert.equal(stopped.completionReason,'list_exhausted');assert.match(stopped.message,/未达到目标/); }
          console.log('PASS Edge native receipt: ' + mode + ', ' + expectedSent + ' saved receipts, auto-dismiss, no continue-chat, successful target count');
        }
        const final = await view('({token:window.__fixtureDocumentToken,contacts:window.__fixtureCommunications||0,url:location.href})');
        assert.equal(final.token, token); assert.equal(final.contacts, mode.startsWith('receipt-') ? wrong ? 1 : expectedSent : wrong || blocked ? 0 : 1); assert.equal(final.url, url);
        assert.deepEqual(await evaluate('chrome.windows.getAll().then(w=>w.map(x=>x.id).sort())'), windows);
        assert.deepEqual(await evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id).sort())'), tabs);
        console.log('PASS Edge fixture: plural jobs list, native uncancelled click, ' + mode + ', receipt count ' + stopped.sent + ', same document and tabs');
      }
      return;
    }
    if (process.argv.includes('--stale-only')) {
      await request('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }, { exclude: true }] });
      sourceTarget = (await request('Target.createTarget', { url: 'about:blank' })).targetId;
      const session = await poll(async () => pageSessions.get(sourceTarget));
      await request('Page.navigate', { url: 'https://www.zhipin.com/web/geek/job' }, session);
      const view = async expression => {
        const result = await request('Runtime.evaluate', { expression, returnByValue: true }, session);
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      const token = await poll(async () => view('window.__fixtureDocumentToken'));
      const tabId = (await evaluate('chrome.tabs.query({url:"https://www.zhipin.com/web/geek/job"})'))[0].id;
      assert.ok((await call('CONNECT_PAGE', { tabId })).ok);
      assert.ok((await call('SAVE_CONFIG', { config: { ...original.data, clickApply: false, customGreeting: false, titleKeywords: 'Java', jdKeywords: 'Spring Boot', blockedWords: '', cities: '', education: [], experience: [], maxScan: 1, maxJobs: 1, intervalSeconds: 3 } })).ok);
      await call('CLEAR_RECORDS');
      await view('sessionStorage.removeItem("fixture-mode");window.__fixtureEnableBatch();document.querySelector("a[href*=fixture-4]").click();true');
      await poll(async () => view('document.querySelector(".job-detail-box").dataset.jobId === "fixture-4"'));
      await view('sessionStorage.setItem("fixture-mode","stale-detail")');
      assert.ok((await call('START', { tabId })).ok);
      const stopped = await poll(async () => { const state = (await call('GET_STATE')).data; return ['error', 'completed'].includes(state.status) ? state : null; }, 40000);
      assert.equal(stopped.status, 'error', stopped.message); assert.equal(stopped.sent, 0); assert.equal(stopped.attempted, 0);
      const final = await view('({token:window.__fixtureDocumentToken,contacts:window.__fixtureCommunications||0,url:location.href})');
      assert.equal(final.token, token); assert.equal(final.contacts, 0); assert.equal(final.url, 'https://www.zhipin.com/web/geek/job');
      console.log('PASS Edge fixture: a different stale right-hand job stops before communicating, same list document');
      return;
    }
    await request('Target.activateTarget', {targetId:optionsTarget.targetId});
    await request('Page.bringToFront', {}, ext);
    const settingsWindow = await evaluate('chrome.windows.getCurrent().then(w=>w.type)');
    assert.equal(settingsWindow, 'normal');
    console.log('PASS Edge settings: opening options does not create a desktop application window');
    await request('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }, { exclude: true }] });
    sourceTarget = (await request('Target.createTarget', { url: 'about:blank' })).targetId;
    const sourceSession = await poll(async () => pageSessions.get(sourceTarget));
    await request('Page.navigate', { url: 'https://www.zhipin.com/web/geek/jobs' }, sourceSession);
    const tabs = await poll(async () => {
      const list = await evaluate('chrome.tabs.query({url:"https://www.zhipin.com/web/geek/jobs"})');
      return list.length ? list : null;
    });
    const tabId = tabs[0].id;
    const initialDocument = await poll(async () => (await request('Runtime.evaluate', { expression: 'window.__fixtureDocumentToken', returnByValue: true }, sourceSession)).result.value);
    const tabsBeforeDelivery = (await evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id).sort())'));
    const readyList = () => poll(async () => {
      const result = await request('Runtime.evaluate', { expression: 'Boolean(document.querySelector(".job-card-wrapper a")&&document.getElementById("zhixiang-controls"))', returnByValue: true }, sourceSession);
      return result.result.value;
    });
    const clickPanel = async id => {
      await request('DOM.enable', {}, sourceSession);
      const doc = await request('DOM.getDocument', { depth: -1, pierce: true }, sourceSession);
      const find = node => {
        const attrs = node.attributes || [];
        if (attrs.some((v, i) => i % 2 === 0 && v === 'id' && attrs[i + 1] === id)) return node;
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const found = find(child); if (found) return found; }
      };
      const button = find(doc.root); assert.ok(button, 'Page panel button ' + id);
      const box = (await request('DOM.getBoxModel', { backendNodeId: button.backendNodeId }, sourceSession)).model.content;
      const position = { x: (box[0] + box[4]) / 2, y: (box[1] + box[5]) / 2 };
      await request('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position }, sourceSession);
      await request('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position }, sourceSession);
    };
    await poll(async () => evaluate('chrome.tabs.sendMessage(' + tabId + ',{type:"PING"}).then(r=>r.ok).catch(()=>false)'));
    const fixtureCheck = await request('Runtime.evaluate', { expression: '({title:document.title,cards:document.querySelectorAll(".job-card-wrapper").length})', returnByValue: true }, sourceSession);
    assert.equal(fixtureCheck.result.value.title, 'BOSS 页面测试样例');
    assert.equal(fixtureCheck.result.value.cards, 1);
    // Simulate a detached content script in an already-open page, then recover without reloading it.
    await evaluate('chrome.scripting.executeScript({target:{tabId:' + tabId + '},func:()=>globalThis.__zhixiangLoaded.dispose()}).then(()=>true)');
    const reconnected = await call('CONNECT_PAGE', { tabId });
    assert.ok(reconnected.ok, reconnected.error);
    await call('CONNECT_PAGE', { tabId });
    const panel = await request('Runtime.evaluate', { expression: '({count:document.querySelectorAll("#zhixiang-controls").length,visible:document.getElementById("zhixiang-controls")?.style.display!=="none"})', returnByValue: true }, sourceSession);
    assert.equal(panel.result.value.count, 1);
    assert.equal(panel.result.value.visible, true);
    await request('Runtime.evaluate', { expression: 'document.getElementById("zhixiang-controls").style.display="none"', returnByValue: true }, sourceSession);
    assert.ok((await call('CONNECT_PAGE', { tabId })).ok);
    const restored = await request('Runtime.evaluate', { expression: 'document.getElementById("zhixiang-controls").style.display', returnByValue: true }, sourceSession);
    assert.equal(restored.result.value, '');
    console.log('PASS Edge fixture: disconnected page reinjected, hidden panel restored, no duplicate panel');
    const config = { ...original.data, clickApply: false, customGreeting: false, maxJobs: 1, maxScan: 1, intervalSeconds: 3, titleKeywords: 'Java', jdKeywords: 'Spring Boot', blockedWords: '外包,派遣', cities: '上海', education: ['本科'], experience: ['1-3年'] };
    assert.ok((await call('SAVE_CONFIG', { config })).ok);
    assert.ok((await call('CLEAR_RECORDS')).ok);
    for (const preview of [true, false]) {
      await readyList();
      await clickPanel(preview ? 'preview' : 'start');
      await poll(async () => (await call('GET_STATE')).data.preview === preview);
      const state = await poll(async () => { const response = await call('GET_STATE'); return ['completed', 'error'].includes(response.data.status) ? response.data : null; });
      assert.equal(state.status, 'completed', state.message);
      assert.equal(state.scanned, 1);
      assert.equal(state.matched, 1);
      assert.equal(state.sent, preview ? 0 : 1);
      const records = await call('GET_RECORDS');
      assert.equal(records.data[0].status, preview ? 'preview' : 'sent');
      assert.match(records.data[0].job.description, /Java 后端服务/);
      if (!preview) { assert.equal(records.data[0].deliveryKind, 'boss_default'); assert.equal(records.data[0].greeting, ''); }
      console.log(preview ? 'PASS Edge fixture: page panel starts preview, complete JD, filters, no send' : 'PASS Edge fixture: page panel starts default greeting, success dialog receipt saved');
    }
    await readyList();
    const again = await call('START', { tabId, preview: false }); assert.ok(again.ok);
    const dedup = await poll(async () => { const response = await call('GET_STATE'); return response.data.status === 'completed' ? response.data : null; });
    assert.equal(dedup.sent, 0); assert.equal(dedup.attempted, 0);
    console.log('PASS Edge fixture: sent history prevents duplicate delivery');
    const windowIds = await evaluate('chrome.windows.getAll().then(w=>w.map(x=>x.id).sort())');
    await readyList();
    assert.ok((await call('OPEN_SETTINGS')).ok);
    const embeddedTarget = await poll(async () => (await request('Target.getTargets')).targetInfos.find(t => t.url.includes('/options.html?embedded=1')));
    const embeddedSession = (await request('Target.attachToTarget', { targetId: embeddedTarget.targetId, flatten: true })).sessionId;
    const embeddedEval = async expression => {
      const result = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, embeddedSession);
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await poll(async () => embeddedEval('Boolean(globalThis.chrome?.runtime?.id && document.getElementById("cities")?.value === "上海")'));
    assert.equal((await embeddedEval('chrome.runtime.sendMessage({type:"GET_CONFIG"})')).ok, true);
    const embeddedSave = await embeddedEval('(async()=>{document.getElementById("cities").value="上海,杭州";return chrome.runtime.sendMessage({type:"SAVE_CONFIG",config:readConfig()});})()');
    assert.ok(embeddedSave.ok, embeddedSave.error);
    assert.equal((await call('GET_CONFIG')).data.cities, '上海,杭州');
    await call('SAVE_CONFIG', { config });
    await call('OPEN_SETTINGS');
    assert.equal((await request('Target.getTargets')).targetInfos.filter(t => t.url.includes('/options.html?embedded=1')).length, 1);
    assert.deepEqual(await evaluate('chrome.windows.getAll().then(w=>w.map(x=>x.id).sort())'), windowIds);
    assert.deepEqual(await evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id).sort())'), tabsBeforeDelivery);
    const settingsShot = await request('Page.captureScreenshot', { format: 'png' }, sourceSession);
    fs.writeFileSync(path.join(root, 'artifacts', 'embedded-settings.png'), Buffer.from(settingsShot.data, 'base64'));
    await clickPanel('close-settings');
    console.log('PASS Edge fixture: settings iframe reads and saves config, reuses overlay, no extra window or tab');
    await call('CLEAR_RECORDS');
    await readyList();
    await call('SAVE_CONFIG', { config: { ...config, clickApply: true } });
    await sleep(3300); // Wait for the content script's settings refresh.
    const beforeClickId = (await call('GET_STATE')).data.id;
    const position = await request('Runtime.evaluate', { expression: '(()=>{const a=document.querySelector(".job-card-wrapper a");a.scrollIntoView({block:"center",behavior:"instant"});const r=a.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()', returnByValue: true }, sourceSession);
    await request('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position.result.value }, sourceSession);
    await request('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position.result.value }, sourceSession);
    let clicked;
    try { clicked = await poll(async () => { const response = await call('GET_STATE'); return response.data.id !== beforeClickId && ['completed', 'error'].includes(response.data.status) ? response.data : null; }); }
    catch (error) {
      const hit = await request('Runtime.evaluate', {expression:'document.elementFromPoint(' + position.result.value.x + ',' + position.result.value.y + ')?.outerHTML',returnByValue:true},sourceSession);
      throw Error(error.message + '; state=' + JSON.stringify((await call('GET_STATE')).data) + '; click target=' + hit.result.value);
    }
    assert.equal(clicked.status, 'completed', clicked.message);
    assert.equal(clicked.sent, 1);
    console.log('PASS Edge fixture: trusted job-link click triggers filtering and automatic greeting');
    await readyList();
    await call('CLEAR_RECORDS');
    await call('SAVE_CONFIG', { config: { ...config, customGreeting: true } });
    const customStart = await call('START', { tabId }); assert.ok(customStart.ok, customStart.error);
    const customState = await poll(async () => { const response = await call('GET_STATE'); return ['completed', 'error'].includes(response.data.status) ? response.data : null; });
    assert.equal(customState.status, 'completed', customState.message);
    assert.equal(customState.sent, 1);
    const customRecords = (await call('GET_RECORDS')).data.filter(r => r.status === 'sent');
    assert.deepEqual(customRecords.map(r => r.deliveryKind), ['boss_default']);
    assert.equal(customRecords[0].greeting, '');
    assert.deepEqual(await evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id).sort())'), tabsBeforeDelivery);
    console.log('PASS Edge fixture: old custom setting uses default-only delivery, no custom message or navigation');
    await readyList();
    await clickPanel('close-chat');
    await clickPanel('hide'); await clickPanel('launcher');
    console.log('PASS Edge fixture: collapsed page panel can reopen directly without toolbar');
    const shot = await request('Page.captureScreenshot', { format: 'png' }, sourceSession);
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts', 'page-delivery-panel.png'), Buffer.from(shot.data, 'base64'));
    await call('CLEAR_RECORDS');
    await request('Runtime.evaluate', { expression: 'sessionStorage.setItem("fixture-mode","wrong-chat")', returnByValue: true }, sourceSession);
    assert.ok((await call('START', { tabId })).ok);
    const defaultState = await poll(async () => { const state = (await call('GET_STATE')).data; return ['completed','error'].includes(state.status) ? state : null; });
    assert.equal(defaultState.status, 'completed', defaultState.message);
    assert.equal(defaultState.sent, 1);
    const retained = (await call('GET_RECORDS')).data.filter(r => r.status === 'sent');
    assert.equal(retained.length, 1);
    assert.equal(retained[0].deliveryKind, 'boss_default');
    assert.deepEqual(await evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id).sort())'), tabsBeforeDelivery);
    console.log('PASS Edge fixture: unused chat destination does not block native default delivery');
    const currentDocument = await request('Runtime.evaluate', { expression: '({token:window.__fixtureDocumentToken,url:location.href})', returnByValue: true }, sourceSession);
    assert.equal(currentDocument.result.value.token, initialDocument);
    assert.equal(currentDocument.result.value.url, 'https://www.zhipin.com/web/geek/jobs');
    await call('CLEAR_RECORDS');
    await call('SAVE_CONFIG', { config: { ...config, customGreeting: false, maxScan: 6 } });
    await evaluate('chrome.tabs.update(' + tabId + ', {active:true})');
    await request('Page.bringToFront',{},sourceSession);
    const beforeBatch = (await request('Runtime.evaluate', { expression: 'sessionStorage.removeItem("fixture-mode"); window.__fixtureEnableBatch(); window.__fixtureCommunications || 0', returnByValue: true }, sourceSession)).result.value;
    assert.ok((await call('START', { tabId, preview: true })).ok);
    const batch = await poll(async () => { const state = (await call('GET_STATE')).data; return ['completed', 'error'].includes(state.status) ? state : null; }, 40000);
    const batchView = (await request('Runtime.evaluate', { expression: '(()=>{const card=document.querySelector("[data-zhixiang-current]");const r=card.getBoundingClientRect();return {token:window.__fixtureDocumentToken,id:card.dataset.zhixiangCurrent,detail:document.querySelector(".job-detail-box").dataset.jobId,scroll:scrollY,visible:r.bottom>0&&r.top<innerHeight,contacts:window.__fixtureCommunications||0,cards:document.querySelectorAll(".job-card-wrapper").length,scrollEvents:window.__fixtureScrollCount||0,visibility:document.visibilityState,height:innerHeight,documentHeight:document.documentElement.scrollHeight,batch:window.__fixtureBatchEnabled||false};})()', returnByValue: true }, sourceSession)).result.value;
    assert.equal(batch.status, 'completed', batch.message); assert.equal(batch.scanned, 6, JSON.stringify(batchView));
    assert.equal(batchView.token, initialDocument); assert.equal(batchView.id, 'fixture-5'); assert.equal(batchView.detail, 'fixture-5');
    assert.ok(batchView.scroll > 0 && batchView.visible && batchView.cards > 5);
    assert.equal(batchView.contacts, beforeBatch);
    const batchRecords = (await call('GET_RECORDS')).data;
    assert.equal(batchRecords.filter(r => r.status === 'preview').length, 6);
    assert.ok(batchRecords.every(r => r.job.description.includes('当前岗位编号：' + r.job.id)));
    const batchShot = await request('Page.captureScreenshot', { format: 'png' }, sourceSession);
    fs.writeFileSync(path.join(root, 'artifacts', 'list-follow-current-job.png'), Buffer.from(batchShot.data, 'base64'));
    console.log('PASS Edge fixture: incremental lazy loading, six scoped JDs, visible current card, scroll follow, same document throughout');
    await call('CLEAR_RECORDS');
    await call('SAVE_CONFIG', { config: { ...config, customGreeting: false, maxScan: 1 } });
    await request('Runtime.evaluate', { expression: 'sessionStorage.removeItem("fixture-mode");document.querySelector("a[href*=fixture-4]").click();true', returnByValue: true }, sourceSession);
    await poll(async () => (await request('Runtime.evaluate', { expression: 'document.querySelector(".job-detail-box").dataset.jobId === "fixture-4"', returnByValue: true }, sourceSession)).result.value);
    await request('Runtime.evaluate', { expression: 'sessionStorage.setItem("fixture-mode","stale-detail")', returnByValue: true }, sourceSession);
    const beforeStale = (await request('Runtime.evaluate', { expression: 'window.__fixtureCommunications||0', returnByValue: true }, sourceSession)).result.value;
    assert.ok((await call('START', { tabId })).ok);
    const stale = await poll(async () => { const state = (await call('GET_STATE')).data; return ['error', 'completed'].includes(state.status) ? state : null; }, 40000);
    assert.equal(stale.status, 'error', stale.message); assert.equal(stale.sent, 0);
    const afterStale = (await request('Runtime.evaluate', { expression: '({contacts:window.__fixtureCommunications||0,token:window.__fixtureDocumentToken})', returnByValue: true }, sourceSession)).result.value;
    assert.equal(afterStale.contacts, beforeStale); assert.equal(afterStale.token, initialDocument);
    console.log('PASS Edge fixture: stale right-hand job identity stops before communicating, no navigation');
    assert.equal(interceptionErrors.length, 0, interceptionErrors.join('; '));
    console.log('BOSS requests intercepted locally: ' + intercepted + '. No real recruiter contacted.');
  } finally {
    await call('STOP');
    await poll(async () => { const response = await call('GET_STATE'); return !['running', 'paused', 'stopping'].includes(response.data.status); });
    const finalState=(await call('GET_STATE')).data;
    if(finalState.reviewTabId&&finalState.reviewTabId===finalState.deliveryTabId&&finalState.reviewTabId!==finalState.sourceTabId)await evaluate('chrome.tabs.remove('+finalState.reviewTabId+')').catch(()=>{});
    await call('CLEAR_RECORDS');
    await call('SAVE_CONFIG', { config: original.data });
    await evaluate('populate(' + JSON.stringify(original.data) + '); dirty = false; true');
    if (sourceTarget) await request('Target.closeTarget', { targetId: sourceTarget }).catch(() => {});
    await request('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    socket.close();
  }
})().catch(error => { console.error(error); socket.close(); process.exitCode = 1; });
