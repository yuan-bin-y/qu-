const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
const scanMoreSource = source.slice(source.indexOf('  async function scanMore('), source.indexOf('  async function detail('));

function listHarness({ batches, known = [], stopAfter, blockedAfter, intervalSeconds } = {}) {
  let position = 0, sleeps = 0, reads = 0, waited = 0, clock = 0;
  const loadDelay = Math.max(2500, (intervalSeconds || 0.5) * 1000);
  let nextBatchAt = loadDelay;
  const scroller = { scrollTop: 0, scrollHeight: 1500, clientHeight: 500 };
  const document = { body: {}, documentElement: {}, scrollingElement: scroller };
  const cards = () => batches[position].map(id => ({ id, parentElement: document.body, scrollIntoView() {} }));
  const context = vm.createContext({ document, Set, Date: { now: () => clock },
    listLoading: () => false, nextPageButton: () => null,
    cards, cardInfo: card => ({ id: card.id }), getComputedStyle: () => ({ overflowY: 'visible' }),
    async allowed() { if (stopAfter && sleeps >= stopAfter) throw Error('任务已停止'); },
    async scan(max, seen) {
      reads++;
      if (blockedAfter && sleeps >= blockedAfter) throw Error('请完成安全验证');
      return cards().filter(card => !seen.has(card.id)).slice(0, max).map(card => ({ id: card.id }));
    },
    async sleep(ms) { waited += ms; clock += ms; },
    async waitForListUpdate(ms) {
      waited += ms; clock += ms;
      if (clock < nextBatchAt) return;
      nextBatchAt = clock + loadDelay; sleeps++;
      if (position < batches.length - 1) { position++; scroller.scrollHeight += 500; }
    }
  });
  vm.runInContext(scanMoreSource, context);
  return { async more() { return JSON.parse(JSON.stringify(await context.scanMore({ known, max: 2, runId: 'run', intervalSeconds }))); }, stats: () => ({ position, sleeps, reads, waited }) };
}

test('return catch-up loads past more than three known batches before finding the next unprocessed job', async () => {
  const known = Array.from({ length: 8 }, (_, index) => 'old-' + index);
  const h = listHarness({ known, batches: known.map(id => [id]).concat([['new-one', 'new-two']]) });
  assert.deepEqual(await h.more(), [{ id: 'new-one' }, { id: 'new-two' }]);
  assert.equal(h.stats().position, 8);
});

test('visible unprocessed cards are returned before any additional scroll or load', async () => {
  const h = listHarness({ known: ['old'], batches: [['old', 'new']] });
  assert.deepEqual(await h.more(), [{ id: 'new' }]); assert.equal(h.stats().sleeps, 0);
});

test('reloading processed batches respects the configured interval before scrolling again', async () => {
  const h = listHarness({ known: ['a', 'b'], batches: [['a'], ['b'], ['new']], intervalSeconds: 3 });
  assert.deepEqual(await h.more(), [{ id: 'new' }]); assert.ok(h.stats().waited >= 3900);
});

test('unchanged end of list terminates after bounded idle checks', async () => {
  const h = listHarness({ known: ['old'], batches: [['old']] });
  assert.deepEqual(await h.more(), []); assert.ok(h.stats().sleeps <= 4);
});

test('stop during catch-up ends the read loop immediately', async () => {
  const h = listHarness({ known: ['a', 'b', 'c'], batches: [['a'], ['b'], ['c'], ['new']], stopAfter: 1 });
  await assert.rejects(h.more(), /任务已停止/); assert.equal(h.stats().sleeps, 1);
});

test('a verification prompt during catch-up propagates instead of reporting list exhaustion', async () => {
  const h = listHarness({ known: ['a'], batches: [['a'], ['new']], blockedAfter: 1 });
  await assert.rejects(h.more(), /安全验证/);
});

test('rescanning skips processed identities before decoding salaries or filling the batch', async () => {
  const scanSource = source.slice(source.indexOf('  async function scan('), source.indexOf('  async function scanMore('));
  let decoded;
  const context = vm.createContext({
    Set, blockReason: () => '', listPage: () => true, cards: () => ['old-one', 'old-two', 'new-one', 'new-two'],
    cardInfo: id => ({ id, title: 'Java 实习' }), first: () => ({}),
    async resolveSalaries(entries) { decoded = entries.map(entry => entry.job.id); }
  });
  vm.runInContext(scanSource, context);
  const result = await context.scan(1, new Set(['old-one', 'old-two']));
  assert.deepEqual(Array.from(result, job => job.id), ['new-one']); assert.deepEqual(Array.from(decoded), ['new-one']);
});
