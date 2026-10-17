const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const rules = { titleGroups: [['Java', '实习']], blockedWords: '外派,付费培训,收费培训,包就业,招生顾问,课程顾问,电话销售' };
const job = { title: 'Java 实习', company: '技术公司', description: '参与业务开发', location: '上海', education: '本科' };

test('one blocked-word list rejects any complete configured word', () => {
  for (const description of ['外派驻场', '先参加收费培训', '电话销售']) {
    const result = C.filters({ ...job, description }, rules);
    assert.equal(result.match, false, description); assert.match(result.reasons.join(), /命中屏蔽词/);
  }
  for (const description of ['免费培训', '需要收费', '电话客服', '课程开发']) assert.equal(C.filters({ ...job, description }, rules).match, true, description);
});

test('plain blockers preserve phrase boundaries instead of combining separate fragments', () => {
  assert.equal(C.filters({ ...job, description: '收费的免费培训' }, rules).match, true);
  assert.equal(C.filters({ ...job, description: '培训结束后另行收费' }, rules).match, true);
  assert.equal(C.filters({ ...job, description: '收费培训' }, rules).match, false);
});

test('blocking still checks title, company and JD independently', () => {
  assert.equal(C.filters({ ...job, company: '包就业公司' }, rules).match, false);
  assert.equal(C.filters({ ...job, title: 'Java实习·电话销售' }, rules).match, false);
  assert.equal(C.filters(job, rules).match, true);
});

test('commas, semicolons and newlines separate independent blockers; old all mode is ignored', () => {
  const raw = { blockedWords: '外包，派遣;收费培训\n电话销售', blockedMode: 'all' };
  assert.deepEqual(C.blockedWordList(raw), ['外包', '派遣', '收费培训', '电话销售']);
  assert.equal(C.filters({ ...job, description: '收费培训' }, raw).match, false);
  assert.equal(C.config(raw).blockedMode, 'any');
  assert.deepEqual(C.matchingBlockedWords('任意内容', { blockedWords: ' ,；\n ' }), []);
});

test('single-term legacy groups migrate exactly into the textbox and are not lost', () => {
  const raw = { blockedGroups: [['外派'], ['付费培训'], ['收费培训'], ['包就业'], ['招生顾问'], ['课程顾问'], ['电话销售']] };
  const c = C.config(raw);
  assert.equal(c.blockedWords, rules.blockedWords); assert.equal(c.blockedGroups, null);
  assert.equal(C.filters({ ...job, description: '收费培训' }, c).match, false);
  assert.deepEqual(C.config(c), c);
});

test('legacy combined blockers become complete phrases without making training alone a blocker', () => {
  const c = C.config({ blockedGroups: [['收费', '培训'], ['电话', '销售'], ['Spring', 'Boot']] });
  assert.equal(c.blockedWords, '收费培训,电话销售,Spring Boot');
  assert.equal(C.filters({ ...job, description: '免费培训' }, c).match, true);
  assert.equal(C.filters({ ...job, description: '收费培训' }, c).match, false);
  assert.equal(C.filters({ ...job, description: 'Spring Boot 开发' }, c).match, false);
  assert.equal(C.config({ blockedGroups: [], blockedWords: '旧词' }).blockedWords, '');
  assert.equal(C.filters({ ...job, description: '外包派遣' }, { blockedWords: '' }).match, true);
  for (const blockedGroups of ['收费培训', ['外包'], [[null]], [null]]) assert.throws(() => C.config({ blockedGroups }), /屏蔽词组/);
});

test('Latin word boundaries and company exclusions remain independent of the textbox', () => {
  assert.deepEqual(C.matchingBlockedWords('JavaScript培训', { blockedWords: 'Java' }), []);
  assert.deepEqual(C.matchingBlockedWords('Java培训', { blockedWords: 'Java' }), ['Java']);
  assert.equal(C.filters({ ...job, company: '排除公司' }, { ...rules, blockedCompanies: '排除公司' }).match, false);
});

test('unknown obsolete settings cannot bypass title or plain blocked words', () => {
  const legacy = { ...rules, retiredMode: true, retiredTitleSwitch: false };
  assert.equal(C.config(legacy).retiredMode, undefined);
  assert.equal(C.filters({ ...job, title: 'JavaScript实习' }, legacy).match, false);
  assert.equal(C.filters({ ...job, description: '收费培训' }, legacy).match, false);
});
