importScripts('cities.js', 'city-codes.js', 'core.js', 'source-plans.js', 'native-sources.js', 'chat-navigation.js', 'schedules.js');
'use strict';
const C = BossCore;
const S = BossSourcePlans;
const sources = S.create(chrome.storage.local);
let run = null, workerId = null, live = false, starting = false, aborted = false, sourcePreviewing = false;
let writeTail = Promise.resolve();
// Read the current native component only; never search contact lists or
// return tokens, other jobs, or arbitrary framework state to the extension.
function inspectNativeChat(token, frame, expectedJobId, page = false) {
  if (frame && window.frameElement?.getAttribute('data-zhixiang-chat') !== token) return null;
  const root = frame ? document.querySelector('.chat-conversation') : document.querySelector('[data-zhixiang-chat="' + token + '"]');
  if (!root) return null;
  const chat = frame || page;
  const keys = chat ? ['conversation$', 'selectedFriend$'] : ['jobInfo', 'jobDetail', 'jobDetailInfo', 'detailInfo', 'jobData', 'job', 'detail', 'currentJob', 'selectedJob'];
  function read(value, depth, seen) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 6 || seen.has(value)) return null;
    seen.add(value);
    try {
      const jobId = value.encryptJobId || value.encryptedJobId || value.jobInfo?.encryptJobId || value.jobInfo?.encryptId;
      const bossId = value.encryptBossId || value.bossInfo?.encryptBossId || value.bossInfo?.encryptId;
      const securityId = value.securityId || value.jobInfo?.securityId;
      if (typeof jobId === 'string' && jobId && typeof bossId === 'string' && bossId && (chat || (typeof securityId === 'string' && securityId))) return { encryptJobId: jobId, encryptBossId: bossId, ...(!chat ? { securityId } : {}) };
      if (chat && !jobId && typeof bossId === 'string' && bossId) return { encryptBossId: bossId };
      for (const key of [...keys, 'props', '$props', 'setupState', '$data', 'data', 'ctx', 'proxy']) {
        const result = read(value[key], depth + 1, seen); if (result) return result;
      }
    } catch { /* Native metadata may disappear while rendering. */ }
    return null;
  }
  function hasList(scope) {
    const selector = '.job-card-wrapper,li.job-card-box,li.job-card,.job-list-item';
    if (!scope?.querySelectorAll) return false;
    return [...scope.querySelectorAll(selector)].some(card => card.querySelector('a[href*="/job_detail/"]') && !card.querySelector('.job-sec-text,.job-detail-text,[class*="job-sec-text"],[class*="job-description"]') && ![...card.querySelectorAll('h1,h2,h3,h4,.title')].some(el => /^(职位描述|岗位描述|岗位职责)$/.test(el.textContent.trim())));
  }
  // Vue 2 attaches __vue__ to the component root, which can be above the
  // DOM pane selected by the content script. Stop before the shared left list.
  const activeHeader = chat && (root.querySelector('.chat-header,.chat-user-info') || [...root.querySelectorAll('.user-info-wrap')].find(el => !el.closest?.('.message-item,.message-list,.user-list,.friend-list,.contact-list,.session-list')));
  const starts = chat ? [activeHeader, root] : [root.querySelector('.job-name,.job-title,h1,h2'), root.querySelector('.op-btn-chat,.btn-startchat'), root];
  const checked = new Set();
  for (const start of starts.filter(Boolean)) {
    for (let el = start, depth = 0; el && depth < 8 && el !== document.body && (!chat || root.contains(el)); el = el.parentElement, depth++) {
      if (!chat && hasList(el)) break;
      for (const component of [el.__vue__, el.__vueParentComponent]) {
        if (!component || checked.has(component)) continue;
        checked.add(component);
        if (!chat && hasList(component.$el || component.vnode?.el)) continue;
        const result = read(component, 0, new Set());
        if (result) return (chat || result.encryptJobId === expectedJobId) ? result : null;
      }
    }
  }
  return null;
}
// Executed in the page's MAIN world. Read only the nearest detail component,
// keeping an encrypted ID and its plain jobId from becoming conflicting jobs.
function inspectInlineIdentity(token) {
  const root = document.querySelector('[data-zhixiang-inspect="' + token + '"]');
  if (!root) return [];
  const title = root.querySelector('[data-zhixiang-inspect-title="' + token + '"]') || root;
  const jobKeys = ['jobDetail', 'jobDetailInfo', 'detailInfo', 'jobInfo', 'jobData', 'job', 'detail', 'currentJob', 'selectedJob'];
  const containers = ['props', '$props', 'setupState', '$data', 'data', 'ctx', 'proxy'];
  function read(value, depth, seen) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value) || depth > 5) return [];
    seen.add(value);
    try {
      for (const key of jobKeys) {
        const child = value[key];
        const nativeId = key === 'jobInfo' && (child?.encryptJobId || child?.encryptedJobId || child?.encryptId);
        const ids = typeof nativeId === 'string' && nativeId ? [nativeId] : read(child, depth + 1, seen);
        if (ids.length) return ids;
      }
      const encrypted = value.encryptJobId || value.encryptedJobId;
      if (typeof encrypted === 'string' && encrypted) return [encrypted];
      if (typeof value.jobId === 'string' && value.jobId) return [value.jobId];
      for (const key of containers) {
        const ids = read(value[key], depth + 1, seen); if (ids.length) return ids;
      }
    } catch { /* Optional framework metadata can be unavailable. */ }
    return [];
  }
  function hasList(scope) {
    const selector = '.job-card-wrapper,li.job-card-box,li.job-card,.job-list-item';
    if (!scope?.querySelectorAll) return Boolean(scope?.querySelector?.(selector));
    return [...scope.querySelectorAll(selector)].some(card => card.querySelector('a[href*="/job_detail/"]') && !card.querySelector('.job-sec-text,.job-detail-text,[class*="job-sec-text"],[class*="job-description"]') && ![...card.querySelectorAll('h1,h2,h3,h4,.title')].some(el => /^(职位描述|岗位描述|岗位职责)$/.test(el.textContent.trim())));
  }
  const checked = new Set();
  for (const start of [title, root]) {
    for (let el = start, depth = 0; el && depth < 5 && el !== document.body; el = el.parentElement, depth++) {
      if (hasList(el)) break;
      for (const component of [el.__vue__, el.__vueParentComponent]) {
        if (!component || checked.has(component)) continue;
        checked.add(component);
        const scope = component.$el || component.vnode?.el;
        if (hasList(scope)) continue;
        const ids = read(component, 0, new Set()); if (ids.length) return ids;
      }
    }
  }
  return [];
}
// Read only salary fields belonging to the explicitly marked native job.
function inspectNativeSalaries(items) {
  const jobKeys = ['jobInfo', 'jobDetail', 'jobDetailInfo', 'detailInfo', 'jobData', 'job', 'detail', 'currentJob', 'selectedJob'];
  const containers = ['props', '$props', 'setupState', '$data', 'data', 'ctx', 'proxy'];
  function read(value, id, depth, seen) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 5 || seen.has(value)) return '';
    seen.add(value);
    try {
      const identity = value.encryptJobId || value.encryptedJobId || value.jobId;
      if (identity && identity !== id) return '';
      if (identity === id) {
        for (const key of ['salaryDesc', 'salaryText', 'salary', 'displaySalary']) {
          const salary = value[key];
          if (typeof salary === 'string' && salary.length < 100 && /[0-9]/.test(salary) && !/[\uE000-\uF8FF\uFFFD]/.test(salary)) return salary;
        }
      }
      for (const key of [...jobKeys, ...containers]) { const salary = read(value[key], id, depth + 1, seen); if (salary) return salary; }
    } catch { /* Framework state can disappear during a native render. */ }
    return '';
  }
  function fromScope(root, id) {
    const starts = [root.querySelector('.job-name'), root.querySelector('.salary,.job-salary'), root].filter(Boolean);
    for (const start of starts) {
      for (let el = start, depth = 0; el && el !== document.body && depth < 6; el = el.parentElement, depth++) {
        if (el !== root && el.querySelectorAll('.job-card-wrapper a[href*="/job_detail/"],li.job-card-box a[href*="/job_detail/"]').length > 1) break;
        for (const component of [el.__vue__, el.__vueParentComponent]) {
          const salary = read(component, id, 0, new Set());
          if (salary) return salary;
        }
      }
    }
    return '';
  }
  return items.map(item => {
    const root = document.querySelector('[data-zhixiang-salary="' + item.token + '"]');
    if (!root) return { token: item.token, salary: '' };
    const own = fromScope(root, item.id);
    if (own) return { token: item.token, salary: own };
    const detailSalary = root.querySelector('.salary,.job-salary');
    // Native detail components sometimes omit clear salary data. Only use the
    // exact same job card when its encoded text and font match this detail.
    if (detailSalary && root.querySelector('.job-detail-header,.job-header')) {
      for (const link of document.querySelectorAll('a[href*="/job_detail/"]')) {
        let url; try { url = new URL(link.href); } catch { continue; }
        if (url.origin !== 'https://www.zhipin.com' || url.pathname !== '/job_detail/' + item.id + '.html') continue;
        const card = link.closest('.job-card-wrapper,li.job-card-box,li.job-card,.job-list-item');
        const cardSalary = card?.querySelector('.salary,.job-salary');
        if (!cardSalary || cardSalary.textContent.trim() !== detailSalary.textContent.trim() || getComputedStyle(cardSalary).fontFamily !== getComputedStyle(detailSalary).fontFamily) continue;
        const salary = fromScope(card, item.id);
        if (salary) return { token: item.token, salary };
      }
    }
    return { token: item.token, salary: '' };
  });
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const trusted = sender => sender.url?.startsWith(chrome.runtime.getURL('')) && ['options.html', 'popup.html'].includes(sender.url.slice(chrome.runtime.getURL('').length).split(/[?#]/)[0]);
const bossPage = sender => sender.tab && sender.frameId === 0 && new URL(sender.url).origin === 'https://www.zhipin.com';
let initialization = null;
// Browser API calls start from a delivered event, after listeners are registered.
// Only these reversible storage operations may retry a transient worker error.
async function startupStorage(operation) {
  const pauses = [150, 350, 750];
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!/\bNo SW\b/i.test(error.message || '') || attempt >= pauses.length) throw error;
      await wait(pauses[attempt]);
    }
  }
}
async function cleanStoredSettings() {
  // Keep only supported settings, including in saved scheduled-task snapshots.
  // Do not rewrite delivery history, task metadata or the running queue.
  const allowed = new Set(Object.keys(C.DEFAULTS));
  const clean = raw => raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw).filter(([key]) => allowed.has(key))) : raw;
  const [settings, savedTasks] = await Promise.all([
    startupStorage(() => chrome.storage.local.get('config')),
    startupStorage(() => chrome.storage.local.get('schedules'))
  ]);
  const changes = {}, config = clean(settings.config);
  if (JSON.stringify(config) !== JSON.stringify(settings.config)) changes.config = config;
  if (Array.isArray(savedTasks.schedules)) {
    const schedules = savedTasks.schedules.map(task => task && typeof task === 'object' && task.config
      ? { ...task, config: clean(task.config) } : task);
    if (JSON.stringify(schedules) !== JSON.stringify(savedTasks.schedules)) changes.schedules = schedules;
  }
  if (Object.keys(changes).length) await startupStorage(() => chrome.storage.local.set(changes));
}
function ensureInitialized() {
  if (initialization) return initialization;
  initialization = (async () => {
    await startupStorage(() => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }));
    await cleanStoredSettings();
    const saved = (await startupStorage(() => chrome.storage.local.get('run'))).run;
    if (saved && ['running', 'paused', 'stopping'].includes(saved.status)) {
      const interrupted = { ...saved, status: 'interrupted', message: '扩展后台曾中断。请查看记录后重新启动，未自动重发。' };
      await startupStorage(() => chrome.storage.local.set({ run: interrupted }));
      run = interrupted;
    } else run = saved || null;
  })().catch(error => {
    initialization = null; // The next event can recover instead of sharing a permanently rejected promise.
    throw new Error(/\bNo SW\b/i.test(error.message || '')
      ? '扩展后台暂未就绪，请重新打开扩展；仍失败时在扩展管理页重新加载'
      : '扩展初始化失败：' + error.message);
  });
  return initialization;
}
async function getConfig() { return C.config((await chrome.storage.local.get('config')).config); }
function publicRun() { return run ? { ...run, currentSource: run.sources?.[run.sourceIndex]?.name || '', sourceCount: run.sources?.length || 0, sources: undefined, queueLength: run.queue?.length || 0, processedCount: run.processedJobIds?.length || 0, queue: undefined, processedJobIds: undefined } : { status: 'idle', message: '等待开始', scanned: 0, matched: 0, sent: 0, attempted: 0 }; }
function pageRun(sender) {
  const state = publicRun();
  if (!sender.tab) return state;
  return { ...state, viewerTabId: sender.tab.id, pageRole: sender.tab.id === run?.sourceTabId ? 'source' : sender.tab.id === run?.deliveryTabId ? 'delivery' : 'other' };
}
function trace(event, details = {}) {
  run.trace = [...(run.trace || []), { time: Date.now(), event, jobId: run.currentJob?.id || '', position: run.queuePosition, sourceTabId: run.sourceTabId, chatTabId: run.deliveryTabId || null, ...details }].slice(-60);
}
async function verifySource(stage) {
  let info;
  try { info = await rpc(run.sourceTabId, { type: 'PING' }); }
  catch (error) { trace('source_unreachable', { stage }); throw error; }
  if (!run.sourcePageId) run.sourcePageId = info.pageId;
  if (info.pageId !== run.sourcePageId || !info.list) {
    trace('source_changed', { stage, expectedPageId: run.sourcePageId, actualPageId: info.pageId, path: info.path });
    throw new Error('原职位列表已跳转或重新加载，已停止；不会从首屏重新扫描。请复制页面诊断');
  }
  return info;
}
async function saveRun(message) {
  if (message) { run.message = message; run.viewRevision = (run.viewRevision || 0) + 1; }
  const operation = writeTail.then(() => chrome.storage.local.set({ run }));
  writeTail = operation.catch(() => {});
  await operation;
  chrome.runtime.sendMessage({ type: 'RUN_CHANGED', run: publicRun() }).catch(() => {});
  if (run?.sourceTabId) chrome.tabs.sendMessage(run.sourceTabId, { type: 'RUN_CHANGED' }).catch(() => {});
}
async function addRecord(record) {
  const runId = run?.id;
  const operation = writeTail.then(async () => {
    const records = (await chrome.storage.local.get('records')).records || [];
    records.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), runId, ...record });
    await chrome.storage.local.set({ records: records.slice(0, 2000) });
  });
  writeTail = operation.catch(() => {});
  await operation;
}
async function gate() {
  while (run?.status === 'paused' && !aborted) await wait(200);
  if (aborted || !run || run.status !== 'running') throw new Error('任务已停止');
}
async function paceSince(startedAt, seconds) {
  const deadline = startedAt + seconds * 1000;
  for (;;) {
    await gate();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await wait(Math.min(200, remaining));
  }
}
async function rpc(tabId, message, timeout = 18000) {
  let last;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await gate();
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (!response?.ok) throw Object.assign(new Error(response?.error || '页面没有返回结果'), { code: response?.code });
      return response.data;
    } catch (error) {
      last = error;
      // Only extraction / read commands may be retried. Never retry a click/send.
      if (message.type !== 'READ_DETAIL' && message.type !== 'PING') throw error;
      await wait(400);
    }
  }
  throw new Error(last?.message || '职位页面加载超时');
}
async function openSettings(sender) {
  let tab = bossPage(sender) ? sender.tab : (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find(t => t.url?.startsWith('https://www.zhipin.com/'));
  if (!tab) tab = (await chrome.tabs.query({ url: 'https://www.zhipin.com/web/geek/job*' }))[0];
  if (!tab) throw new Error('请先打开 BOSS 职位列表，再打开页面内设置');
  await connectPage(tab.id);
  const result = await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_SETTINGS' });
  if (!result?.ok) throw new Error(result?.error || '页面内设置打开失败');
  return { tabId: tab.id, embedded: true };
}
async function closeWorker() {
  const id = workerId;
  workerId = null;
  // The source list and tabs opened by the user always stay open. Only dispose
  // of the temporary page created by this run after a resolved send or no send.
  if (id === null || id === run?.sourceTabId || id !== run?.deliveryTabId) return;
  if (run.pendingDelivery?.tabId === id && !run.pendingDelivery.resolved && !(run.sentJobIds || []).includes(run.pendingDelivery.job.id)) {
    run.reviewTabId = id;
    return;
  }
  try { await chrome.tabs.remove(id); } catch { /* Already closed by the user. */ }
  run.deliveryTabId = null;
}
function customTask(sender, message, paused = false, source = false) {
  const tabId = source ? run?.sourceTabId : run?.pendingDelivery?.tabId;
  if (!bossPage(sender) || aborted || sender.tab.id !== tabId || run?.id !== message.runId || run.pendingDelivery?.job.id !== message.jobId || !run.pendingDelivery.customOnly || !(paused ? ['running', 'paused'] : ['running']).includes(run.status)) throw new Error('自定义消息不属于当前任务或任务已停止');
  return run.pendingDelivery;
}
function appendQueue(candidates, max) {
  const known = new Set(run.queue.map(job => job.id));
  let added = 0;
  for (const candidate of candidates || []) {
    const identity = C.jobIdentity(candidate.url);
    if (added >= max) break;
    if (identity && !known.has(identity.id) && typeof candidate.title === 'string' && candidate.title.trim()) {
      run.queue.push({ ...candidate, ...identity }); known.add(identity.id); added++;
    }
  }
  trace('queue_append', { added, length: run.queue.length });
  return added;
}
function markProcessed(id) {
  if (run.processedJobIds.includes(id)) return;
  run.processedJobIds.push(id);
  run.scanned++;
}
async function navigationTask(action) {
  const token = run?.pendingDelivery?.navigationToken;
  if (!token) return null;
  const result = await chrome.scripting.executeScript({ target: { tabId: run.sourceTabId }, world: 'MAIN', func: BossChatNavigation, args: [action, token] });
  return result?.[0]?.result;
}
async function clearNavigationTask() {
  if (!run?.pendingDelivery?.navigationToken) return;
  try { await navigationTask('clear'); } catch { /* A manually closed or reloaded list is never reopened. */ }
  delete run.pendingDelivery.navigationToken;
}
async function confirmDelivery(runId, jobId, kind, reason, deliveryProof) {
  const operation = writeTail.then(async () => {
    if (run?.id !== runId || run.pendingDelivery?.job.id !== jobId) throw new Error('发送确认不属于当前岗位');
    const pending = run.pendingDelivery;
    if (kind !== (pending.customOnly ? 'custom' : 'boss_default')) throw new Error('发送凭据与当前消息模式不一致');
    const records = (await chrome.storage.local.get('records')).records || [];
    const receiptId = runId + ':' + jobId + ':' + kind;
    if (records.some(r => r.receiptId === receiptId)) return;
    const sentJobs = run.sentJobIds || [];
    const next = { ...run, lastGreetingAt: Date.now(), sentJobIds: [...new Set([...sentJobs, jobId])], sent: sentJobs.includes(jobId) ? run.sent : run.sent + 1 };
    const record = { id: crypto.randomUUID(), time: new Date().toISOString(), runId, job: pending.job, analysis: pending.analysis,
      greeting: kind === 'custom' ? pending.greeting : '', status: 'sent', deliveryKind: kind, deliveryProof, receiptId, reason };
    // Save the receipt and counter together before dismissing a success dialog or navigating.
    await chrome.storage.local.set({ records: [record, ...records].slice(0, 2000), run: next });
    run.sent = next.sent;
    run.sentJobIds = next.sentJobIds;
    run.lastGreetingAt = next.lastGreetingAt;
  });
  writeTail = operation.catch(() => {});
  await operation;
  // Publish the saved counter immediately, including while the notice closes.
  chrome.runtime.sendMessage({ type: 'RUN_CHANGED', run: publicRun() }).catch(() => {});
  if (run?.sourceTabId) chrome.tabs.sendMessage(run.sourceTabId, { type: 'RUN_CHANGED' }).catch(() => {});
  return { recorded: true };
}
async function clickInCurrentTab(sender, message) {
  const pagination = message.purpose === 'pagination';
  const boundJob = message.purpose === 'select' || pagination ? run?.currentJob : run?.pendingDelivery?.job;
  if (!bossPage(sender) || aborted || run?.id !== message.runId || workerId !== sender.tab.id || run.status !== 'running' || boundJob?.id !== message.jobId) throw new Error('页面点击已取消');
  if (pagination && (run.phase !== 'pagination' || sender.tab.id !== run.sourceTabId)) throw new Error('翻页不属于当前列表任务');
  if (!/^[a-f0-9-]{36}$/.test(message.token || '')) throw new Error('页面点击标记无效');
  const captureInList = !pagination && Boolean(run.pendingDelivery?.navigationToken && sender.tab.id === run.sourceTabId);
  const results = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: 'MAIN', args: [message.token, captureInList, pagination], func: (token, captureInList, pagination) => {
    const button = document.querySelector('[data-zhixiang-click="' + token + '"]');
    if (!button) throw new Error('待点击按钮已变化');
    button.removeAttribute('data-zhixiang-click');
    if (pagination) { button.click(); return { clicked: true, navigation: '' }; }
    const originalOpen = window.open;
    let navigation = '';
    // Native handlers must see an uncancelled event. Cancel default navigation
    // after their target/document handlers, at the end of bubbling.
    const preventNavigation = event => {
      if (!event.composedPath().includes(button)) return;
      // Let a genuine chat anchor reach the Navigation API capture as well.
      // Other anchors (including job selection) retain the baseline behavior.
      if (captureInList && button.matches('a[href]')) {
        if (window.__qutouChatNavigation?.url) { event.preventDefault(); return; }
        const url = new URL(button.href, location.href);
        if (url.origin === 'https://www.zhipin.com' && /^\/web\/geek\/chat\/?$/.test(url.pathname)) return;
      }
      event.preventDefault();
    };
    window.addEventListener('click', preventNavigation);
    if (!captureInList) window.open = function (url) {
      const destination = new URL(url, location.href);
      if (destination.origin !== location.origin) return null;
      navigation = destination.href; return null;
    };
    try { button.click(); return { clicked: true, navigation }; }
    finally { if (!captureInList) window.open = originalOpen; window.removeEventListener('click', preventNavigation); }
  } });
  if (!results?.[0]?.result) throw new Error('页面点击未执行');
  return results[0].result;
}
async function connectPage(tabId, show = false) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith('https://www.zhipin.com/')) throw new Error('请先打开 BOSS 直聘页面');
  if (!await chrome.permissions.contains({ origins: ['https://www.zhipin.com/*'] })) throw new Error('请在扩展详细信息中允许访问 BOSS 直聘');
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (!response?.ok || response.data?.version !== chrome.runtime.getManifest().version) throw new Error('页面连接失败');
  } catch (error) {
    if (!/Receiving end|message port|Could not establish|页面连接失败/i.test(error.message)) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['cities.js', 'core.js', 'salary.js', 'content.js'] });
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (!response?.ok) throw new Error('页面连接失败，请刷新 BOSS 页面');
  }
  if (show) {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'SHOW_PANEL' });
    if (!response?.ok) throw new Error('面板恢复失败，请刷新 BOSS 页面');
  }
  return { connected: true };
}
async function reconnectOpenPages() {
  const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' });
  await Promise.allSettled(tabs.map(tab => connectPage(tab.id)));
}
function reconnectAfterStartup() {
  // Both initialization and reconnection have rejection handlers from the first event.
  void ensureInitialized().then(async () => { await scheduler.restore(true); await reconnectOpenPages(); }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(reconnectAfterStartup);
chrome.runtime.onStartup.addListener(reconnectAfterStartup);
async function sendJob(job, analysis, greeting, customOnly, delivery, intervalSeconds) {
  await gate();
  if (run.lastGreetingAt && Date.now() < run.lastGreetingAt + intervalSeconds * 1000) {
    await saveRun('岗位符合，等待打招呼间隔：' + job.title);
    await paceSince(run.lastGreetingAt, intervalSeconds);
  }
  // Persist intent before the first irreversible click to prevent a restart from duplicating it.
  run.attempted++;
  run.phase = 'chat';
  run.pendingDelivery = { job, analysis, greeting, customOnly, tabId: run.sourceTabId };
  run.lastGreetingAt = Date.now();
  await addRecord({ job, analysis, greeting, status: 'communication_requested', reason: customOnly ? '岗位筛选通过，准备进入原生聊天页发送插件文案；尚未确认发送' : '即将点击立即沟通，发送 BOSS 默认招呼；尚未确认发送' });
  await saveRun('沟通：' + job.title);
  await gate();
  const target = run.sourceTabId;
  delivery.started = true;
  const outcome = await rpc(target, { type: 'COMMUNICATE', job, customGreeting: customOnly, ...(customOnly ? { greeting } : {}), runId: run.id });
  if (outcome.status === 'already_contacted') {
    run.pendingDelivery.resolved = true;
    await addRecord({ job, analysis, greeting: '', status: 'already_contacted', reason: '页面显示已沟通' });
    return;
  }
  await saveRun((customOnly ? '恢复文案并发送自定义消息：' : '等待 BOSS 确认发送：') + job.title);
  // A chat navigation destroys the content-script message channel; COMMUNICATE replies before clicking.
  let deliveryConfirmed = false, waitReason = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    await gate();
    deliveryConfirmed ||= (run.sentJobIds || []).includes(job.id);
    await wait(400);
    try {
      const target = run.pendingDelivery.tabId;
      const r = await chrome.tabs.sendMessage(target, { type: 'CHECK_DELIVERY', job, recipient: outcome.recipient, runId: run.id });
      if (!r?.ok && r?.error) throw new Error(r.error);
      if (r?.data?.identityCheck) run.pendingDelivery.identityCheck = r.data.identityCheck;
      waitReason = r?.data?.waitReason || waitReason;
      if (customOnly && r?.data?.customSent && (run.sentJobIds || []).includes(job.id)) { deliveryConfirmed = true; break; }
      if (r?.data?.blocked) { delivery.observedGreeting = r.data.observedGreeting || ''; throw new Error(r.data.reason); }
      if (customOnly && r?.data?.defaultSent) throw new Error('检测到 BOSS 已发送默认招呼，未补发自定义消息；请关闭 BOSS 自动招呼后核实');
      if (customOnly && r?.data?.ready) {
        const result = await rpc(target, { type: 'SEND_GREETING', job, recipient: r.data.recipient || outcome.recipient, greeting, runId: run.id });
        if (result?.receiptCheck) run.pendingDelivery.receiptCheck = result.receiptCheck;
        if (!result?.sent) { delivery.observedGreeting = result?.observedGreeting || ''; throw new Error(result?.reason || '自定义消息发送未确认，禁止自动重发'); }
        await confirmDelivery(run.id, job.id, 'custom', '已在当前聊天的发出消息中确认自定义消息');
        deliveryConfirmed = true;
        break;
      }
      if (r?.ok && r.data?.defaultSent) {
        await confirmDelivery(run.id, job.id, 'boss_default', 'BOSS 页面已确认默认招呼发送成功');
        deliveryConfirmed = true;
        break;
      }
      if (r?.data?.blocked) throw new Error(r.data.reason);
    } catch (error) {
      if (!/Receiving end|message (?:port|channel).*closed|back\/forward cache|Could not establish/i.test(error.message)) throw error;
      // A confirmed receipt survives even if navigation destroys the content-script channel.
      if ((run.sentJobIds || []).includes(job.id)) { deliveryConfirmed = true; break; }
    }
  }
  if (!deliveryConfirmed && !(run.sentJobIds || []).includes(job.id)) throw new Error(customOnly ? (waitReason || '未能确认当前岗位的聊天入口或自定义消息发送结果') + '；未重试，请人工核实' : '未看到 BOSS 招呼发送成功凭据，已保留待核实记录');
  await clearNavigationTask();
  trace('send_complete', { sent: run.sent, deliveryTabId: run.pendingDelivery.tabId });
  await verifySource('after_send');
  if (customOnly) await saveRun('消息已发送，继续原列表的下一岗位…');
}

async function loadNextPage(c) {
  const before = await rpc(run.sourceTabId, { type: 'LIST_PROGRESS' });
  const key = before.url + '\n' + before.ids.join(',');
  run.visitedListPages ||= [];
  if (run.visitedListPages.includes(key)) { run.completionDetail = '下一页未产生新岗位，已停止重复翻页'; return false; }
  run.visitedListPages.push(key);
  run.phase = 'pagination';
  await saveRun('当前列表没有新增岗位，尝试下一页；保留已投 ' + run.sent + ' 人…');
  const clicked = await rpc(run.sourceTabId, { type: 'NEXT_PAGE', runId: run.id, job: run.currentJob });
  if (!clicked.clicked) return false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await gate();
    const tab = await chrome.tabs.get(run.sourceTabId);
    if (tab.status === 'loading') { await wait(200); continue; }
    if (!C.isJobListUrl(tab.url)) throw Error('翻页后未停留在职位列表，已停止；不会自动返回首页');
    try {
      await connectPage(run.sourceTabId);
      const response = await chrome.tabs.sendMessage(run.sourceTabId, { type: 'LIST_PROGRESS' });
      if (!response?.ok) { await wait(200); continue; }
      const info = response.data;
      if (info.blocked) throw Error(info.blocked);
      if (info.paginationError) throw Error(info.paginationError);
      if (!info.loading && info.ids.some(id => !run.queue.some(job => job.id === id))) {
        const result = await chrome.tabs.sendMessage(run.sourceTabId, { type: 'SCAN', max: c.maxScan, known: run.queue.map(job => job.id) });
        if (!result?.ok) throw Error(result?.error || '下一页读取失败');
        const added = appendQueue(result.data, c.maxScan);
        if (added) {
          // Only this acknowledged pagination action can adopt a replacement
          // document. Ordinary source-page changes still fail verifySource.
          run.sourcePageId = info.pageId; run.sourceUrl = tab.url;
          trace('next_page', { added }); await saveRun('下一页已加载，继续原投递进度'); return true;
        }
      }
    } catch (error) {
      if (!/Receiving end|message port|Could not establish|页面连接失败/i.test(error.message)) throw error;
    }
    await wait(200);
  }
  run.completionDetail = '点击下一页后没有读取到新增岗位';
  return false;
}
async function nativeSources(tabId, action = 'read', entry = null) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: BossNativeSources, args: [action, { ...entry, cityNames: Object.keys(globalThis.BossCityCodes || {}) }] });
  if (!result?.[0]?.result) throw Error('没有读取到求职入口，请刷新 BOSS 职位页后重试');
  return result[0].result;
}
function sourceUrlKey(address) {
  const u = S.listUrl(address); if (!u) return '';
  u.hash = ''; u.searchParams.sort(); return u.href;
}
async function activateSourceTab(tabId, focusWindow = false) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId !== undefined && chrome.windows?.get) {
    const window = await chrome.windows.get(tab.windowId);
    if (window.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal', focused: true });
    else if (focusWindow) await chrome.windows.update(tab.windowId, { focused: true });
  }
  return tab;
}
async function readySource(tabId, cancelled, expectedUrl = '', previousPageId = '') {
  const deadline = Date.now() + 20000;
  let last = '职位列表尚未加载', previous = '';
  while (Date.now() < deadline) {
    if (cancelled()) throw Error('定时启动已取消');
    const tab = await chrome.tabs.get(tabId);
    if (!C.isJobListUrl(tab.url) && tab.status === 'complete') throw Error('职位页需要登录或已跳转，请手动处理');
    if (C.isJobListUrl(tab.url) && tab.status === 'complete') {
      if (expectedUrl && sourceUrlKey(tab.url) !== sourceUrlKey(expectedUrl)) { previous = ''; last = '正在打开保存的职位链接'; await wait(150); continue; }
      try {
        await connectPage(tabId);
        const result = await chrome.tabs.sendMessage(tabId, { type: 'LIST_PROGRESS' });
        if (result?.ok && result.data.blocked) throw Error(result.data.blocked);
        const info = result?.data;
        if (result?.ok && info.ready !== false && info.visible !== false && !info.loading && (!previousPageId || info.pageId !== previousPageId) && (!info.url || sourceUrlKey(info.url) === sourceUrlKey(expectedUrl || tab.url)) && (info.ids.length || info.empty)) {
          const snapshot = sourceUrlKey(info.url || tab.url) + '\n' + info.pageId + '\n' + info.ids.join(',') + '\n' + Boolean(info.empty);
          if (snapshot === previous) return info;
          previous = snapshot;
        } else previous = '';
        if (info?.visible === false) last = '目标职位页尚未可见';
        last = result?.error || last;
      } catch (error) {
        last = error.message;
        if (/登录|验证|频繁|上限|限制/.test(last)) throw error;
      }
    }
    await wait(250);
  }
  throw Error(last + '，本链接未启动');
}
function sourceFatal(error) { return /登录|验证|频繁|上限|限制|取消|任务已停止/.test(error.message); }
async function applySourceConditions(tabId, plan, cancelled) {
  const wanted = S.conditionsFor(plan, await sources.catalog());
  const sameEntry = entry => entry?.selected && (wanted.entry.id && (entry.id === wanted.entry.id || entry.legacyId === wanted.entry.id) || S.key(entry.label) === S.key(wanted.entry.label));
  const read = () => nativeSources(tabId, 'read', wanted);
  async function until(predicate, reason, seconds = 8) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (cancelled()) throw Error('定时启动已取消');
      const page = await chrome.tabs.get(tabId);
      if (page.status === 'complete' && !C.isJobListUrl(page.url)) throw Error('职位页需要登录或已跳转，请手动处理');
      if (page.status === 'complete') {
        const progress = await chrome.tabs.sendMessage(tabId, { type: 'LIST_PROGRESS' }).catch(() => null);
        if (progress?.data?.blocked) throw Error(progress.data.blocked);
        try { const state = await read(); if (predicate(state)) return state; } catch (error) { if (sourceFatal(error)) throw error; }
      }
      await wait(250);
    }
    throw Error(reason + '；本链接未开始扫描');
  }
  let state = await read();
  let changedFromRevision = null;
  if (!state.entries.some(sameEntry)) {
    const changed = await nativeSources(tabId, 'activate', wanted.entry);
    if (changed.missing) throw Error(changed.reason);
    if (changed.clicked && Number.isInteger(changed.list?.revision)) changedFromRevision = changed.list.revision;
    await wait(250);
    state = await until(s => s.entries.some(sameEntry), '未能切换到求职期望「' + wanted.entry.label + '」');
  }
  for (const kind of ['city', 'jobType', 'degree']) {
    const value = kind === 'city' ? wanted.cityCode : wanted[kind];
    const label = kind === 'city' ? wanted.city || '全国' : (kind === 'jobType' ? S.jobTypes : S.degrees).find(o => o.value === value)?.label;
    const matches = s => kind === 'city' ? s.filters?.city !== undefined && S.cityKey(s.filters.city) === S.cityKey(wanted.city) : s.filters?.[kind] === value;
    if (matches(state)) continue;
    const request = { ...wanted, kind, value, label };
    const opened = await nativeSources(tabId, 'filter', { ...request, phase: 'open' });
    if (opened.missing) throw Error(opened.reason);
    const groups = new Set(); let clicked = false, hovered = false, last = '';
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !clicked) {
      if (cancelled()) throw Error('定时启动已取消');
      await wait(250);
      const option = await nativeSources(tabId, 'filter', { ...request, phase: 'option' });
      if (option.missing) throw Error(option.reason);
      if ((option.changed || option.clicked && !option.selected) && Number.isInteger(option.list?.revision)) changedFromRevision = option.list.revision;
      clicked = Boolean(option.clicked); last = option.reason || '';
      if (!clicked) {
        if (option.needsHover && !hovered) { hovered = true; await nativeSources(tabId, 'filter', { ...request, phase: 'hover' }); }
        const group = option.groups?.find(g => !groups.has(g));
        if (group) { groups.add(group); await nativeSources(tabId, 'filter', { ...request, phase: 'group', group }); }
      }
    }
    if (!clicked) throw Error(last || '未能应用列表条件「' + label + '」');
    state = await until(matches, '未能应用列表条件「' + label + '」');
  }
  if (changedFromRevision !== null || state.list?.loading) state = await until(s => !s.list?.loading && (changedFromRevision === null || s.list?.revision > changedFromRevision), '入口条件已切换，岗位列表尚未更新', 15);
  // Entry and filters are checked only once at source startup. They are not
  // inferred from the shared URL or rechecked for individual job cards.
  if (!state.entries.some(sameEntry)) throw Error('原生筛选切换了求职入口，本链接未开始扫描');
  if (S.cityKey(state.filters?.city) !== S.cityKey(wanted.city) || state.filters?.jobType !== wanted.jobType || state.filters?.degree !== wanted.degree) throw Error('等待列表期间筛选条件发生变化，本链接未开始扫描');
  if (wanted.keyword && state.filters?.keyword !== wanted.keyword) throw Error('搜索关键词未生效；本链接未开始扫描');
  return state;
}
async function prepareSource(plan, cancelled = () => false, existingTabId = null) {
  if (cancelled()) throw Error('定时启动已取消');
  const opened = await chrome.tabs.query({ url: 'https://www.zhipin.com/web/geek/job*' });
  let previousPageId = '';
  let tab = existingTabId === null ? opened.filter(t => sourceUrlKey(t.url) && sourceUrlKey(t.url) === sourceUrlKey(plan.sourceUrl)).sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] : await chrome.tabs.get(existingTabId);
  if (tab && !C.isJobListUrl(tab.url)) throw Error('当前页面已离开职位列表');
  if (!tab) {
    // Reuse the tab owned by this run when switching schemes, retaining all
    // queue IDs and counters. Never open a new tab on every pagination retry.
    if (live && run?.sourceTabId) {
      try { const before = await chrome.tabs.sendMessage(run.sourceTabId, { type: 'PING' }); previousPageId = before?.data?.pageId || ''; } catch { /* The new document will establish a fresh page binding. */ }
      tab = await chrome.tabs.update(run.sourceTabId, { url: plan.sourceUrl, active: true });
    } else tab = await chrome.tabs.create({ url: plan.sourceUrl, active: true });
  }
  if (cancelled()) throw Error('定时启动已取消');
  await activateSourceTab(tab.id);
  // Native recommendation/expectation views share a URL. Apply the saved
  // entry and filters before the worker reads any job cards.
  await readySource(tab.id, cancelled, plan.legacy ? plan.sourceUrl : '', previousPageId);
  const applied = plan.legacy ? null : await applySourceConditions(tab.id, plan, cancelled);
  const progress = await readySource(tab.id, cancelled);
  if (applied) progress.conditions = { entry: applied.entries.find(e => e.selected), ...applied.filters };
  return { tabId: tab.id, progress };
}
async function previewSource(plan, existingTabId = null) {
  if (live || starting || sourcePreviewing || scheduler.launching || ['running', 'paused', 'stopping'].includes(run?.status)) throw Error('已有任务或链接正在处理，请先等待结束');
  sourcePreviewing = true;
  try { const page = await prepareSource(plan, () => false, existingTabId); await activateSourceTab(page.tabId, true); return { opened: true, label: S.describe(plan) }; }
  finally { sourcePreviewing = false; }
}
async function prepareSources(plans, cancelled) {
  const results = [];
  for (let index = 0; index < plans.length; index++) {
    try { return { ...(await prepareSource(plans[index], cancelled)), index, results }; }
    catch (error) {
      if (sourceFatal(error)) throw error;
      results.push({ name: plans[index].name, status: 'skipped', sent: 0, targetJobs: plans[index].targetJobs, reason: error.message });
    }
  }
  throw Error(results.map(r => r.name + '：' + r.reason).join('；') || '没有可执行的搜索方案');
}
async function switchSource(baseConfig, reason = 'exhausted') {
  if (!run.sources?.length) return null;
  run.sourceResults ||= [];
  const current = run.sources[run.sourceIndex];
  run.sourceResults.push({ name: current.name, status: reason, sent: run.sent - (run.sourceStartedSent || 0), targetJobs: current.targetJobs });
  while (run.sourceIndex + 1 < run.sources.length) {
    await gate();
    const index = run.sourceIndex + 1, plan = run.sources[index];
    run.sourceIndex = index; run.phase = 'source';
    await saveRun('切换链接：' + plan.name + '；已投 ' + run.sent + ' / ' + run.targetJobs + ' 人');
    try {
      const prepared = await prepareSource(plan, () => aborted);
      await gate();
      run.sourceTabId = workerId = prepared.tabId;
      run.sourcePageId = prepared.progress.pageId; run.sourceUrl = prepared.progress.url;
      run.sourceStartedSent = run.sent; run.visitedListPages = []; run.completionDetail = '';
      // A quota can end a link before its queue is exhausted. Drop only its
      // unvisited tail so those jobs are not processed under the next URL.
      run.queue = run.queue.slice(0, run.queuePosition);
      run.pendingDelivery = null;
      // This is the only deliberate source change. All processed/sent IDs,
      // queue position, and last greeting time survive the transition.
      const c = C.config(S.configFor(plan, baseConfig));
      const current = await rpc(prepared.tabId, { type: 'SCAN', max: c.maxScan, known: run.queue.map(j => j.id) });
      appendQueue(current, c.maxScan);
      trace('source_switch', { name: plan.name, index }); await saveRun('开始链接：' + plan.name);
      return c;
    } catch (error) {
      if (sourceFatal(error)) throw error;
      run.sourceResults.push({ name: plan.name, status: 'skipped', sent: 0, targetJobs: plan.targetJobs, reason: error.message });
      await saveRun('跳过链接「' + plan.name + '」：' + error.message);
    }
  }
  run.completionDetail = '所有职位链接均已处理完';
  return null;
}
async function runQueue(c) {
  const baseConfig = c;
  if (run.sources?.length) c = C.config(S.configFor(run.sources[run.sourceIndex], baseConfig));
  // Extension API calls keep an active operation alive; interruption still fails closed on restart.
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
    // Keep the navigation capture armed across a long pause. If the worker
    // dies, the page hook still expires instead of trapping manual chat links.
    if (run?.pendingDelivery?.navigationToken) void navigationTask('read').catch(() => {});
  }, 20000);
  live = true;
  const missingCards = new Map();
  let retryItem = null;
  try {
    while (!run.preview || run.scanned < c.maxScan) {
      await gate();
      const quota = run.sources?.[run.sourceIndex]?.targetJobs;
      if (!run.preview && quota && run.sent - (run.sourceStartedSent || 0) >= quota) {
        const nextConfig = await switchSource(baseConfig, 'quota_reached');
        if (nextConfig) { c = nextConfig; continue; }
        run.completionReason = 'links_done'; break;
      }
      if (!run.preview && run.sent >= c.maxJobs) { run.completionReason = 'target'; break; }
      workerId = run.sourceTabId;
      while (run.queuePosition < run.queue.length && run.processedJobIds.includes(run.queue[run.queuePosition].id)) run.queuePosition++;
      if (!retryItem && run.queuePosition >= run.queue.length) {
        if (run.singleJob) { run.completionReason = 'single_job'; break; }
        run.phase = 'loading';
        await saveRun('向下加载更多岗位…');
        await verifySource('load_more');
        trace('scan_more', { known: run.queue.length });
        const more = await rpc(run.sourceTabId, { type: 'SCAN_MORE', max: c.maxScan, known: run.queue.map(job => job.id), intervalSeconds: c.browseIntervalSeconds, runId: run.id });
        const added = appendQueue(Array.isArray(more) ? more : more.jobs || [], c.maxScan);
        if (!added && !(more.nextPage && await loadNextPage(c))) {
          const nextConfig = await switchSource(baseConfig);
          if (nextConfig) { c = nextConfig; continue; }
          run.completionReason = 'list_exhausted'; break;
        }
      }
      const item = retryItem || run.queue[run.queuePosition++];
      retryItem = null;
      item.monthlySalary = C.monthlySalary(item.salary, c.salaryWorkDays);
      run.current = item.title;
      run.currentJob = item;
      run.phase = 'card';
      run.message = '卡片初筛：' + item.title;
      run.viewRevision = (run.viewRevision || 0) + 1;
      let job = item, analysis = null, greeting = '', retainWorker = false, failed = false, refreshing = false;
      const delivery = { started: false, observedGreeting: '' };
      const customOnly = c.greetingMode === 'custom';
      let browseStartedAt = null, localResultSaved = false;
      try {
        workerId = run.sourceTabId;
        await gate();
        // Following a card only changes local highlighting/scrolling. Rejected
        // cards stay visible without clicking them or requesting their JD.
        await rpc(workerId, { type: 'FOCUS_JOB', job: item, runId: run.id, instant: true, state: publicRun() });
        const previous = (await chrome.storage.local.get('records')).records || [];
        if (previous.some(r => r.job.id === item.id && ['sent', 'communication_requested', 'uncertain', 'already_contacted'].includes(r.status))) {
          markProcessed(item.id);
          await saveRun('跳过历史已沟通或待核实岗位：' + item.title);
          localResultSaved = true;
          continue;
        }
        const pre = C.filters(item, c, 'card');
        if (!pre.match) {
          const reason = pre.reasons.join('；');
          await addRecord({ job: item, status: 'filtered', reason });
          markProcessed(item.id);
          trace('card_filtered');
          await saveRun('卡片初筛跳过：' + item.title + '；' + reason);
          localResultSaved = true;
          continue;
        }
        browseStartedAt = Date.now();
        await verifySource('select_job');
        run.phase = 'detail';
        await saveRun('读取完整 JD：' + item.title);
        await rpc(workerId, { type: 'SELECT_JOB', job: item, runId: run.id, focused: true, browseIntervalSeconds: c.browseIntervalSeconds });
        await gate();
        const detail = await rpc(workerId, { type: 'READ_DETAIL', id: item.id });
        job = { ...item, ...detail, cardLocation: item.location || '', detailLocation: detail.location || '', id: item.id, url: item.url };
        job.monthlySalary = C.monthlySalary(job.salary, c.salaryWorkDays);
        trace('detail_ready');
        await gate();
        const hard = C.filters(job, c);
        if (!hard.match) {
          const reason = hard.reasons.join('；');
          await addRecord({ job, status: 'filtered', reason });
          await saveRun('跳过：' + reason);
          continue;
        }
        if (!job.description || job.description.trim().length < 20) throw new Error('未读取到完整 JD，已停止');
        await saveRun('正在筛选：' + job.title);
        greeting = customOnly ? c.greetingTemplate : '';
        if (customOnly) greeting = C.template(job, c);
        if (customOnly && !greeting) throw new Error('自定义消息为空，未建立沟通');
        analysis = { match: true, reasons: ['条件筛选通过'], evidence: [], score: null, greeting };
        await gate();
        run.matched++;
        if (run.preview) {
          await addRecord({ job, analysis, greeting, status: 'preview', reason: '仅分析，未点击沟通、未发送消息' });
          continue;
        }
        await sendJob(job, analysis, greeting, customOnly, delivery, c.intervalSeconds);
      } catch (error) {
        if (!delivery.started && error.code === 'JOB_CARD_UNREACHABLE') {
          await addRecord({ job, status: 'skipped', reason: '当前卡片未能定位，已跳过该岗继续列表；未点击沟通或发送消息' });
          trace('card_unreachable');
          await saveRun('跳过无法定位的卡片，继续下一岗位：' + item.title);
        } else if (!delivery.started && !run.singleJob && error.code === 'JOB_CARD_MISSING') {
          // Native list rendering can replace a queued card between reads. Rebuild
          // from the current DOM; this does not retry communication or sending.
          const attempts = (missingCards.get(item.id) || 0) + 1;
          missingCards.set(item.id, attempts);
          await verifySource('missing_card');
          trace('scan_refresh', { reason: 'card_missing', attempts });
          await saveRun('列表已更新，保留 ' + run.sent + ' / ' + c.maxJobs + ' 进度并继续读取岗位…');
          const current = await rpc(run.sourceTabId, { type: 'SCAN', max: c.maxScan, known: run.processedJobIds });
          appendQueue(current, c.maxScan);
          const present = current.find(candidate => candidate.id === item.id);
          refreshing = attempts < 2 && Boolean(present);
          if (refreshing) retryItem = { ...item, ...present };
          else await addRecord({ job, status: 'skipped', reason: '岗位卡片已移除或持续更新，本批跳过；未点击沟通或发送消息' });
        } else {
          failed = true;
          retainWorker = !aborted && delivery.started;
          const confirmed = (run.sentJobIds || []).includes(job.id);
          if (!aborted || !confirmed) await addRecord({ job, analysis, greeting, observedGreeting: delivery.observedGreeting, deliveryKind: customOnly ? 'custom' : 'boss_default', status: confirmed ? 'error' : delivery.started ? 'uncertain' : 'error', reason: confirmed ? '消息已确认发送，后续列表处理未完成：' + error.message : error.message });
          throw error;
        }
      } finally {
        await clearNavigationTask();
        if (!refreshing) markProcessed(item.id);
        if (retainWorker && workerId !== null) {
          run.reviewTabId = workerId;
          workerId = null; // Preserve the current page for manual verification.
        } else await closeWorker();
        if (!localResultSaved) await saveRun();
        if (browseStartedAt !== null && !aborted && !failed && (run.preview ? run.scanned < c.maxScan : run.sent < c.maxJobs) && !run.singleJob) await paceSince(browseStartedAt, c.browseIntervalSeconds);
      }
    }
    run.status = aborted ? 'stopped' : 'completed';
    if (run.sources?.length && !['list_exhausted', 'links_done'].includes(run.completionReason)) run.sourceResults.push({ name: run.sources[run.sourceIndex].name, status: aborted ? 'stopped' : 'completed', sent: run.sent - (run.sourceStartedSent || 0), targetJobs: run.sources[run.sourceIndex].targetJobs });
    await saveRun(aborted ? '任务已停止。' : run.preview ? '分析完成。结果已保存到投递记录。' : run.sent >= c.maxJobs ? '目标已完成：已向 ' + run.sent + ' 个岗位打招呼。' : run.singleJob ? '当前岗位处理完成，发送记录已保存。' : (run.completionDetail || '当前列表已无更多岗位') + '，已打招呼 ' + run.sent + ' / ' + c.maxJobs + '；未达到目标。');
  } catch (error) {
    run.status = aborted ? 'stopped' : 'error';
    await saveRun(error.message);
  } finally { const finished = publicRun(); live = false; clearInterval(keepAlive); await closeWorker(); await scheduler.finish(finished).catch(() => {}); }
}
async function start(tabId, preview, oneJob, configOverride = null, scheduleInfo = null) {
  if (live || starting || sourcePreviewing || (scheduler.launching && !scheduleInfo) || ['running', 'paused', 'stopping'].includes(run?.status)) throw new Error('已有任务在运行或准备启动，请先停止');
  starting = true;
  try {
  const c = configOverride ? C.config(configOverride) : await getConfig();
  if (c.greetingMode === 'custom' && !c.greetingTemplate.trim()) throw new Error('请先填写自定义消息并保存');
  const titleRules = C.effectiveTitleGroupRules(c);
  if (titleRules.length && !titleRules.some(rule => rule.enabled)) throw new Error('所有标题关键词组已停用，请启用至少一组，或清空所有组以不限标题');
  const tab = await chrome.tabs.get(tabId);
  if (!C.isJobListUrl(tab.url)) throw new Error('请在 BOSS 职位列表启动，扩展会留在列表内处理');
  run = { id: crypto.randomUUID(), version: chrome.runtime.getManifest().version, status: 'running', preview: Boolean(preview), targetJobs: c.maxJobs, sourceTabId: tabId, sourceUrl: tab.url, queue: [], queuePosition: 0, processedJobIds: [], scanned: 0, matched: 0, sent: 0, sentJobIds: [], attempted: 0, startedAt: Date.now(), message: '正在扫描当前列表…' };
  if (scheduleInfo) {
    run.scheduleId = scheduleInfo.id; run.scheduleOccurrence = scheduleInfo.occurrence;
    run.sources = scheduleInfo.sources; run.sourceIndex = scheduleInfo.sourceIndex || 0; run.sourceResults = scheduleInfo.sourceResults || []; run.sourceStartedSent = 0;
    if (scheduleInfo.sourcePageId) run.sourcePageId = scheduleInfo.sourcePageId;
  }
  aborted = false;
  live = true;
  await saveRun();
  try {
    await connectPage(tabId);
    await verifySource('start');
    trace('scan_initial');
    const response = oneJob ? { ok: true, data: [oneJob] } : await chrome.tabs.sendMessage(tabId, { type: 'SCAN', max: c.maxScan });
    if (!response?.ok) throw new Error(response?.error || '扩展尚未连接页面，请刷新 BOSS 直聘页面');
    appendQueue(response.data, c.maxScan);
    run.singleJob = Boolean(oneJob);
    if (!run.queue.length) throw new Error('没有识别到职位卡片，请打开职位列表并加载岗位');
    await saveRun('已扫描 ' + run.queue.length + ' 个岗位');
    void runQueue(c);
    return publicRun();
  } catch (error) { live = false; run.status = 'error'; await saveRun(error.message); throw error; }
  } finally { starting = false; }
}
const scheduler = BossSchedules.create({
  storage: chrome.storage.local, alarms: chrome.alarms, tabs: chrome.tabs, core: C,
  getConfig, ready: ensureInitialized, connect: connectPage, sources, prepareSources, plans: S,
  busy: () => live || starting || sourcePreviewing || ['running', 'paused', 'stopping'].includes(run?.status),
  launch: (tabId, config, info) => start(tabId, false, null, config, info)
});
chrome.alarms?.onAlarm.addListener(alarm => { void scheduler.onAlarm(alarm).catch(() => {}); });
if (chrome.alarms) void ensureInitialized().then(() => scheduler.restore(false)).catch(() => {});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (!trusted(sender) && !bossPage(sender)) throw new Error('消息来源未授权');
    await ensureInitialized();
    const isTrusted = trusted(sender);
    switch (message.type) {
      case 'GET_PAGE_CONFIG': {
        const tasks = (await chrome.storage.local.get('schedules')).schedules || [];
        const next = tasks.filter(task => task.enabled && task.nextRunAt).sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
        return { clickApply: (await getConfig()).clickApply, ...(next ? { nextSchedule: { time: next.nextRunAt, targetJobs: next.targetJobs } } : {}) };
      }
      case 'GET_STATE': return pageRun(sender);
      case 'FOCUS_TASK_PAGE': {
        if (!run?.sourceTabId) throw Error('当前没有任务页面');
        const tab = await chrome.tabs.get(run.sourceTabId);
        if (!C.isJobListUrl(tab.url)) throw Error('任务页已关闭或离开职位列表，请先查看任务记录');
        await activateSourceTab(tab.id, true); return { focused: true };
      }
      case 'CAN_SEND': {
        const belongs = !aborted && run?.id === message.runId && sender.tab?.id === workerId;
        return { allowed: belongs && run?.status === 'running', paused: belongs && run?.status === 'paused' };
      }
      case 'PREPARE_CUSTOM_HANDOFF': {
        const pending = customTask(sender, message, false, true);
        if (pending.handoffReady) throw new Error('本岗位沟通入口已准备，禁止重复点击');
        const recipient = message.recipient || {};
        if (typeof recipient.bossId !== 'string' || !/^[a-zA-Z0-9_-]*$/.test(recipient.bossId)) throw new Error('招聘者标识无效');
        pending.recipient = { bossId: recipient.bossId, name: String(recipient.name || '').trim().slice(0, 100) };
        pending.navigationToken = crypto.randomUUID();
        const armed = await navigationTask('arm');
        if (!armed?.armed) throw new Error('无法保留原列表，尚未点击沟通');
        pending.handoffReady = true;
        trace('handoff_prepared');
        await saveRun(); return { saved: true };
      }
      case 'READ_CUSTOM_HANDOFF': {
        customTask(sender, message, true, true);
        const result = await navigationTask('read');
        if (result?.error) throw new Error(result.error);
        return result || {};
      }
      case 'OPEN_CUSTOM_CHAT': {
        const pending = customTask(sender, message, false, true);
        if (!pending.handoffReady || pending.tabId !== run.sourceTabId) throw new Error('本岗位聊天入口已打开或尚未准备');
        const url = new URL(message.url, 'https://www.zhipin.com');
        if (url.origin !== 'https://www.zhipin.com' || url.username || url.password || !/^\/web\/geek\/chat\/?$/.test(url.pathname)) throw new Error('聊天页面地址无效');
        for (const key of ['jobId', 'encryptJobId']) if (url.searchParams.has(key) && url.searchParams.get(key) !== pending.job.id) throw new Error('聊天入口与当前岗位不一致');
        for (const key of ['id', 'bossId', 'encryptBossId']) {
          const id = url.searchParams.get(key); if (!id) continue;
          if (pending.recipient?.bossId && id !== pending.recipient.bossId) throw new Error('聊天招聘者与当前岗位不一致');
          pending.recipient = { ...pending.recipient, bossId: id };
        }
        const captured = await navigationTask('read');
        if (captured?.error) throw new Error(captured.error);
        if (captured?.url !== url.href && !C.chatTarget(url.href, pending.job.id)) throw new Error('未取得当前岗位原生聊天入口，禁止打开猜测的会话');
        await verifySource('open_chat');
        pending.chatUrl = url.href;
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false, openerTabId: run.sourceTabId });
        pending.tabId = workerId = run.deliveryTabId = tab.id;
        trace('chat_open', { method: captured?.method || 'native_link', path: url.pathname });
        await saveRun('原列表保持不动，在聊天页发送自定义消息…');
        await gate();
        await chrome.tabs.update(tab.id, { url: url.href }); return { opening: true };
      }
      case 'GET_PENDING_CUSTOM': {
        const pending = customTask(sender, message, true);
        if (sender.tab.id === run.sourceTabId) throw new Error('原列表不能领取聊天发送任务');
        if (!/^\/web\/geek\/chat\/?$/.test(new URL(sender.url).pathname)) throw new Error('当前页面不是 BOSS 聊天页');
        if (!pending.handoffReady) throw new Error('本岗位尚未保存原生沟通任务，不发送消息');
        return { runId: run.id, job: pending.job, greeting: pending.greeting, recipient: pending.recipient || {}, handoffReady: true, sendAttempted: Boolean(pending.sendAttempted), delivered: (run.sentJobIds || []).includes(pending.job.id) };
      }
      case 'CLAIM_CUSTOM_SEND': {
        const operation = writeTail.then(async () => {
          const pending = customTask(sender, message);
          if (sender.tab.id === run.sourceTabId) throw new Error('原列表不能发送聊天文案');
          if (!pending.handoffReady || !/^\/web\/geek\/chat\/?$/.test(new URL(sender.url).pathname)) throw new Error('当前聊天页没有已保存的原生沟通任务，不发送消息');
          if (pending.sendAttempted || (run.sentJobIds || []).includes(pending.job.id)) throw new Error('本岗位已经尝试发送，禁止重复发送；请人工核实');
          pending.sendAttempted = true;
          await chrome.storage.local.set({ run }); return { claimed: true };
        });
        writeTail = operation.catch(() => {}); return operation;
      }
      case 'CLICK_CURRENT_TAB': return clickInCurrentTab(sender, message);
      case 'READ_NATIVE_SALARIES': {
        if (!bossPage(sender) || !Array.isArray(message.items) || message.items.length > 200 || message.items.some(item => !/^[a-f0-9-]{36}$/.test(item.token || '') || !/^[a-zA-Z0-9_-]+$/.test(item.id || ''))) throw new Error('薪资读取范围无效');
        const result = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: 'MAIN', func: inspectNativeSalaries, args: [message.items] });
        return result[0]?.result || [];
      }
      case 'INSPECT_INLINE_JOB': {
        if (!bossPage(sender) || sender.tab.id !== workerId || run?.id !== message.runId || run.currentJob?.id !== message.jobId || !/^[a-f0-9-]{36}$/.test(message.token || '')) throw new Error('详情读取不属于当前任务');
        const result = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: 'MAIN', args: [message.token], func: inspectInlineIdentity });
        return result?.[0]?.result || [];
      }
      case 'READ_NATIVE_CHAT': {
        if (!bossPage(sender) || sender.tab.id !== workerId || run?.id !== message.runId || run.pendingDelivery?.job.id !== message.jobId || !/^[a-f0-9-]{36}$/.test(message.token || '')) throw new Error('聊天身份读取不属于当前任务');
        const result = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, allFrames: Boolean(message.frame) }, world: 'MAIN', args: [message.token, Boolean(message.frame), message.jobId, Boolean(message.page)], func: inspectNativeChat });
        return result?.find(item => item.result)?.result || null;
      }
      case 'REPORT_DELIVERY': {
        if (!bossPage(sender) || sender.tab.id !== (run?.pendingDelivery?.tabId ?? run?.sourceTabId) || message.runId !== run?.id || message.jobId !== run.pendingDelivery?.job.id || !['success_dialog', 'success_notice', 'outgoing_message', 'native_editor_cleared'].includes(message.proof)) throw new Error('发送凭据不属于当前任务');
        const kind = message.kind === 'custom' ? 'custom' : 'boss_default';
        if (kind === 'custom' && (!['outgoing_message', 'native_editor_cleared'].includes(message.proof) || !run.pendingDelivery.greeting)) throw new Error('自定义消息发送凭据无效');
        if (message.proof === 'native_editor_cleared' && (kind !== 'custom' || !run.pendingDelivery.handoffReady || !run.pendingDelivery.sendAttempted || !/^\/web\/geek\/chat\/?$/.test(new URL(sender.url).pathname))) throw new Error('原生发送反馈不属于已尝试发送的聊天任务');
        const reasons = { success_dialog: '已看到 BOSS 招呼发送成功对话框', success_notice: '已看到 BOSS 招呼发送成功提示', outgoing_message: '已在当前聊天的新增消息中确认招呼语', native_editor_cleared: '原生发送后输入框持续清空，页面未显示发送中或失败，按参考插件流程记录并继续' };
        return confirmDelivery(message.runId, message.jobId, kind, reasons[message.proof], message.proof);
      }
      case 'CLICK_JOB': {
        if (!bossPage(sender) || !(await getConfig()).clickApply) throw new Error('点击投递未开启');
        return start(sender.tab.id, false, message.job);
      }
      case 'GET_CONFIG': if (isTrusted) return getConfig(); break;
      case 'GET_SOURCE_PLANS': if (isTrusted) return { plans: await sources.list(), catalog: await sources.catalog() }; break;
      case 'SAVE_SOURCE_PLAN': if (isTrusted) return sources.save(message.plan); break;
      case 'TOGGLE_SOURCE_PLAN': if (isTrusted) return sources.toggle(message.id, message.enabled); break;
      case 'DELETE_SOURCE_PLAN': if (isTrusted) return sources.remove(message.id); break;
      case 'OPEN_SOURCE_PREVIEW': if (isTrusted) {
        if (live || starting || scheduler.launching) throw Error('请在本轮投递结束后查看方案');
        const saved = message.id && (await sources.list()).find(p => p.id === message.id);
        if (message.id && !saved) throw Error('方案已删除，请刷新');
        const plan = saved || S.normalize({ ...message.plan, name: message.plan?.name || '预览方案' }, await sources.catalog());
        return previewSource(plan);
      } break;
      case 'OPEN_SCHEDULE_LINK': if (isTrusted) {
        if (live || starting || scheduler.launching) throw Error('请在本轮投递结束后查看链接');
        const plan = S.normalizeLinks([{ ...message.link, enabled: true, targetJobs: 1 }], await sources.catalog()).links[0];
        return previewSource(plan);
      } break;
      case 'REFRESH_SOURCE_CATALOG': if (isTrusted) {
        if (live || starting || scheduler.launching) throw Error('请在本轮投递结束后刷新求职期望');
        const tabs = (await chrome.tabs.query({ url: 'https://www.zhipin.com/web/geek/job*' })).filter(tab => C.isJobListUrl(tab.url)).sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
        const tab = sender.tab && C.isJobListUrl(sender.tab.url) ? sender.tab : tabs[0];
        if (!tab) throw Error('请先打开已登录的 BOSS 职位页，显示「推荐 / 求职期望」后再刷新');
        await connectPage(tab.id);
        const page = await chrome.tabs.sendMessage(tab.id, { type: 'LIST_PROGRESS' });
        if (page?.data?.blocked) throw Error(page.data.blocked);
        const result = await nativeSources(tab.id);
        const previous = await sources.catalog();
        const catalog = { entries: result.entries.map(e => ({ ...S.entry(e), selected: Boolean(e.selected) })).filter(e => e.label), cities: { ...previous.cities, ...result.cities }, refreshedAt: Date.now(), url: result.url };
        await chrome.storage.local.set({ sourceCatalog: catalog }); return catalog;
      } break;
      case 'GET_SCHEDULES': if (isTrusted) {
        const tasks = await scheduler.list();
        const catalog = await sources.catalog();
        return tasks.map(task => {
          let display = task;
          // Resolve stored numeric IDs through the current catalog while
          // preserving each task's quota, annotation and selected entry.
          if (task.links?.length) { try { display = { ...task, links: S.normalizeLinks(task.links, catalog).links }; } catch { /* Keep invalid rows editable. */ } }
          return display.lastRun?.runId && display.lastRun.runId === run?.id ? { ...display, lastRun: { ...display.lastRun, sent: run.sent || 0, status: run.status, reason: run.message } } : display;
        });
      } break;
      case 'SAVE_SCHEDULE': if (isTrusted) return scheduler.save(message.schedule); break;
      case 'TOGGLE_SCHEDULE': if (isTrusted) return scheduler.toggle(message.id, message.enabled); break;
      case 'DELETE_SCHEDULE': if (isTrusted) return scheduler.remove(message.id); break;
      case 'GET_SCHEDULE_SOURCE': if (isTrusted) {
        const opened = (await chrome.tabs.query({ url: 'https://www.zhipin.com/web/geek/job*' })).sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
        const candidates = [sender.tab, ...opened].filter(tab => tab && C.isJobListUrl(tab.url));
        const tab = candidates[0];
        if (!tab) throw new Error('请先打开要定时投递的 BOSS 职位列表，或手动粘贴列表地址');
        const info = await nativeSources(tab.id);
        const catalog = await sources.catalog();
        const captured = S.captureCurrent(info, catalog);
        const conditions = S.conditionsFor({ ...captured, sourceUrl: tab.url }, catalog);
        return { url: tab.url, title: tab.title, conditions, note: S.describe(conditions) };
      } break;
      case 'CONNECT_PAGE': if (isTrusted) return connectPage(message.tabId, true); break;
      case 'SAVE_CONFIG': if (isTrusted) {
        if (live) throw new Error('运行中无法修改配置，请先停止任务');
        const c = C.config(message.config);
        if (c.greetingMode === 'custom' && !c.greetingTemplate.trim()) throw new Error('请填写自定义消息');
        await chrome.storage.local.set({ config: c });
        return { saved: true };
      } break;
      case 'START': return start(isTrusted ? message.tabId : sender.tab.id, message.preview);
      case 'PAUSE': if (run?.status === 'running') { run.status = 'paused'; await saveRun('已暂停，等待继续'); } return publicRun();
      case 'RESUME': if (live && run?.status === 'paused') { run.status = 'running'; await saveRun('继续处理'); } return publicRun();
      case 'STOP': scheduler.cancelPending(); aborted = true; if (live) { run.status = 'stopping'; await saveRun('正在停止…'); await closeWorker(); } return publicRun();
      case 'GET_RECORDS': if (isTrusted) return (await chrome.storage.local.get('records')).records || []; break;
      case 'CLEAR_RECORDS': if (isTrusted) { if (live) throw new Error('请先停止任务'); await chrome.storage.local.set({ records: [] }); return true; } break;
      case 'OPEN_SETTINGS': return openSettings(sender);
    }
    throw new Error('不支持的操作或没有权限');
  })().then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});
