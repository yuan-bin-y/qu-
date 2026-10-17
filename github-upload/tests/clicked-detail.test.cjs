const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
const readSource = source.slice(source.indexOf('  async function detail('), source.indexOf('  function recruiterName('));
const loadingSource = source.slice(source.indexOf('  function detailLoading('), source.indexOf('  function detailIds('));

function reader({ loadingRounds = 0, blocked = '', displayOnly = false } = {}) {
  let clock = 0, polls = 0, salaryReads = 0;
  const job = { id: 'target', title: '后端开发实习生-居家办公', company: '成都爱迪森通用科技', location: '成都' };
  const salary = { textContent: '200-230元/天' };
  const parts = { root: { matches: () => false }, header: {}, title: '后端开发实习生', company: '', description: '负责 Java 后端服务开发，使用 Spring Boot 和 MySQL，参与业务接口设计和系统维护。',
    summary: { location: '成都', education: '本科', daysPerWeek: 4, internshipMonths: 3 } };
  const context = vm.createContext({ selection: { job, detailRead: false }, Date: { now: () => clock },
    listPage: () => true, blockReason: () => blocked, detailParts: () => parts, visible: () => true,
    first: selectors => selectors.includes('.salary') ? salary : polls < loadingRounds ? {} : null,
    waitForDetailUpdate: async ms => { polls++; clock += ms; }, text: el => el?.textContent || '', activityText: () => '',
    resolveSalaries: async () => { salaryReads++; },
    call: async () => { throw Error('List detail must not request native identity or state'); },
    C: { compareJobDetails: () => { throw Error('List detail must not compare panes'); } }
  });
  vm.runInContext(loadingSource + readSource, context);
  return { context, read: () => context.detail('target', displayOnly), metrics: () => ({ clock, polls, salaryReads }) };
}

test('the reported home-working title variant reads immediately without identity metadata or stability delays', async () => {
  const h = reader(), result = await h.read();
  assert.equal(result.title, '后端开发实习生-居家办公');
  assert.equal(result.detailTitle, '后端开发实习生');
  assert.equal(result.company, '成都爱迪森通用科技');
  assert.equal(result.salary, '200-230元/天');
  assert.match(result.description, /Spring Boot/);
  assert.deepEqual(h.metrics(), { clock: 0, polls: 0, salaryReads: 1 });
  assert.equal(h.context.selection.detailRead, true);
});

test('loading a native detail pane waits only for loading to finish', async () => {
  const h = reader({ loadingRounds: 7 });
  await h.read();
  assert.deepEqual(h.metrics(), { clock: 700, polls: 7, salaryReads: 1 });
  assert.equal(h.context.selection.lastCheck.ready, true);
});

test('a loading timeout or risk-control notice never authorizes communication', async () => {
  const loading = reader({ loadingRounds: Infinity });
  await assert.rejects(loading.read(), /等待本次点击的职位描述更新/);
  assert.equal(loading.context.selection.detailRead, false);
  const blocked = reader({ blocked: '页面需要验证码' });
  await assert.rejects(blocked.read(), /验证码/);
  assert.equal(blocked.context.selection.detailRead, false);
});

test('display-only reads do not prepare communication', async () => {
  const h = reader({ displayOnly: true });
  assert.equal((await h.read()).displayOnly, true);
  assert.equal(h.context.selection.detailRead, false);
  assert.equal(h.metrics().salaryReads, 0);
});

test('a new default-greeting receipt uses the task click without requiring matching pane titles or IDs', () => {
  const fn = source.slice(source.indexOf('  function receiptBoundToJob('), source.indexOf('  function receiptEvidence('));
  let onList = true;
  const context = vm.createContext({ selection: { job: { id: 'target' }, detailRead: true }, listPage: () => onList });
  vm.runInContext(fn, context);
  const pending = { clicked: true, message: { job: { id: 'target' } } };
  assert.equal(context.receiptBoundToJob(pending), true);
  assert.equal(context.receiptBoundToJob({ ...pending, clicked: false }), false);
  assert.equal(context.receiptBoundToJob({ ...pending, message: { job: { id: 'another-task' } } }), false);
  onList = false;
  assert.equal(context.receiptBoundToJob(pending), false);
});
