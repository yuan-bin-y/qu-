(function () {
  'use strict';
  const S = BossSourcePlans;
  let tasks = [], links = [], loading = false, edited = false;
  const repeatNames = { once: '仅一次', daily: '每天', weekdays: '周一至周五' };
  const states = { starting: '准备启动', running: '投递中', paused: '已暂停', stopping: '正在停止', completed: '本轮结束', error: '未完成', skipped: '已跳过', missed: '已错过', stopped: '已停止', interrupted: '已中断' };
  const dateText = stamp => stamp ? new Date(stamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '无后续计划';
  const blank = () => ({ id: crypto.randomUUID(), sourceUrl: '', note: '', targetJobs: 5, enabled: true, autoNote: true });
  function total() {
    const enabled = links.filter(link => link.enabled);
    $('schedule-target').value = enabled.reduce((n, link) => n + (Number(link.targetJobs) || 0), 0);
    $('schedule-links-count').textContent = enabled.length + ' 条启用 / 共 ' + links.length + ' 条';
  }
  function repeatChanged() { $('schedule-date-field').hidden = $('schedule-repeat').value !== 'once'; $('schedule-date').required = $('schedule-repeat').value === 'once'; }
  function reset() {
    const soon = new Date(Date.now() + 5 * 60000), pad = n => String(n).padStart(2, '0');
    $('schedule-form').reset(); $('schedule-id').value = '';
    $('schedule-time').value = pad(soon.getHours()) + ':' + pad(soon.getMinutes());
    $('schedule-date').value = soon.getFullYear() + '-' + pad(soon.getMonth() + 1) + '-' + pad(soon.getDate());
    $('schedule-form-title').textContent = '添加定时任务'; $('save-schedule').textContent = '保存定时任务';
    $('schedule-refresh-config-row').hidden = true; links = [blank()]; edited = false; repeatChanged(); renderLinks();
  }
  function action(label, className, fn) {
    const b = element('button', className, label); b.type = 'button';
    b.onclick = async () => { b.disabled = true; try { await fn(); } catch (error) { notify(error.message, true); } finally { b.disabled = false; } }; return b;
  }
  function annotate(link) {
    try { if (link.autoNote !== false) link.note = S.describe(S.conditionsFor(link, QutouLinkBuilder.catalog)); } catch { if (link.autoNote !== false) link.note = ''; }
  }
  function renderLinks() {
    const list = $('schedule-links'); list.replaceChildren();
    list.append(QutouLinkBuilder.cityOptions());
    links.forEach((link, index) => {
      const row = element('article', 'schedule-link-row' + (link.enabled ? '' : ' is-disabled'));
      const head = element('div', 'schedule-link-head');
      const annotation = document.createElement('input'); annotation.className = 'link-annotation'; annotation.value = link.note || ''; annotation.maxLength = 200; annotation.placeholder = '条件注释（自动生成，可修改）'; annotation.setAttribute('aria-label', '第 ' + (index + 1) + ' 条链接注释'); annotation.title = link.note || '';
      annotation.oninput = () => { link.note = annotation.value; link.autoNote = false; annotation.title = annotation.value; edited = true; };
      head.append(element('strong', '', '链接 ' + (index + 1)), annotation); row.append(head);
      const url = document.createElement('textarea'); url.rows = 2; url.value = link.sourceUrl; url.className = 'schedule-link-url'; url.placeholder = '粘贴 BOSS 职位列表链接，或展开下方条件生成'; url.setAttribute('aria-label', '第 ' + (index + 1) + ' 条职位列表链接');
      const open = element('a', 'link-open', '打开链接 ↗'); open.target = '_blank'; open.rel = 'noreferrer';
      function syncUrl() {
        const parsed = S.listUrl(link.sourceUrl);
        if (parsed) { open.href = parsed.href; open.removeAttribute('aria-disabled'); } else { open.removeAttribute('href'); open.setAttribute('aria-disabled', 'true'); }
        annotation.value = link.note || ''; annotation.title = link.note || '';
      }
      url.oninput = () => { link.sourceUrl = url.value.trim(); for (const field of ['conditions', 'entry', 'city', 'cityCode', 'jobType', 'degree', 'keyword']) delete link[field]; annotate(link); syncUrl(); edited = true; }; row.append(url);
      const feedback = element('p', 'hint link-open-status'); feedback.hidden = true; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
      let opening = false;
      open.onclick = async event => {
        if (!installed) return;
        event.preventDefault();
        if (opening) return;
        opening = true; feedback.hidden = false; feedback.textContent = '正在打开并切换求职期望和筛选条件…';
        try { await call('OPEN_SCHEDULE_LINK', { link }); feedback.textContent = '已按保存条件打开职位列表，尚未开始投递。'; notify('已按保存条件打开职位列表'); }
        catch (error) { feedback.textContent = '链接未就绪：' + error.message; notify(error.message, true); }
        finally { opening = false; }
      };
      const controls = element('div', 'schedule-link-controls'), quota = document.createElement('input'); quota.type = 'number'; quota.min = '1'; quota.max = '100'; quota.step = '1'; quota.value = link.targetJobs; quota.className = 'link-quota'; quota.setAttribute('aria-label', '第 ' + (index + 1) + ' 条链接投递人数');
      quota.oninput = () => { link.targetJobs = Number(quota.value); edited = true; total(); };
      const quotaLabel = element('label', 'link-quota-label', '投递人数'); quotaLabel.append(quota);
      const toggle = element('label', 'check-row'), enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = link.enabled;
      enabled.onchange = () => { link.enabled = enabled.checked; row.classList.toggle('is-disabled', !link.enabled); edited = true; total(); };
      toggle.append(enabled, document.createTextNode('启用')); controls.append(quotaLabel, toggle, open);
      const move = delta => { [links[index], links[index + delta]] = [links[index + delta], links[index]]; edited = true; renderLinks(); };
      const up = action('↑', 'text-button', () => move(-1)); up.disabled = index === 0; up.setAttribute('aria-label', '上移第 ' + (index + 1) + ' 条链接');
      const down = action('↓', 'text-button', () => move(1)); down.disabled = index === links.length - 1; down.setAttribute('aria-label', '下移第 ' + (index + 1) + ' 条链接');
      const remove = action('删除', 'danger-text', () => { links.splice(index, 1); if (!links.length) links.push(blank()); edited = true; renderLinks(); });
      controls.append(up, down, remove); row.append(controls, feedback);
      const details = element('details', 'link-generator'), summary = element('summary', '', '按条件生成链接');
      const body = document.createElement('div'); details.append(summary, body);
      details.ontoggle = () => { if (details.open) body.replaceChildren(QutouLinkBuilder.editor(link, generated => {
        link.sourceUrl = generated.sourceUrl; link.conditions = generated.conditions; link.note = generated.note; link.autoNote = true; url.value = generated.sourceUrl; syncUrl(); details.open = false; edited = true;
      })); };
      row.append(details, action('使用当前职位页', 'text-button link-capture', async () => {
        const current = await call('GET_SCHEDULE_SOURCE'); link.sourceUrl = current.url; link.conditions = current.conditions; link.autoNote = true; annotate(link); url.value = link.sourceUrl; syncUrl(); details.open = false; edited = true; notify('已保存当前页面的求职入口和条件，可修改注释和投递人数');
      }));
      syncUrl(); list.append(row);
    });
    total();
  }
  function edit(task) {
    $('schedule-id').value = task.id; $('schedule-time').value = task.time; $('schedule-date').value = task.date;
    $('schedule-repeat').value = task.repeat; $('schedule-enabled').checked = task.enabled;
    if (task.links?.length) links = structuredClone(task.links).map(l => ({ ...l, autoNote: false }));
    else {
      const previous = task.legacyLinks || [{ sourceUrl: task.sourceUrl, note: '原职位页', enabled: true }];
      const active = previous.filter(l => l.enabled !== false).length || 1;
      let remaining = task.targetJobs;
      links = previous.map(l => {
        const quota = Math.min(remaining, Math.max(1, Math.floor(task.targetJobs / active)));
        if (l.enabled !== false) remaining -= quota;
        return { ...blank(), ...l, targetJobs: Math.max(1, quota), enabled: l.enabled !== false && quota > 0, autoNote: false };
      });
      const first = links.find(l => l.enabled); if (first && remaining > 0) first.targetJobs += remaining;
      if (previous.length > 1) notify('旧任务原来共用目标，已将 ' + task.targetJobs + ' 人分配到链接草稿；请检查人数后保存');
    }
    $('schedule-refresh-config').checked = false; $('schedule-refresh-config-row').hidden = false;
    $('schedule-form-title').textContent = '编辑定时任务'; $('save-schedule').textContent = '保存修改';
    edited = false; repeatChanged(); renderLinks(); $('schedule-form-title').scrollIntoView({ block: 'center' });
  }
  function render() {
    const ordered = [...tasks].sort((a, b) => (a.enabled ? a.nextRunAt : Infinity) - (b.enabled ? b.nextRunAt : Infinity));
    const next = ordered.find(t => t.enabled && t.nextRunAt);
    $('schedule-next').textContent = next ? '下次 ' + dateText(next.nextRunAt) + ' · 合计投递 ' + next.targetJobs + ' 人' : '暂无已启用的定时任务';
    const list = $('schedule-list'); list.replaceChildren();
    if (!ordered.length) { const empty = element('div', 'empty-state'); empty.append(element('h2', '', '安排下一轮投递'), element('p', '', '添加链接并设置各自人数，再保存执行时间。')); list.append(empty); return; }
    for (const task of ordered) {
      const card = element('article', 'card schedule-card' + (task.enabled ? '' : ' is-disabled'));
      const header = element('div', 'schedule-card-head'), timing = element('div', 'schedule-timing');
      timing.append(element('strong', 'schedule-clock', task.time), element('span', 'schedule-repeat', repeatNames[task.repeat] + (task.repeat === 'once' ? ' · ' + task.date : '')));
      const target = element('div', 'schedule-target'); target.append(element('strong', '', String(task.targetJobs)), element('span', '', ' 人 / 轮')); header.append(timing, target); card.append(header);
      card.append(element('p', 'schedule-meta', task.enabled ? '下次执行：' + dateText(task.nextRunAt) : '已停用，保留任务设置'));
      for (const [i, link] of (task.links || task.legacyLinks || []).entries()) {
        const item = element('div', 'saved-schedule-link'), head = element('div', 'saved-link-head');
        head.append(element('span', '', '链接 ' + (i + 1) + (link.targetJobs ? ' · ' + link.targetJobs + ' 人' : ' · 共用目标') + (link.enabled === false ? ' · 已停用' : '')), element('span', 'saved-link-note', link.note || ''));
        const address = element('a', 'schedule-address', link.sourceUrl || '链接已失效'); if (S.listUrl(link.sourceUrl)) { address.href = link.sourceUrl; address.target = '_blank'; address.rel = 'noreferrer'; address.title = '按保存的求职期望和条件打开'; address.onclick = async event => { if (!installed) return; event.preventDefault(); try { await call('OPEN_SCHEDULE_LINK', { link }); notify('已按保存条件打开职位列表'); } catch (error) { notify(error.message, true); } }; }
        item.append(head, address); card.append(item);
      }
      if (task.lastRun) {
        const last = task.lastRun, result = element('div', 'schedule-result');
        result.append(element('strong', '', (states[last.status] || last.status) + ' · ' + dateText(last.startedAt || last.scheduledAt)), element('span', '', '成功 ' + (last.sent || 0) + ' / ' + (last.targetJobs || task.targetJobs) + '：' + (last.reason || ''))); card.append(result);
        for (const source of last.sourceResults || []) card.append(element('p', 'hint', source.name + '：' + (source.sent || 0) + (source.targetJobs ? ' / ' + source.targetJobs : '') + ' 人' + (source.reason ? ' · ' + source.reason : source.status === 'exhausted' ? ' · 岗位不足' : '')));
      }
      const actions = element('div', 'card-actions schedule-card-actions');
      actions.append(action('编辑', 'secondary', () => edit(task)), action(task.enabled ? '停用' : '启用', 'secondary', async () => { await call('TOGGLE_SCHEDULE', { id: task.id, enabled: !task.enabled }); await refresh(); }), action('删除', 'danger-text', async () => { await call('DELETE_SCHEDULE', { id: task.id }); if ($('schedule-id').value === task.id) reset(); await refresh(); })); card.append(actions); list.append(card);
    }
  }
  async function refresh() {
    if (loading) return; loading = true;
    try { await QutouLinkBuilder.load(); tasks = installed ? await call('GET_SCHEDULES') : []; render(); }
    catch (error) { notify(error.message, true); } finally { loading = false; }
  }
  $('schedule-repeat').onchange = repeatChanged; $('schedule-form').addEventListener('input', () => { edited = true; });
  $('reset-schedule').onclick = reset; $('refresh-schedules').onclick = refresh;
  $('add-schedule-link').onclick = () => { if (links.length >= 40) { notify('最多添加 40 条链接', true); return; } links.push(blank()); edited = true; renderLinks(); };
  $('schedule-form').addEventListener('submit', async event => {
    event.preventDefault(); const b = $('save-schedule'); b.disabled = true;
    try {
      if (dirty && (!$('schedule-id').value || $('schedule-refresh-config').checked)) throw Error('筛选与消息配置尚未保存，请先到「筛选与投递」保存配置');
      const normalized = S.normalizeLinks(links, QutouLinkBuilder.catalog);
      await call('SAVE_SCHEDULE', { schedule: { id: $('schedule-id').value || undefined, time: $('schedule-time').value, date: $('schedule-date').value, repeat: $('schedule-repeat').value, links: normalized.links, enabled: $('schedule-enabled').checked, useCurrentConfig: $('schedule-refresh-config').checked } });
      reset(); await refresh(); notify('定时任务已保存，每条链接按各自人数执行。电脑需唤醒、Edge 保持运行。');
    } catch (error) { notify(error.message, true); } finally { b.disabled = false; }
  });
  window.addEventListener('beforeunload', event => { if (edited) { event.preventDefault(); event.returnValue = ''; } });
  window.QutouScheduleUI = { refresh };
  reset();
  if (location.hash === '#schedules') void refresh();
  const timer = setInterval(() => { if (!$('schedules').hidden) void refresh(); }, 5000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
})();
