'use strict';
const C = BossCore;
const $ = id => document.getElementById(id);
const installed = Boolean(globalThis.chrome?.runtime?.id);
let records = [];
let dirty = false;
const cityData = BossCities;
let cityDraft = null, cityTab = 'all';
function cityKey(city) { return city.normalize('NFKC').replace(/市$/, ''); }
function uniqueCities(cities) {
  const seen = new Set();
  return cities.filter(city => {
    const key = cityKey(city);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function selectedCities() { return uniqueCities(C.words($('cities').value)); }
function renderCities() {
  const cities = selectedCities();
  $('city-count').textContent = cities.length ? '已选 ' + cities.length + ' 个城市 / 地区' : '不限城市';
  $('clear-cities').hidden = !cities.length;
  $('selected-cities').replaceChildren(...cities.map(city => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'selected-city';
    button.textContent = city + ' ×'; button.setAttribute('aria-label', '移除' + city);
    button.onclick = () => setCities(selectedCities().filter(value => cityKey(value) !== cityKey(city)));
    return button;
  }));
  renderGreetingAssistance();
}
function setCities(cities) {
  $('cities').value = cities.join(',');
  $('cities').dispatchEvent(new Event('input', { bubbles: true }));
}
$('cities').addEventListener('input', renderCities);
$('clear-cities').onclick = () => setCities([]);
function pickerButton(label, className) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = className; button.textContent = label;
  return button;
}
function pickerMatches(city, query) {
  return city.toLowerCase().includes(query) || (cityData.pinyin[city] || '').includes(query.replace(/\s/g, ''));
}
function currentCityOptions() {
  const query = $('city-search').value.trim().toLowerCase();
  if (query) return cityData.cities.filter(city => pickerMatches(city, query));
  if (cityTab === 'hot') return cityData.hot;
  if (cityData.letterGroups.includes(cityTab)) return cityData.cities.filter(city => cityTab.includes(cityData.pinyin[city][0].toUpperCase())).sort((a, b) => cityData.pinyin[a].localeCompare(cityData.pinyin[b]));
  return cityData.cities;
}
function renderCityPicker() {
  if (!cityDraft) return;
  const keys = new Set(cityDraft.map(cityKey)), cities = currentCityOptions();
  const grid = document.createElement('div'); grid.className = 'city-option-grid';
  if (!$('city-search').value.trim() && ['all', 'hot'].includes(cityTab)) {
    const unlimited = pickerButton('全国', 'city-option'); unlimited.dataset.cityUnlimited = 'true';
    unlimited.setAttribute('aria-pressed', String(!cityDraft.length)); grid.append(unlimited);
  }
  grid.append(...cities.map(city => {
    const button = pickerButton(city, 'city-option'); button.dataset.city = city;
    button.setAttribute('aria-pressed', String(keys.has(cityKey(city)))); return button;
  }));
  const results = $('city-picker-results');
  if (cities.length) results.replaceChildren(grid);
  else { const empty = document.createElement('p'); empty.className = 'city-no-results'; empty.textContent = '没有找到，可在设置里的城市输入框手动填写。'; results.replaceChildren(empty); }
  $('city-results-count').textContent = ($('city-search').value.trim() ? '搜索结果' : '当前分类') + ' · ' + cities.length + ' 个城市';
  $('select-visible-cities').disabled = !cities.length;
  $('city-draft-count').textContent = cityDraft.length ? '已选 ' + cityDraft.length + ' 个城市 / 地区' : '未选城市 · 不限';
  $('clear-city-draft').hidden = !cityDraft.length;
  $('confirm-city-picker').textContent = cityDraft.length ? '确认选择 · ' + cityDraft.length : '确认不限';
  $('city-draft-chips').replaceChildren(...cityDraft.map(city => {
    const button = pickerButton(city + ' ×', 'selected-city'); button.dataset.removeCity = city;
    button.setAttribute('aria-label', '移除待选城市' + city); return button;
  }));
  $('city-tabs').querySelectorAll('button').forEach(button => {
    const active = button.dataset.cityTab === cityTab;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
}
$('open-city-picker').onclick = () => {
  cityDraft = selectedCities(); cityTab = 'all'; $('city-search').value = '';
  renderCityPicker(); $('city-picker').showModal(); $('city-search').focus();
};
$('city-picker-results').onclick = event => {
  const button = event.target.closest('button'); if (!button || !cityDraft) return;
  if (button.dataset.cityUnlimited) { cityDraft = []; renderCityPicker(); return; }
  const city = button.dataset.city; if (!city) return;
  const keys = new Set(cityDraft.map(cityKey));
  cityDraft = keys.has(cityKey(city)) ? cityDraft.filter(value => cityKey(value) !== cityKey(city)) : [...cityDraft, city];
  renderCityPicker();
  [...$('city-picker-results').querySelectorAll('[data-city]')].find(item => item.dataset.city === city)?.focus({ preventScroll: true });
};
$('select-visible-cities').onclick = () => { if (cityDraft) { cityDraft = uniqueCities([...cityDraft, ...currentCityOptions()]); renderCityPicker(); } };
$('city-draft-chips').onclick = event => {
  const city = event.target.closest('[data-remove-city]')?.dataset.removeCity;
  if (!city || !cityDraft) return;
  cityDraft = cityDraft.filter(value => cityKey(value) !== cityKey(city)); renderCityPicker();
};
$('city-tabs').onclick = event => {
  const tab = event.target.closest('[data-city-tab]')?.dataset.cityTab;
  if (!tab) return; cityTab = tab; renderCityPicker(); $('city-picker-results').scrollTop = 0;
};
$('city-search').addEventListener('input', renderCityPicker);
$('clear-city-draft').onclick = () => { cityDraft = []; renderCityPicker(); };
$('confirm-city-picker').onclick = () => { setCities(cityDraft); $('city-picker').close(); };
$('close-city-picker').onclick = $('cancel-city-picker').onclick = () => $('city-picker').close();
$('city-picker').addEventListener('close', () => { cityDraft = null; });
// Escape closes the inner picker first, retaining the BOSS settings overlay.
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('city-picker').open) {
    event.preventDefault(); event.stopPropagation(); $('city-picker').close();
  }
}, true);
async function call(type, extra = {}) {
  if (!installed) throw new Error('这是界面预览，请在 Edge 中加载扩展后操作');
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || '后台无响应');
  return result.data;
}
function notify(message, error = false) {
  $('notice').hidden = false;
  $('notice').classList.toggle('error', error);
  $('notice').textContent = message;
}
function readTitleGroupEntries() {
  return [...$('title-group-list').children].map((row, index) => ({
    number: index + 1,
    enabled: row.dataset.enabled !== 'false',
    terms: C.normalizeTitleGroups([[...row.querySelectorAll('[data-title-term]')].map(input => input.value)])[0] || []
  })).filter(entry => entry.terms.length);
}
function readTitleGroups() {
  return readTitleGroupEntries().map(entry => entry.terms);
}
function titleRuleChanged() {
  $('title-group-list').dispatchEvent(new Event('input', { bubbles: true }));
}
function labelTitleGroups() {
  [...$('title-group-list').children].forEach((row, index) => {
    const enabled = row.dataset.enabled !== 'false';
    row.classList.toggle('is-disabled', !enabled);
    row.querySelector('legend').textContent = '第 ' + (index + 1) + ' 组 · ' + (enabled ? '组内全部满足' : '已停用');
    const toggle = row.querySelector('[data-toggle-title-group]');
    toggle.textContent = enabled ? '停用组' : '启用组';
    toggle.setAttribute('aria-label', (enabled ? '停用' : '启用') + '第 ' + (index + 1) + ' 组');
    toggle.setAttribute('aria-pressed', String(!enabled));
    row.querySelector('[data-remove-group]').setAttribute('aria-label', '删除第 ' + (index + 1) + ' 组');
    row.querySelectorAll('[data-title-term]').forEach((input, termIndex) => {
      input.setAttribute('aria-label', '第 ' + (index + 1) + ' 组关键词 ' + (termIndex + 1));
      input.nextElementSibling.setAttribute('aria-label', '移除第 ' + (index + 1) + ' 组关键词 ' + (termIndex + 1));
    });
  });
}
function addTitleTerm(row, value = '') {
  const term = document.createElement('span'); term.className = 'title-keyword';
  const input = document.createElement('input'); input.type = 'text'; input.dataset.titleTerm = '';
  input.value = value; input.placeholder = '关键词';
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
  remove.onclick = () => {
    const next = term.nextElementSibling?.querySelector('input') || term.previousElementSibling?.querySelector('input');
    term.remove();
    if (!row.querySelector('[data-title-term]')) addTitleTerm(row);
    labelTitleGroups(); titleRuleChanged(); (next || row.querySelector('[data-title-term]')).focus();
  };
  term.append(input, remove); row.querySelector('.title-group-terms').append(term);
  return input;
}
function addTitleGroup(terms = [''], enabled = true) {
  const row = document.createElement('fieldset'); row.className = 'title-group-row';
  row.dataset.enabled = String(enabled);
  const legend = document.createElement('legend');
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button title-group-remove';
  remove.dataset.removeGroup = ''; remove.textContent = '删除组';
  const controls = document.createElement('div'); controls.className = 'title-group-controls';
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'text-button'; toggle.dataset.toggleTitleGroup = '';
  toggle.onclick = () => { row.dataset.enabled = String(row.dataset.enabled === 'false'); labelTitleGroups(); titleRuleChanged(); };
  controls.append(toggle, remove);
  const list = document.createElement('div'); list.className = 'title-group-terms';
  const add = document.createElement('button'); add.type = 'button'; add.className = 'text-button title-term-add'; add.textContent = '＋ 关键词';
  add.onclick = () => { const input = addTitleTerm(row); labelTitleGroups(); titleRuleChanged(); input.focus(); };
  remove.onclick = () => {
    row.remove(); labelTitleGroups(); titleRuleChanged();
    ($('title-group-list').querySelector('[data-title-term]') || $('add-title-group')).focus();
  };
  row.append(legend, controls, list, add); $('title-group-list').append(row);
  for (const term of terms.length ? terms : ['']) addTitleTerm(row, term);
  labelTitleGroups(); return row;
}
function renderTitleRule() {
  const storedEntries = readTitleGroupEntries(), entries = storedEntries.filter(entry => entry.enabled), groups = entries.map(entry => entry.terms), all = $('titleMode').value === 'all';
  $('title-mode-hint').textContent = all ? '所有启用组都要满足；每组内仍要求全部关键词同时出现。' : '满足任意一整组即可；不同组里的词不能拼在一起通过。停用组不参与匹配。';
  $('clear-title-groups').hidden = !storedEntries.length;
  const preview = $('title-rule-preview'); preview.replaceChildren();
  if (!groups.length) preview.textContent = storedEntries.length ? '所有关键词组已停用 · 不匹配任何岗位。启用至少一组，或清空所有组以不限标题。' : '未设置关键词组 · 不限标题。空白关键词和空白组不参与匹配。';
  groups.forEach((group, index) => {
    if (index) preview.append(element('span', 'title-rule-join', all ? '并且' : '或者'));
    const box = element('span', 'title-rule-group');
    group.forEach((term, termIndex) => {
      if (termIndex) box.append(element('span', 'title-rule-and', '＋'));
      box.append(element('span', '', term));
    });
    preview.append(box);
  });
  const title = $('title-test-input').value.trim(), result = $('title-test-result');
  result.classList.remove('matches', 'misses');
  if (!title) { result.textContent = '输入标题，检查是否满足当前关键词组。'; return; }
  const match = C.titleKeywordRule(title, { titleGroupRules: storedEntries.map(({ terms, enabled }) => ({ terms, enabled })), titleMode: all ? 'all' : 'any' });
  result.classList.add(match ? 'matches' : 'misses');
  const hits = entries.filter(entry => entry.terms.every(term => C.keywordHit(title, term))).map(entry => entry.number);
  result.textContent = !groups.length ? (storedEntries.length ? '未通过标题筛选 · 所有关键词组已停用' : '标题不限 · 通过标题筛选') : match ? '通过标题筛选 · 满足第 ' + hits.join('、') + ' 组' : '未通过标题筛选 · ' + (all ? '需要满足所有启用组' : '没有满足任何一整组');
}
function populateTitleGroups(groups) {
  populateTitleGroupRules(groups.map(terms => ({ terms, enabled: true })));
}
function populateTitleGroupRules(rules) {
  $('title-group-list').replaceChildren();
  for (const rule of rules.length ? rules : [{ terms: [], enabled: true }]) addTitleGroup(rule.terms, rule.enabled);
  renderTitleRule();
}
$('add-title-group').onclick = () => { const row = addTitleGroup(); titleRuleChanged(); row.querySelector('input').focus(); };
$('clear-title-groups').onclick = () => { populateTitleGroups([]); titleRuleChanged(); $('title-group-list').querySelector('input').focus(); };
$('title-group-list').addEventListener('input', renderTitleRule);
$('titleMode').addEventListener('change', renderTitleRule);
$('title-test-input').addEventListener('input', renderTitleRule);
$('title-test-input').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
function readBlockedWords() {
  return C.words([...$('blocked-word-list').querySelectorAll('[data-blocked-word]')].map(input => input.value).join(','));
}
function syncBlockedWords() {
  $('blockedWords').value = readBlockedWords().join(',');
  $('blocked-word-list').querySelectorAll('[data-blocked-word]').forEach((input, index) => {
    input.setAttribute('aria-label', '屏蔽词 ' + (index + 1));
    input.nextElementSibling.setAttribute('aria-label', '移除屏蔽词 ' + (index + 1));
  });
}
function blockedWordsChanged() {
  syncBlockedWords();
  $('blockedWords').dispatchEvent(new Event('input', { bubbles: true }));
}
function addBlockedWord(value = '') {
  const term = document.createElement('span'); term.className = 'title-keyword';
  const input = document.createElement('input'); input.type = 'text'; input.dataset.blockedWord = '';
  input.value = value; input.placeholder = '屏蔽词';
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
  remove.onclick = () => {
    const next = term.nextElementSibling?.querySelector('input') || term.previousElementSibling?.querySelector('input');
    term.remove();
    if (!$('blocked-word-list').children.length) addBlockedWord();
    blockedWordsChanged(); (next || $('blocked-word-list').querySelector('input')).focus();
  };
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault(); $('add-blocked-word').click();
  });
  term.append(input, remove); $('blocked-word-list').append(term);
  return input;
}
function populateBlockedWords(words) {
  $('blocked-word-list').replaceChildren();
  for (const word of words.length ? words : ['']) addBlockedWord(word);
  syncBlockedWords();
}
$('blocked-word-list').addEventListener('input', syncBlockedWords);
$('add-blocked-word').onclick = () => { const input = addBlockedWord(); blockedWordsChanged(); input.focus(); };
const greetingEditor = GreetingEditor.create({ editor: $('greeting-editor'), input: $('greetingTemplate'), bindButton: $('bind-greeting-city'), hint: $('greeting-selection-hint') });
let greetingPreviewEdited = false;
function renderGreetingAssistance() {
  const cities = selectedCities().map(cityKey);
  const words = [...new Set([...cities, ...cityData.cities])].filter(word => greetingEditor.hasText(word)).slice(0, 3);
  const area = $('greeting-city-shortcuts'); area.replaceChildren();
  if (words.length) {
    const label = document.createElement('span'); label.textContent = '也可直接点选：'; area.append(label);
    for (const word of words) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'greeting-city-shortcut';
      button.textContent = word + ' → 岗位城市'; button.dataset.cityWord = word;
      button.title = '绑定文案中首处未绑定的“' + word + '”；也可自行框选其他位置';
      button.onclick = () => greetingEditor.bindText(word); area.append(button);
    }
  }
  area.hidden = !words.length;
  const count = greetingEditor.originals().length;
  $('greeting-binding-state').textContent = count ? '已绑定 ' + count + ' 处地区，将按当前岗位城市替换。点标签 × 可恢复原文字。' : '尚未绑定地区；文案中的城市仍是固定文字。框选文字或点击上方快捷入口后再保存。';
  $('greeting-binding-state').classList.toggle('is-bound', count > 0);
  if (!greetingPreviewEdited && cities.length) {
    const original = greetingEditor.originals()[0] || words[0];
    $('greeting-preview-location').value = cities.find(city => city !== original) || cities[0];
  }
  renderGreetingPreview();
}
function renderGreetingPreview() {
  try {
    $('greeting-preview').textContent = C.template({ title: 'Java 开发实习生', company: '示例科技公司', location: $('greeting-preview-location').value }, { greetingTemplate: $('greetingTemplate').value });
    $('greeting-preview').classList.remove('problem');
  } catch (error) { $('greeting-preview').textContent = error.message; $('greeting-preview').classList.add('problem'); }
}
function renderGreetingMode() {
  const custom = $('greetingMode').value === 'custom';
  $('custom-greeting-fields').hidden = !custom;
  $('greetingTemplate').disabled = !custom;
  $('greetingTemplate').required = false;
  greetingEditor.sync(); greetingEditor.enable(custom);
  $('greeting-length').textContent = $('greetingTemplate').value.length + ' / 300 字';
  $('greeting-mode-hint').textContent = custom
    ? '自定义模式：原列表核对岗位并发起沟通，使用真实入口在独立聊天页发送。确认成功后继续原队列；发送中、失败时停下核实。检测到 BOSS 已自动发出招呼时停止，并提示关闭自动招呼。'
    : '只发送 BOSS 默认招呼：筛选通过后点击「立即沟通」，看到发送成功提示后选择「留在此页」。';
  renderGreetingAssistance();
}
$('greetingMode').addEventListener('change', renderGreetingMode);
$('greetingTemplate').addEventListener('input', renderGreetingMode);
$('greeting-preview-location').addEventListener('input', () => { greetingPreviewEdited = true; renderGreetingPreview(); });
$('reset-speed').onclick = () => {
  for (const key of ['browseIntervalSeconds', 'intervalSeconds']) {
    $(key).value = C.DEFAULTS[key];
    $(key).dispatchEvent(new Event('input', { bubbles: true }));
  }
};
function populate(c) {
  c = C.config(c);
  greetingPreviewEdited = false;
  for (const key of Object.keys(C.DEFAULTS)) {
    const el = $(key); if (!el) continue;
    if (Array.isArray(c[key])) el.querySelectorAll('input').forEach(x => { x.checked = c[key].includes(x.value); });
    else if (el.type === 'checkbox') el.checked = c[key];
    else el.value = c[key];
  }
  populateTitleGroupRules(C.effectiveTitleGroupRules(c));
  populateBlockedWords(C.words(c.blockedWords));
  greetingEditor.set(c.greetingTemplate, c.greetingCityOriginals);
  renderGreetingMode();
  updateSalaryPreview();
  renderCities();
}
function readConfig() {
  const result = {};
  for (const [key, fallback] of Object.entries(C.DEFAULTS)) {
    const el = $(key); if (!el) continue;
    if (Array.isArray(fallback)) result[key] = [...el.querySelectorAll('input:checked')].map(x => x.value);
    else if (typeof fallback === 'boolean') result[key] = el.checked;
    else if (typeof fallback === 'number') result[key] = Number(el.value);
    else result[key] = el.value;
  }
  result.titleGroups = readTitleGroups();
  result.titleGroupRules = readTitleGroupEntries().map(({ terms, enabled }) => ({ terms, enabled }));
  // Retain a text fallback for older versions; current matching uses the explicit groups.
  result.titleKeywords = result.titleGroupRules.filter(rule => rule.enabled).map(rule => rule.terms.join(' ')).join(',');
  result.blockedWords = readBlockedWords().join(',');
  result.blockedGroups = null;
  result.blockedMode = 'any';
  result.greetingCityOriginals = greetingEditor.originals();
  if (result.greetingMode === 'custom' && !result.greetingTemplate.trim()) throw new Error('请填写自定义消息');
  if (result.salaryMax && result.salaryMin > result.salaryMax) throw new Error('最低月薪不能高于最高月薪');
  return C.config(result);
}
function updateSalaryPreview() {
  $('salary-preview').textContent = '例如 180–210 元/天 → ' + C.monthlySalary('180-210元/天', $('salaryWorkDays').value).label;
}
$('salaryWorkDays').addEventListener('input', updateSalaryPreview);
$('config-form').addEventListener('input', event => { if (['title-test-input', 'greeting-preview-location'].includes(event.target.id)) return; dirty = true; $('save-config').textContent = '保存配置'; });
$('config-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('save-config');
  try {
    if (!installed) throw new Error('请在 Edge 中加载扩展后保存');
    const c = readConfig();
    button.disabled = true;
    await call('SAVE_CONFIG', { config: c });
    dirty = false;
    button.textContent = '已保存 ✓';
    notify('配置已保存。关闭设置后，从页面右下角开始分析或自动打招呼。');
  } catch (e) { notify(e.message, true); }
  finally { button.disabled = false; }
});
const titles = { rules: ['筛选与投递', '先筛选，再沟通。空白条件表示不限。'], schedules: ['定时投递', '设置几点开始、投多少，到点自动执行。'], records: ['投递记录', '查看筛选结果和消息发送状态。'] };
async function selectTab(tab) {
  if (!titles[tab]) tab = 'rules';
  for (const el of document.querySelectorAll('.tab-panel')) el.hidden = el.id !== tab;
  document.querySelectorAll('.nav-item').forEach(el => { el.classList.toggle('selected', el.dataset.tab === tab); el.setAttribute('aria-current', el.dataset.tab === tab ? 'page' : 'false'); });
  $('config-form').hidden = tab !== 'rules';
  $('page-title').textContent = titles[tab][0]; $('page-subtitle').textContent = titles[tab][1];
  history.replaceState(null, '', '#' + tab);
  window.scrollTo(0, 0);
  if (tab === 'records') await refreshRecords();
  if (tab === 'schedules') await window.QutouScheduleUI?.refresh();
}
document.querySelectorAll('.nav-item').forEach(el => { el.onclick = () => selectTab(el.dataset.tab); });
$('compact-window').onclick = () => call('OPEN_SETTINGS').catch(e => notify(e.message, true));
const statuses = { draft: '消息草稿，未发送', preview: '仅分析', sent: '确认已发送', filtered: '已过滤', skipped: '已跳过', review: '待人工确认', uncertain: '发送待核实', error: '错误', communication_requested: '沟通尝试', already_contacted: '已沟通，跳过' };
function element(tag, className, value) { const el = document.createElement(tag); if (className) el.className = className; if (value) el.textContent = value; return el; }
function renderRecords() {
  const filter = $('record-filter').value;
  const results = C.displayRecords(records);
  const visible = results.filter(r => filter === 'all' || r.status === filter);
  $('record-stats').textContent = '显示 ' + visible.length + ' / ' + results.length + ' 条岗位结果 · 同一轮草稿与发送过程已合并 · 原始记录 ' + records.length + ' 条，可导出 CSV';
  const list = $('record-list'); list.replaceChildren();
  if (!visible.length) {
    const empty = element('div', 'empty-state');
    empty.append(element('h2', '', '暂无记录'), element('p', '', '在 BOSS 职位列表打开扩展，运行「仅分析岗位」。'));
    list.append(empty); return;
  }
  for (const r of visible.slice(0, 200)) {
    const card = element('article', 'record-card');
    const head = element('div', 'record-head');
    const link = element('a', '', r.job.title || '未知岗位');
    if (C.jobIdentity(r.job.url)) { link.href = r.job.url; link.target = '_blank'; link.rel = 'noreferrer'; }
    head.append(link, element('span', 'badge' + (['error', 'uncertain', 'review'].includes(r.status) ? ' problem' : ''), r.status === 'sent' && r.deliveryKind ? (r.deliveryKind === 'boss_default' ? 'BOSS 招呼已发送' : '自定义消息已发送') : statuses[r.status] || r.status));
    card.append(head, element('p', 'record-meta', [r.job.company, r.job.location, r.job.education, r.job.experience].filter(Boolean).join(' · ')), element('p', 'record-meta', new Date(r.time).toLocaleString('zh-CN') + (r.analysis?.score != null ? ' · 匹配分 ' + r.analysis.score : '')));
    const displaySalary = /[\uE000-\uF8FF\uFFFD]/.test(r.job.salary || '') ? (r.job.salarySource ? '' : '旧记录：') + '薪资字体编码未解析' : r.job.salary;
    const details = [displaySalary, r.job.monthlySalary?.label, r.job.hrActivity && 'HR：' + r.job.hrActivity].filter(Boolean);
    if (details.length) card.append(element('p', 'record-meta', details.join(' · ')));
    card.append(element('p', 'record-reason', [r.reason, ...(r.analysis?.reasons || [])].filter(Boolean).join('；')));
    if (r.analysis?.evidence?.length) card.append(element('div', 'record-evidence', 'JD 原文：' + r.analysis.evidence.join(' / ')));
    if (r.greeting) {
      if (r.status === 'preview' && r.analysis?.greeting) card.append(element('p', 'hint', '消息预览 · 未发送'));
      else if (r.status !== 'sent') card.append(element('p', 'hint', '拟发送文案 · 尚未确认发送'));
      card.append(element('div', 'record-greeting', r.greeting));
    }
    if (r.observedGreeting) card.append(element('p', 'record-evidence', '检测到的已有消息：' + r.observedGreeting));
    list.append(card);
  }
  if (visible.length > 200) list.append(element('p', 'hint', '当前展示最近 200 条。导出 CSV 可查看全部记录。'));
}
async function refreshRecords() {
  try { records = installed ? await call('GET_RECORDS') : []; renderRecords(); }
  catch (e) { notify(e.message, true); }
}
$('record-filter').onchange = renderRecords;
$('refresh-records').onclick = refreshRecords;
$('export-records').onclick = async () => {
  await refreshRecords();
  if (!records.length) { notify('暂无可导出的记录'); return; }
  const blob = new Blob([C.csv(records)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'qu投-投递记录-' + new Date().toISOString().slice(0, 10) + '.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('clear-records').onclick = async () => {
  if (!confirm('清空全部投递记录？去重记录也会清除，历史岗位可能再次沟通。')) return;
  try { await call('CLEAR_RECORDS'); await refreshRecords(); notify('记录已清空'); }
  catch (e) { notify(e.message, true); }
};
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
(async () => {
  try { populate(installed ? await call('GET_CONFIG') : C.config()); }
  catch (e) { populate(C.config()); notify(e.message, true); }
  if (!installed) notify('界面预览模式。要保存配置和投递，请在 Edge 扩展管理页加载此文件夹。');
  $('compact-window').hidden = true;
  if (window.parent !== window) {
    document.documentElement.classList.add('embedded-settings');
    document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); selectTab('rules'); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') window.parent.postMessage({ type: 'ZHIXIANG_CLOSE_SETTINGS' }, 'https://www.zhipin.com'); });
  }
  await selectTab(location.hash.slice(1) || 'rules');
})();
