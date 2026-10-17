(function (scope) {
  'use strict';
  const BASE = 'https://www.zhipin.com/web/geek/jobs';
  const jobTypes = [{ value: '', label: '不限' }, { value: '1901', label: '全职' }, { value: '1902', label: '实习' }, { value: '1903', label: '兼职' }];
  const degrees = [{ value: '', label: '不限' }, { value: '209', label: '初中及以下' }, { value: '208', label: '中专/中技' }, { value: '206', label: '高中' }, { value: '202', label: '大专' }, { value: '203', label: '本科' }, { value: '204', label: '硕士' }, { value: '205', label: '博士' }];
  const clean = (value, length = 120) => String(value ?? '').replace(/[\u0000-\u001f\u200B-\u200F\uFEFF]/g, '').trim().slice(0, length);
  const key = value => clean(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const cityKey = value => key(value).replace(/市$/, '');
  function listUrl(value) { try { const u = new URL(value); return u.origin === 'https://www.zhipin.com' && !u.username && !u.password && /^\/web\/geek\/jobs?\/?$/.test(u.pathname) ? u : null; } catch { return null; } }
  function entry(input) {
    const label = clean(input.label), id = clean(input.id, 100);
    if (!label || /添加.*求职|新增.*期望/.test(label)) return null;
    const recommend = key(label) === '推荐' || id === 'recommend';
    const url = listUrl(input.url);
    return { id: recommend ? 'recommend' : /^[a-zA-Z0-9_-]+$/.test(id) ? id : '', label, mode: recommend ? 'recommend' : 'expect', url: url?.href || '', param: input.param === 'encryptExpectId' ? 'encryptExpectId' : 'expectId', ...(input.legacyId ? { legacyId: clean(input.legacyId, 100) } : {}) };
  }
  function normalize(input, catalog = {}) {
    const name = clean(input.name, 60);
    if (!name) throw Error('请填写方案名称');
    const selected = entry(input.entry || {});
    if (!selected) throw Error('请选择求职入口，可先刷新求职期望');
    const city = clean(input.city, 40), codes = { ...(scope.BossCityCodes || {}), ...(catalog.cities || {}) };
    const cityCode = !city || ['全国', '不限', '不限城市'].includes(city) ? '100010000' : Object.entries(codes).find(([name]) => cityKey(name) === cityKey(city))?.[1];
    if (!cityCode || !/^\d{9}$/.test(String(cityCode))) throw Error('未识别这个城市，请选择城市列表中的名称，或刷新求职期望后重试');
    const jobType = clean(input.jobType), degree = clean(input.degree);
    if (!jobTypes.some(option => option.value === jobType) || !degrees.some(option => option.value === degree)) throw Error('求职类型或学历无效');
    const note = String(input.note || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200B-\u200F\uFEFF]/g, '').trim().slice(0, 300);
    const plan = { id: clean(input.id, 100), name, note, entry: selected, city: cityCode === '100010000' ? '' : city.replace(/市$/, ''), cityCode: String(cityCode), jobType, degree, keyword: clean(input.keyword, 80), enabled: input.enabled !== false };
    plan.sourceUrl = buildUrl(plan);
    return plan;
  }
  function buildUrl(plan) {
    // Start with a clean list URL: never carry pagination, tracking or a stale city.
    const url = new URL(BASE);
    if (plan.entry.mode === 'expect' && plan.entry.id) url.searchParams.set('expectId', plan.entry.id);
    if (plan.cityCode) url.searchParams.set('city', plan.cityCode);
    if (plan.jobType) url.searchParams.set('jobType', plan.jobType);
    if (plan.degree) url.searchParams.set('degree', plan.degree);
    if (plan.keyword) url.searchParams.set('query', plan.keyword);
    return url.href;
  }
  function configFor(plan, config) {
    if (plan.legacy) return config;
    return { ...config, cities: plan.city || '', education: plan.degree ? [degrees.find(option => option.value === plan.degree)?.label].filter(Boolean) : [] };
  }
  function describe(plan) { return plan.legacy ? '原职位页入口' : [plan.entry.label, plan.city || '全国', jobTypes.find(x => x.value === plan.jobType)?.label || '不限类型', plan.degree ? degrees.find(x => x.value === plan.degree)?.label : '不限学历', plan.keyword].filter(Boolean).join(' · '); }
  function captureCurrent(info, catalog = {}) {
    const url = listUrl(info.url);
    if (!url) throw Error('当前页面不是职位列表');
    if (info.entries && info.entries.filter(item => item.selected).length !== 1) throw Error('尚未读取到页面选中的求职期望，请等原生入口显示后重试');
    const code = url.searchParams.get('city'), codes = { ...(scope.BossCityCodes || {}), ...(catalog.cities || {}) };
    return { entry: info.entries?.find(item => item.selected) || catalog.entries?.find(item => item.id === url.searchParams.get('expectId')) || { id: 'recommend', label: '推荐', mode: 'recommend' }, city: info.filters?.city ?? (Object.keys(codes).find(name => codes[name] === code && name !== '全国') || ''), jobType: info.filters?.jobType ?? (url.searchParams.get('jobType') || ''), degree: info.filters?.degree ?? (url.searchParams.get('degree') || ''), keyword: info.filters?.keyword ?? (url.searchParams.get('query') || '') };
  }
  function fromUrl(address, catalog = {}) {
    const url = listUrl(address);
    if (!url) throw Error('请填写 BOSS 职位列表链接');
    const id = url.searchParams.get('expectId') || url.searchParams.get('encryptExpectId') || '';
    const known = (catalog.entries || []).find(e => id && (e.id === id || e.legacyId === id));
    const selected = known || (id ? { id, label: '求职期望 ' + id, mode: 'expect', url: url.href } : { id: 'recommend', label: '推荐', mode: 'recommend', url: url.href });
    const cityCode = url.searchParams.get('city') || '100010000', codes = { ...(scope.BossCityCodes || {}), ...(catalog.cities || {}) };
    return { entry: selected, city: cityCode === '100010000' ? '' : Object.keys(codes).find(name => codes[name] === cityCode) || '', cityCode, jobType: url.searchParams.get('jobType') || '', degree: url.searchParams.get('degree') || '', keyword: url.searchParams.get('query') || '', sourceUrl: url.href };
  }
  function generateLink(input, catalog = {}) {
    const selected = input.entry ? entry(input.entry) : null;
    const base = input.baseUrl || selected?.url || BASE;
    const url = listUrl(base);
    if (!url) throw Error('求职期望入口链接应为 BOSS 职位列表地址');
    const normalized = normalize({ ...input, name: '条件生成链接', entry: selected || fromUrl(base, catalog).entry }, catalog);
    if (selected?.mode === 'recommend') { url.searchParams.delete('expectId'); url.searchParams.delete('encryptExpectId'); }
    else if (selected?.id) {
      const parameter = selected.param === 'encryptExpectId' || (url.searchParams.has('encryptExpectId') && !url.searchParams.has('expectId')) ? 'encryptExpectId' : 'expectId';
      url.searchParams.delete('expectId'); url.searchParams.delete('encryptExpectId'); url.searchParams.set(parameter, selected.id);
    }
    for (const k of ['city', 'jobType', 'degree', 'query']) { url.searchParams.delete(k); const v = k === 'query' ? normalized.keyword : normalized[k === 'city' ? 'cityCode' : k]; if (v) url.searchParams.set(k, v); }
    for (const k of ['page', 'pageNo', 'pageNum']) url.searchParams.delete(k);
    return { ...normalized, sourceUrl: url.href, note: describe(normalized), conditions: conditionsFor(normalized), urlOnly: false };
  }
  // Keep routing intent separate from the address: BOSS can normalize a URL
  // without retaining its expectation/city parameters. Notes are never parsed.
  function conditionsFor(input, catalog = {}) {
    const requested = input.conditions || input;
    const fallback = fromUrl(input.sourceUrl || BASE, catalog);
    let selected = entry(requested.entry || fallback.entry);
    const matches = (catalog.entries || []).filter(e => selected && ((selected.id && (e.id === selected.id || e.legacyId === selected.id)) || key(e.label) === key(selected.label)));
    if (matches.length === 1) selected = entry(matches[0]);
    const plan = normalize({ ...fallback, ...requested, entry: selected, name: '链接条件' }, catalog);
    return { entry: plan.entry, city: plan.city, cityCode: plan.cityCode, jobType: plan.jobType, degree: plan.degree, keyword: plan.keyword };
  }
  function normalizeLinks(input, catalog = {}) {
    if (!Array.isArray(input) || !input.length || input.length > 40) throw Error('请添加 1–40 条职位链接');
    const ids = new Set();
    const links = input.map((item, index) => {
      const enabled = item.enabled !== false, targetJobs = Number(item.targetJobs);
      if (!Number.isInteger(targetJobs) || targetJobs < 1 || targetJobs > 100) throw Error('第 ' + (index + 1) + ' 条链接的投递人数应为 1–100');
      const info = fromUrl(item.sourceUrl, catalog);
      const conditions = conditionsFor({ sourceUrl: info.sourceUrl, conditions: item.conditions || (item.entry ? item : info) }, catalog);
      const note = clean(item.note, 200) || describe(conditions);
      let id = clean(item.id, 100); if (!id || ids.has(id)) id = crypto.randomUUID(); ids.add(id);
      return { ...info, ...conditions, conditions, id, note, name: note, targetJobs, enabled, urlOnly: false };
    });
    const total = links.filter(link => link.enabled).reduce((sum, link) => sum + link.targetJobs, 0);
    if (!total) throw Error('请启用至少一条职位链接');
    if (total > 100) throw Error('本轮启用链接的投递人数合计不能超过 100');
    return { links, total };
  }
  function create(storage) {
    let tail = Promise.resolve();
    const serial = fn => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
    const list = async () => (await storage.get('sourcePlans')).sourcePlans || [];
    return {
      list,
      catalog: async () => (await storage.get('sourceCatalog')).sourceCatalog || { entries: [], cities: {}, refreshedAt: 0 },
      save: input => serial(async () => {
        const plans = await list(), previous = plans.find(plan => plan.id === input.id);
        if (input.id && !previous) throw Error('方案已不存在，请刷新');
        if (!previous && plans.length >= 40) throw Error('最多保存 40 个搜索方案');
        const catalog = (await storage.get('sourceCatalog')).sourceCatalog || {};
        const plan = { ...normalize(input, catalog), id: previous?.id || crypto.randomUUID(), createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now() };
        await storage.set({ sourcePlans: previous ? plans.map(p => p.id === plan.id ? plan : p) : [...plans, plan] });
        return plan;
      }),
      toggle: (id, enabled) => serial(async () => {
        const plans = await list(), plan = plans.find(p => p.id === id);
        if (!plan) throw Error('方案已不存在');
        plan.enabled = Boolean(enabled); await storage.set({ sourcePlans: plans }); return plan;
      }),
      remove: id => serial(async () => { await storage.set({ sourcePlans: (await list()).filter(p => p.id !== id) }); return true; })
    };
  }
  const api = { BASE, jobTypes, degrees, clean, key, cityKey, listUrl, entry, normalize, buildUrl, configFor, describe, captureCurrent, fromUrl, generateLink, conditionsFor, normalizeLinks, create };
  scope.BossSourcePlans = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
