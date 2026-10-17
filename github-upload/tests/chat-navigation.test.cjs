const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function harness(supported = true) {
  const listeners = new Set(), timers = new Map(), opened = [];
  const nativeOpen = (...args) => { opened.push(args); return 'native-window'; };
  const window = { open: nativeOpen, ...(supported ? { navigation: { addEventListener(type, fn) { listeners.add(fn); }, removeEventListener(type, fn) { listeners.delete(fn); } } } : {}) };
  let id = 0;
  const context = vm.createContext({ window, URL, location: { href: 'https://www.zhipin.com/web/geek/jobs' }, setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(key) { timers.delete(key); } });
  vm.runInContext(fs.readFileSync(require.resolve('../chat-navigation.js'), 'utf8'), context);
  return { window, nativeOpen, listeners, timers, opened, call: context.BossChatNavigation,
    navigate(url, extra = {}) { const event = { destination: { url }, cancelable: true, navigationType: 'push', canceled: false, preventDefault() { this.canceled = true; }, ...extra }; for (const fn of listeners) fn(event); return event; } };
}
const chat = 'https://www.zhipin.com/web/geek/chat?id=hr&jobId=job';
test('native chat navigation is canceled and handed off without replacing the list', () => {
  const h = harness(); h.call('arm', 'task');
  assert.equal(h.navigate(chat).canceled, true);
  assert.equal(h.call('read', 'task').url, chat);
  assert.equal(h.call('read', 'task').method, 'navigation:push');
  for (const url of ['https://example.com/web/geek/chat', 'https://www.zhipin.com/web/geek/jobs?city=101', 'https://www.zhipin.com/web/geek/chat-other', 'https://name:pw@www.zhipin.com/web/geek/chat']) assert.equal(h.navigate(url).canceled, false);
});
test('asynchronous window.open calls are captured until cleanup and unrelated windows remain native', () => {
  const h = harness(); h.call('arm', 'task');
  assert.equal(h.window.open(chat, '_blank'), null); assert.equal(h.opened.length, 0);
  assert.equal(h.call('read', 'task').method, 'window.open');
  assert.equal(h.window.open('https://example.com', '_blank'), 'native-window');
  assert.equal(h.opened.length, 1);
  h.call('clear', 'task'); assert.equal(h.window.open, h.nativeOpen); assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0);
});
test('conflicting native chat destinations are retained as an error rather than silently switching HR', () => {
  const h = harness(); h.call('arm', 'task'); h.navigate(chat); h.navigate(chat.replace('id=hr', 'id=other'));
  assert.match(h.call('read', 'task').error, /不同聊天入口/); assert.equal(h.call('read', 'task').url, chat);
});
test('native URL aliases and refreshed security parameters keep the same encrypted conversation', () => {
  const h = harness(); h.call('arm', 'task'); h.navigate(chat);
  const alias = 'https://www.zhipin.com/web/geek/chat?bossId=hr&encryptJobId=job&securityId=fresh';
  h.navigate(alias); assert.equal(h.call('read', 'task').error, ''); assert.equal(h.call('read', 'task').url, alias);
});
test('stale tokens and user back/forward cannot cancel or dispose the current task', () => {
  const h = harness(); h.call('arm', 'old'); h.call('arm', 'current');
  assert.equal(h.listeners.size, 1); assert.equal(h.timers.size, 1);
  assert.ok(h.call('clear', 'old').error); assert.equal(h.listeners.size, 1);
  assert.equal(h.navigate(chat, { navigationType: 'traverse' }).canceled, false);
  assert.equal(h.call('read', 'current').url, '');
});
test('unsupported or uncancelable navigation fails visibly instead of reporting preservation', () => {
  const old = harness(false); assert.throws(() => old.call('arm', 'task'), /更新 Edge/); assert.equal(old.window.open, old.nativeOpen);
  const h = harness(); h.call('arm', 'task'); assert.equal(h.navigate(chat, { cancelable: false }).canceled, false); assert.match(h.call('read', 'task').error, /未允许阻止/);
});
test('navigation hooks expire and do not overwrite another later page patch', () => {
  const h = harness(); h.call('arm', 'task'); const later = () => 'other'; h.window.open = later;
  [...h.timers.values()][0](); assert.equal(h.window.open, later); assert.equal(h.listeners.size, 0);
});
test('an active or paused task renews its capture without losing the original destination', () => {
  const h = harness(); h.call('arm', 'task'); h.navigate(chat);
  const before = [...h.timers.keys()][0]; assert.equal(h.call('read', 'task').url, chat);
  assert.equal(h.timers.has(before), false); assert.equal(h.timers.size, 1);
  assert.equal(h.listeners.size, 1); assert.equal(h.call('read', 'task').method, 'navigation:push');
});
