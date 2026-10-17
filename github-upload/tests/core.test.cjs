const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const job = { id: 'abc123', url: 'https://www.zhipin.com/job_detail/abc123.html', title: 'Java 开发工程师', company: '技术公司', location: '上海·浦东', education: '本科', experience: '1-3年', description: '负责 Java 后端服务开发，使用 Spring Boot 和 MySQL。' };

test('browsing and greeting speeds have faster independent defaults and preserve old saved intervals', () => {
  assert.equal(C.config().browseIntervalSeconds, 0.5); assert.equal(C.config().intervalSeconds, 2);
  assert.equal(C.config({ intervalSeconds: 8 }).browseIntervalSeconds, 0.5);
  assert.equal(C.config({ intervalSeconds: 8 }).intervalSeconds, 8);
  assert.equal(C.config({ browseIntervalSeconds: 1, intervalSeconds: 30 }).browseIntervalSeconds, 1);
  assert.equal(C.config({ browseIntervalSeconds: 1, intervalSeconds: 30 }).intervalSeconds, 30);
  for (const [value, browse, greeting] of [[0, 0.2, 1], [-1, 0.2, 1], [500, 120, 120], ['invalid', 0.5, 2], [4.9, 4.9, 4]]) {
    const actual = C.config({ browseIntervalSeconds: value, intervalSeconds: value });
    assert.equal(actual.browseIntervalSeconds, browse); assert.equal(actual.intervalSeconds, greeting);
  }
});

test('direct chat requires the current encrypted job and recruiter; never accepts friend/add links', () => {
  const target = C.chatTarget({ encryptJobId: job.id, encryptBossId: 'boss-123', securityId: 'native-security' }, job.id);
  const route = new URL(target.url);
  assert.equal(route.pathname, '/web/geek/chat');
  assert.equal(route.searchParams.get('id'), 'boss-123');
  assert.equal(C.chatTarget(target.url, job.id).bossId, 'boss-123');
  for (const invalid of ['/wapi/zpgeek/friend/add.json?jobId=abc123', '/web/geek/chat?bossId=boss-123&jobId=other', 'https://evil.test/web/geek/chat?bossId=boss-123&jobId=abc123', {encryptJobId:'other',encryptBossId:'boss-123',securityId:'native-security'}, {encryptJobId:job.id,encryptBossId:'boss-123'}]) assert.equal(C.chatTarget(invalid, job.id), null);
});
test('job lists support both native job and jobs routes without accepting other pages', () => {
  for (const path of ['/web/geek/job', '/web/geek/jobs', '/web/geek/jobs?city=101210100', '/web/geek/job/#search']) assert.equal(C.isJobListUrl('https://www.zhipin.com' + path), true);
  for (const url of ['https://evil.test/web/geek/jobs', 'https://www.zhipin.com.evil.test/web/geek/jobs', 'https://www.zhipin.com/web/geek/jobs-other', 'https://www.zhipin.com/web/geek/chat', job.url, 'invalid']) assert.equal(C.isJobListUrl(url), false);
});
test('Latin keyword boundaries distinguish Java / JavaScript and Go / Django', () => {
  assert.equal(C.keywordHit('JavaScript 开发', 'Java'), false);
  assert.equal(C.keywordHit('Django Python', 'Go'), false);
  assert.equal(C.keywordHit('JAVA/Spring Boot', 'Java'), true);
  assert.equal(C.keywordHit('熟悉 C++ / C#', 'C++'), true);
  assert.equal(C.keywordHit('Java开发工程师', 'Java'), true);
});
test('hard filters combine title, blockers across JD, city and education', () => {
  const c = { titleKeywords: 'Java', jdKeywords: 'Spring Boot,MySQL', jdMode: 'all', cities: '上海,杭州', education: ['本科'], experience: ['1-3年'] };
  assert.equal(C.filters(job, c).match, true);
  assert.equal(C.filters({ ...job, description: job.description + ' 外包岗位' }, c).match, false);
  assert.equal(C.filters({ ...job, title: 'JavaScript工程师' }, c).match, false);
  assert.equal(C.filters({ ...job, education: '' }, c).match, false);
  assert.equal(C.filters({ ...job, description: '' }, c, 'card').match, true);
  assert.equal(C.filters({ ...job, location: '北京' }, c).match, false);
});
test('legacy JD keywords no longer reject differently worded Java internship descriptions', () => {
  const raw = { titleKeywords: 'Java,实习', titleMode: 'all', jdKeywords: 'Spring Boot,MySQL', jdMode: 'all', blockedWords: '' };
  assert.equal(C.filters({ ...job, title: 'java实习生', description: '熟悉Java语言，使用Springboot和PostgresSQL开发。' }, raw).match, true);
  assert.equal(C.config(raw).jdKeywords, undefined);
  assert.equal(C.filters({ ...job, title: 'java实习生', description: 'Java 实习岗位，外包驻场。' }, { ...raw, blockedWords: '外包' }).match, false);
});
test('daily and monthly ranges use configured workdays without adding annual bonuses', () => {
  const daily = C.monthlySalary('180–210元/天', 30);
  assert.equal(daily.min, 5400); assert.equal(daily.max, 6300); assert.equal(daily.estimated, true);
  assert.match(daily.label, /30天估算/);
  assert.equal(C.monthlySalary('180元/天', 22).min, 3960);
  assert.equal(C.monthlySalary('200元/日', 21.75).max, 4350);
  assert.equal(C.monthlySalary('13-24K·14薪').min, 13000);
  assert.equal(C.monthlySalary('13-24K·14薪').max, 24000);
  assert.equal(C.monthlySalary('1.5-2万元/月').min, 15000);
  assert.equal(C.monthlySalary('18-24万元/年').min, 15000);
  for (const value of ['', '面议', '180元', '200-180元/天']) assert.equal(C.monthlySalary(value), null);
});
test('monthly salary filtering uses interval overlap and defers unknown card salaries', () => {
  const candidate = { ...job, salary: '180-210元/天' }, c = { salaryMin: 6000, salaryMax: 7000, salaryWorkDays: 30 };
  assert.equal(C.filters(candidate, c).match, true);
  assert.equal(C.filters(candidate, { ...c, salaryMin: 6400 }).match, false);
  assert.equal(C.filters(candidate, { ...c, salaryMin: 0, salaryMax: 5300 }).match, false);
  assert.equal(C.filters({ ...candidate, salary: '面议' }, c, 'card').match, true);
  assert.match(C.filters({ ...candidate, salary: '面议' }, c).reasons.join(), /薪资未明确/);
  assert.equal(C.filters({ ...candidate, salary: '面议' }, {}).match, true);
});
test('recruiter activity honors recency and handles undisplayed labels explicitly', () => {
  for (const label of ['在线', '刚刚活跃', '今日活跃']) assert.equal(C.filters({ ...job, hrActivity: label }, { hrMaxDays: 1 }).match, true);
  assert.equal(C.filters({ ...job, hrActivity: '3日内活跃' }, { hrMaxDays: 3 }).match, true);
  assert.equal(C.filters({ ...job, hrActivity: '本周活跃' }, { hrMaxDays: 3 }).match, false);
  assert.equal(C.filters({ ...job, hrActivity: '本月活跃' }, { hrMaxDays: 30 }).match, true);
  assert.equal(C.filters({ ...job, hrActivity: '昨天活跃' }, { hrMaxDays: 1 }).match, false);
  assert.equal(C.filters(job, { hrMaxDays: 7 }, 'card').match, true);
  assert.match(C.filters(job, { hrMaxDays: 7 }).reasons.join(), /未展示 HR 活跃度/);
  assert.equal(C.filters(job, {}).match, true);
  assert.equal(C.config().salaryWorkDays, 30);
  assert.equal(C.config({ hrMaxDays: 99 }).hrMaxDays, 0);
});
test('any/all, empty rules and excluded company work deterministically', () => {
  assert.equal(C.filters(job, { titleKeywords: 'Java,前端', titleMode: 'all' }).match, false);
  assert.equal(C.filters(job, { titleKeywords: '', blockedWords: '', cities: '' }).match, true);
  assert.equal(C.filters(job, { blockedCompanies: '技术公司' }).match, false);
  assert.deepEqual(C.words(' Java，Java\n后端;Spring '), ['Java', '后端', 'Spring']);
});
test('canonical job identity prevents foreign origin and path traversal', () => {
  assert.deepEqual(C.jobIdentity(job.url + '?ka=search'), { id: 'abc123', url: job.url });
  for (const u of ['https://evil.test/job_detail/abc123.html', 'javascript:alert(1)', 'https://www.zhipin.com/web/geek/chat', 'https://www.zhipin.com/job_detail/a/b.html']) assert.equal(C.jobIdentity(u), null);
});
test('unknown obsolete settings cannot disable local title or other hard filters', () => {
  const intern = { ...job, title: '业务研发实习生', experience: '在校/应届', salary: '200-250元/天', hrActivity: '今日活跃' };
  const rules = { retiredMode: true, titleKeywords: 'Java', cities: '上海', education: ['本科'], salaryMin: 5000, hrMaxDays: 3 };
  for (const phase of ['card', 'detail']) {
    assert.equal(C.filters(intern, rules, phase).match, false);
    assert.equal(C.filters(intern, {...rules, retiredTitleSwitch: true}, phase).match, false);
    assert.equal(C.filters(intern, {...rules, retiredMode: false}, phase).match, false);
    assert.equal(C.filters({...intern, description: intern.description + ' 外包'}, rules, phase).match, false);
    assert.equal(C.filters({...intern, location: '北京'}, rules, phase).match, false);
    assert.equal(C.filters({...intern, education: '硕士'}, rules, phase).match, false);
    assert.equal(C.filters({...intern, salary: '100元/天'}, rules, phase).match, false);
    assert.equal(C.filters({...intern, hrActivity: '本周活跃'}, rules, phase).match, false);
  }
});
test('display merges a job lifecycle without hiding other jobs, runs or preview results', () => {
  const create=(status,extra={})=>({status,runId:'run1',job,greeting:'same',...extra});
  const sent=create('sent'),requested=create('communication_requested'),draft=create('draft');
  const otherJob=create('draft',{job:{...job,id:'other'}}),otherRun=create('draft',{runId:'run2'}),preview=create('preview');
  const records=[sent,requested,draft,otherJob,otherRun,preview];
  assert.deepEqual(C.displayRecords(records),[sent,otherJob,otherRun,preview]);
  assert.equal(records.length,6);
  assert.equal(C.displayRecords([{...requested,runId:undefined},{...draft,runId:undefined}]).length,1);
});
test('template replaces safe variables without inventing years from JD', () => {
  assert.equal(C.template(job, { greetingTemplate: '您好，我想了解{company}的{position}岗位。' }), '您好，我想了解技术公司的Java 开发工程师岗位。');
  assert.ok(!C.template(job, {}).includes('1-3年'));
});
test('CSV protects spreadsheet formulas and quotes user-controlled values', () => {
  const output = C.csv([{ time: 'now', job: { ...job, title: '  =1+1', company: 'A,"B"' }, status: 'preview', reason: 'test' }]);
  assert.ok(output.startsWith('\uFEFF'));
  assert.ok(output.includes("'  =1+1"));
  assert.ok(output.includes('A,""B""'));
});
test('configuration bounds limit batch size and request rate', () => {
  const c = C.config({ maxJobs: 9999, maxScan: -1, intervalSeconds: 0 });
  assert.equal(c.maxJobs, 100); assert.equal(c.maxScan, 1); assert.equal(c.intervalSeconds, 1);
});
