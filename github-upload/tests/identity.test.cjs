const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const fs = require('node:fs');
const vm = require('node:vm');
const card = { title: 'java实习-双休', company: '绍兴扬瑾网络科技', salary: '150-200元/天', location: '绍兴·越城区·镜湖', education: '本科', daysPerWeek: 4, internshipMonths: 12 };
const detail = { ...card, title: 'java实习', location: '绍兴' };

test('benefit suffixes, separators and display spacing preserve the same role', () => {
  for (const title of ['Java 实习-双休', 'java实习（双休）', 'java实习—双休-五险一金', 'java实习（外企+金融保险+双休）']) {
    assert.equal(C.compatibleJobTitle(title, 'java实习'), true, title);
  }
  assert.equal(C.compatibleJobTitle('C++开发-双休', 'C++开发'), true);
});

test('role qualifiers cannot be stripped or accepted as mere title prefixes', () => {
  for (const title of ['java实习-测试', 'java实习（前端）', 'JavaScript实习', 'java开发工程师', 'java实习-全职', 'java实习-双休培训']) {
    assert.equal(C.compatibleJobTitle(title, 'java实习'), false, title);
  }
});

test('the reported title variant is corroborated by company, exact pay and the other displayed facts', () => {
  const check = C.compareJobDetails(card, detail);
  assert.equal(check.secondaryMatch, true);
  assert.deepEqual(check.conflicts, []);
  assert.deepEqual(check.evidence, ['company', 'salary', 'location', 'education', 'daysPerWeek', 'internshipMonths']);
});

test('matching company alone or with one common field cannot prove a title variant', () => {
  assert.equal(C.compareJobDetails(card, { title: detail.title, company: detail.company }).secondaryMatch, false);
  assert.equal(C.compareJobDetails(card, { title: detail.title, company: detail.company, education: detail.education }).secondaryMatch, false);
  assert.equal(C.compareJobDetails(card, { title: detail.title, company: detail.company, location: detail.location, salary: detail.salary }).secondaryMatch, true);
});

test('a conflict in any supplied company, pay, location, qualification or internship term rejects secondary verification', () => {
  for (const [field, value] of Object.entries({ company: '另一家公司', salary: '180-250元/天', location: '杭州', education: '大专', daysPerWeek: 5, internshipMonths: 6 })) {
    const check = C.compareJobDetails(card, { ...detail, [field]: value });
    assert.equal(check.secondaryMatch, false, field);
    assert.ok(check.conflicts.includes(field), field);
  }
});

test('a shared city does not erase conflicting districts, and daily/monthly pay is distinct', () => {
  assert.ok(C.compareJobDetails(card, { ...detail, location: '绍兴·上虞区' }).conflicts.includes('location'));
  assert.ok(C.compareJobDetails(card, { ...detail, salary: '4.5-6K' }).conflicts.includes('salary'));
  assert.equal(C.compareJobDetails(card, { ...detail, location: '绍兴市', salary: '150–200 元/天' }).secondaryMatch, true);
});

test('missing or undecoded values are unavailable evidence rather than positive matches', () => {
  const check = C.compareJobDetails(card, { title: detail.title, company: detail.company, salary: '\uE100-\uE101元/天' });
  assert.deepEqual(check.evidence, ['company']);
  assert.deepEqual(check.conflicts, []);
  assert.equal(check.secondaryMatch, false);
});

test('internship terms are read locally from both split and combined labels', () => {
  assert.deepEqual(C.jobSchedule('4天/周 12个月 本科'), { daysPerWeek: 4, internshipMonths: 12 });
  assert.deepEqual(C.jobSchedule('４天/周１２个月'), { daysPerWeek: 4, internshipMonths: 12 });
  assert.deepEqual(C.jobSchedule('1-3年 本科'), { daysPerWeek: 0, internshipMonths: 0 });
});

test('a selected detail pane remains usable without comparing card titles, fields or IDs', () => {
  const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
  const fn = source.slice(source.indexOf('  function selectedDetailReady('), source.indexOf('  let highlightJobId'));
  let parts = { root: {}, title: '后端开发实习生', company: '', signature: 'new-pane' }, onList = true;
  const context = vm.createContext({ selection: { job: { title: '后端开发实习生-居家办公', id: 'target' }, detailRead: true },
    listPage: () => onList, detailParts: () => parts });
  vm.runInContext(fn, context);
  assert.equal(context.selectedDetailReady('target'), true);
  const replacement = { dataset: { jobId: 'plain-alias' } }; parts.root = replacement;
  assert.equal(context.selectedDetailReady('target'), true);
  assert.equal(context.selection.root, replacement);
  assert.equal(context.selectedDetailReady('other-task-job'), false);
  context.selection.detailRead = false;
  assert.equal(context.selectedDetailReady('target'), false);
  context.selection.detailRead = true; onList = false;
  assert.equal(context.selectedDetailReady('target'), false);
  onList = true; parts = null;
  assert.equal(context.selectedDetailReady('target'), false);
});

