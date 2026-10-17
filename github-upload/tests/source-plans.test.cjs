const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
require('../city-codes.js');
const S = require('../source-plans.js'), C = require('../core.js'), Schedules = require('../schedules.js');
const VERSION = require('../manifest.json').version;
const entry = { id: 'expect-java', label: 'Java（马鞍山）' };
const plan = (city, id = city) => S.normalize({ id, name: city + ' Java 实习', entry, city, jobType: '1902', degree: '203', note: '只显示备注' });
test('generate city URLs and retain expectation, type, degree without putting notes in the link', () => {
  const hz = plan('杭州'), sz = plan('苏州市'), h = new URL(hz.sourceUrl), s = new URL(sz.sourceUrl);
  assert.equal(h.searchParams.get('expectId'), 'expect-java'); assert.equal(h.searchParams.get('city'), '101210100');
  assert.equal(s.searchParams.get('city'), '101190400'); assert.equal(s.searchParams.get('degree'), '203'); assert.equal(s.searchParams.get('jobType'), '1902');
  assert.equal(sz.city, '苏州'); assert.equal(hz.sourceUrl.includes('备注'), false);
  const c = S.configFor(sz, C.config({ cities: '杭州', education: ['硕士'], blockedWords: '外包', greetingTemplate: '你好{city}' }));
  assert.equal(c.cities, '苏州'); assert.deepEqual(c.education, ['本科']); assert.equal(c.blockedWords, '外包'); assert.equal(c.greetingTemplate, '你好{city}'); assert.equal(c.note, undefined);
  const noId = S.normalize({ name: '原生入口', entry: { label: 'Java（马鞍山）' }, city: '合肥', jobType: '', degree: '' });
  assert.equal(new URL(noId.sourceUrl).searchParams.has('expectId'), false);
  assert.throws(() => plan('不存在的城市'), /未识别/);
});
test('scheme storage preserves disabled rows and rejects editing a deleted scheme', async () => {
  const data = {}, storage = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)) };
  const api = S.create(storage), saved = await api.save({ ...plan('杭州'), id: undefined });
  await api.toggle(saved.id, false); assert.equal((await api.list())[0].enabled, false); assert.equal((await api.list())[0].note, '只显示备注');
  await assert.rejects(api.save({ ...saved, id: 'deleted' }), /不存在/);
  await api.remove(saved.id); assert.equal((await api.list()).length, 0);
});
function harness({ missingFirst = false, blocked = false, extraJobs = false, firstLimited = false, onRecommendation = false, targetAlreadyOpen = false, readinessSteps = [], unreachableIds = [], minimized = false, stripParameters = false } = {}) {
  let time = Date.now(), currentCity = '101210100', listener, page = 1, progressReads = 0;
  let activeEntry = onRecommendation || stripParameters ? { id: 'recommend', label: '推荐' } : entry;
  const data = { config: C.config({ cities: '杭州', education: ['硕士'], browseIntervalSeconds: 0.2, intervalSeconds: 1, maxJobs: 2 }), records: [], sourcePlans: [plan('杭州', 'hz'), plan('苏州', 'sz')] };
  const events = [], tabs = new Map([[1, { id: 1, windowId: 7, active: true, url: onRecommendation ? 'https://www.zhipin.com/web/geek/jobs?city=101210100' : data.sourcePlans[0].sourceUrl, status: 'complete' }]]);
  if (targetAlreadyOpen) tabs.set(2, { id: 2, windowId: 7, active: false, url: data.sourcePlans[0].sourceUrl, status: 'complete' });
  let windowState = minimized ? 'minimized' : 'normal';
  const jobs = { hz: { id: 'hzjob', url: 'https://www.zhipin.com/job_detail/hzjob.html', title: 'Java实习', education: '本科', location: '杭州', company: '公司甲', description: '负责 Java 后端开发，参与团队项目维护和功能实现。' }, sz: { id: 'szjob', url: 'https://www.zhipin.com/job_detail/szjob.html', title: 'Java实习', education: '本科', location: '苏州', company: '公司乙', description: '负责 Java 后端开发，参与团队项目维护和功能实现。' } };
  jobs.hzExtra = { ...jobs.hz, id: 'hzExtra', url: 'https://www.zhipin.com/job_detail/hzExtra.html' };
  jobs.szExtra = { ...jobs.sz, id: 'szExtra', url: 'https://www.zhipin.com/job_detail/szExtra.html' };
  const visible = () => currentCity === '101190400' ? [jobs.hz, jobs.sz, ...(extraJobs ? [jobs.szExtra] : [])] : [jobs.hz, ...(extraJobs && !firstLimited ? [jobs.hzExtra] : [])];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const chrome = {
    storage: { local: { async setAccessLevel() {}, async get(key) { return { [key]: structuredClone(data[key]) }; }, async set(value) { Object.assign(data, structuredClone(value)); } } },
    runtime: { getManifest: () => ({ version: VERSION }), getURL: p => 'chrome-extension://test/' + p, async sendMessage() {}, async getPlatformInfo() { return {}; }, onMessage: { addListener(fn) { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    permissions: { contains: async () => true },
    tabs: {
      async query() { return [...tabs.values()]; }, async get(id) { return { ...tabs.get(id) }; },
      async create(info) { const tab = { id: tabs.size + 1, windowId: 7, ...info, status: 'complete' }; if (info.active) for (const other of tabs.values()) other.active = false; currentCity = stripParameters ? '' : new URL(tab.url).searchParams.get('city'); if (stripParameters) { const u = new URL(tab.url); u.searchParams.delete('expectId'); u.searchParams.delete('city'); tab.url = u.href; } tabs.set(tab.id, tab); events.push(['create', tab.url, info.active]); return tab; },
      async update(id, info) { const tab = { ...tabs.get(id), ...info, status: 'complete' }; if (info.active) for (const other of tabs.values()) other.active = false; tabs.set(id, tab); currentCity = new URL(tab.url).searchParams.get('city'); if (info.url) { page++; events.push(['navigate', currentCity]); } else events.push(['activate', id]); return tab; },
      async remove() { throw Error('Must preserve the list'); },
      async sendMessage(id, message) {
        const tab = tabs.get(id); events.push([message.type, message.job?.id]);
        if (message.type === 'RUN_CHANGED') return;
        if (message.type === 'PING') return { ok: true, data: { version: VERSION, pageId: 'page' + page, list: true } };
        if (message.type === 'LIST_PROGRESS') { const step = readinessSteps[progressReads++] || {}; return { ok: true, data: { ids: visible().map(j => j.id), ready: true, visible: true, loading: false, pageId: 'page' + page, url: tab.url, blocked: blocked ? '页面需要验证码' : '', ...step } }; }
        if (message.type === 'SCAN') return { ok: true, data: visible().filter(j => !(message.known || []).includes(j.id)) };
        if (message.type === 'SCAN_MORE') return { ok: true, data: [] };
        if (message.type === 'FOCUS_JOB' && unreachableIds.includes(message.job.id)) return { ok: false, code: 'JOB_CARD_UNREACHABLE', error: '当前卡片未能定位' };
        if (['FOCUS_JOB', 'SELECT_JOB'].includes(message.type)) return { ok: true, data: true };
        if (message.type === 'READ_DETAIL') return { ok: true, data: Object.values(jobs).find(j => j.id === message.id) };
        if (message.type === 'COMMUNICATE') return { ok: true, data: { status: 'clicking' } };
        if (message.type === 'CHECK_DELIVERY') return { ok: true, data: { defaultSent: true } };
        throw Error('Unexpected message ' + message.type);
      }
    },
    scripting: { async executeScript({ args: [action, requested] }) {
      events.push(['NATIVE_SCRIPT', action, requested?.kind || requested?.id]);
      if (action === 'activate') {
        if (missingFirst && currentCity === '101210100') return [{ result: { missing: true, reason: '没有找到求职期望「Java（马鞍山）」' } }];
        activeEntry = entry;
      }
      if (action === 'filter' && requested.phase === 'option' && requested.kind === 'city') currentCity = requested.value;
      const selected = !(missingFirst && currentCity === '101210100');
      return [{ result: { selected, clicked: action !== 'read', entries: [{ ...activeEntry, selected }], filters: { city: currentCity === '101190400' ? '苏州' : currentCity === '101210100' ? '杭州' : '', jobType: '1902', degree: '203', keyword: '' } } }];
    } },
    windows: { async get() { return { state: windowState }; }, async update(id, info) { events.push(['window', id, info]); if (info.state) windowState = info.state; return { id, state: windowState }; } }
  };
  const context = vm.createContext({ chrome, BossCore: C, BossSourcePlans: S, BossNativeSources: function () {}, BossSchedules: Schedules, importScripts() {}, crypto, URL, console, Date: Clock, setInterval: () => 1, clearInterval() {}, setTimeout(fn, ms) { return setTimeout(() => { time += ms; fn(); }, 0); }, clearTimeout });
  vm.runInContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), context);
  function dispatch(type, extra = {}, sender = { url: 'chrome-extension://test/options.html' }) { return new Promise(resolve => listener({ type, ...extra }, sender, resolve)); }
  async function finish() { const end = Date.now() + 3000; while (Date.now() < end) { if (data.run && ['completed', 'error', 'stopped'].includes(data.run.status)) { await new Promise(r => setTimeout(r, 10)); return; } await new Promise(r => setTimeout(r, 2)); } throw Error('Background did not finish'); }
  return { data, events, context, dispatch, finish, tabs, get progressReads() { return progressReads; } };
}
test('one run switches cities, retains counters and skips duplicate IDs from the next source', async () => {
  const h = harness(); await h.dispatch('GET_CONFIG');
  await vm.runInContext('start(1, false, null, null, { id: "task", occurrence: 1, sources: ' + JSON.stringify(h.data.sourcePlans) + ', sourceIndex: 0 })', h.context);
  await h.finish();
  assert.equal(h.data.run.status, 'completed', h.data.run.message); assert.equal(h.data.run.sent, 2);
  assert.deepEqual(h.events.filter(e => e[0] === 'COMMUNICATE').map(e => e[1]), ['hzjob', 'szjob']);
  assert.equal(h.data.run.scanned, 2); assert.equal(h.data.run.sourceIndex, 1);
  assert.equal(h.data.config.cities, '杭州'); assert.deepEqual(h.data.config.education, ['硕士']);
  assert.equal(h.events.filter(e => e[0] === 'navigate').length, 1);
});
test('an unavailable expectation skips its source without scanning the recommendation', async () => {
  const h = harness({ missingFirst: true }); await h.dispatch('GET_CONFIG');
  const result = await vm.runInContext('prepareSources(' + JSON.stringify(h.data.sourcePlans) + ', () => false)', h.context);
  assert.equal(result.index, 1); assert.equal(result.results.length, 1); assert.match(result.results[0].reason, /没有找到求职期望/); assert.equal(h.events.some(e => e[0] === 'SCAN'), false);
  const b = harness({ blocked: true }); await b.dispatch('GET_CONFIG');
  await assert.rejects(vm.runInContext('prepareSources(' + JSON.stringify(b.data.sourcePlans) + ', () => false)', b.context), /验证码/);
});
test('schedule stores ordered scheme IDs and still accepts legacy single URL tasks', async () => {
  const data = { schedules: [], sourcePlans: [plan('杭州', 'hz'), plan('苏州', 'sz')] };
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)) };
  const api = Schedules.create({ storage, core: C, getConfig: async () => C.config(), sources: S.create(storage) });
  const task = await api.save({ time: '09:00', repeat: 'daily', targetJobs: 20, enabled: false, sourcePlanIds: ['sz', 'hz'] });
  assert.deepEqual(task.sourcePlanIds, ['sz', 'hz']); assert.deepEqual((await api.list())[0].sourceNames, ['苏州 Java 实习', '杭州 Java 实习']);
  const old = await api.save({ time: '09:00', repeat: 'daily', targetJobs: 20, enabled: false, sourceUrl: 'https://www.zhipin.com/web/geek/jobs?city=101210100' });
  assert.equal(old.sourceUrl.includes('101210100'), true);
  await assert.rejects(api.save({ ...task, sourcePlanIds: ['deleted'] }), /已删除/);
});
test('scheduled alarm prepares selected sources in order and launches one shared target once', async () => {
  const occurrence = Date.now(), config = C.config(), selected = [plan('苏州', 'sz'), plan('杭州', 'hz')];
  const data = { schedules: [{ id: 'task', time: '09:00', repeat: 'daily', enabled: true, nextRunAt: occurrence, targetJobs: 20, sourcePlanIds: ['sz', 'hz'], config }], sourcePlans: selected };
  let launches = 0, info;
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)) };
  const api = Schedules.create({ storage, core: C, sources: S.create(storage), ready: async () => {}, busy: () => false,
    prepareSources: async plans => { assert.deepEqual(plans.map(p => p.id), ['sz', 'hz']); return { tabId: 7, index: 0, results: [] }; },
    launch: async (tabId, c, supplied) => { launches++; assert.equal(tabId, 7); assert.equal(c.maxJobs, 20); info = supplied; return { id: 'one-run' }; }
  });
  const alarm = { name: 'qutou-schedule:task', scheduledTime: occurrence };
  await api.onAlarm(alarm); await api.onAlarm(alarm);
  assert.equal(launches, 1); assert.equal(info.sources.length, 2); assert.equal(data.schedules[0].lastRun.runId, 'one-run');
  await api.finish({ scheduleId: 'task', id: 'one-run', status: 'completed', sent: 20, targetJobs: 20, sourceResults: [{ name: '苏州', sent: 3 }, { name: '杭州', sent: 17 }] });
  assert.equal(data.schedules[0].lastRun.sent, 20); assert.equal(data.schedules[0].lastRun.sourceResults.length, 2);
});
test('URL generation preserves expectation-specific parameters and creates matching annotations', () => {
  const generated = S.generateLink({ entry: { id: 'expect-other', label: '后端（南京）', url: 'https://www.zhipin.com/web/geek/jobs?expectId=old&position=100101&page=4&city=101210100' }, city: '苏州', jobType: '1902', degree: '203' });
  const url = new URL(generated.sourceUrl);
  assert.equal(url.searchParams.get('expectId'), 'expect-other'); assert.equal(url.searchParams.get('position'), '100101'); assert.equal(url.searchParams.has('page'), false);
  assert.equal(url.searchParams.get('city'), '101190400'); assert.match(generated.note, /后端（南京）.*苏州.*实习.*本科/);
  const byName = S.generateLink({ entry: { label: 'Java（马鞍山）' }, city: '杭州' });
  assert.equal(byName.conditions.entry.label, 'Java（马鞍山）'); assert.equal(new URL(byName.sourceUrl).searchParams.has('expectId'), false);
  const manual = S.generateLink({ baseUrl: 'https://www.zhipin.com/web/geek/jobs?encryptExpectId=encrypted&position=100101', city: '杭州', jobType: '1902', degree: '203' });
  assert.equal(new URL(manual.sourceUrl).searchParams.get('encryptExpectId'), 'encrypted');
});
test('each URL gets its own quota and unvisited jobs from the old queue are not carried to the next URL', async () => {
  const h = harness({ extraJobs: true }); await h.dispatch('GET_CONFIG');
  const links = S.normalizeLinks(h.data.sourcePlans.map(p => ({ ...p, targetJobs: 1 }))).links;
  await vm.runInContext('start(1, false, null, null, { id: "task", occurrence: 1, sources: ' + JSON.stringify(links) + ', sourceIndex: 0 })', h.context);
  await h.finish();
  assert.equal(h.data.run.status, 'completed', h.data.run.message); assert.equal(h.data.run.sent, 2);
  assert.deepEqual(h.events.filter(e => e[0] === 'COMMUNICATE').map(e => e[1]), ['hzjob', 'szjob']);
  assert.equal(h.events.some(e => e[0] === 'FOCUS_JOB' && e[1] === 'hzExtra'), false);
  assert.equal(h.events.some(e => e[0] === 'SCAN_MORE'), false, 'Reaching a link quota should switch without scrolling');
  assert.deepEqual(h.data.run.sourceResults.map(r => [r.sent, r.targetJobs, r.status]), [[1, 1, 'quota_reached'], [1, 1, 'quota_reached']]);
});
test('an exhausted link records its shortfall without increasing the next link quota', async () => {
  const h = harness({ extraJobs: true, firstLimited: true }); await h.dispatch('GET_CONFIG');
  const links = S.normalizeLinks(h.data.sourcePlans.map((p, i) => ({ ...p, targetJobs: i === 0 ? 2 : 1 }))).links;
  await vm.runInContext('start(1, false, null, ' + JSON.stringify({ ...h.data.config, maxJobs: 3 }) + ', { id: "task", sources: ' + JSON.stringify(links) + ', sourceIndex: 0 })', h.context);
  await h.finish();
  assert.equal(h.data.run.status, 'completed', h.data.run.message); assert.equal(h.data.run.sent, 2); assert.equal(h.data.run.targetJobs, 3);
  assert.deepEqual(h.data.run.sourceResults.map(r => [r.sent, r.targetJobs, r.status]), [[1, 2, 'exhausted'], [1, 1, 'quota_reached']]);
  assert.match(h.data.run.message, /未达到目标/);
});
test('schedule stores URL rows and derives the target from enabled quotas', async () => {
  const data = { schedules: [] }, storage = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)) };
  const api = Schedules.create({ storage, core: C, plans: S, sources: S.create(storage), getConfig: async () => C.config() });
  const links = [ { ...plan('杭州'), targetJobs: 5 }, { ...plan('苏州'), targetJobs: 3 }, { ...plan('合肥'), targetJobs: 10, enabled: false } ];
  const task = await api.save({ time: '09:00', repeat: 'daily', enabled: false, links, targetJobs: 99 });
  assert.equal(task.targetJobs, 8); assert.equal(task.links.length, 3); assert.equal(task.sourcePlanIds.length, 0); assert.equal(task.sourceUrl, '');
  await assert.rejects(api.save({ time: '09:00', repeat: 'daily', links: links.map(l => ({ ...l, enabled: false })) }), /至少/);
});
test('a scheduled source opens and activates its saved link without changing the recommendation tab', async () => {
  const h = harness({ onRecommendation: true, minimized: true }); await h.dispatch('GET_CONFIG');
  const original = h.tabs.get(1).url;
  const prepared = await vm.runInContext('prepareSources(' + JSON.stringify([h.data.sourcePlans[0]]) + ', () => false)', h.context);
  assert.equal(prepared.tabId, 2); assert.equal(h.tabs.get(2).url, h.data.sourcePlans[0].sourceUrl); assert.equal(h.tabs.get(2).active, true);
  assert.equal(h.tabs.get(1).url, original); assert.equal(h.tabs.get(1).active, false);
  assert.ok(h.events.some(e => e[0] === 'window' && e[2].state === 'normal'));
  assert.ok(h.progressReads >= 2, 'Wait for a settled list after activating');
});
test('an already-open target tab is activated and old/loading list snapshots are not accepted', async () => {
  const h = harness({ onRecommendation: true, targetAlreadyOpen: true, readinessSteps: [{ ready: false }, { url: 'https://www.zhipin.com/web/geek/jobs?city=101210100', ids: ['old'] }, { loading: true }, { ids: [] }] });
  await h.dispatch('GET_CONFIG');
  const prepared = await vm.runInContext('prepareSource(' + JSON.stringify(h.data.sourcePlans[0]) + ')', h.context);
  assert.equal(prepared.tabId, 2); assert.equal(h.tabs.size, 2); assert.equal(h.tabs.get(2).active, true);
  assert.ok(h.progressReads >= 6); assert.deepEqual(prepared.progress.ids, ['hzjob']);
});
test('a card that cannot be positioned is skipped and the next job is still sent', async () => {
  const h = harness({ extraJobs: true, unreachableIds: ['hzjob'] }); await h.dispatch('GET_CONFIG');
  const links = S.normalizeLinks([{ ...h.data.sourcePlans[0], targetJobs: 1 }]).links;
  await vm.runInContext('start(1, false, null, ' + JSON.stringify({ ...h.data.config, maxJobs: 1 }) + ', { id:"task", sources:' + JSON.stringify(links) + ',sourceIndex:0})', h.context);
  await h.finish(); assert.equal(h.data.run.status, 'completed', h.data.run.message); assert.equal(h.data.run.sent, 1);
  assert.deepEqual(h.events.filter(e => e[0] === 'COMMUNICATE').map(e => e[1]), ['hzExtra']);
  assert.ok(h.data.records.some(r => r.job.id === 'hzjob' && r.status === 'skipped'));
});
test('state distinguishes the task page from another BOSS tab and the jump action activates only the task', async () => {
  const h = harness({ onRecommendation: true, targetAlreadyOpen: true }); await h.dispatch('GET_CONFIG');
  vm.runInContext('run={id:"run",status:"running",sourceTabId:2,sourcePageId:"page1",currentJob:{id:"hzjob",title:"Java实习"}};', h.context);
  const sender = id => ({ url: h.tabs.get(id).url, tab: { id }, frameId: 0 });
  assert.equal((await h.dispatch('GET_STATE', {}, sender(1))).data.pageRole, 'other');
  assert.equal((await h.dispatch('GET_STATE', {}, sender(2))).data.pageRole, 'source');
  assert.equal((await h.dispatch('FOCUS_TASK_PAGE', {}, sender(1))).ok, true); assert.equal(h.tabs.get(2).active, true);
  assert.ok(h.events.some(e => e[0] === 'window' && e[2].focused));
});
test('ignored URL parameters trigger one native expectation selection and city application before scanning', async () => {
  const h = harness({ onRecommendation: true, stripParameters: true }); await h.dispatch('GET_CONFIG');
  const prepared = await vm.runInContext('prepareSource(' + JSON.stringify(h.data.sourcePlans[0]) + ')', h.context);
  assert.equal(new URL(h.tabs.get(prepared.tabId).url).searchParams.has('expectId'), false);
  assert.equal(prepared.progress.conditions.entry.id, entry.id); assert.equal(prepared.progress.conditions.city, '杭州');
  assert.equal(h.events.filter(e => e[0] === 'NATIVE_SCRIPT' && e[1] === 'activate').length, 1);
  assert.equal(h.events.filter(e => e[0] === 'NATIVE_SCRIPT' && e[1] === 'filter').length, 2);
  assert.equal(h.events.some(e => e[0] === 'SCAN' || e[0] === 'COMMUNICATE'), false);
});
test('saved conditions survive route normalization and annotations never change routing', () => {
  const generated = S.generateLink({ entry, city: '杭州', jobType: '1902', degree: '203' });
  const stripped = 'https://www.zhipin.com/web/geek/jobs?jobType=1902&degree=203';
  const normalized = S.normalizeLinks([{ ...generated, sourceUrl: stripped, targetJobs: 5, note: '只是备注，不是推荐' }]).links[0];
  assert.equal(normalized.conditions.entry.id, entry.id); assert.equal(normalized.conditions.city, '杭州');
  assert.deepEqual(S.normalizeLinks([normalized]).links[0].conditions, normalized.conditions);
  const captured = S.captureCurrent({ url: stripped, entries: [{ ...entry, selected: true }], filters: { city: '合肥', degree: '203', jobType: '1902' } });
  assert.equal(captured.city, '合肥'); assert.equal(captured.entry.id, entry.id);
});
test('the same native URL retains independent recommendation and expectation entries', () => {
  const sourceUrl = 'https://www.zhipin.com/web/geek/jobs?city=101210100&jobType=1902&degree=203';
  const conditions = { city: '杭州', jobType: '1902', degree: '203', keyword: '' };
  const links = S.normalizeLinks([
    { sourceUrl, targetJobs: 5, conditions: { ...conditions, entry: { id: 'recommend', label: '推荐' } } },
    { sourceUrl, targetJobs: 3, conditions: { ...conditions, entry } }
  ]).links;
  assert.equal(links[0].sourceUrl, links[1].sourceUrl);
  assert.equal(links[0].conditions.entry.mode, 'recommend'); assert.equal(links[1].conditions.entry.mode, 'expect');
  assert.equal(links[1].conditions.entry.id, entry.id); assert.deepEqual(links.map(l => l.targetJobs), [5, 3]);
  const catalog = { entries: [{ id: 'encrypted-java', legacyId: entry.id, label: entry.label, param: 'encryptExpectId' }] };
  const upgraded = S.normalizeLinks(links, catalog).links[1];
  assert.equal(upgraded.conditions.entry.id, 'encrypted-java'); assert.equal(upgraded.conditions.entry.legacyId, entry.id); assert.equal(upgraded.targetJobs, 3);
});
