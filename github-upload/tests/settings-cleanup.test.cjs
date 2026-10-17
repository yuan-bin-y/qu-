const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const C = require('../core.js');
const S = require('../source-plans.js');
const Schedules = require('../schedules.js');
function worker(data) {
  let listener;
  const writes = [];
  const storage = {
    async setAccessLevel() {},
    async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(values) { writes.push(structuredClone(values)); Object.assign(data, structuredClone(values)); }
  };
  const context = vm.createContext({
    BossCore: C, BossSourcePlans: S, BossSchedules: Schedules, importScripts() {}, URL,
    chrome: { storage: { local: storage }, runtime: {
      getURL: name => 'chrome-extension://fixture/' + name,
      onMessage: { addListener(fn) { listener = fn; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} }
    } }, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), context);
  const config = () => new Promise(resolve => listener({ type: 'GET_CONFIG' }, { url: 'chrome-extension://fixture/options.html' }, resolve));
  return { config, writes };
}
test('upgrade removes unsupported settings from saved config and task snapshots without changing history or task requirements', async () => {
  const supported = C.config({ cities: '杭州,合肥', greetingMode: 'custom', greetingTemplate: '我关注{city}的实习岗位', titleGroups: [['Java', '实习']], maxJobs: 5 });
  const data = {
    config: { ...supported, retiredSecret: 'obsolete-private-value', retiredProvider: { key: 'obsolete-private-value' } },
    schedules: [{ id: 'task', enabled: false, time: '09:00', targetJobs: 5, links: [{ url: 'https://www.zhipin.com/web/geek/jobs', targetJobs: 5 }], lastRun: { sent: 2 }, config: { ...supported, retiredProfile: 'obsolete text' } }],
    records: [{ id: 'history', greeting: '保留已发消息', status: 'sent' }], run: { status: 'completed', sent: 2 }
  };
  const original = structuredClone(data), first = worker(data);
  const result = await first.config();
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(data.config, supported);
  assert.deepEqual(data.schedules[0], { ...original.schedules[0], config: supported });
  assert.deepEqual(data.records, original.records); assert.deepEqual(data.run, original.run);
  assert.equal(first.writes.length, 1);
  assert.equal(JSON.stringify(data.config).includes('obsolete-private-value'), false);
  const next = worker(data); assert.equal((await next.config()).ok, true);
  assert.equal(next.writes.length, 0, 'Cleanup is idempotent across worker restarts');
});
test('fresh installations do not write configuration or task defaults during cleanup', async () => {
  const h = worker({}); const result = await h.config();
  assert.equal(result.ok, true, result.error); assert.equal(result.data.greetingMode, 'boss_default');
  assert.equal(h.writes.length, 0);
});
