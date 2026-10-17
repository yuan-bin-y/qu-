/* Lifecycle checks connect only to the isolated Edge .qa-profile. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const port = fs.readFileSync(path.join(root, '.qa-profile/DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
const socket = new WebSocket('ws://127.0.0.1:' + port[0] + port[1]);
const pending = new Map(); let nextId = 0;
function call(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Timed out: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
socket.onmessage = event => {
  const data = JSON.parse(event.data), request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id); clearTimeout(request.timer);
  if (data.error) request.reject(Error(data.error.message)); else request.resolve(data.result);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(100); }
  throw Error('Lifecycle condition timed out');
}
async function evaluate(session, expression) {
  const data = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (data.exceptionDetails) throw Error(JSON.stringify(data.exceptionDetails));
  return data.result.value;
}
(async () => {
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const targets = await call('Target.getTargets');
  const options = targets.targetInfos.find(t => t.url.startsWith('chrome-extension://') && t.url.includes('/options.html'));
  assert.ok(options, 'Open extension settings in the isolated Edge session first');
  const extensionId = new URL(options.url).host;
  let optionsTarget = options.targetId;
  let ext = (await call('Target.attachToTarget', { targetId: optionsTarget, flatten: true })).sessionId;
  // Keep settings local while testing reloads; no BOSS page is opened here.
  await evaluate(ext, 'history.replaceState(null,"","#rules"); dirty=false; true');
  const awake = await evaluate(ext, 'chrome.runtime.sendMessage({type:"GET_CONFIG"})');
  assert.ok(awake.ok, awake.error);
  const original = await evaluate(ext, 'chrome.storage.local.get(["config","records","run"])');
  let managerTarget;
  try {
    const saved = { status: 'paused', id: 'qa-interrupted-run', sent: 2, attempted: 2, queue: [] };
    await evaluate(ext, 'chrome.storage.local.set({run:' + JSON.stringify(saved) + '}).then(()=>true)');
    const before = (await call('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url === 'chrome-extension://' + extensionId + '/background.js');
    assert.ok(before);
    await call('ServiceWorker.enable', {}, ext);
    await call('ServiceWorker.stopAllWorkers', {}, ext);
    await poll(async () => !(await call('Target.getTargets')).targetInfos.some(t => t.targetId === before.targetId));
    const state = await evaluate(ext, 'chrome.runtime.sendMessage({type:"GET_STATE"})');
    assert.ok(state.ok, state.error);
    assert.equal(state.data.status, 'interrupted'); assert.equal(state.data.sent, 2);
    const newWorker = (await call('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url === before.url);
    // Edge may reuse a DevTools target ID for the same service-worker registration.
    // The interrupted persisted state above proves the new worker initialized again.
    assert.ok(newWorker);
    const preserved = await evaluate(ext, 'chrome.storage.local.get(["config","records"])');
    assert.deepEqual(preserved.config, original.config);
    assert.deepEqual(preserved.records, original.records);
    console.log('PASS Edge lifecycle: stopped worker wakes on message, marks prior run interrupted, preserves configuration and history');
    managerTarget = (await call('Target.createTarget', { url: 'chrome://extensions/' })).targetId;
    const manager = (await call('Target.attachToTarget', { targetId: managerTarget, flatten: true })).sessionId;
    await poll(async () => evaluate(manager, 'Boolean(globalThis.chrome?.developerPrivate)'));
    for (let i = 0; i < 3; i++) {
      await evaluate(manager, 'chrome.developerPrivate.reload(' + JSON.stringify(extensionId) + ').then(()=>true)');
      // Edge replaces open extension pages with a new-tab page during reload.
      // Open a fresh settings page after the old contexts have been invalidated.
      await sleep(300);
      const oldTarget = optionsTarget;
      optionsTarget = (await call('Target.createTarget', { url: 'chrome-extension://' + extensionId + '/options.html#rules' })).targetId;
      ext = (await call('Target.attachToTarget', { targetId: optionsTarget, flatten: true })).sessionId;
      const response = await poll(async () => {
        try { const data = await evaluate(ext, 'chrome.runtime.sendMessage({type:"GET_CONFIG"})'); return data?.ok ? data : null; } catch { return null; }
      });
      assert.deepEqual(response.data, original.config);
      await call('Target.closeTarget', { targetId: oldTarget }).catch(() => {});
      const info = await evaluate(manager, 'chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}).then(list=>list.find(x=>x.id===' + JSON.stringify(extensionId) + '))');
      assert.deepEqual(info.manifestErrors, []); assert.deepEqual(info.runtimeErrors, []);
      assert.equal(info.state, 'ENABLED');
    }
    console.log('PASS Edge lifecycle: three extension reloads, settings reconnect, no manifest or runtime errors');
  } finally {
    await evaluate(ext, 'chrome.storage.local.set(' + JSON.stringify(original) + ').then(()=>true)').catch(error => { console.error('Isolated QA cleanup failed: ' + error.message); });
    if (managerTarget) await call('Target.closeTarget', { targetId: managerTarget });
    socket.close();
  }
})().catch(error => { console.error(error); socket.close(); process.exitCode = 1; });
