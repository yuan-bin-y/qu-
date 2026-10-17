(function () {
  'use strict';
  const S = BossSourcePlans;
  let catalog = { entries: [], cities: {} }, loaded = false;
  const choiceKey = e => (e.id || '') + '|' + S.key(e.label);
  function button(label, fn, className = 'secondary') {
    const b = element('button', className, label); b.type = 'button';
    b.onclick = async () => { b.disabled = true; try { await fn(); } catch (error) { notify(error.message, true); } finally { b.disabled = false; } }; return b;
  }
  async function load() {
    if (!loaded && installed) { catalog = (await call('GET_SOURCE_PLANS')).catalog; loaded = true; }
    return catalog;
  }
  function editor(link, apply) {
    const root = element('div', 'link-condition-editor'), fields = element('div', 'fields two-col');
    let info; try { info = S.conditionsFor(link, catalog); } catch { info = { entry: { id: 'recommend', label: '推荐', mode: 'recommend' }, city: '', jobType: '', degree: '', keyword: '' }; }
    const label = (caption, input, full = false) => { const l = element('label', full ? 'full' : '', caption); l.append(input); return l; };
    const select = options => { const s = document.createElement('select'); for (const o of options) { const el = element('option', '', o.label); el.value = o.value; s.append(el); } return s; };
    const entrySelect = document.createElement('select');
    let entries = [], selectedKey = choiceKey(info.entry);
    function fillEntries(previous = null) {
      entries = [...(catalog.entries || [])];
      if (!entries.some(e => e.id === 'recommend')) entries.unshift({ id: 'recommend', label: '推荐', mode: 'recommend' });
      if (info.entry.id !== 'recommend' && !entries.some(e => S.key(e.label) === S.key(info.entry.label))) entries.push(info.entry);
      const byName = previous && entries.filter(e => S.key(e.label) === S.key(previous.label));
      if (byName?.length === 1) selectedKey = choiceKey(byName[0]);
      else if (previous && !entries.some(e => choiceKey(e) === selectedKey)) entries.push(previous);
      entrySelect.replaceChildren(...entries.map(e => { const o = element('option', '', e.label); o.value = choiceKey(e); return o; }));
      const manual = element('option', '', '粘贴求职期望链接'); manual.value = 'manual'; entrySelect.append(manual);
      entrySelect.value = [...entrySelect.options].some(o => o.value === selectedKey) ? selectedKey : 'recommend|推荐';
    }
    fillEntries();
    const refresh = button('刷新求职期望', async () => {
      selectedKey = entrySelect.value; const previous = entries.find(e => choiceKey(e) === selectedKey); catalog = await call('REFRESH_SOURCE_CATALOG'); loaded = true; fillEntries(previous); updateBase();
      notify('已读取 ' + catalog.entries.length + ' 个求职入口，选择后生成链接');
    });
    const entryRow = element('div', 'source-entry-row'); entryRow.append(entrySelect, refresh); fields.append(label('求职期望', entryRow, true));
    const base = document.createElement('input'); base.type = 'url'; base.placeholder = '粘贴这个求职期望对应的职位列表地址'; base.value = link.sourceUrl || '';
    const baseLabel = label('求职期望入口链接', base, true);
    fields.append(baseLabel);
    const city = document.createElement('input'); city.value = info.city; city.placeholder = '例如：杭州；留空表示全国'; city.setAttribute('list', 'link-city-options');
    const type = select(S.jobTypes); type.value = info.jobType;
    const degree = select(S.degrees); degree.value = info.degree;
    const keyword = document.createElement('input'); keyword.value = info.keyword || ''; keyword.maxLength = 80; keyword.placeholder = '可选，例如 Java';
    fields.append(label('城市', city), label('求职类型', type), label('学历要求', degree), label('搜索关键词（可选）', keyword)); root.append(fields);
    function updateBase() {
      selectedKey = entrySelect.value; baseLabel.hidden = selectedKey !== 'manual';
      if (!baseLabel.hidden && !base.value) base.value = link.sourceUrl || '';
    }
    entrySelect.onchange = updateBase; updateBase();
    root.append(element('p', 'hint', '入口名称和标识随任务保存。执行时先点击「推荐 / 对应求职期望」，再设置城市等条件；BOSS 地址相同也可以对应不同入口。'));
    const applyButton = button('生成并应用链接', () => {
      const selected = entrySelect.value === 'manual' ? null : entries.find(e => choiceKey(e) === entrySelect.value);
      const generated = S.generateLink({ entry: selected, baseUrl: selected ? selected.url || S.BASE : base.value.trim(), city: city.value.trim(), jobType: type.value, degree: degree.value, keyword: keyword.value.trim() }, catalog);
      apply(generated); notify('链接和右上角注释已更新，保存定时任务后生效');
    }, 'primary');
    root.append(applyButton); return root;
  }
  function cityOptions() {
    const list = document.createElement('datalist'); list.id = 'link-city-options';
    for (const name of [...new Set([...Object.keys(BossCityCodes), ...Object.keys(catalog.cities || {})])].sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
      const option = document.createElement('option'); option.value = name; list.append(option);
    }
    return list;
  }
  window.QutouLinkBuilder = { load, editor, cityOptions, get catalog() { return catalog; } };
})();
