const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
const inspector = source.slice(source.indexOf('function inspectNativeChat('), source.indexOf('// Executed in the page'));
const jobId = 'current-job';
const payload = { jobInfo: { encryptId: jobId, jobId: 'plain-alias', securityId: 'native-security' }, bossInfo: { encryptId: 'current-boss' }, secret: 'never-export' };

function node(parentElement = null) {
  return { parentElement, querySelector: () => null, querySelectorAll: () => [], contains(el) { for (; el; el = el.parentElement) if (el === this) return true; return false; } };
}
function inspect(root, frame = false, frameToken = 'qa', page = false) {
  const document = { body: node(), querySelector: () => root };
  const window = { frameElement: { getAttribute: () => frameToken } };
  const context = vm.createContext({ document, window });
  vm.runInContext(inspector, context);
  return JSON.parse(JSON.stringify(context.inspectNativeChat('qa', frame, jobId, page)));
}

test('native Vue 2 detail data can live above the selected detail DOM root', () => {
  const component = node();
  component.__vue__ = { $props: { data: payload } };
  const root = node(component);
  let title = root;
  for (let i = 0; i < 6; i++) title = node(title);
  root.querySelector = selector => selector.includes('job-name') ? title : null;
  assert.deepEqual(inspect(root), { encryptJobId: jobId, encryptBossId: 'current-boss', securityId: 'native-security' });
});

test('native Vue 3 detail data exports only the current encrypted recipient', () => {
  const root = node();
  root.__vueParentComponent = { props: { data: payload }, ctx: { selectedJob: { encryptJobId: 'other-job', encryptBossId: 'other-boss', securityId: 'other-security' } } };
  assert.deepEqual(inspect(root), { encryptJobId: jobId, encryptBossId: 'current-boss', securityId: 'native-security' });
});

test('native chat lookup stops before a shared job list component', () => {
  const list = node();
  list.__vue__ = { currentJob: { encryptJobId: jobId, encryptBossId: 'unverified-boss', securityId: 'native-security' } };
  const card = node(list);
  card.querySelector = selector => selector.includes('/job_detail/') ? {} : null;
  list.querySelectorAll = () => [card];
  assert.equal(inspect(node(list)), null);
});

test('a different job in the nearest native component never becomes the recipient', () => {
  const root = node();
  root.__vue__ = { data: { ...payload, jobInfo: { ...payload.jobInfo, encryptId: 'different-job' } } };
  assert.equal(inspect(root), null);
});

test('incomplete current metadata never borrows a recruiter from other jobs', () => {
  const root = node();
  root.__vue__ = { data: { jobInfo: payload.jobInfo }, jobList: [payload] };
  assert.equal(inspect(root), null);
});

test('frame lookup reads the active conversation only and requires the marked frame', () => {
  const root = node();
  root.__vue__ = { selectedFriend$: { encryptJobId: jobId, encryptBossId: 'current-boss', secret: 'never-export' } };
  assert.deepEqual(inspect(root, true), { encryptJobId: jobId, encryptBossId: 'current-boss' });
  assert.equal(inspect(root, true, 'another-frame'), null);
});

const content = fs.readFileSync(require.resolve('../content.js'), 'utf8');
const chatContextSource = content.slice(content.indexOf('  async function chatContext('), content.indexOf('  async function restorePendingChat('));
async function checkChat({ url = 'https://www.zhipin.com/web/geek/chat', native = null, saved = true, input = true, actualName = '', linkIds = [], nativeError = false, overrides = {} } = {}) {
  let nativeReads = 0;
  const document = { nodeType: 9, documentElement: {} }, scope = { className: 'unknown-native-layout' };
  const header = actualName ? { textContent: actualName, querySelector: () => ({ textContent: actualName }) } : null;
  const jobPanel = linkIds.length ? { querySelectorAll: () => linkIds.map(id => ({ href: 'https://www.zhipin.com/job_detail/' + id + '.html' })) } : null;
  const context = vm.createContext({
    document, C: require('../core.js'), location: { pathname: new URL(url).pathname },
    communication: saved ? { fullPage: true, handoffReady: true, message: { runId: 'run', job: { id: jobId } }, ...overrides } : null,
    text: el => el?.textContent || '', recruiterName: el => el?.textContent || '',
    findChatInput: () => input ? {} : null, chatScope: () => scope,
    activeChatHeader: () => header, activeChatJob: () => jobPanel,
    blockReason: () => '', boundToJob: () => false, first: () => null,
    readNativeChat: async () => { nativeReads++; if (nativeError) throw Error('Optional component metadata unavailable'); return native; }
  });
  vm.runInContext(chatContextSource, context);
  return { ...JSON.parse(JSON.stringify(await context.chatContext({ id: jobId, title: 'Java 实习', company: '样例公司' }, { bossId: 'current-boss', name: '测试HR' }, 'run', true))), nativeReads };
}
const nativeRecipient = { encryptJobId: jobId, encryptBossId: 'current-boss' };

test('a saved native handoff can send without HR fields, job links, Vue state or route parameters', async () => {
  const result = await checkChat();
  assert.equal(result.ready, true); assert.equal(result.page, true);
  assert.equal(result.identityCheck.strategy, 'saved_native_handoff');
  assert.equal(result.identityCheck.matches.savedTask, true);
});

test('missing, different or unprepared pending tasks never authorize a chat send', async () => {
  for (const options of [{ saved: false }, { overrides: { handoffReady: false } }, { overrides: { fullPage: false } }, { overrides: { message: { runId: 'other-run', job: { id: jobId } } } }, { overrides: { message: { runId: 'run', job: { id: 'other-job' } } } }]) {
    assert.equal((await checkChat(options)).ready, false);
  }
});

test('a pending task waits for its editor and never authorizes another page route', async () => {
  assert.equal((await checkChat({ input: false })).ready, false);
  assert.equal((await checkChat({ url: 'https://www.zhipin.com/web/geek/jobs' })).ready, false);
});

test('optional native component inspection failing does not recreate the missing-HR gate', async () => {
  const result = await checkChat({ nativeError: true });
  assert.equal(result.ready, true); assert.equal(result.nativeReads, 0);
  assert.equal((await checkChat({ native: { encryptBossId: 'current-boss' } })).ready, true);
});

test('chat readiness uses the saved native handoff instead of page labels and guessed Vue fields', async () => {
  for (const options of [{ native: { ...nativeRecipient, encryptJobId: 'other-job' } }, { native: { ...nativeRecipient, encryptBossId: 'other-boss' } }, { linkIds: ['other-job'] }, { actualName: '其他HR' }]) {
    assert.equal((await checkChat(options)).ready, true);
  }
  assert.equal((await checkChat({ actualName: '测试HR', native: nativeRecipient, linkIds: [jobId] })).ready, true);
});

test('native full-page inspection exports only explicit active IDs when available', () => {
  const root = node(); root.__vue__ = { selectedFriend$: { ...nativeRecipient, secret: 'never-export' } };
  assert.deepEqual(inspect(root, false, 'unused', true), nativeRecipient);
});
