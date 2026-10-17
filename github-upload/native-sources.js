// Runs in the native page. A startup action clicks existing navigation/filter
// controls only; it never calls private APIs or changes account expectations.
function BossNativeSources(action = 'read', requested = null) {
  const clean = v => String(v ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
  const key = v => clean(v).normalize('NFKC').replace(/\s/g, '').toLowerCase();
  const visible = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const excluded = '.job-card-wrapper,.job-card-wrap,.job-detail-container,.job-detail-box,.chat-conversation,[role="dialog"],#zhixiang-controls';
  const all = [...document.querySelectorAll('a,button,span,li,div')].filter(el => !el.closest(excluded));
  const add = all.find(el => visible(el) && /^\+?\s*添加求职期望$/.test(clean(el.innerText)));
  // The native recommendation tab and expectation list are siblings. Reading
  // only .expect-list loses the selected recommendation and hidden choices.
  let nav = document.querySelector('.c-expect-select') || add?.parentElement;
  for (let n = 0; nav && n < 5; n++, nav = nav.parentElement) {
    if (nav === document.body || nav.querySelector('.job-card-wrap,.job-list-container')) { nav = null; break; }
    if ([...nav.querySelectorAll('a,button,li,span')].some(el => /^推荐$/.test(clean(el.innerText)))) break;
  }
  nav ||= document.querySelector('.job-expect-list,.expect-list,.job-expect-box,.expect-wrap,.recommend-tabs');
  if (!nav) throw Error('没有读取到求职期望栏，请打开显示「推荐 / 求职期望」的 BOSS 职位页再刷新');
  const entries = [], cities = {}, nodes = new Map();
  const urlId = href => { try { const u = new URL(href, location.href); return u.origin === location.origin ? u.searchParams.get('expectId') || u.searchParams.get('encryptExpectId') || '' : ''; } catch { return ''; } };
  function addEntry(label, id, node, selected = false, url = '', param = '', legacyId = '') {
    label = clean(label); id = clean(id);
    if (!label || label.length > 100 || /添加.*求职|新增.*期望/.test(label)) return;
    if (key(label) === '推荐') id = 'recommend';
    if (!/^[a-zA-Z0-9_-]*$/.test(id)) id = '';
    const existing = entries.find(item => (id && item.id === id) || key(item.label) === key(label));
    if (existing) { if (param === 'encryptExpectId' && id) { existing.id = id; existing.param = param; } else existing.id ||= id; existing.legacyId ||= clean(legacyId); existing.selected ||= selected; if (node) nodes.set(existing, node); return; }
    const entry = { id, label, selected, url, ...(param ? { param } : {}), ...(legacyId ? { legacyId: clean(legacyId) } : {}) }; entries.push(entry); if (node) nodes.set(entry, node);
  }
  const candidates = [...nav.querySelectorAll('a,button,li,[role="tab"],.expect-item,.job-expect-item,.job-item,span')];
  for (const el of candidates) {
    if (!visible(el) && !el.closest('.dropdown-expect-list')) continue;
    const node = el.closest('a,button,li,[role="tab"],.expect-item,.job-expect-item,.job-item') || el;
    const label = clean(node.querySelector('.text-content')?.innerText || node.innerText);
    if (!label || label.length > 100 || /添加.*求职|新增.*期望/.test(label)) continue;
    if (el === node && [...el.children].some(child => clean(child.innerText) === label)) continue;
    const id = node.dataset.expectId || node.dataset.id || node.getAttribute('data-expect-id') || urlId(node.getAttribute('href'));
    const isChoice = key(label) === '推荐' || /[（(].+[）)]$/.test(label) || /expect|job-item|tab-item/.test(node.className || '') || id;
    if (!isChoice || /^\+|^\|$/.test(label)) continue;
    const active = el.closest('.active,.selected,.current,.cur,[aria-selected="true"]');
    const selected = node.matches('.active,.selected,.current,.cur,[aria-selected="true"]') || Boolean(active && active !== nav && nav.contains(active) && key(active.innerText) === key(label));
    addEntry(label, id, node, selected && (!node.closest('.dropdown-expect-list') || Boolean(node.closest('.expect-select-filter.active'))), node.href || '');
  }
  const containers = ['props', '$props', 'setupState', '$data', 'data', 'ctx', 'proxy'];
  const expectKeys = ['expectList', 'jobExpectList', 'expectJobList', 'geekExpectList', 'expectPositionList', 'expectInfos', 'expectations'];
  const cityKeys = ['cityList', 'cityGroup', 'cityGroups', 'cityTree', 'cityData', 'hotCityList', 'hotCities', 'cityOptions'];
  function cityData(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) return;
    seen.add(value);
    if (Array.isArray(value)) { value.slice(0, 500).forEach(item => cityData(item, depth + 1, seen)); return; }
    const name = clean(value.cityName || value.name || value.label), code = clean(value.cityCode || value.code || value.value);
    if (name && name.length < 20 && /^\d{9}$/.test(code)) cities[name.replace(/市$/, '')] = code;
    for (const k of ['children', 'subLevelModelList', 'cityList', 'data', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) cityData(value[k], depth + 1, seen);
  }
  function componentData(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value) || depth > 4) return;
    seen.add(value);
    for (const k of expectKeys) {
      const list = value[k];
      if (!Array.isArray(list) || list.length > 40) continue;
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const id = item.encryptId || item.encryptExpectId || item.expectId || item.id;
        const name = item.positionName || item.jobName || item.expectPositionName || item.expectJobName || item.name;
        const city = item.locationName || item.cityName || item.city;
        if (!id || typeof name !== 'string') continue;
        const label = clean(name) + (typeof city === 'string' && city ? '(' + city + ')' : '');
        const sameName = entries.filter(e => key(e.label) === key(name) || key(e.label).startsWith(key(name) + '('));
        const dom = entries.find(e => e.id === clean(id) || key(e.label) === key(label)) || (sameName.length === 1 ? sameName[0] : null);
        // Keep the native label and associate an ID only with the same choice.
        addEntry(dom?.label || label, id, dom && nodes.get(dom), dom?.selected, '', item.encryptId || item.encryptExpectId ? 'encryptExpectId' : 'expectId', item.id || item.expectId);
      }
    }
    for (const k of cityKeys) cityData(value[k]);
    for (const k of containers) componentData(value[k], depth + 1, seen);
  }
  const inspected = new Set();
  for (const start of [nav, ...candidates.slice(0, 40), ...document.querySelectorAll('.c-filter-condition,.filter-select-box,.job-search-filter,.search-condition')]) {
    for (let el = start, d = 0; el && el !== document.body && d < 4; el = el.parentElement, d++) {
      for (const vm of [el.__vue__, el.__vueParentComponent]) if (vm && !inspected.has(vm)) { inspected.add(vm); componentData(vm); }
    }
  }
  const url = new URL(location.href), currentId = url.searchParams.get('expectId') || url.searchParams.get('encryptExpectId');
  if (currentId) { const e = entries.find(item => item.selected && item.id !== 'recommend'); if (e) e.id ||= currentId; }
  if (!entries.length) throw Error('求职期望尚未加载，请等页面显示后再刷新');
  const ignored = '.job-card-wrapper,.job-card-wrap,.job-detail-container,.job-detail-box,.chat-conversation,#zhixiang-controls,#zhixiang-settings';
  const usable = el => visible(el) && !el.closest(ignored) && !nav.contains(el);
  const labels = { city: '城市', jobType: '求职类型', degree: '学历要求' };
  const selectors = { city: '.city-select,.city-select-box,.city-label,.filter-city,.condition-city,[data-filter="city"]', jobType: '[data-filter="jobType"],.job-type-select', degree: '[data-filter="degree"],.degree-select' };
  const rootSelector = '.c-filter-condition,.filter-select-box,.job-search-filter,.search-condition,.job-filter,.filter-box,.condition-list,.search-filter,.filter-select,.condition-filter';
  function trigger(kind) {
    const specific = [...document.querySelectorAll(selectors[kind])].filter(usable);
    if (specific.length) return specific.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    const candidates = [...document.querySelectorAll(rootSelector + ',button,[role="button"],span,a')].filter(el => usable(el) && !el.closest('[role="dialog"],.city-dialog,.city-dropdown,.filter-select-dropdown,.dropdown-menu,.filter-options'));
    const labelled = candidates.filter(el => new RegExp('^' + labels[kind] + '(?:[（(]\\d+[）)])?$').test(clean(el.innerText)));
    if (labelled.length) return labelled.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    if (kind === 'city') {
      const known = { ...Object.fromEntries((requested?.cityNames || []).map(name => [name, ''])), ...cities, ...(requested?.city ? { [requested.city]: requested.cityCode } : {}) };
      return candidates.find(el => Object.keys(known).some(name => key(name) === key(el.innerText))) || null;
    }
    return null;
  }
  const controls = Object.fromEntries(Object.keys(labels).map(kind => [kind, trigger(kind)]));
  const filters = { jobType: url.searchParams.get('jobType') || '', degree: url.searchParams.get('degree') || '', keyword: url.searchParams.get('query') || '' };
  for (const kind of ['jobType', 'degree']) {
    const scope = controls[kind]?.closest('.condition-filter-select');
    if (scope) filters[kind] = [...scope.querySelectorAll('.filter-select-dropdown li.active')].map(el => el.getAttribute('ka')?.match(/-(\d+)$/)?.[1]).filter(Boolean).sort().join(',');
  }
  if (controls.city) {
    const text = clean(controls.city.innerText).replace(/\s*[∨⌄▾▼]$/, '');
    if (['城市', '全国', '不限', '不限城市'].includes(text)) filters.city = '';
    else if (text.length < 20 && !/选择|切换|\d|\n/.test(text)) filters.city = text.replace(/市$/, '');
  }
  // The native page assigns a new jobList array after each list response.
  // Read that reference/loading flag only, so startup can wait for a refresh
  // even when the URL stays the same. No job/HR identity checks are involved.
  let list;
  outer: for (const start of [nav, document.querySelector('.job-list-container')].filter(Boolean)) {
    for (let el = start, d = 0; el && el !== document.body && d < 8; el = el.parentElement, d++) {
      for (const vm of [el.__vue__, el.__vueParentComponent?.proxy, el.__vueParentComponent?.ctx]) {
        const data = vm?.$data || vm;
        if (!Array.isArray(data?.jobList) || typeof data.loading !== 'boolean') continue;
        let tracker = window.__qutouSourceList;
        if (!tracker) { tracker = { revision: 0 }; Object.defineProperty(window, '__qutouSourceList', { value: tracker, configurable: true }); }
        if (tracker.owner !== data || tracker.reference !== data.jobList) { tracker.owner = data; tracker.reference = data.jobList; tracker.revision++; }
        list = { revision: tracker.revision, loading: data.loading };
        break outer;
      }
    }
  }
  const result = { entries, cities, filters, ...(list ? { list } : {}), url: location.href, refreshedAt: Date.now() };
  if (action === 'activate') {
    const exact = entries.filter(e => requested?.id && (e.id === requested.id || e.legacyId === requested.id));
    const matches = exact.length ? exact : entries.filter(e => requested?.label && key(e.label) === key(requested.label));
    const choice = matches.length === 1 ? matches[0] : null, node = choice && nodes.get(choice);
    // Native overflow choices are already mounted under a CSS hover menu.
    // Their click handlers work without moving the user's mouse.
    if (!choice || !node || !visible(node) && !node.closest('.dropdown-expect-list')) return { ...result, missing: true, reason: '没有找到求职期望「' + (requested?.label || requested?.id) + '」，请刷新求职期望后重新选择' };
    if (choice.selected) return { ...result, selected: true, clicked: false };
    node.click(); return { ...result, selected: false, clicked: true };
  }
  if (action === 'filter') {
    const kind = requested?.kind, control = controls[kind];
    if (!control) return { ...result, missing: true, reason: '没有找到原生' + (labels[kind] || '筛选') + '入口' };
    if (requested.phase === 'open') {
      control.click(); return { ...result, clicked: true };
    }
    if (requested.phase === 'hover') {
      for (const node of new Set([control, control.closest(rootSelector)].filter(Boolean))) {
        node.dispatchEvent(new MouseEvent('mouseenter', { view: window }));
        node.dispatchEvent(new MouseEvent('mouseover', { view: window, bubbles: true }));
      }
      return { ...result, hovered: true };
    }
    const popupSelector = '.city-select-dialog,.city-dialog,.city-box,.city-select-content,.city-dropdown,.city-select-dropdown,.city-search-result,.city-list,.filter-select-dropdown,.dropdown-menu,.dropdown-select,.filter-dropdown,.filter-options,.filter-list,.option-list,[role="listbox"],[role="dialog"]';
    const popups = [...document.querySelectorAll(popupSelector)].filter(usable);
    const scope = control.closest('.condition-filter-select,.filter-select-box') || control.closest(rootSelector);
    if (scope && usable(scope) && !popups.includes(scope)) popups.push(scope);
    const options = [...new Set(popups.flatMap(p => [...p.querySelectorAll('a,button,li,span,label,div,[role="option"]')]))].filter(el => usable(el) || scope?.matches('.condition-filter-select') && scope.contains(el) && el.matches('.filter-select-dropdown li'));
    const wanted = requested.label || '';
    const same = text => kind === 'city' ? key(text).replace(/市$/, '') === key(wanted).replace(/市$/, '') || (!requested.value || requested.value === '100010000') && ['全国', '不限', '不限城市'].includes(clean(text)) : key(text) === key(wanted);
    if (scope?.matches('.condition-filter-select') && requested.phase === 'option') {
      const active = [...scope.querySelectorAll('.filter-select-dropdown li.active')];
      const other = active.find(el => !requested.value || !same(el.innerText));
      if (other) { other.click(); return { ...result, pending: true, changed: true }; }
      if (!requested.value || active.some(el => same(el.innerText))) return { ...result, clicked: true, selected: true };
    }
    const option = options.filter(el => same(clean(el.innerText)) && !el.querySelector('input[type="checkbox"]:checked')).sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    if (option && requested.phase !== 'group') { option.click(); return { ...result, clicked: true }; }
    if (requested.group) {
      const group = options.find(el => key(el.innerText) === key(requested.group));
      if (group) { group.click(); return { ...result, clicked: true }; }
    }
    // Some city pickers expose cities by alphabetic tabs. Return only their
    // visible group labels; the worker tries each group at most once.
    const groups = [...new Set(options.map(el => clean(el.innerText)).filter(text => /^[A-Z]{2,8}$/.test(text)))];
    return { ...result, pending: true, groups, needsHover: !popups.some(p => p !== scope), reason: '原生' + labels[kind] + '选项尚未显示「' + wanted + '」' };
  }
  return result;
}
if (typeof module !== 'undefined' && module.exports) module.exports = BossNativeSources;
