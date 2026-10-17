const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Core = require('../core.js');
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
const job = { id: 'abc123', url: 'https://www.zhipin.com/job_detail/abc123.html', title: 'Java 开发', company: '样例公司', location: '上海', description: '负责 Java 后端服务开发，使用 Spring Boot。' };
const analysis = { match: true, reasons: ['本地筛选通过'], greeting: '' };
async function until(condition, timeout = 2500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (condition()) return; await new Promise(r => setTimeout(r, 2)); }
  throw Error('Timed out waiting for condition');
}
function harness(options = {}) {
  const data = { config: Core.config({ intervalSeconds: 3, ...options.config }), records: options.records || [], run: options.savedRun || null };
  const published = [];
  const calls = [], messages = [], communications = [], communicationTimes = [], removed = [], created = [], updates = [], intervals = new Set(), windowCalls = [], fetchCalls = [], injections = [];
  let visibleJobs = options.jobs || [job];
  let connected = !options.disconnected;
  let currentTabUrl = options.tabUrl || 'https://www.zhipin.com/web/geek/job';
  const tabUrls = new Map([[1, currentTabUrl]]);
  let nextTabId = 22;
  const returns = [];
  let contentVersion = options.contentVersion || '0.6.35';
  let listener, httpCalls = 0, abortCalls = 0, pacedMilliseconds = 0, clock = Date.now();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  let storageReady = false;
  const startupCalls = [], startupEvents = {}, failures = structuredClone(options.startupFailures || {});
  function startupCall(name) {
    startupCalls.push(name);
    const failuresForCall = failures[name];
    if (failuresForCall?.length) { const error = failuresForCall.shift(); if (error) throw Error(error); }
  }
  const chrome = {
    storage: { local: {
      async setAccessLevel(options) { startupCall('access'); assert.equal(options.accessLevel, 'TRUSTED_CONTEXTS'); storageReady = true; },
      async get(key) { assert.ok(storageReady, 'Storage access must be restricted before reading'); if (key === 'run') startupCall('get'); return { [key]: structuredClone(data[key]) }; },
      async set(value) { assert.ok(storageReady, 'Storage access must be restricted before writing'); if (value.run?.status === 'interrupted') startupCall('set'); Object.assign(data, structuredClone(value)); }
    } },
    permissions: { async contains() { return options.authorized !== false; } },
    runtime: {
      getManifest: () => ({ version: '0.6.35' }),
      getURL: p => 'chrome-extension://test-extension/' + p,
      onMessage: { addListener(fn) { listener = fn; } },
      onInstalled: { addListener(fn) { startupEvents.install = fn; } }, onStartup: { addListener(fn) { startupEvents.startup = fn; } },
      async sendMessage(message) { published.push(structuredClone(message)); }, async getPlatformInfo() { return {}; }, async openOptionsPage() {}
    },
    tabs: {
      async query(query) { if (options.noBossTab) return []; return [{ id: 1, url: 'https://www.zhipin.com/web/geek/job' }]; },
      async get(id) { return { id, url: id === 1 ? currentTabUrl : tabUrls.get(id) }; },
      async create(value) { const id = nextTabId++; created.push({ ...value, id }); tabUrls.set(id, value.url); return { id, ...value }; },
      async update(id, value) { updates.push({ id, ...value }); if (value.url) { tabUrls.set(id, value.url); if (id === 1) currentTabUrl = value.url; } return { id, ...value }; },
      async goBack(id) {
        returns.push(id); currentTabUrl = options.tabUrl || 'https://www.zhipin.com/web/geek/job';
        if (options.returnJobs) visibleJobs = options.returnJobs;
        if (options.onReturn) await options.onReturn({ dispatch, data, setJobs(jobs) { visibleJobs = jobs; } });
      },
      async remove(id) { removed.push(id); tabUrls.delete(id); if (options.onCloseWorker) await options.onCloseWorker({ dispatch, data, setJobs(jobs) { visibleJobs = jobs; } }); },
      async sendMessage(tab, message) {
        calls.push(message.type);
        messages.push(structuredClone(message));
        if (message.type === 'RUN_CHANGED') return { ok: true };
        if (message.type === 'PING') { if (!connected) throw Error('Could not establish connection. Receiving end does not exist.'); return { ok: true, data: { version: contentVersion, pageId: tab === 1 && options.reloadSourceAfterSend && data.run?.sent ? 'replaced-source' : 'page-' + tab, list: tab === 1, path: tab === 1 ? '/web/geek/jobs' : '/web/geek/chat' } }; }
        if (message.type === 'SHOW_PANEL') return { ok: true, data: true };
        if (message.type === 'SHOW_SETTINGS' || message.type === 'MARK_JOB') return { ok: true, data: true };
        if (['FOCUS_JOB', 'SELECT_JOB'].includes(message.type)) {
          if (options.onFocus) await options.onFocus(message, { setJobs(jobs) { visibleJobs = jobs; } });
          if (options.strictCards && !visibleJobs.some(job => job.id === message.job.id)) return { ok: false, code: 'JOB_CARD_MISSING', error: 'fixture card disappeared' };
          return { ok: true, data: true };
        }
        if (message.type === 'SCAN_MORE') {
          const more = options.moreJobBatches?.shift() || options.moreJobs || [];
          visibleJobs = [...visibleJobs, ...more];
          return { ok: true, data: more };
        }
        if (message.type === 'SCAN') {
          if (options.onScan) await options.onScan(message, { setJobs(jobs) { visibleJobs = jobs; } });
          return { ok: true, data: visibleJobs.slice(0, message.max) };
        }
        if (message.type === 'READ_DETAIL') { clock += options.detailLoadMilliseconds || 0; return { ok: true, data: options.detailsById?.[message.id] || options.detail || visibleJobs.find(job => job.id === message.id) || job }; }
        if (message.type === 'PREPARE_DELIVERY_JOB') {
          if (options.deliveryError) return { ok: false, error: options.deliveryError };
          return { ok: true, data: options.deliveryDetail || options.detailsById?.[message.job.id] || message.job };
        }
        if (message.type === 'COMMUNICATE') {
          communications.push(structuredClone(message));
          communicationTimes.push(clock);
          if (options.reportOnClick) {
            const receipt = await new Promise(resolve => listener({ type: 'REPORT_DELIVERY', runId: message.runId, jobId: message.job.id, proof: 'success_dialog' }, { url: job.url, tab: { id: tab }, frameId: 0 }, resolve));
            assert.equal(receipt.ok, !message.customGreeting);
          }
          if (message.customGreeting && !options.manualHandoff && !options.alreadyContacted && !options.alreadyContactedIds?.includes(message.job.id)) {
            const task = { runId: message.runId, jobId: message.job.id };
            const sourceSender = { url: currentTabUrl, tab: { id: tab }, frameId: 0 };
            assert.ok((await dispatch('PREPARE_CUSTOM_HANDOFF', { ...task, recipient: { bossId: 'test-boss' } }, sourceSender)).ok);
            assert.ok((await dispatch('OPEN_CUSTOM_CHAT', { ...task, url: 'https://www.zhipin.com/web/geek/chat?id=test-boss&jobId=' + message.job.id }, sourceSender)).ok);
          }
          return { ok: true, data: { status: options.alreadyContacted || options.alreadyContactedIds?.includes(message.job.id) ? 'already_contacted' : 'clicking', recipient: {} } };
        }
        if (message.type === 'CHECK_CHAT') return { ok: true, data: { ready: options.chatReady !== false } };
        if (message.type === 'CHECK_DELIVERY') {
          if (options.onDeliveryCheck) return { ok: true, data: await options.onDeliveryCheck(message, { dispatch, data }) };
          if (options.lostChannel) throw Error('The message port closed before a response was received.');
          if (options.observedGreeting) return { ok: true, data: { blocked: true, reason: '检测到 BOSS 自动招呼仍在发送，请关闭 BOSS 自动招呼后再试', observedGreeting: options.observedGreeting } };
          return { ok: true, data: { ready: options.chatReady !== false, defaultSent: options.defaultSent !== false } };
        }
        if (message.type === 'SEND_GREETING') {
          if (options.navigateOnCustomSend) tabUrls.set(tab, 'https://www.zhipin.com/web/geek/chat');
          assert.equal(message.greeting, Core.template(message.job, data.config));
          if (options.reportCustomOnSend) {
            const receipt = await new Promise(resolve => listener({ type: 'REPORT_DELIVERY', runId: message.runId, jobId: message.job.id, proof: 'outgoing_message', kind: 'custom' }, { url: job.url, tab: { id: tab }, frameId: 0 }, resolve));
            assert.equal(receipt.ok, true);
          }
          if (options.customLostChannel) throw Error('The message port closed before a response was received.');
          return { ok: true, data: { sent: !options.existingGreeting && options.sendConfirmed !== false, alreadyContacted: Boolean(options.existingGreeting), reason: 'fixture result' } };
        }
        throw Error('Unexpected command: ' + message.type);
      }
    },
    scripting: { async executeScript(value) { injections.push(value); connected = true; contentVersion = '0.6.35'; return [{ result: value.func?.name === 'chatNavigation' ? (value.args[0] === 'arm' ? { armed: true } : value.args[0] === 'read' ? { url: options.capturedChatUrl || '', method: 'navigation:push' } : { cleared: true }) : true }]; } },
    windows: {
      async get(id) { return { id, type: options.settingsWindowType || 'normal' }; },
      async create(value) { windowCalls.push({ operation: 'create', ...value }); return { id: 99 }; },
      async update(id, value) { windowCalls.push({ operation: 'update', id, ...value }); return { id, ...value }; }
    }
  };
  const context = vm.createContext({
    BossCore: Core, BossChatNavigation: require('../chat-navigation.js'), BossSourcePlans: require('../source-plans.js'), BossSchedules: require('../schedules.js'), importScripts() {}, chrome, crypto, URL, AbortController, console, Date: ClockDate, document: options.inspectDocument, getComputedStyle: options.getComputedStyle,
    setTimeout(fn, ms) { return setTimeout(() => { clock += ms; if (ms <= 200) pacedMilliseconds += ms; fn(); }, ms === 45000 ? ms : Math.min(ms, 1)); }, clearTimeout,
    setInterval(fn, ms) { const id = setInterval(fn, ms); intervals.add(id); return id; },
    clearInterval(id) { intervals.delete(id); clearInterval(id); },
    async fetch(url) {
      httpCalls++; fetchCalls.push({ url });
      throw Error('Unexpected external request');
    }
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  const sender = { url: 'chrome-extension://test-extension/options.html' };
  const dispatch = (type, extra = {}, customSender = sender) => new Promise(resolve => listener({ type, ...extra }, customSender, resolve));
  return { data, calls, messages, communications, communicationTimes, published, removed, created, updates, returns, dispatch, windowCalls, fetchCalls, injections, startupCalls, startupEvents, now: () => clock, pacedMilliseconds: () => pacedMilliseconds, inspectIdentity: () => Array.from(vm.runInContext('inspectInlineIdentity("qa")', context)), inspectSalaries: items => JSON.parse(JSON.stringify(context.inspectNativeSalaries(items))), httpCalls: () => httpCalls, abortCalls: () => abortCalls, async finish() { await until(() => ['completed', 'error', 'stopped', 'interrupted'].includes(data.run?.status), options.finishTimeout || 2500); for (const id of intervals) clearInterval(id); } };
}

test('native chat handoff belongs only to its temporary tab and preserves the source list', async () => {
  const chat = 'https://www.zhipin.com/web/geek/chat?id=test-boss&jobId=' + job.id;
  const sender = { url: chat, tab: { id: 22 }, frameId: 0 };
  const sourceSender = { url: 'https://www.zhipin.com/web/geek/jobs', tab: { id: 1 }, frameId: 0 };
  let handoffOpened = false;
  const h = harness({ config: { greetingMode: 'custom', retiredSecret: 'never-export' }, manualHandoff: true, defaultSent: false, reportCustomOnSend: true,
    async onDeliveryCheck(message, { dispatch, data }) {
      if (handoffOpened) return { ready: true };
      const task = { runId: message.runId, jobId: job.id };
      assert.equal((await dispatch('GET_PENDING_CUSTOM', task, sender)).ok, false, 'No handoff has been saved yet');
      assert.equal((await dispatch('CLAIM_CUSTOM_SEND', task, sender)).ok, false, 'A bare chat page cannot claim a send');
      for (const invalidSender of [{ ...sender, tab: { id: 1 } }, { ...sender, tab: { id: 99 } }, { ...sender, frameId: 1 }, { url: 'chrome-extension://test-extension/options.html' }]) {
        assert.equal((await dispatch('GET_PENDING_CUSTOM', task, invalidSender)).ok, false);
      }
      assert.equal((await dispatch('PREPARE_CUSTOM_HANDOFF', { ...task, recipient: { bossId: 'test-boss' } }, sender)).ok, false);
      assert.ok((await dispatch('PREPARE_CUSTOM_HANDOFF', { ...task, recipient: { bossId: 'test-boss', name: '测试HR' } }, sourceSender)).ok);
      assert.equal(data.run.pendingDelivery.recipient.bossId, 'test-boss');
      for (const url of ['https://example.com/web/geek/chat', chat.replace(job.id, 'other-job'), chat.replace('test-boss', 'other-boss')]) {
        assert.equal((await dispatch('OPEN_CUSTOM_CHAT', { ...task, url }, sourceSender)).ok, false);
      }
      assert.ok((await dispatch('OPEN_CUSTOM_CHAT', { ...task, url: chat }, sourceSender)).ok);
      handoffOpened = true;
      const pending = await dispatch('GET_PENDING_CUSTOM', task, sender);
      assert.ok(pending.ok); assert.equal(pending.data.greeting, Core.template(job, data.config));
      assert.equal(JSON.stringify(pending).includes('never-export'), false);
      const claims = await Promise.all([dispatch('CLAIM_CUSTOM_SEND', task, sender), dispatch('CLAIM_CUSTOM_SEND', task, sender)]);
      assert.equal(claims.filter(result => result.ok).length, 1);
      assert.equal(data.run.pendingDelivery.sendAttempted, true);
      assert.equal((await dispatch('GET_PENDING_CUSTOM', task, sender)).data.sendAttempted, true);
      return { ready: false };
    }
  });
  assert.ok((await h.dispatch('START', { tabId: 1 })).ok); await h.finish();
  assert.equal(h.data.run.status, 'completed', h.data.run.message); assert.equal(h.data.run.sent, 1);
  assert.deepEqual(h.returns, []); assert.equal(h.created.length, 1);
  assert.deepEqual(h.removed, [22]); assert.equal(h.updates.some(update => update.id === 1), false);
  assert.equal(h.calls.filter(type => type === 'SCAN').length, 1);
  assert.equal(h.calls.filter(type => type === 'SEND_GREETING').length, 1);
});

test('an interrupted worker never restores or reclaims a pending send automatically', async () => {
  const h = harness({ savedRun: { id: 'interrupted-custom', status: 'running', sourceTabId: 1, pendingDelivery: { job, greeting: '待核实文案', customOnly: true, sendAttempted: true } } });
  const sender = { url: 'https://www.zhipin.com/web/geek/chat', tab: { id: 1 }, frameId: 0 };
  for (const type of ['GET_PENDING_CUSTOM', 'CLAIM_CUSTOM_SEND', 'OPEN_CUSTOM_CHAT']) assert.equal((await h.dispatch(type, { runId: 'interrupted-custom', jobId: job.id }, sender)).ok, false);
  assert.equal(h.data.run.status, 'interrupted'); assert.equal(h.data.run.pendingDelivery.sendAttempted, true);
  assert.equal(h.created.length, 0); assert.equal(h.communications.length, 0);
});
test('inline identity uses nearest rendered job and prioritizes encrypted ID over plain alias', () => {
  const page = { querySelector: () => ({}) };
  const root = { parentElement: page, __vueParentComponent: { props: { jobInfo: { encryptJobId: 'other-job' } } }, querySelector: s => s.includes('inspect-title') ? title : null };
  const title = { parentElement: root, querySelector: () => null, __vueParentComponent: { props: { jobInfo: { encryptJobId: 'abc123', jobId: '100123456' } } } };
  const h = harness({ inspectDocument: { body: {}, querySelector: () => root } });
  assert.deepEqual(h.inspectIdentity(), ['abc123']);
  title.__vueParentComponent.props.jobInfo.encryptJobId = 'wrong-job';
  assert.deepEqual(h.inspectIdentity(), ['wrong-job']);
  delete title.__vueParentComponent;
  delete root.__vueParentComponent;
  assert.deepEqual(h.inspectIdentity(), []);
});

test('explicit custom mode sends the configured template once and counts its durable receipt once', async () => {
  const h = harness({ config: { greetingMode: 'custom', greetingTemplate: '您好，{company}，想了解{title}岗位。' }, defaultSent: false, reportCustomOnSend: true });
  assert.ok((await h.dispatch('START', { tabId: 1 })).ok); await h.finish();
  assert.equal(h.data.run.status, 'completed'); assert.equal(h.data.run.sent, 1);
  assert.equal(h.communications[0].customGreeting, true);
  assert.equal(h.calls.filter(type => type === 'SEND_GREETING').length, 1);
  const receipts = h.data.records.filter(record => record.status === 'sent');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].deliveryKind, 'custom');
  assert.equal(receipts[0].greeting, '您好，样例公司，想了解Java 开发岗位。');
  assert.equal(h.created.length, 1); assert.deepEqual(h.removed, [22]); assert.equal(h.httpCalls(), 0);
});

test('all disabled groups prevent scanning and restoring a group makes it available again', async () => {
  const config = { titleGroupRules: [{ terms: ['Java'], enabled: false }] };
  const h = harness({ config });
  const disabled = await h.dispatch('START', { tabId: 1 });
  assert.equal(disabled.ok, false); assert.match(disabled.error, /所有标题关键词组已停用/);
  assert.equal(h.calls.includes('SCAN'), false); assert.equal(h.communications.length, 0);
  assert.ok((await h.dispatch('SAVE_CONFIG', { config: { ...config, titleGroupRules: [{ terms: ['Java'], enabled: true }] } })).ok);
  assert.ok((await h.dispatch('START', { tabId: 1 })).ok); await h.finish();
  assert.equal(h.data.run.sent, 1);
});

test('verified BOSS auto-greeting evidence stops custom delivery and keeps the observed message in records', async () => {
  const h = harness({ config: { greetingMode: 'custom' }, observedGreeting: 'BOSS 已自动发出的招呼正文' });
  assert.ok((await h.dispatch('START', { tabId: 1 })).ok); await h.finish();
  assert.equal(h.data.run.status, 'error'); assert.equal(h.calls.includes('SEND_GREETING'), false);
  assert.equal(h.data.records[0].observedGreeting, 'BOSS 已自动发出的招呼正文');
  assert.match(h.data.run.message, /关闭 BOSS/); assert.equal(h.data.run.sent, 0);
});

test('custom mode detects a BOSS default receipt and stops before sending any extra text', async () => {
  const h = harness({ config: { greetingMode: 'custom' }, reportOnClick: true });
  assert.ok((await h.dispatch('START', { tabId: 1 })).ok); await h.finish();
  assert.equal(h.data.run.status, 'error'); assert.equal(h.data.run.sent, 0);
  assert.equal(h.calls.includes('SEND_GREETING'), false);
  assert.match(h.data.run.message, /BOSS.*默认招呼/);
  assert.equal(h.data.records[0].status, 'uncertain');
  assert.equal(h.data.records.some(record => record.status === 'sent'), false);
});

test('custom preview saves the expanded message without communicating or sending', async () => {
  const h = harness({ config: { greetingMode: 'custom', greetingTemplate: '您好，我想应聘{position}。' } });
  assert.ok((await h.dispatch('START', { tabId: 1, preview: true })).ok); await h.finish();
  assert.equal(h.data.run.sent, 0); assert.equal(h.communications.length, 0);
  assert.equal(h.data.records[0].status, 'preview');
  assert.equal(h.data.records[0].greeting, '您好，我想应聘Java 开发。');
});

test('blank custom messages are rejected before scanning or creating a conversation', async () => {
  const h = harness({ config: { greetingMode: 'custom', greetingTemplate: '' } });
  assert.equal((await h.dispatch('SAVE_CONFIG', { config: { greetingMode: 'custom', greetingTemplate: '  ' } })).ok, false);
  assert.equal((await h.dispatch('START', { tabId: 1 })).ok, false);
  assert.equal(h.calls.includes('SCAN'), false); assert.equal(h.communications.length, 0);
});

test('unverified custom chat and unconfirmed sends never retry or count as successful', async () => {
  for (const extra of [{ chatReady: false }, { sendConfirmed: false }, { existingGreeting: true }]) {
    const h = harness({ config: { greetingMode: 'custom' }, defaultSent: false, ...extra });
    assert.ok((await h.dispatch('START', { tabId: 1 })).ok); await h.finish();
    assert.equal(h.data.run.status, 'error'); assert.equal(h.data.run.sent, 0);
    assert.equal(h.calls.filter(type => type === 'SEND_GREETING').length, extra.chatReady === false ? 0 : 1);
    assert.equal(h.data.records[0].status, 'uncertain'); assert.equal(h.removed.length, 0);
  }
});

test('a custom receipt survives a lost message channel without a duplicate send', async () => {
  const h = harness({ config: { greetingMode: 'custom' }, defaultSent: false, reportCustomOnSend: true, customLostChannel: true });
  assert.ok((await h.dispatch('START', { tabId: 1 })).ok); await h.finish();
  assert.equal(h.data.run.status, 'completed'); assert.equal(h.data.run.sent, 1);
  assert.equal(h.calls.filter(type => type === 'SEND_GREETING').length, 1);
  assert.equal(h.data.records.filter(record => record.status === 'sent').length, 1);
});

test('custom delivery rejects default receipts and preserves confirmed text across worker restarts', async () => {
  const savedRun = { id: 'custom-run', status: 'running', sourceTabId: 1, sent: 0, pendingDelivery: { job, analysis, greeting: '自定义测试消息', customOnly: true } };
  const h = harness({ savedRun }); const sender = { url: job.url, tab: { id: 1 }, frameId: 0 };
  const receipt = { runId: savedRun.id, jobId: job.id, kind: 'custom', proof: 'outgoing_message' };
  assert.equal((await h.dispatch('REPORT_DELIVERY', { ...receipt, kind: 'boss_default', proof: 'success_dialog' }, sender)).ok, false);
  assert.equal((await h.dispatch('REPORT_DELIVERY', { ...receipt, proof: 'success_dialog' }, sender)).ok, false);
  assert.equal((await h.dispatch('REPORT_DELIVERY', receipt, sender)).ok, true);
  assert.equal((await h.dispatch('REPORT_DELIVERY', receipt, sender)).ok, true);
  assert.equal(h.data.run.sent, 1); assert.equal(h.data.records.length, 1);
  assert.equal(h.data.records[0].deliveryKind, 'custom');
});

test('native editor feedback counts once only for a prepared, claimed custom send in its temporary chat tab', async () => {
  const task = { job, analysis, greeting: '待发送文案', customOnly: true, handoffReady: true, sendAttempted: true, tabId: 22 };
  const savedRun = { id: 'native-feedback-run', status: 'running', sourceTabId: 1, sent: 0, pendingDelivery: task };
  const receipt = { runId: savedRun.id, jobId: job.id, kind: 'custom', proof: 'native_editor_cleared' };
  const sender = { url: 'https://www.zhipin.com/web/geek/chat', tab: { id: 22 }, frameId: 0 };
  for (const patch of [{ handoffReady: false }, { sendAttempted: false }]) {
    const h = harness({ savedRun: { ...savedRun, pendingDelivery: { ...task, ...patch } } });
    assert.equal((await h.dispatch('REPORT_DELIVERY', receipt, sender)).ok, false);
    assert.equal(h.data.run.sent, 0); assert.equal(h.data.records.length, 0);
  }
  const h = harness({ savedRun });
  for (const wrong of [{ ...sender, url: job.url }, { ...sender, tab: { id: 1 } }, { ...sender, tab: { id: 2 } }, { ...sender, frameId: 1 }]) assert.equal((await h.dispatch('REPORT_DELIVERY', receipt, wrong)).ok, false);
  assert.equal((await h.dispatch('REPORT_DELIVERY', receipt, sender)).ok, true);
  assert.equal((await h.dispatch('REPORT_DELIVERY', receipt, sender)).ok, true);
  assert.equal(h.data.run.sent, 1); assert.equal(h.data.records.length, 1);
  assert.equal(h.data.records[0].deliveryProof, 'native_editor_cleared');
});

test('inline identity recognizes native Vue 2 jobInfo.encryptId instead of its plain alias', () => {
  const root = { __vue__: { $props: { data: { jobInfo: { encryptId: 'abc123', jobId: '100123456' }, bossInfo: { encryptId: 'boss-id' } } } }, querySelector: () => null, querySelectorAll: () => [] };
  const h = harness({ inspectDocument: { body: {}, querySelector: () => root } });
  assert.deepEqual(h.inspectIdentity(), ['abc123']);
  root.__vue__.$props.data.jobInfo.encryptJobId = 'explicit-encrypted-id';
  assert.deepEqual(h.inspectIdentity(), ['explicit-encrypted-id']);
});
test('background evaluation registers listeners without calling browser storage APIs', async () => {
  const h = harness({ startupFailures: { access: ['No SW'] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.startupCalls, []);
  assert.equal(typeof h.startupEvents.install, 'function');
  assert.equal(typeof h.startupEvents.startup, 'function');
  const rejected = await h.dispatch('GET_STATE', {}, { url: 'https://evil.test/', tab: { id: 1 }, frameId: 0 });
  assert.equal(rejected.ok, false);
  assert.deepEqual(h.startupCalls, []);
});
test('concurrent requests share one initialization and recover a transient No SW', async () => {
  const h = harness({ startupFailures: { access: ['No SW'] } });
  const responses = await Promise.all([h.dispatch('GET_STATE'), h.dispatch('GET_CONFIG')]);
  assert.ok(responses.every(r => r.ok));
  assert.deepEqual(h.startupCalls, ['access', 'access', 'get']);
  assert.equal(h.data.run, null);
  assert.equal(h.calls.length, 0);
});
test('No SW recovery covers startup storage read and interrupted-state write without replaying jobs', async () => {
  for (const stage of ['get', 'set']) {
    const h = harness({ savedRun: { id: 'old-run', status: 'running', sent: 2 }, startupFailures: { [stage]: ['No SW'] } });
    const response = await h.dispatch('GET_STATE');
    assert.equal(response.ok, true);
    assert.equal(response.data.status, 'interrupted');
    assert.equal(response.data.sent, 2);
    assert.equal(h.startupCalls.filter(call => call === stage).length, 2);
    assert.equal(h.calls.length, 0);
    assert.equal(h.data.records.length, 0);
  }
});
test('exhausted startup retries return an error and a later message can initialize successfully', async () => {
  const h = harness({ startupFailures: { access: ['No SW', 'No SW', 'No SW', 'No SW'] } });
  const failed = await h.dispatch('GET_CONFIG');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /后台暂未就绪/);
  assert.deepEqual(h.startupCalls, ['access', 'access', 'access', 'access']);
  const recovered = await h.dispatch('GET_CONFIG');
  assert.equal(recovered.ok, true);
  assert.deepEqual(h.startupCalls, ['access', 'access', 'access', 'access', 'access', 'get']);
});
test('permanent initialization failures do not retry or erase configuration', async () => {
  const h = harness({ config: { cities: '杭州', greetingTemplate: '保留我的招呼内容' }, startupFailures: { access: ['Permission denied'] } });
  const failed = await h.dispatch('GET_CONFIG');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Permission denied/);
  assert.deepEqual(h.startupCalls, ['access']);
  const recovered = await h.dispatch('GET_CONFIG');
  assert.equal(recovered.ok, true);
  assert.equal(recovered.data.cities, '杭州');
  assert.equal(recovered.data.greetingTemplate, '保留我的招呼内容');
});
test('failed interrupted-state persistence leaves the stored run intact until recovery', async () => {
  const h = harness({ savedRun: { status: 'paused', sent: 3 }, startupFailures: { set: ['Storage unavailable'] } });
  assert.equal((await h.dispatch('GET_STATE')).ok, false);
  assert.equal(h.data.run.status, 'paused');
  const next = await h.dispatch('GET_STATE');
  assert.equal(next.ok, true);
  assert.equal(next.data.status, 'interrupted');
  assert.equal(next.data.sent, 3);
  assert.equal(h.calls.length, 0);
});
test('installation and startup event failures are handled and do not poison future messages', async () => {
  for (const event of ['install', 'startup']) {
    const h = harness({ startupFailures: { access: ['No SW', 'No SW', 'No SW', 'No SW'] } });
    h.startupEvents[event]();
    await until(() => h.startupCalls.length === 4);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await h.dispatch('GET_STATE')).ok, true);
    assert.equal(h.calls.length, 0);
  }
});
test('the native plural jobs route starts and analyzes inline', async () => {
  const h = harness({ tabUrl: 'https://www.zhipin.com/web/geek/jobs?city=101210100' });
  const started = await h.dispatch('START', { tabId: 1, preview: true });
  assert.equal(started.ok, true, started.error);
  await h.finish();
  assert.equal(h.data.run.status, 'completed');
  assert.equal(h.data.run.scanned, 1);
  assert.equal(h.data.run.sent, 0);
  assert.equal(h.created.length, 0);
});
test('preview evaluates but never clicks or sends', async () => {
  const h = harness();
  assert.equal((await h.dispatch('START', { tabId: 1, preview: true })).ok, true);
  await h.finish();
  assert.equal(h.data.run.matched, 1);
  assert.equal(h.data.records[0].status, 'preview');
  assert.ok(!h.calls.includes('COMMUNICATE'));
  assert.ok(!h.calls.includes('SEND_GREETING'));
});

test('complete title groups gate default delivery and survive background config persistence', async () => {
  const titleGroups = [['Java', '实习'], ['后端', '开发', '实习']];
  for (const [title, accepted] of [['java 实习生', true], ['实习-JAVA开发', true], ['后端开发实习生', true], ['Java后端工程师', false], ['JavaScript开发实习生', false], ['全栈开发（偏JAVA）--周末双休', false]]) {
    const candidate = { ...job, title };
    const h = harness({ jobs: [candidate], detail: candidate });
    const saved = await h.dispatch('SAVE_CONFIG', { config: { titleGroups, titleMode: 'any', blockedWords: '', intervalSeconds: 3, maxJobs: 1, maxScan: 1 } });
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual((await h.dispatch('GET_CONFIG')).data.titleGroups, titleGroups);
    assert.equal((await h.dispatch('START', { tabId: 1 })).ok, true);
    await h.finish();
    assert.equal(h.data.run.status, 'completed', title);
    assert.equal(h.data.run.sent, accepted ? 1 : 0, title);
    assert.equal(h.communications.length, accepted ? 1 : 0, title);
    assert.ok(!h.calls.includes('SEND_GREETING'));
    if (accepted) assert.equal(h.data.records.find(record => record.status === 'sent').deliveryKind, 'boss_default');
    else assert.equal(h.data.records[0].status, 'filtered');
  }
});
test('obsolete settings never bypass local title groups during preview', async () => {
  const intern = { ...job, title: '业务研发实习生', description: '接受在校实习生，负责 Java 后端服务开发。' };
  const h = harness({ jobs: [intern], detail: intern, config: { retiredMode: true, retiredSecret: 'fixture-key', titleGroups: [['Java', '实习']], retiredTitleSwitch: false } });
  assert.equal((await h.dispatch('GET_CONFIG')).data.retiredMode, undefined);
  assert.equal((await h.dispatch('START', { tabId: 1, preview: true })).ok, true);
  await h.finish();
  assert.equal(h.data.run.matched, 0); assert.equal(h.data.run.sent, 0);
  assert.equal(h.data.records[0].status, 'filtered'); assert.equal(h.httpCalls(), 0);
  assert.ok(!h.calls.includes('COMMUNICATE'));
});

test('unsupported actions reject without opening pages', async () => {
  const h = harness(); const result = await h.dispatch('UNSUPPORTED_ACTION');
  assert.equal(result.ok, false); assert.equal(h.data.run, null);
  assert.equal(h.created.length, 0); assert.equal(h.removed.length, 0);
  assert.ok(!h.calls.includes('COMMUNICATE'));
});

test('website scripts cannot invoke unsupported actions', async () => {
  const h = harness(); const sender = { url: job.url, tab: { id: 1 }, frameId: 0 };
  for (const type of ['UNSUPPORTED_ACTION', 'INTERNAL_ACTION']) assert.equal((await h.dispatch(type, {}, sender)).ok, false);
  assert.equal(h.created.length, 0); assert.equal(h.httpCalls(), 0);
});

test('reconnect injects a disconnected BOSS page and restores its panel without sending', async () => {
  const h = harness({ disconnected: true });
  const result = await h.dispatch('CONNECT_PAGE', { tabId: 1 });
  assert.equal(result.ok, true);
  assert.equal(h.injections.length, 1);
  assert.deepEqual(Array.from(h.injections[0].files), ['cities.js', 'core.js', 'salary.js', 'content.js']);
  assert.equal(h.injections[0].target.tabId, 1);
  assert.ok(h.calls.includes('SHOW_PANEL'));
  assert.ok(!h.calls.includes('COMMUNICATE'));
  assert.equal(h.data.records.length, 0);
  assert.equal(h.data.run, null);
  await h.dispatch('CONNECT_PAGE', { tabId: 1 });
  assert.equal(h.injections.length, 1);
});
test('reconnect cannot inject other sites, ungranted pages or requests from website scripts', async () => {
  for (const options of [{ tabUrl: 'https://evil.test/' }, { authorized: false }]) {
    const h = harness(options);
    assert.equal((await h.dispatch('CONNECT_PAGE', { tabId: 1 })).ok, false);
    assert.equal(h.injections.length, 0);
  }
  const h = harness({ disconnected: true });
  assert.equal((await h.dispatch('CONNECT_PAGE', { tabId: 1 }, { url: job.url, tab: { id: 1 }, frameId: 0 })).ok, false);
  assert.equal(h.injections.length, 0);
});
test('starting preview reconnects a page left open across extension updates', async () => {
  const h = harness({ disconnected: true });
  assert.equal((await h.dispatch('START', { tabId: 1, preview: true })).ok, true);
  await h.finish();
  assert.equal(h.injections.length, 1);
  assert.equal(h.data.run.status, 'completed');
  assert.ok(!h.calls.includes('COMMUNICATE'));
});
test('default delivery records BOSS receipt and uses only the existing tab', async () => {
  const h = harness();
  await h.dispatch('START', { tabId: 1, preview: false }); await h.finish();
  assert.equal(h.data.run.sent, 1); assert.equal(h.data.run.attempted, 1);
  assert.equal(h.calls.filter(x => x === 'SEND_GREETING').length, 0);
  assert.ok(h.data.records.some(r => r.status === 'communication_requested'));
  assert.ok(h.data.records.some(r => r.status === 'sent'));
  assert.equal(h.created.length, 0); assert.equal(h.removed.length, 0);
  assert.equal(h.updates.length, 0);
  assert.ok(h.calls.includes('SELECT_JOB'));
  assert.equal(h.data.records[0].deliveryKind, 'boss_default');
  assert.equal(h.data.records[0].greeting, '');
});
test('obsolete settings do not affect local default delivery', async () => {
  const h = harness({ config: { retiredMode: true, retiredSecret: 'expired-fixture-key', retiredModel: 'obsolete' } });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.status, 'completed'); assert.equal(h.data.run.sent, 1);
  assert.equal(h.httpCalls(), 0); assert.equal(h.communications.length, 1);
});

test('title mismatches with obsolete settings filter before any communication', async () => {
  const candidate = { ...job, title: 'JavaScript实习生' };
  const h = harness({ jobs: [candidate], detail: candidate, config: { retiredMode: true, retiredSecret: 'fixture-key', titleGroups: [['Java', '实习']] } });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.status, 'completed'); assert.equal(h.data.run.sent, 0);
  assert.equal(h.data.records[0].status, 'filtered'); assert.equal(h.httpCalls(), 0);
  assert.ok(!h.calls.includes('COMMUNICATE'));
});

test('unsupported commands reject even trusted settings requests without network access', async () => {
  const h = harness({ config: { retiredMode: true, retiredSecret: 'fixture-key' } });
  const result = await h.dispatch('UNSUPPORTED_ACTION', { config: h.data.config });
  assert.equal(result.ok, false); assert.equal(h.httpCalls(), 0);
  assert.equal(h.data.run, null); assert.equal(h.communications.length, 0);
});

test('unconfirmed default send retains tab, records uncertainty and never retries or sends custom text', async () => {
  const h = harness({ config: { customGreeting: true }, sendConfirmed: false, defaultSent: false });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 0); assert.equal(h.data.run.status, 'error');
  assert.equal(h.data.run.reviewTabId, 1); assert.equal(h.removed.length, 0);
  assert.equal(h.calls.filter(x => x === 'SEND_GREETING').length, 0);
  assert.equal(h.calls.filter(x => x === 'COMMUNICATE').length, 1);
  assert.equal(h.data.records[0].status, 'uncertain');
});
test('default delivery does not require a direct chat identity even with old custom settings', async () => {
  const h = harness({ config: { customGreeting: true }, chatReady: false });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.status, 'completed');
  assert.equal(h.data.run.sent, 1);
  assert.ok(!h.calls.includes('SEND_GREETING'));
  assert.ok(!h.calls.includes('READ_NATIVE_CHAT'));
  assert.equal(h.data.records[0].deliveryKind, 'boss_default');
});
test('history prevents repeat attempts for sent and uncertain jobs', async () => {
  const h = harness({ records: [{ job, status: 'uncertain' }] });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.scanned, 1); assert.ok(!h.calls.includes('READ_DETAIL')); assert.ok(!h.calls.includes('COMMUNICATE'));
});

test('old custom switch cannot suppress a verified native default receipt', async () => {
  const h = harness({ config: { customGreeting: true }, chatReady: false });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 1);
  assert.equal(h.data.run.status, 'completed');
  assert.equal(h.calls.filter(t => t === 'SEND_GREETING').length, 0);
  assert.equal(h.data.records.filter(r => r.status === 'sent').length, 1);
  assert.equal(h.data.records[0].deliveryKind, 'boss_default');
});

test('default-only delivery saves the native receipt and counts the job once', async () => {
  const h = harness({ config: { customGreeting: true } });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 1);
  assert.deepEqual(h.data.records.filter(r => r.status === 'sent').map(r => r.deliveryKind), ['boss_default']);
  assert.equal(h.calls.filter(t => t === 'SEND_GREETING').length, 0);
  assert.equal(h.communications[0].customGreeting, false);
  assert.equal(h.communications[0].greeting, undefined);
  assert.equal(h.created.length, 0);
});

test('native default delivery ignores unused template settings', async () => {
  const h = harness({ config: { retiredMode: true, retiredSecret: 'fixture-key', retiredGreeting: true, customGreeting: true, greetingTemplate: '不能使用这个模板' }, reportOnClick: true });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.status, 'completed');
  assert.equal(h.data.run.sent, 1);
  const receipts = h.data.records.filter(r => r.status === 'sent');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].deliveryKind, 'boss_default');
  assert.equal(receipts[0].greeting, '');
  assert.equal(receipts[0].analysis.greeting, '');
  assert.equal(h.httpCalls(), 0);
  assert.ok(!h.calls.includes('SEND_GREETING'));
});

test('local screening supports native default delivery and unsent preview with legacy flags', async () => {
  const h = harness({ config: { retiredMode: true, retiredSecret: 'fixture-key', retiredGreeting: false } });
  assert.equal((await h.dispatch('START', { tabId: 1 })).ok, true);
  await h.finish();
  assert.equal(h.data.run.sent, 1);
  assert.equal(h.calls.includes('SEND_GREETING'), false);
  assert.ok((await h.dispatch('START', { tabId: 1, preview: true })).ok);
  await h.finish();
  assert.equal(h.data.run.status, 'completed');
  assert.equal(h.data.run.sent, 0);
});

test('different companies receive native default messages after independent JD screening without greeting rewrites', async () => {
  const second={...job,id:'def456',url:'https://www.zhipin.com/job_detail/def456.html',company:'杭城产品公司',description:'使用 Java，负责2B端互联网产品研发，快速定位线上问题。'};
  const h=harness({jobs:[job,second],config:{retiredMode:true,retiredSecret:'fixture-key',maxJobs:2},detailsById:{abc123:job,def456:second}});
  await h.dispatch('START',{tabId:1});await h.finish();
  assert.equal(h.data.run.sent,2);
  assert.equal(h.httpCalls(),0);
  assert.equal(h.data.records.find(r=>r.status==='sent'&&r.job.id===second.id).greeting,'');
});

test('preview remains local and never sends', async () => {
  const h=harness({config:{retiredMode:true,retiredSecret:'fixture-key'}});
  await h.dispatch('START',{tabId:1,preview:true});await h.finish();
  assert.equal(h.httpCalls(),0);
  assert.equal(h.calls.includes('COMMUNICATE'),false);
  assert.equal(h.data.records[0].status,'preview');
  assert.equal(h.data.records[0].greeting,'');
});

test('an already contacted job is skipped without another default greeting', async () => {
  const h = harness({ config: { customGreeting: true }, alreadyContacted: true });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.status, 'completed');
  assert.equal(h.data.run.sent, 0);
  assert.equal(h.data.records.filter(r => r.status === 'sent').length, 0);
  assert.equal(h.data.records[0].status, 'already_contacted');
});

test('missing default receipt stops without opening or closing tabs or sending a custom message', async () => {
  const h = harness({ defaultSent: false });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 0);
  assert.equal(h.data.run.status, 'error');
  assert.equal(h.data.records[0].status, 'uncertain');
  assert.equal(h.created.length, 0); assert.equal(h.removed.length, 0);
  assert.ok(!h.calls.includes('SEND_GREETING'));
});

test('a receipt saved by the page survives a destroyed communication channel', async () => {
  const h = harness({ reportOnClick: true, lostChannel: true });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.status, 'completed'); assert.equal(h.data.run.sent, 1);
  assert.equal(h.data.records.filter(r => r.status === 'sent').length, 1);
  assert.ok(!h.calls.includes('SEND_GREETING')); assert.equal(h.removed.length, 0);
});

test('late receipts after worker interruption are durable, idempotent and restricted to the pending job', async () => {
  const savedRun = { id: 'receipt-run', status: 'running', sourceTabId: 1, sent: 0, pendingDelivery: { job, analysis, greeting: '测试招呼' } };
  const h = harness({ savedRun });
  const sender = { url: job.url, tab: { id: 1 }, frameId: 0 };
  const receipt = { runId: 'receipt-run', jobId: job.id, proof: 'success_dialog' };
  for (const extra of [{ jobId: 'another-job' }, { runId: 'stale-run' }, { proof: 'button_changed' }]) {
    assert.equal((await h.dispatch('REPORT_DELIVERY', { ...receipt, ...extra }, sender)).ok, false);
  }
  assert.equal((await h.dispatch('REPORT_DELIVERY', receipt, { ...sender, tab: { id: 2 } })).ok, false);
  const responses = await Promise.all([h.dispatch('REPORT_DELIVERY', receipt, sender), h.dispatch('REPORT_DELIVERY', receipt, sender)]);
  assert.ok(responses.every(r => r.ok));
  assert.equal(h.data.run.sent, 1);
  assert.equal(h.data.run.status, 'interrupted');
  assert.equal(h.data.records.length, 1);
  assert.equal(h.data.records[0].greeting, '');
  const restarted = harness({ savedRun: h.data.run, records: h.data.records });
  assert.equal((await restarted.dispatch('GET_STATE')).data.sent, 1);
  assert.equal((await restarted.dispatch('REPORT_DELIVERY', receipt, sender)).ok, true);
  assert.equal(restarted.data.records.length, 1);
});

test('the page can start a run only in its own tab and STOP preserves that tab', async () => {
  const h = harness();
  const sender = { url: 'https://www.zhipin.com/web/geek/job', tab: { id: 1 }, frameId: 0 };
  assert.equal((await h.dispatch('START', { tabId: 99, preview: true }, sender)).ok, true);
  await h.dispatch('STOP', {}, sender); await h.finish();
  assert.equal(h.data.run.sourceTabId, 1);
  assert.equal(h.removed.length, 0);
  assert.equal(h.created.length, 0);
});
test('service worker restart marks active run interrupted and preserves completed state', async () => {
  for (const status of ['running', 'paused', 'completed']) {
    const h = harness({ savedRun: { status, id: 'previous', sent: 3 } });
    const result = await h.dispatch('GET_STATE');
    assert.equal(result.data.status, status === 'completed' ? 'completed' : 'interrupted');
    assert.equal(result.data.sent, 3); assert.equal(h.calls.length, 0);
  }
});
test('BOSS content script cannot read private settings or change config', async () => {
  const h = harness({ config: { retiredSecret: 'fixture-key' } });
  const contentSender = { url: 'https://www.zhipin.com/web/geek/job', tab: { id: 1 }, frameId: 0 };
  assert.equal((await h.dispatch('GET_CONFIG', {}, contentSender)).ok, false);
  assert.equal((await h.dispatch('SAVE_CONFIG', { config: {} }, contentSender)).ok, false);
  const pageConfig = (await h.dispatch('GET_PAGE_CONFIG', {}, contentSender)).data;
  assert.equal(pageConfig.clickApply, false);
  assert.deepEqual(Object.keys(pageConfig), ['clickApply']);
  assert.equal((await h.dispatch('GET_STATE', {}, { url: 'https://evil.test', tab: { id: 1 }, frameId: 0 })).ok, false);
});
test('extension options opened in a tab can access and save configuration', async () => {
  const h = harness();
  const optionsSender = { url: 'chrome-extension://test-extension/options.html#rules', tab: { id: 100 } };
  assert.equal((await h.dispatch('GET_CONFIG', {}, optionsSender)).ok, true);
  assert.equal((await h.dispatch('SAVE_CONFIG', { config: { cities: '上海' } }, optionsSender)).ok, true);
  assert.equal(h.data.config.cities, '上海');
});
test('pause blocks the next irreversible step until resume', async () => {
  const h = harness();
  await h.dispatch('START', { tabId: 1 });
  await h.dispatch('PAUSE');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.data.run.status, 'paused'); assert.ok(!h.calls.includes('COMMUNICATE'));
  await h.dispatch('RESUME'); await h.finish();
  assert.equal(h.data.run.sent, 1);
});
test('concurrent starts cannot overwrite the active queue', async () => {
  const h = harness();
  const results = await Promise.all([h.dispatch('START', { tabId: 1, preview: true }), h.dispatch('START', { tabId: 1, preview: true })]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => !r.ok).length, 1);
  await h.finish();
  assert.equal(h.calls.filter(t => t === 'SCAN').length, 1);
});
test('settings opens a BOSS overlay without creating windows or tabs', async () => {
  const h = harness();
  const replies = await Promise.all([h.dispatch('OPEN_SETTINGS'), h.dispatch('OPEN_SETTINGS')]);
  assert.ok(replies.every(r => r.ok && r.data.embedded && r.data.tabId === 1));
  assert.equal(h.windowCalls.length, 0); assert.equal(h.created.length, 0);
  assert.equal(h.calls.filter(t => t === 'SHOW_SETTINGS').length, 2);
});
test('settings requires an existing BOSS page and does not create a desktop popup', async () => {
  const h = harness({ noBossTab: true });
  assert.equal((await h.dispatch('OPEN_SETTINGS')).ok, false);
  assert.equal(h.windowCalls.length, 0); assert.equal(h.created.length, 0);
});
test('batch loads subsequent cards incrementally without page navigation', async () => {
  const next = { ...job, id: 'next-job', url: 'https://www.zhipin.com/job_detail/next-job.html', title: 'Java 实习' };
  const h = harness({ moreJobs: [next] });
  await h.dispatch('START', { tabId: 1, preview: true }); await h.finish();
  assert.equal(h.data.run.scanned, 2);
  assert.equal(h.calls.filter(t => t === 'SELECT_JOB').length, 2);
  assert.ok(h.calls.includes('SCAN_MORE'));
  assert.equal(h.updates.length, 0); assert.equal(h.created.length, 0);
});
test('a single job click never continues into a batch', async () => {
  const h = harness({ config: { clickApply: true } });
  const sender = { url: 'https://www.zhipin.com/web/geek/job', tab: { id: 1 }, frameId: 0 };
  assert.equal((await h.dispatch('CLICK_JOB', { job }, sender)).ok, true); await h.finish();
  assert.equal(h.data.run.sent, 1); assert.ok(!h.calls.includes('SCAN_MORE'));
});

test('saving configuration discards unsupported fields', async () => {
  const h = harness();
  const result = await h.dispatch('SAVE_CONFIG', { config: { retiredMode: true, retiredProvider: 'removed', retiredSecret: '', retiredModel: '', titleGroups: [['Java']] } });
  assert.equal(result.ok, true, result.error); assert.equal(h.data.config.retiredMode, undefined);
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 1); assert.equal(h.httpCalls(), 0);
});

test('automatic batch keeps loading past scan batch size and attempted count until successful target', async () => {
  const make = id => ({ ...job, id, url: 'https://www.zhipin.com/job_detail/' + id + '.html' });
  const first = { ...make('filtered'), title: 'JavaScript 实习生' };
  const h = harness({ jobs: [first], config: { maxScan: 1, maxJobs: 2 }, alreadyContactedIds: ['already'], moreJobBatches: [[make('already')], [make('new-one')], [make('new-two')], [make('excess')]] });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.status, 'completed'); assert.equal(h.data.run.completionReason, 'target');
  assert.equal(h.data.run.sent, 2); assert.equal(h.data.run.scanned, 4); assert.equal(h.data.run.attempted, 3);
  assert.equal(h.calls.filter(type => type === 'SCAN_MORE').length, 3);
  assert.equal(h.calls.filter(type => type === 'COMMUNICATE').length, 3);
  assert.equal(h.data.records.filter(record => record.status === 'sent').length, 2);
  assert.match(h.data.run.message, /目标已完成/);
});

test('exhausted list reports successful count below target instead of claiming target completion', async () => {
  const h = harness({ config: { maxScan: 1, maxJobs: 5 } });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 1); assert.equal(h.data.run.completionReason, 'list_exhausted');
  assert.match(h.data.run.message, /1 \/ 5/); assert.match(h.data.run.message, /未达到目标/);
});

test('preview still honors its analysis count and never continues to meet a send target', async () => {
  const h = harness({ config: { maxScan: 1, maxJobs: 5 }, moreJobs: [{ ...job, id: 'next', url: 'https://www.zhipin.com/job_detail/next.html' }] });
  await h.dispatch('START', { tabId: 1, preview: true }); await h.finish();
  assert.equal(h.data.run.scanned, 1); assert.equal(h.data.run.sent, 0);
  assert.ok(!h.calls.includes('SCAN_MORE')); assert.ok(!h.calls.includes('COMMUNICATE'));
});

const batchJob = (id, title = 'Java 实习生') => ({ ...job, id, url: 'https://www.zhipin.com/job_detail/' + id + '.html', title });
const customBatchConfig = { greetingMode: 'custom', maxJobs: 2, maxScan: 200, titleGroups: [['Java']] };

test('card-first title and city rejection bypasses stale details; JD blockers apply only to candidates', async () => {
  for (const mode of ['boss_default', 'custom']) {
    const titleMismatch = { ...batchJob('title-mismatch', 'Java开发工程师-双休'), location: '杭州' };
    const cityMismatch = { ...batchJob('city-mismatch'), location: '苏州' };
    const blocked = { ...batchJob('blocked-jd'), location: '杭州' };
    const accepted = { ...batchJob('accepted'), location: '杭州' };
    const h = harness({ jobs: [titleMismatch, cityMismatch, blocked, accepted],
      config: { titleGroups: [['Java', '实习']], cities: '杭州', blockedWords: '外派', maxJobs: 1, greetingMode: mode },
      detailsById: { 'blocked-jd': { ...blocked, description: '负责 Java 后端服务开发，该岗位为外派工作。' } },
      defaultSent: mode === 'boss_default', reportCustomOnSend: true,
      onFocus(message) { if (message.type === 'SELECT_JOB') assert.ok(!['title-mismatch', 'city-mismatch'].includes(message.job.id), 'Rejected cards must never open or verify a stale right-hand detail'); }
    });
    await h.dispatch('START', { tabId: 1 }); await h.finish();
    assert.equal(h.data.run.status, 'completed', h.data.run.message);
    assert.deepEqual(h.messages.filter(message => message.type === 'SELECT_JOB').map(message => message.job.id), [blocked.id, accepted.id]);
    assert.deepEqual(h.messages.filter(message => message.type === 'READ_DETAIL').map(message => message.id), [blocked.id, accepted.id]);
    assert.deepEqual(h.communications.map(message => message.job.id), [accepted.id]);
    assert.equal(h.data.run.sent, 1); assert.equal(h.data.run.scanned, 4);
    for (const [candidate, pattern] of [[titleMismatch, /标题/], [cityMismatch, /地区/], [blocked, /外派/]]) {
      assert.match(h.data.records.find(record => record.status === 'filtered' && record.job.id === candidate.id).reason, pattern);
    }
  }
});

test('card-first screening skips rejected candidates and history without opening native details', async () => {
  const history = batchJob('history'), filtered = batchJob('filtered', 'Python 实习');
  const h = harness({ jobs: [history, filtered], records: [{ job: history, status: 'sent' }], config: { titleGroups: [['Java']] } });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.calls.includes('MARK_JOB'), false);
  assert.equal(h.calls.filter(type => type === 'FOCUS_JOB').length, 2);
  assert.equal(h.calls.includes('SELECT_JOB'), false);
  assert.equal(h.calls.includes('READ_DETAIL'), false);
  assert.equal(h.communications.length, 0);
  assert.match(h.data.records[0].reason, /标题关键词组不匹配/);
  assert.equal(h.data.run.phase, 'loading');
});

test('card-first title rejection never waits for browsing or greeting intervals before a candidate', async () => {
  for (const browseIntervalSeconds of [1, 3, 8]) {
    const rejected = [batchJob('python', 'Python 实习'), batchJob('frontend', '前端实习')], accepted = batchJob('java');
    const selections = [];
    const h = harness({ jobs: [...rejected, accepted], config: { titleGroups: [['Java']], browseIntervalSeconds, intervalSeconds: 120, maxJobs: 1 },
      onFocus(message) { if (message.type === 'SELECT_JOB') selections.push({ id: message.job.id, at: h.now() }); }
    });
    await h.dispatch('START', { tabId: 1 }); await h.finish();
    assert.equal(h.data.run.status, 'completed', h.data.run.message);
    assert.deepEqual(selections.map(item => item.id), [accepted.id]);
    assert.equal(h.pacedMilliseconds(), 0, 'Local rejection needs no native request throttle');
    assert.deepEqual(h.messages.filter(message => message.type === 'READ_DETAIL').map(message => message.id), selections.map(item => item.id));
    assert.equal(h.messages.some(message => message.displayOnly), false);
    assert.deepEqual(h.communications.map(message => message.job.id), [accepted.id]);
    assert.equal(h.data.run.scanned, 3); assert.equal(h.data.run.sent, 1);
    assert.ok(h.published.some(message => message.run?.message.startsWith('卡片初筛跳过：')));
    assert.equal(h.updates.some(update => update.id === 1), false);
  }
});

test('preview filters rejected cards locally and stops at the analysis limit', async () => {
  const rejected = [batchJob('python', 'Python 实习'), batchJob('frontend', '前端实习')];
  const h = harness({ jobs: [...rejected, batchJob('excess')], config: { titleGroups: [['Java']], maxScan: 2 } });
  await h.dispatch('START', { tabId: 1, preview: true }); await h.finish();
  assert.equal(h.calls.includes('SELECT_JOB'), false); assert.equal(h.calls.includes('READ_DETAIL'), false);
  assert.equal(h.data.run.scanned, 2); assert.equal(h.data.run.matched, 0); assert.equal(h.communications.length, 0);
  assert.equal(h.calls.includes('SCAN_MORE'), false);
});

test('native detail loading counts toward browsing time without adding a full delay afterward', async () => {
  for (const load of [0, 1500, 2500]) {
    const selected = [];
    const h = harness({ jobs: [batchJob('java-one'), batchJob('java-two')], detailLoadMilliseconds: load,
      config: { titleGroups: [['Java']], browseIntervalSeconds: 2, intervalSeconds: 120, maxScan: 2 },
      onFocus(message) { if (message.type === 'SELECT_JOB') selected.push(h.now()); }
    });
    await h.dispatch('START', { tabId: 1, preview: true }); await h.finish();
    assert.equal(selected[1] - selected[0], Math.max(2000, load));
    assert.equal(h.pacedMilliseconds(), Math.max(0, 2000 - load), 'Final preview and slow-loading details need no extra browsing delay');
    assert.equal(h.communications.length, 0);
  }
});

test('both message modes enforce greeting spacing independently of faster browsing', async () => {
  for (const mode of ['boss_default', 'custom']) {
    const selected = [];
    const h = harness({ jobs: [batchJob('first'), batchJob('second')], detailLoadMilliseconds: 1500,
      config: { greetingMode: mode, browseIntervalSeconds: 1, intervalSeconds: 8, maxJobs: 2 }, defaultSent: mode === 'boss_default', reportCustomOnSend: true,
      onFocus(message) { if (message.type === 'SELECT_JOB') selected.push(h.now()); }
    });
    await h.dispatch('START', { tabId: 1 }); await h.finish();
    assert.equal(h.data.run.sent, 2, h.data.run.message);
    const firstReceipt = h.data.records.find(record => record.status === 'sent' && record.job.id === 'first');
    assert.ok(h.communicationTimes[1] - Date.parse(firstReceipt.time) >= 8000);
    assert.ok(selected[1] - selected[0] < 8000, 'Browsing need not wait for the next greeting');
    assert.ok(h.published.some(message => message.run?.message.startsWith('岗位符合，等待打招呼间隔')));
    assert.equal(h.updates.some(update => update.id === 1), false);
  }
});

test('local rejects preserve the greeting cooldown without opening their details', async () => {
  const selected = [];
  const h = harness({ jobs: [batchJob('first'), batchJob('python', 'Python 实习'), batchJob('frontend', '前端实习'), batchJob('second')], detailLoadMilliseconds: 1000,
    config: { titleGroups: [['Java']], browseIntervalSeconds: 3, intervalSeconds: 5, maxJobs: 2 },
    onFocus(message) { if (message.type === 'SELECT_JOB') selected.push(h.now()); }
  });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 2);
  const firstReceipt = h.data.records.find(record => record.status === 'sent' && record.job.id === 'first');
  assert.ok(h.communicationTimes[1] >= Date.parse(firstReceipt.time) + 5000);
  assert.equal(selected.length, 2);
  assert.deepEqual(h.messages.filter(message => message.type === 'READ_DETAIL').map(message => message.id), ['first', 'second']);
});

test('pause and stop during greeting cooldown cannot save a new send intent or click early', async () => {
  for (const stop of [false, true]) {
    const h = harness({ jobs: [batchJob('first'), batchJob('second')], config: { browseIntervalSeconds: 1, intervalSeconds: 30, maxJobs: 2 } });
    await h.dispatch('START', { tabId: 1 });
    await until(() => h.data.run.message.startsWith('岗位符合，等待打招呼间隔'));
    await h.dispatch(stop ? 'STOP' : 'PAUSE');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.communications.length, 1);
    assert.equal(h.data.records.some(record => record.job.id === 'second' && record.status === 'communication_requested'), false);
    if (!stop) await h.dispatch('RESUME');
    await h.finish();
    assert.equal(h.data.run.status, stop ? 'stopped' : 'completed'); assert.equal(h.data.run.sent, stop ? 1 : 2);
    assert.equal(h.data.records.some(record => record.status === 'uncertain'), false);
  }
});

test('pause after selecting a candidate waits for resume before continuing details or later jobs', async () => {
  const rejected = [batchJob('java-one'), batchJob('java-two')];
  let paused = false;
  const h = harness({ jobs: rejected, config: { titleGroups: [['Java']], maxScan: 2 },
    async onFocus(message) { if (message.type === 'SELECT_JOB' && !paused) { paused = true; await h.dispatch('PAUSE'); } }
  });
  await h.dispatch('START', { tabId: 1, preview: true }); await until(() => h.data.run.status === 'paused');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(h.calls.filter(type => type === 'SELECT_JOB').length, 1); assert.equal(h.calls.includes('READ_DETAIL'), false);
  await h.dispatch('RESUME'); await h.finish();
  assert.equal(h.data.run.status, 'completed'); assert.equal(h.data.run.scanned, 2); assert.equal(h.communications.length, 0);
});

test('stop during the browsing interval prevents selecting the next candidate', async () => {
  const h = harness({ jobs: [batchJob('first'), batchJob('next')], config: { titleGroups: [['Java']], browseIntervalSeconds: 8 } });
  await h.dispatch('START', { tabId: 1, preview: true }); await until(() => h.data.run.scanned === 1);
  await h.dispatch('STOP'); await h.finish();
  assert.equal(h.data.run.status, 'stopped'); assert.equal(h.calls.filter(type => type === 'SELECT_JOB').length, 1);
  assert.equal(h.communications.length, 0); assert.equal(h.data.records[0].status, 'preview');
});

test('custom city bindings send the separately verified city for each job until the successful target', async () => {
  const one = { ...batchJob('hangzhou'), location: '杭州·余杭区·仓前' }, two = { ...batchJob('suzhou'), location: '苏州·工业园区' };
  const h = harness({ jobs: [one, two], config: { ...customBatchConfig, greetingTemplate: '{city}有常住地，想了解{title}。' }, defaultSent: false, navigateOnCustomSend: true, reportCustomOnSend: true });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 2, h.data.run.message);
  assert.deepEqual(h.communications.map(message => message.greeting), ['杭州有常住地，想了解Java 实习生。', '苏州有常住地，想了解Java 实习生。']);
  assert.equal(h.data.records.filter(record => record.status === 'sent').length, 2);
});

test('city ambiguity or a card/detail conflict stops before any native communication and preserves the template', async () => {
  for (const detail of [{ ...job, location: '全国' }, { ...job, location: '杭州' }]) {
    const h = harness({ config: { greetingMode: 'custom', greetingTemplate: '{city}有常住地。' }, detail, defaultSent: false });
    await h.dispatch('START', { tabId: 1 }); await h.finish();
    assert.equal(h.data.run.status, 'error'); assert.match(h.data.run.message, /城市/);
    assert.equal(h.communications.length, 0); assert.equal(h.data.run.sent, 0);
    assert.equal(h.data.records[0].greeting, '{city}有常住地。');
  }
});

test('140 filtered jobs are scanned once while multiple custom sends retain the original queue and list', async () => {
  const filtered = Array.from({ length: 140 }, (_, index) => batchJob('filtered-' + index, 'Python开发工程师'));
  const first = batchJob('first-send'), second = batchJob('second-send');
  const counts = [], runIds = [];
  const h = harness({ jobs: [...filtered, first, second], finishTimeout: 60000, strictCards: true, config: customBatchConfig, defaultSent: false, navigateOnCustomSend: true, reportCustomOnSend: true,
    onCloseWorker({ data }) { counts.push(data.run.sent); runIds.push(data.run.id); }
  });
  assert.ok((await h.dispatch('START', { tabId: 1 })).ok); await h.finish();
  assert.equal(h.data.run.status, 'completed', h.data.run.message); assert.equal(h.data.run.completionReason, 'target');
  assert.deepEqual(counts, [1, 2]); assert.equal(new Set(runIds).size, 1);
  assert.deepEqual(h.communications.map(message => message.job.id), [first.id, second.id]);
  assert.equal(h.data.run.scanned, 142); assert.equal(h.data.run.processedJobIds.length, 142);
  assert.equal(h.data.records.filter(record => record.status === 'sent').length, 2);
  assert.equal(h.calls.filter(type => type === 'SCAN').length, 1);
  assert.equal(h.calls.filter(type => type === 'SCAN_MORE').length, 0);
  assert.equal(h.calls.filter(type => type === 'FOCUS_JOB').length, 142);
  assert.equal(h.calls.filter(type => type === 'SELECT_JOB').length, 2);
  assert.equal(h.created.length, 2); assert.deepEqual(h.removed, [22, 23]);
  assert.ok(h.created.every(tab => tab.active === false && tab.openerTabId === 1));
  assert.equal(h.updates.some(tab => tab.id === 1), false); assert.deepEqual(h.returns, []);
  assert.equal(h.httpCalls(), 0);
});

test('duplicate identities and changed titles cannot resend a completed job while the source stays open', async () => {
  const first = batchJob('sent-first'), second = batchJob('sent-second');
  const h = harness({ jobs: [first, { ...first, title: 'Java 开发（已改名）' }, second, second],
    config: customBatchConfig, defaultSent: false, strictCards: true, navigateOnCustomSend: true, reportCustomOnSend: true
  });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.completionReason, 'target'); assert.equal(h.data.run.sent, 2);
  assert.deepEqual(h.communications.map(message => message.job.id), [first.id, second.id]);
  assert.equal(h.calls.filter(type => type === 'SEND_GREETING').length, 2);
  assert.equal(h.calls.filter(type => type === 'SCAN').length, 1);
});

test('a card disappearing before focus rebuilds the list without communication or stopping the batch', async () => {
  const vanished = batchJob('vanished'), next = batchJob('available');
  const h = harness({ jobs: [vanished], config: { maxJobs: 1 }, strictCards: true,
    onFocus(message, { setJobs }) { if (message.job.id === vanished.id) setJobs([next]); }
  });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.status, 'completed', h.data.run.message); assert.equal(h.data.run.sent, 1);
  assert.deepEqual(h.communications.map(message => message.job.id), [next.id]);
  assert.equal(h.data.records.some(record => record.job.id === vanished.id && record.status === 'communication_requested'), false);
});

test('a card disappearing between focus and selection also recovers without sending to it', async () => {
  const vanished = batchJob('vanished'), next = batchJob('available');
  const h = harness({ jobs: [vanished, next], config: { maxJobs: 1 }, strictCards: true,
    onFocus(message, { setJobs }) { if (message.type === 'SELECT_JOB' && message.job.id === vanished.id) setJobs([next]); }
  });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 1); assert.deepEqual(h.communications.map(message => message.job.id), [next.id]);
});

test('a persistently unstable card is skipped after bounded reads while other jobs continue', async () => {
  const unstable = batchJob('unstable'), next = batchJob('available');
  let focusCount = 0;
  const h = harness({ jobs: [unstable, next], config: { maxJobs: 1 }, strictCards: true,
    onFocus(message, { setJobs }) { if (message.job.id === unstable.id) { focusCount++; setJobs([next]); } },
    onScan(message, { setJobs }) { setJobs([unstable, next]); }
  });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 1); assert.equal(focusCount, 2);
  assert.equal(h.data.records.filter(record => record.job.id === unstable.id && record.status === 'skipped').length, 1);
  assert.equal(h.data.run.status, 'completed');
});

test('history is checked before opening details of cards already sent or uncertain', async () => {
  for (const status of ['sent', 'uncertain', 'communication_requested', 'already_contacted']) {
    let focused = false;
    const h = harness({ records: [{ job, status }], onFocus(message) { if (message.type === 'SELECT_JOB') focused = true; } });
    await h.dispatch('START', { tabId: 1 }); await h.finish();
    assert.equal(focused, false, status); assert.equal(h.communications.length, 0);
    assert.deepEqual(h.data.run.processedJobIds, [job.id]);
  }
});

test('returning to an exhausted list retains the successful count and reports the unmet target', async () => {
  const h = harness({ config: customBatchConfig, defaultSent: false, navigateOnCustomSend: true, reportCustomOnSend: true });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 1); assert.equal(h.data.run.completionReason, 'list_exhausted');
  assert.match(h.data.run.message, /1 \/ 2/); assert.equal(h.communications.length, 1);
});

test('pause and stop after a temporary page closes prevent the next greeting', async () => {
  const next = batchJob('next');
  for (const stop of [false, true]) {
    const h = harness({ jobs: [job, next], config: customBatchConfig, defaultSent: false, navigateOnCustomSend: true, reportCustomOnSend: true,
      async onCloseWorker({ data, dispatch }) { if (data.run.sent === 1) assert.ok((await dispatch(stop ? 'STOP' : 'PAUSE')).ok); }
    });
    await h.dispatch('START', { tabId: 1 });
    await until(() => h.data.run?.sent === 1 && h.removed.length === 1);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.communications.length, 1); assert.equal(h.data.run.sent, 1);
    if (!stop) { assert.equal(h.data.run.status, 'paused'); await h.dispatch('RESUME'); }
    await h.finish();
    assert.equal(h.data.run.sent, stop ? 1 : 2); assert.equal(h.data.run.status, stop ? 'stopped' : 'completed');
    assert.equal(h.data.records.some(record => record.status === 'uncertain'), false);
    assert.equal(h.removed.includes(1), false); assert.deepEqual(h.returns, []);
  }
});

test('a new send never scans the source again after the previous confirmed greeting', async () => {
  const next = batchJob('next');
  const h = harness({ jobs: [job, next], config: customBatchConfig, defaultSent: false, navigateOnCustomSend: true, reportCustomOnSend: true,
    onScan(message) { if (h.data.run.sent > 0) throw Error('Revisiting the source is a regression'); }
  });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.status, 'completed', h.data.run.message); assert.equal(h.data.run.sent, 2);
  assert.equal(h.calls.filter(type => type === 'SCAN').length, 1);
});

test('custom sending uses the selected list detail and opens only the native chat destination', async () => {
  const h = harness({ config: customBatchConfig, defaultSent: false, reportCustomOnSend: true });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.sent, 1);
  assert.equal(h.calls.filter(type => type === 'READ_DETAIL').length, 1);
  assert.equal(h.calls.includes('PREPARE_DELIVERY_JOB'), false);
  assert.ok(h.updates.every(update => update.id !== 1 && update.url.includes('/web/geek/chat')));
  assert.equal(h.data.run.queuePosition, 1); assert.equal(h.data.run.queue.length, 1);
});

test('already contacted jobs close their temporary page and continue without using the greeting target', async () => {
  const next = batchJob('not-contacted');
  const h = harness({ jobs: [job, next], config: { ...customBatchConfig, maxJobs: 1 }, alreadyContactedIds: [job.id], defaultSent: false, reportCustomOnSend: true });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.status, 'completed'); assert.equal(h.data.run.sent, 1);
  assert.deepEqual(h.removed, [22]);
  assert.equal(h.calls.filter(type => type === 'SEND_GREETING').length, 1);
  assert.equal(h.data.records.filter(record => record.status === 'already_contacted').length, 1);
  assert.equal(h.data.records.find(record => record.status === 'sent').job.id, next.id);
  assert.equal(h.removed.includes(1), false); assert.deepEqual(h.returns, []);
});

test('a replaced source document stops after a confirmed send without rescanning or resending', async () => {
  const h = harness({ config: customBatchConfig, defaultSent: false, reportCustomOnSend: true, reloadSourceAfterSend: true });
  await h.dispatch('START', { tabId: 1 }); await h.finish();
  assert.equal(h.data.run.status, 'error'); assert.equal(h.data.run.sent, 1);
  assert.equal(h.calls.filter(type => type === 'SCAN').length, 1);
  assert.equal(h.communications.length, 1); assert.match(h.data.run.message, /不会从首屏重新扫描/);
  assert.ok(h.data.run.trace.some(entry => entry.event === 'source_changed'));
  assert.equal(h.data.records.filter(record => record.status === 'sent').length, 1);
  assert.equal(h.data.records.some(record => record.status === 'uncertain'), false);
});

test('both message modes append later batches without resetting the original queue cursor', async () => {
  for (const mode of ['boss_default', 'custom']) {
    const second = batchJob('second'), third = batchJob('third');
    const h = harness({ jobs: [job], moreJobBatches: [[job, second], [second, third]],
      config: { ...customBatchConfig, greetingMode: mode, maxJobs: 3, maxScan: 1 }, defaultSent: mode === 'boss_default', reportCustomOnSend: true });
    await h.dispatch('START', { tabId: 1 }); await h.finish();
    assert.equal(h.data.run.status, 'completed', h.data.run.message); assert.equal(h.data.run.sent, 3);
    assert.equal(h.data.run.queuePosition, 3); assert.equal(h.data.run.queue.length, 3);
    assert.deepEqual(h.data.run.queue.map(row => row.id), [job.id, second.id, third.id]);
    const positions = h.data.run.trace.filter(row => row.event === 'queue_append').map(row => row.position);
    assert.deepEqual(positions, [0, 1, 2]);
    assert.equal(h.calls.filter(type => type === 'SCAN').length, 1);
    assert.deepEqual(h.messages.filter(row => row.type === 'SCAN_MORE').map(row => row.known), [[job.id], [job.id, second.id]]);
  }
});

test('native salary extraction returns only salary for the matching encrypted job identity', () => {
  const title = { querySelectorAll: () => [], __vueParentComponent: { props: { jobInfo: { encryptJobId: 'abc123', jobId: 'plain-alias', salaryDesc: '200–250元/天', secret: 'never-export' } } } };
  const root = { querySelector: selector => selector === '.job-name' ? title : null, querySelectorAll: () => [], contains: () => true };
  title.parentElement = root;
  const h = harness({ inspectDocument: { body: {}, querySelector: () => root } });
  assert.deepEqual(h.inspectSalaries([{token:'qa',id:'abc123'}]), [{token:'qa',salary:'200–250元/天'}]);
  title.__vueParentComponent.props.jobInfo.encryptJobId = 'other-job';
  assert.deepEqual(h.inspectSalaries([{token:'qa',id:'abc123'}]), [{token:'qa',salary:''}]);
});


test('detail salary uses only the same card identity, encoded text and font', () => {
  const makeSalary = text => ({ textContent: text, family: 'kanzhun-mix', querySelectorAll: () => [] });
  const detailSalary = makeSalary('\uE035-\uE036K');
  const cardSalary = makeSalary(detailSalary.textContent);
  const card = {
    __vueParentComponent: { props: { jobInfo: { encryptJobId: 'abc123', salaryDesc: '4-5K', privateData: 'never-export' } } },
    querySelector: selector => selector === '.salary,.job-salary' ? cardSalary : null,
    querySelectorAll: () => []
  };
  const detail = {
    querySelector: selector => selector === '.salary,.job-salary' ? detailSalary : selector === '.job-detail-header,.job-header' ? {} : null,
    querySelectorAll: () => []
  };
  detailSalary.parentElement = detail; cardSalary.parentElement = card;
  const link = { href: 'https://www.zhipin.com/job_detail/abc123.html', closest: () => card };
  const h = harness({
    inspectDocument: { body: {}, querySelector: () => detail, querySelectorAll: () => [link] },
    getComputedStyle: el => ({ fontFamily: el.family })
  });
  const read = () => h.inspectSalaries([{ token: 'qa', id: 'abc123' }]);
  const rejected = [{ token: 'qa', salary: '' }];
  assert.deepEqual(read(), [{ token: 'qa', salary: '4-5K' }]);
  cardSalary.textContent = '\uE035-\uE037K'; assert.deepEqual(read(), rejected);
  cardSalary.textContent = detailSalary.textContent;
  cardSalary.family = 'different-font'; assert.deepEqual(read(), rejected);
  cardSalary.family = detailSalary.family;
  link.href = 'https://www.zhipin.com/job_detail/other.html'; assert.deepEqual(read(), rejected);
  link.href = 'https://www.zhipin.com/job_detail/abc123.html';
  card.__vueParentComponent.props.jobInfo.encryptJobId = 'other'; assert.deepEqual(read(), rejected);
});


test('saved receipts publish the updated count immediately and duplicate reports count once', async () => {
  const savedRun = { id: 'notify-run', status: 'completed', sourceTabId: 1, sent: 0, pendingDelivery: { job, analysis, greeting: '' } };
  const h = harness({ savedRun });
  const sender = { url: job.url, tab: { id: 1 }, frameId: 0 };
  const receipt = { runId: 'notify-run', jobId: job.id, proof: 'success_dialog' };
  assert.equal((await h.dispatch('REPORT_DELIVERY', receipt, sender)).ok, true);
  assert.equal(h.data.records[0].status, 'sent');
  assert.equal(h.published.at(-1).type, 'RUN_CHANGED');
  assert.equal(h.published.at(-1).run.sent, 1);
  assert.ok(h.calls.includes('RUN_CHANGED'));
  assert.equal((await h.dispatch('REPORT_DELIVERY', receipt, sender)).ok, true);
  assert.equal(h.data.records.length, 1); assert.equal(h.data.run.sent, 1);
});


test('reconnect replaces a stale content version without sending or changing history', async () => {
  const h = harness({ contentVersion: '0.6.4' });
  assert.equal((await h.dispatch('CONNECT_PAGE', { tabId: 1 })).ok, true);
  assert.equal(h.injections.length, 1); assert.equal(h.data.records.length, 0);
  assert.ok(!h.calls.includes('COMMUNICATE'));
  assert.equal((await h.dispatch('CONNECT_PAGE', { tabId: 1 })).ok, true);
  assert.equal(h.injections.length, 1);
});
