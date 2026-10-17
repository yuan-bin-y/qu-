const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const groups = [['Java', '实习'], ['后端', '开发', '实习'], ['Java', '开发', '实习'], ['Java', '全栈', '开发', '实习'], ['软件', '开发', '实习']];
const rules = { titleGroups: groups, titleMode: 'any', blockedWords: '' };

test('disabled groups retain their terms and never contribute to any/all matching', () => {
  const titleGroupRules = [{ terms: ['Java', '实习'], enabled: false }, { terms: ['后端', '开发'], enabled: true }];
  for (const titleMode of ['any', 'all']) {
    const raw = { titleGroupRules, titleMode, blockedWords: '' };
    assert.equal(C.titleKeywordRule('Java实习', raw), false);
    for (const phase of ['card', 'detail']) assert.equal(C.filters({ title: '后端开发' }, raw, phase).match, true);
    assert.deepEqual(C.config(raw).titleGroups, [['Java', '实习'], ['后端', '开发']]);
  }
  assert.equal(C.titleKeywordRule('Java实习', { titleGroupRules: [{ ...titleGroupRules[0], enabled: true }] }), true);
});

test('all disabled groups reject titles until reenabled or explicitly cleared', () => {
  const raw = { titleGroupRules: [{ terms: ['Java'], enabled: false }], titleGroups: [['Python']], titleKeywords: 'Python' };
  assert.equal(C.titleKeywordRule('Java Python 实习', raw), false);
  assert.equal(C.filters({ title: 'Java Python 实习' }, raw).match, false);
  assert.equal(C.titleKeywordRule('任意岗位', { ...raw, titleGroupRules: [] }), true);
});

test('duplicate groups keep independent enabled states across normalization and persistence', () => {
  const raw = { titleGroupRules: [{ terms: [], enabled: false }, { terms: [' Java ', '实习'], enabled: false }, { terms: ['Java', '实习'], enabled: true }] };
  const saved = C.config(raw);
  assert.deepEqual(saved.titleGroupRules, [{ terms: ['Java', '实习'], enabled: false }, { terms: ['Java', '实习'], enabled: true }]);
  assert.deepEqual(C.config(saved), saved);
  assert.equal(C.titleKeywordRule('Java实习', saved), true);
  assert.deepEqual(C.effectiveTitleGroupRules({ titleGroups: groups }), groups.map(terms => ({ terms, enabled: true })));
});

test('invalid group states fail visibly instead of silently enabling an ignored group', () => {
  for (const titleGroupRules of ['Java', [null], [['Java']], [{ terms: ['Java'], enabled: 'false' }], [{ terms: null }]]) {
    assert.throws(() => C.config({ titleGroupRules }), /关键词组/);
  }
});

test('any title group requires every term in one complete group, regardless of order', () => {
  for (const title of ['java 实习生', '实习-JAVA开发', '后端开发实习生', '软件开发实习', '全栈开发（偏JAVA）实习--周末双休']) {
    for (const phase of ['card', 'detail']) assert.equal(C.filters({ title }, rules, phase).match, true, title);
  }
  for (const title of ['Java开发工程师', '全栈开发（偏JAVA）--周末双休', '实习生', 'JavaScript实习生', 'Python开发实习生']) {
    assert.equal(C.filters({ title }, rules).match, false, title);
  }
});

test('partial matches from different groups never combine into a match', () => {
  const raw = { titleGroups: [['Java', '实习'], ['后端', '开发']], titleMode: 'any' };
  assert.equal(C.titleKeywordRule('Java 后端工程师', raw), false);
  assert.equal(C.titleKeywordRule('实习开发', raw), false);
  assert.equal(C.titleKeywordRule('后端开发工程师', raw), true);
});

test('all mode requires all complete groups while any mode needs just one', () => {
  const titleGroups = [['Java', '实习'], ['软件', '开发', '实习']];
  assert.equal(C.titleKeywordRule('实习-Java开发', { titleGroups, titleMode: 'any' }), true);
  assert.equal(C.titleKeywordRule('实习-Java开发', { titleGroups, titleMode: 'all' }), false);
  assert.equal(C.titleKeywordRule('软件开发实习（Java）', { titleGroups, titleMode: 'all' }), true);
});

test('legacy screenshot phrases convert to editable groups and retain the selected mode', () => {
  const raw = { titleKeywords: 'Java实习，后端开发实习，Java开发实习，java全栈开发实习，软件开发实习，java 实习', titleMode: 'any' };
  assert.deepEqual(C.effectiveTitleGroups(raw), groups.map(group => group.map(term => term.toLowerCase())).concat([['java', '实习']]));
  assert.equal(C.config(raw).titleGroups, null);
  assert.equal(C.titleKeywordRule('实习-JAVA开发', raw), true);
  assert.equal(C.titleKeywordRule('实习-JAVA开发', { ...raw, titleMode: 'all' }), false);
  assert.equal(C.titleKeywordRule('Java 实习生', { titleKeywords: 'Java,实习', titleMode: 'all' }), true);
});

test('explicit terms stay literal; they are not automatically split or aliased', () => {
  assert.equal(C.titleKeywordRule('Java实习', { titleGroups: [['Java实习']] }), true);
  assert.equal(C.titleKeywordRule('实习-Java', { titleGroups: [['Java实习']] }), false);
  assert.equal(C.titleKeywordRule('软件开发实习', { titleGroups: [['产品经理', '实习']] }), false);
  assert.equal(C.titleKeywordRule('实习生', { titleGroups: [['实习生']] }), true);
  assert.equal(C.titleKeywordRule('实习岗位', { titleGroups: [['实习生']] }), false);
  assert.equal(C.titleKeywordRule('Spring Boot 实习', { titleGroups: [['Spring Boot', '实习']] }), true);
  assert.equal(C.titleKeywordRule('C++实习', { titleGroups: [['C++', '实习']] }), true);
});

test('empty groups cannot satisfy any mode, and clearing explicit groups removes the old fallback', () => {
  const raw = { titleGroups: [[], [' '], ['Java', '实习']], titleKeywords: 'Python', titleMode: 'any' };
  assert.equal(C.titleKeywordRule('Java工程师', raw), false);
  assert.equal(C.titleKeywordRule('Java实习', raw), true);
  assert.equal(C.titleKeywordRule('Python工程师', raw), false);
  assert.equal(C.titleKeywordRule('任意标题', { ...raw, titleGroups: [] }), true);
  assert.deepEqual(C.config({ titleGroups: [[' Java ', 'JAVA', '实习', ' '], []] }).titleGroups, [['Java', '实习']]);
});

test('malformed structured groups are rejected rather than silently broadening the filter', () => {
  for (const titleGroups of ['Java,实习', [null], ['Java'], [[null]], [[12]]]) assert.throws(() => C.config({ titleGroups }), /关键词组/);
  const raw = { ...rules, titleKeywords: '旧配置' };
  assert.deepEqual(C.config(C.config(raw)), C.config(raw));
});

test('nonempty legacy separator keywords do not accidentally remove the title filter', () => {
  assert.equal(C.titleKeywordRule('Java工程师', { titleKeywords: '---' }), false);
  assert.equal(C.titleKeywordRule('Java --- 实习', { titleKeywords: '---' }), true);
  assert.deepEqual(C.titleTerms(''), []);
});

test('title groups inspect the title only and always apply despite unknown obsolete settings', () => {
  const job = { title: '开发工程师', company: 'Java实习公司', description: 'Java 实习，后端开发实习' };
  assert.equal(C.filters(job, rules).match, false);
  assert.equal(C.filters({ ...job, title: 'Java实习', description: '外包职位' }, { ...rules, blockedWords: '外包' }).match, false);
  assert.equal(C.filters({ title: 'Java实习', company: '软件开发公司' }, { ...rules, blockedCompanies: '软件 开发' }).match, true);
  assert.equal(C.filters(job, { ...rules, retiredMode: true }).match, false);
  assert.equal(C.filters(job, { ...rules, retiredMode: true, retiredTitleSwitch: true }).match, false);
});
