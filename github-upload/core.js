/* Shared pure logic: browser content script, service worker and Node tests. */
(function (scope) {
  'use strict';
  const DEFAULTS = {
    titleKeywords: 'Java,后端', titleGroups: null, titleGroupRules: null, titleMode: 'any',
    blockedWords: '外包,派遣', blockedGroups: null, blockedMode: 'any', blockedCompanies: '', cities: '', education: [], experience: [],
    salaryMin: 0, salaryMax: 0, salaryWorkDays: 30, hrMaxDays: 0,
    clickApply: false, greetingMode: 'boss_default', customGreeting: false, maxJobs: 10, maxScan: 60, browseIntervalSeconds: 0.5, intervalSeconds: 2,
    greetingTemplate: '您好，我对贵公司的{title}岗位很感兴趣，希望进一步了解岗位要求，期待与您沟通。',
    greetingCityOriginals: [],
  };
  function words(value) {
    const input = Array.isArray(value) ? value : String(value || '').split(/[,，;；\n]/);
    return [...new Set(input.map(x => String(x).trim()).filter(Boolean))];
  }
  function bounded(value, fallback, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
  }
  function config(raw = {}) {
    const c = {};
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      if (key === 'titleGroups' || key === 'titleGroupRules' || key === 'blockedGroups' || key === 'greetingCityOriginals') continue;
      if (Array.isArray(fallback)) c[key] = words(raw[key] ?? fallback);
      else if (typeof fallback === 'boolean') c[key] = typeof raw[key] === 'boolean' ? raw[key] : fallback;
      else if (typeof fallback === 'string') c[key] = typeof raw[key] === 'string' ? raw[key].trim().slice(0, 12000) : fallback;
      else c[key] = raw[key] ?? fallback;
    }
    c.titleGroups = raw.titleGroups == null ? null : normalizeTitleGroups(raw.titleGroups);
    c.titleGroupRules = raw.titleGroupRules == null ? null : normalizeTitleGroupRules(raw.titleGroupRules);
    if (c.titleGroupRules !== null) c.titleGroups = c.titleGroupRules.map(rule => rule.terms);
    c.blockedWords = blockedWordList({ ...raw, blockedWords: c.blockedWords }).join(',');
    c.blockedGroups = null;
    c.blockedMode = 'any';
    c.titleMode = c.titleMode === 'all' ? 'all' : 'any';
    // Old customGreeting switches never opt an existing installation into sending text.
    c.greetingMode = raw.greetingMode === 'custom' ? 'custom' : 'boss_default';
    c.greetingTemplate = c.greetingTemplate.slice(0, 300);
    c.greetingCityOriginals = Array.isArray(raw.greetingCityOriginals) ? raw.greetingCityOriginals.slice(0, 50).map(value => typeof value === 'string' ? value.slice(0, 300) : '') : [];
    c.salaryMin = bounded(c.salaryMin, 0, 0, 1000000);
    c.salaryMax = bounded(c.salaryMax, 0, 0, 1000000);
    const workDays = Number(c.salaryWorkDays);
    c.salaryWorkDays = Number.isFinite(workDays) && workDays >= 1 && workDays <= 31 ? workDays : 30;
    c.hrMaxDays = [0, 1, 3, 7, 30].includes(Number(c.hrMaxDays)) ? Number(c.hrMaxDays) : 0;
    c.maxJobs = bounded(c.maxJobs, 10, 1, 100);
    c.maxScan = bounded(c.maxScan, 60, 1, 200);
    const browseInterval = Number(c.browseIntervalSeconds);
    c.browseIntervalSeconds = Number.isFinite(browseInterval) ? Math.min(120, Math.max(0.2, browseInterval)) : 0.5;
    // Keep the old interval field as the greeting interval, preserving saved
    // preferences while new/old profiles both get independent browsing speed.
    c.intervalSeconds = bounded(c.intervalSeconds, 2, 1, 120);
    return c;
  }
  function keywordHit(text, keyword) {
    const haystack = String(text || '').normalize('NFKC').toLowerCase();
    const needle = String(keyword).normalize('NFKC').toLowerCase();
    // Java must not match JavaScript; Go must not match Django.
    if (/^[a-z0-9+#. -]+$/i.test(needle)) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9])' + escaped + '(?=$|[^a-z0-9])', 'i').test(haystack);
    }
    return haystack.includes(needle);
  }
  // Split old compound phrases once; explicitly edited groups keep their terms intact.
  function titleTerms(value) {
    const text = String(value || '').normalize('NFKC').toLowerCase()
      .replace(/实习生/g, '实习')
      .replace(/(实习|全栈|后端|前端|软件|开发|工程师)/g, ' $1 ')
      .replace(/([\p{Script=Han}])([a-z0-9])/gu, '$1 $2')
      .replace(/([a-z0-9+#.])([\p{Script=Han}])/gu, '$1 $2');
    const terms = [...new Set(text.split(/[\s\-—–_()\[\]{}【】\/|·、:：]+/u).filter(Boolean))];
    // A nonempty old keyword consisting of separators must not become an unlimited rule.
    return terms.length || !text.trim() ? terms : [String(value).normalize('NFKC').toLowerCase().trim()];
  }
  function normalizeTitleGroups(groups) {
    return normalizeKeywordGroups(groups, '标题关键词组');
  }
  function normalizeKeywordGroups(groups, label = '关键词组') {
    if (!Array.isArray(groups)) throw new Error(label + '格式不正确');
    return groups.map(group => {
      if (!Array.isArray(group) || group.some(term => typeof term !== 'string')) throw new Error('每个' + label + '必须由文字关键词组成');
      const seen = new Set();
      return group.map(term => term.normalize('NFKC').trim()).filter(term => {
        const key = term.toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key); return true;
      });
    }).filter(group => group.length);
  }
  function effectiveTitleGroups(raw = {}) {
    if (raw.titleGroupRules != null) return normalizeTitleGroupRules(raw.titleGroupRules).filter(rule => rule.enabled).map(rule => rule.terms);
    if (raw.titleGroups != null) return normalizeTitleGroups(raw.titleGroups);
    return words(raw.titleKeywords ?? DEFAULTS.titleKeywords).map(titleTerms).filter(group => group.length);
  }
  function titleKeywordRule(title, raw = {}) {
    const groups = effectiveTitleGroups(raw);
    if (!groups.length) return !effectiveTitleGroupRules(raw).length;
    const hit = group => group.every(term => keywordHit(title, term));
    return raw.titleMode === 'all' ? groups.every(hit) : groups.some(hit);
  }
  function normalizeTitleGroupRules(rules) {
    if (!Array.isArray(rules)) throw new Error('标题关键词组状态格式不正确');
    return rules.map(rule => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule) || (rule.enabled !== undefined && typeof rule.enabled !== 'boolean')) throw new Error('标题关键词组状态格式不正确');
      return { terms: normalizeTitleGroups([rule.terms])[0] || [], enabled: rule.enabled !== false };
    }).filter(rule => rule.terms.length);
  }
  function effectiveTitleGroupRules(raw = {}) {
    return raw.titleGroupRules != null ? normalizeTitleGroupRules(raw.titleGroupRules) : effectiveTitleGroups(raw).map(terms => ({ terms, enabled: true }));
  }
  function blockedWordList(raw = {}) {
    if (raw.blockedGroups != null) {
      // Old groups become complete phrases; do not turn "收费 + 培训" into
      // two broad blockers that would also exclude free training.
      const groups = normalizeKeywordGroups(raw.blockedGroups, '屏蔽词组');
      return words(groups.map(group => group.reduce((phrase, term) => {
        const adjacentChinese = /\p{Script=Han}$/u.test(phrase) && /^\p{Script=Han}/u.test(term);
        return phrase + (phrase && !adjacentChinese ? ' ' : '') + term;
      }, '')));
    }
    return words(raw.blockedWords ?? DEFAULTS.blockedWords);
  }
  function matchingBlockedWords(text, raw = {}) {
    return blockedWordList(raw).filter(word => keywordHit(text, word));
  }
  function jobTitleKey(value) {
    let title = String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const decoration = value => Boolean(value) && !value.replace(/周末双休|双休|五险一金|五险|一金|包吃住|包吃|包住|提供住宿|餐补|交通补贴|可转正|转正机会|外企|金融保险|急招|急聘/g, '').replace(/[+、,，/|·-]/g, '');
    for (let previous; title !== previous;) {
      previous = title;
      const bracket = title.match(/\(([^()]*)\)$/);
      const suffix = title.match(/[-—–|｜·]([^-—–|｜·]+)$/);
      if (bracket && decoration(bracket[1])) title = title.slice(0, bracket.index);
      else if (suffix && decoration(suffix[1])) title = title.slice(0, suffix.index);
    }
    return title;
  }
  function compatibleJobTitle(a, b) {
    const title = jobTitleKey(a);
    return Boolean(title && title === jobTitleKey(b));
  }
  function jobSchedule(value) {
    const text = String(value || '').normalize('NFKC').replace(/\s+/g, '');
    return { daysPerWeek: Number(text.match(/(\d)天(?:\/|每)周/)?.[1]) || 0, internshipMonths: Number(text.match(/(?<![\d-])(\d{1,2})个月/)?.[1]) || 0 };
  }
  function compareJobDetails(card, detail) {
    const normalized = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const evidence = [], conflicts = [];
    const compare = (name, a, b, matches = (a, b) => normalized(a) === normalized(b)) => {
      if (a && b) (matches(a, b) ? evidence : conflicts).push(name);
    };
    compare('company', card.company, detail.company);
    const salaryA = monthlySalary(card.salary), salaryB = monthlySalary(detail.salary);
    if (salaryA && salaryB) compare('salary', salaryA, salaryB, (a, b) => a.period === b.period && a.min === b.min && a.max === b.max);
    compare('location', card.location, detail.location, (a, b) => {
      const parts = value => String(value).normalize('NFKC').split(/[·•|｜,，\s]+/).filter(Boolean).map(part => normalized(part).replace(/市$/, '').replace(/\.{2,}|…+/g, ''));
      const left = parts(a), right = parts(b);
      return left.length > 0 && right.length > 0 && left.slice(0, Math.min(left.length, right.length)).every((part, index) => part && part === right[index]);
    });
    for (const field of ['education', 'experience', 'daysPerWeek', 'internshipMonths']) compare(field, card[field], detail[field]);
    return { titleCompatible: compatibleJobTitle(card.title, detail.title), companyMatch: evidence.includes('company'), evidence, conflicts,
      secondaryMatch: compatibleJobTitle(card.title, detail.title) && evidence.includes('company') && evidence.filter(field => field !== 'company').length >= 2 && !conflicts.length };
  }
  function monthlySalary(input, days = 30) {
    const raw = String(input || '').trim();
    const value = raw.normalize('NFKC').toLowerCase().replace(/[\s,，]/g, '').replace(/[~～–—至到]/g, '-');
    if (!value || /面议|保密|不限|[\uE000-\uF8FF\uFFFD]/.test(value)) return null;
    const match = value.match(/(\d+(?:\.\d+)?)(万|w|千|k|元)?(?:-(\d+(?:\.\d+)?)(万|w|千|k|元)?)?/);
    if (!match) return null;
    const period = /(?:\/|每)(?:天|日)|(?:日|天)薪/.test(value) ? 'day' : /(?:\/|每)年|年薪/.test(value) ? 'year' : /(?:\/|每)月|月薪|[kw万千]/.test(value) ? 'month' : '';
    if (!period) return null;
    const factor = unit => /万|w/.test(unit || '') ? 10000 : /千|k/.test(unit || '') ? 1000 : 1;
    const unit = match[4] || match[2];
    let min = Number(match[1]) * factor(match[2] || unit), max = Number(match[3] || match[1]) * factor(match[4] || unit);
    if (!(min > 0 && max >= min)) return null;
    const count = Number(days);
    const workDays = Number.isFinite(count) && count >= 1 && count <= 31 ? count : 30;
    const multiplier = period === 'day' ? workDays : period === 'year' ? 1 / 12 : 1;
    min = Math.round(min * multiplier); max = Math.round(max * multiplier);
    return { min, max, period, raw, days: period === 'day' ? workDays : null, estimated: period !== 'month', label: (min === max ? min.toLocaleString('zh-CN') : min.toLocaleString('zh-CN') + '–' + max.toLocaleString('zh-CN')) + ' 元/月' + (period === 'day' ? '（按' + workDays + '天估算）' : period === 'year' ? '（年薪÷12估算）' : '') };
  }
  function recruiterActivity(input) {
    const label = String(input || '').trim();
    let days = null;
    if (/^(在线|当前在线)$|刚刚活跃/.test(label)) days = 0;
    else if (/今日活跃|今天活跃|\d+分钟前|\d+小时前/.test(label)) days = 1;
    else if (/昨天活跃|昨日活跃/.test(label)) days = 2;
    else if (/3日内活跃|三日内活跃|3天内活跃|三天内活跃/.test(label)) days = 3;
    else if (/本周(?:内)?活跃|一周内活跃|7日内活跃|7天内活跃/.test(label)) days = 7;
    else if (/本月(?:内)?活跃|一个月内活跃|30日内活跃|30天内活跃/.test(label)) days = 30;
    else { const ago = label.match(/(\d+)(?:天|日)前(?:活跃)?/); if (ago) days = Number(ago[1]) + 1; }
    return { label: label || '未展示', days, known: days !== null };
  }
  function filters(job, raw, phase = 'detail') {
    const c = config(raw), reasons = [];
    if (!titleKeywordRule(job.title, c)) reasons.push('标题关键词组不匹配');
    const corpus = [job.title, job.company, job.description, job.location, job.experience, job.education].filter(Boolean).join('\n');
    const blocked = matchingBlockedWords(corpus, c);
    if (blocked.length) reasons.push('命中屏蔽词：' + blocked.join('、'));
    const companies = words(c.blockedCompanies).filter(w => keywordHit(job.company, w));
    if (companies.length) reasons.push('屏蔽公司：' + companies.join('、'));
    const cities = words(c.cities);
    if (cities.length && (job.location || phase === 'detail') && !cities.some(w => keywordHit(job.location, w))) reasons.push('地区不匹配或未读取到地区');
    for (const [key, label] of [['education', '学历'], ['experience', '经验']]) {
      if (c[key].length && (job[key] || phase === 'detail') && !c[key].includes(job[key])) reasons.push(label + '不匹配或信息缺失');
    }
    if (c.salaryMin || c.salaryMax) {
      const salary = monthlySalary(job.salary, c.salaryWorkDays);
      if (!salary && phase === 'detail') reasons.push(/[\uE000-\uF8FF\uFFFD]/.test(job.salary || '') ? '薪资数字字体编码未解析，无法按月薪筛选' : '薪资未明确，无法按月薪筛选');
      else if (salary && ((c.salaryMin && salary.max < c.salaryMin) || (c.salaryMax && salary.min > c.salaryMax))) reasons.push('月薪区间不匹配：' + salary.label);
    }
    if (c.hrMaxDays) {
      const activity = recruiterActivity(job.hrActivity);
      if (!activity.known && phase === 'detail') reasons.push('页面未展示 HR 活跃度');
      else if (activity.known && activity.days > c.hrMaxDays) reasons.push('HR 活跃度不符合：' + activity.label);
    }
    return { match: reasons.length === 0, reasons };
  }
  function isJobListUrl(url) {
    try {
      const u = new URL(url);
      return u.origin === 'https://www.zhipin.com' && /^\/web\/geek\/jobs?(?:\/|$)/.test(u.pathname);
    } catch { return false; }
  }
  function jobIdentity(url) {
    try {
      const u = new URL(url);
      if (u.origin !== 'https://www.zhipin.com') return null;
      const match = u.pathname.match(/^\/job_detail\/([a-zA-Z0-9_-]+)\.html$/);
      return match ? { id: match[1], url: u.origin + u.pathname } : null;
    } catch { return null; }
  }
  function displayRecords(records) {
    const ranks = { draft: 1, communication_requested: 2, already_contacted: 3, error: 3, uncertain: 4, sent: 5 };
    const key = r => JSON.stringify([r.job?.id, r.runId || '', r.greeting || '']);
    const best = new Map();
    for (const r of records) if (ranks[r.status] && r.job?.id) {
      const current = best.get(key(r));
      if (!current || ranks[r.status] > ranks[current.status]) best.set(key(r), r);
    }
    return records.filter(r => !ranks[r.status] || !r.job?.id || best.get(key(r)) === r);
  }
  function jobCity(location) {
    const input = String(location || '').normalize('NFKC').trim();
    if (!input || /全国|不限|多地|多城市|多个城市|远程|海外|待定|就近/.test(input)) return '';
    const provinces = '黑龙江|内蒙古|新疆|西藏|宁夏|广西|河北|山西|辽宁|吉林|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾';
    const province = new RegExp('^(?:' + provinces + ')(?:维吾尔自治区|壮族自治区|回族自治区|自治区|省)');
    const provinceOnly = new RegExp('^(?:' + provinces + ')$');
    if (/[/、;；]/.test(input)) return '';
    const parts = input.split(/[·•|｜,，\n]+/).map(part => part.replace(/\s+/g, '').replace(province, '')).filter(part => part && !provinceOnly.test(part));
    const first = parts[0]; if (!first) return '';
    const names = [...new Set([...(scope.BossCities?.cities || []), '北京', '上海', '广州', '深圳', '杭州', '苏州', '天津', '重庆', '香港', '澳门'])].sort((a, b) => b.length - a.length);
    const explicit = part => part.match(/^([\u4e00-\u9fff]{2,8}?)市/)?.[1] || '';
    const city = explicit(first) || names.find(name => first.startsWith(name)) || (/^[\u4e00-\u9fff]{2,8}$/.test(first) && !/[区县镇乡街道省]$/.test(first) ? first : '');
    if (!city || parts.slice(1).some(part => (explicit(part) && explicit(part) !== city) || (names.includes(part) && part !== city))) return '';
    return city;
  }
  function greetingCity(job) {
    const detail = jobCity(Object.hasOwn(job, 'detailLocation') ? job.detailLocation : job.location);
    if (!detail) throw new Error('未能确定当前岗位的唯一城市，城市绑定文案未发送；请核对岗位地点');
    if (job.cardLocation) {
      const card = jobCity(job.cardLocation);
      if (!card || card !== detail) throw new Error('左侧岗位与详情城市不一致或无法核对，城市绑定文案未发送');
    }
    return detail;
  }
  function template(job, raw) {
    const value = config(raw).greetingTemplate;
    const city = value.includes('{city}') ? greetingCity(job) : '';
    const expanded = value.replace(/\{(title|position|company|city)\}/g, (_, key) => key === 'city' ? city : job[key === 'position' ? 'title' : key] || '').trim();
    if (expanded.length > 300) throw new Error('替换后的自定义消息超过 300 字，请缩短文案后再发送');
    return expanded;
  }
  // BOSS's native chat route uses encrypted IDs. Opening it does not click
  // the job page's friend/add handler, which sends the default greeting.
  function chatTarget(value, jobId) {
    const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
    if (!validId(jobId)) return null;
    if (typeof value === 'string') {
      try {
        const url = new URL(value, 'https://www.zhipin.com');
        const bossId = url.searchParams.get('id') || url.searchParams.get('bossId') || url.searchParams.get('encryptBossId');
        if (url.origin !== 'https://www.zhipin.com' || url.username || url.password || !/^\/web\/geek\/chat\/?$/.test(url.pathname) || !validId(bossId) || (url.searchParams.get('jobId') || url.searchParams.get('encryptJobId')) !== jobId) return null;
        return { url: url.href, bossId };
      } catch { return null; }
    }
    if (!value || value.encryptJobId !== jobId || !validId(value.encryptBossId) || typeof value.securityId !== 'string' || !value.securityId || value.securityId.length > 2000) return null;
    const url = new URL('https://www.zhipin.com/web/geek/chat');
    url.searchParams.set('id', value.encryptBossId);
    url.searchParams.set('jobId', jobId);
    url.searchParams.set('securityId', value.securityId);
    return { url: url.href, bossId: value.encryptBossId };
  }
  function csv(records) {
    const cell = value => '"' + String(value ?? '').replace(/^(\s*[=+@-])/, "'$1").replace(/"/g, '""') + '"';
    const rows = [['时间', '岗位', '公司', '地区', '岗位薪资', '月薪换算', 'HR活跃度', '状态', '分数', '理由', 'JD证据', '招呼语', '网址']];
    for (const r of records) rows.push([r.time, r.job.title, r.job.company, r.job.location, r.job.salary, r.job.monthlySalary?.label, r.job.hrActivity, r.status, r.analysis?.score ?? '', (r.analysis?.reasons || [r.reason]).join('；'), (r.analysis?.evidence || []).join('；'), r.greeting, r.job.url]);
    return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
  }
  const api = { DEFAULTS, words, config, keywordHit, titleTerms, normalizeKeywordGroups, normalizeTitleGroups, normalizeTitleGroupRules, effectiveTitleGroups, effectiveTitleGroupRules, titleKeywordRule, blockedWordList, matchingBlockedWords, filters, jobTitleKey, compatibleJobTitle, jobSchedule, compareJobDetails, monthlySalary, recruiterActivity, isJobListUrl, jobIdentity, displayRecords, jobCity, greetingCity, template, chatTarget, csv };
  scope.BossCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
