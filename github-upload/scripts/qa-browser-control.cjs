// Controls only a named isolated test profile; never discovers a real browser.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const name = process.env.BOSS_EXTENSION_QA_PROFILE;
assert.match(name || '', /^\.qa-[a-z0-9-]+-profile$/);
const profile = path.join(root, name);
const [port, endpoint] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
const socket = new WebSocket('ws://127.0.0.1:' + port + endpoint);
const pending = new Map(); let sequence = 0;
socket.onmessage = event => {
  const message = JSON.parse(event.data), item = pending.get(message.id);
  if (item) { pending.delete(message.id); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result); }
};
function call(method, params = {}, sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
}
(async () => {
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  try {
    const command = await call('Browser.getBrowserCommandLine');
    assert.ok(command.arguments.some(arg => arg.startsWith('--user-data-dir=') && path.resolve(arg.slice('--user-data-dir='.length)) === profile));
    assert.ok(command.arguments.some(arg => arg.includes('MAP www.zhipin.com ~NOTFOUND')), 'Real BOSS DNS must remain blocked');
    if (process.argv.includes('--close')) { await call('Browser.close'); console.log('Closed isolated QA browser'); return; }
    const targets = (await call('Target.getTargets')).targetInfos;
    assert.ok(!targets.some(target => target.type === 'page' && target.url.startsWith('https://www.zhipin.com/')), 'Finish fixture tests before reloading the extension');
    const preferences = path.join(profile, 'Default', 'Secure Preferences');
    const installed = fs.existsSync(preferences) ? Object.entries(JSON.parse(fs.readFileSync(preferences, 'utf8')).extensions?.settings || {}).find(([, settings]) => settings.path && path.resolve(settings.path) === root)?.[0] : null;
    const belongsToExtension = target => target.url.startsWith(installed ? 'chrome-extension://' + installed + '/' : 'chrome-extension://');
    const target = targets.find(target => belongsToExtension(target) && target.url.includes('/options.html'));
    const worker = targets.find(target => belongsToExtension(target) && target.type === 'service_worker' && target.url.endsWith('/background.js'));
    const url = target?.url || worker?.url.replace('/background.js', '/options.html') || (installed && 'chrome-extension://' + installed + '/options.html'); assert.ok(url, 'Expected QA extension');
    if (!target && !worker) await call('Target.createTarget', { url });
    if (process.argv.includes('--reload')) {
      const available = target || worker || (await call('Target.getTargets')).targetInfos.find(target => target.url === url);
      const attached = await call('Target.attachToTarget', { targetId: available.targetId, flatten: true });
      await call('Runtime.evaluate', { expression: 'setTimeout(()=>chrome.runtime.reload(),100);true' }, attached.sessionId);
      await new Promise(resolve => setTimeout(resolve, 1800));
    }
    const current = (await call('Target.getTargets')).targetInfos;
    if (!current.some(target => target.url.includes('/options.html'))) await call('Target.createTarget', { url });
    console.log('Isolated QA extension ready');
  } finally { socket.close(); }
})().catch(error => { console.error(error); socket.close(); process.exitCode = 1; });
