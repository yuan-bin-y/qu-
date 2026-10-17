'use strict';
const $ = id => document.getElementById(id);
let state = { status: 'idle' };
async function call(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || '后台无响应');
  return result.data;
}
function showError(error) { $('notice').hidden = false; $('notice').textContent = error.message; }
function render(next) {
  state = next;
  const busy = ['running', 'paused', 'stopping'].includes(state.status);
  const labels = { idle: '等待开始', running: '正在处理', paused: '已暂停', stopping: '正在停止', stopped: '已停止', completed: '已完成', error: '已停止，请检查', interrupted: '后台中断，请查看记录' };
  $('state').textContent = (state.status === 'completed' && state.completionReason === 'list_exhausted' ? '列表已处理完' : labels[state.status] || state.status) + ' · ' + (state.message || '打开 BOSS 直聘职位列表，先分析再投递。');
  for (const key of ['scanned', 'matched', 'sent']) $(key).textContent = key === 'sent' && state.targetJobs && !state.preview ? (state.sent || 0) + ' / ' + state.targetJobs : state[key] || 0;
  $('start').disabled = busy; $('preview').disabled = busy;
  $('pause').disabled = !['running', 'paused'].includes(state.status);
  $('stop').disabled = !busy || state.status === 'stopping';
  $('pause').textContent = state.status === 'paused' ? '继续' : '暂停';
  $('review-tab').hidden = !state.reviewTabId;
}
async function start(preview) {
  try {
    $('notice').hidden = true;
    $('start').disabled = true; $('preview').disabled = true;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://www.zhipin.com/')) throw new Error('请先在当前标签页打开 BOSS 直聘职位列表');
    render(await call('START', { tabId: tab.id, preview }));
  } catch (e) { showError(e); await refresh(); }
}
$('preview').onclick = () => start(true);
$('start').onclick = () => start(false);
$('settings').onclick = () => call('OPEN_SETTINGS').catch(showError);
$('reconnect').onclick = async () => {
  try {
    $('notice').hidden = true;
    $('reconnect').disabled = true;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await call('CONNECT_PAGE', { tabId: tab?.id });
    $('connection').textContent = '已连接 BOSS 页面，面板已恢复';
  } catch (error) { showError(error); }
  finally { $('reconnect').disabled = false; }
};
$('review-tab').onclick = async () => { try { await chrome.tabs.update(state.reviewTabId, { active: true }); } catch { showError(new Error('待核实页面已关闭，请从投递记录打开岗位检查')); } };
$('pause').onclick = async () => { try { render(await call(state.status === 'paused' ? 'RESUME' : 'PAUSE')); } catch (e) { showError(e); } };
$('stop').onclick = async () => { try { render(await call('STOP')); } catch (e) { showError(e); } };
async function refresh() { try { render(await call('GET_STATE')); } catch (e) { showError(e); } }
chrome.runtime.onMessage.addListener(message => { if (message.type === 'RUN_CHANGED') render(message.run); });
refresh();
setInterval(refresh, 1500);
