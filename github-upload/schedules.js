(function (scope) {
  'use strict';
  const PREFIX = 'qutou-schedule:';
  function nextTime(task, after = Date.now()) {
    if (!/^\d{2}:\d{2}$/.test(task.time || '')) throw Error('请设置开始时间');
    const [hour, minute] = task.time.split(':').map(Number);
    if (hour > 23 || minute > 59) throw Error('开始时间无效');
    if (task.repeat === 'once') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(task.date || '')) throw Error('请选择执行日期');
      const [y, m, d] = task.date.split('-').map(Number), date = new Date(y, m - 1, d, hour, minute);
      if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw Error('执行日期无效');
      return date.getTime() > after ? date.getTime() : 0;
    }
    const today = new Date(after);
    for (let day = 0; day < 8; day++) {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + day, hour, minute);
      if (date.getTime() > after && (task.repeat !== 'weekdays' || (date.getDay() > 0 && date.getDay() < 6))) return date.getTime();
    }
    return 0;
  }
  function create(env) {
    let tail = Promise.resolve(), launching = false, activeId = '', cancelled = false;
    const serial = fn => { const operation = tail.then(fn); tail = operation.catch(() => {}); return operation; };
    const read = async () => (await env.storage.get('schedules')).schedules || [];
    const write = tasks => env.storage.set({ schedules: tasks });
    const summary = task => ({ ...task, config: undefined, configSummary: { cities: task.config.cities || '不限城市', mode: task.config.greetingMode, groups: env.core.effectiveTitleGroups(task.config).length } });
    async function arm(task) {
      if (!env.alarms) return;
      await env.alarms.clear(PREFIX + task.id);
      if (task.enabled && task.nextRunAt) await env.alarms.create(PREFIX + task.id, { when: task.nextRunAt });
    }
    async function sourcePage(task) {
      const tabs = await env.tabs.query({ url: 'https://www.zhipin.com/web/geek/job*' });
      const key = address => { const u = new URL(address); u.hash = ''; return u.href; };
      let tab = tabs.filter(t => env.core.isJobListUrl(t.url) && key(t.url) === key(task.sourceUrl)).sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      if (!tab) tab = await env.tabs.create({ url: task.sourceUrl, active: false });
      const end = Date.now() + 20000;
      let reason = '职位列表尚未加载';
      while (Date.now() < end) {
        if (cancelled) throw Error('定时启动已取消');
        const current = await env.tabs.get(tab.id);
        if (!env.core.isJobListUrl(current.url)) {
          if (current.status === 'complete') throw Error('定时职位页需要登录，或已跳转到其他页面');
        } else if (current.status === 'complete') {
          try {
            await env.connect(tab.id);
            const response = await env.tabs.sendMessage(tab.id, { type: 'LIST_PROGRESS' });
            if (response?.ok && response.data.blocked) throw Error(response.data.blocked);
            if (response?.ok && response.data.ids.length && !response.data.loading) return tab.id;
            reason = response?.error || '职位列表尚未加载';
          } catch (error) {
            reason = error.message;
            if (/登录|验证|频繁|上限|限制/.test(reason)) throw error;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw Error(reason + '，本次定时任务未启动');
    }
    async function sourcesFor(task) {
      if (task.links?.length) return env.plans.normalizeLinks(task.links, await env.sources.catalog()).links.filter(link => link.enabled);
      if (!task.sourcePlanIds?.length) return [{ legacy: true, name: '原职位页', sourceUrl: task.sourceUrl }];
      const saved = await env.sources.list();
      const sources = task.sourcePlanIds.map(id => saved.find(p => p.id === id)).filter(p => p?.enabled);
      if (!sources.length) throw Error('任务选用的搜索方案已全部停用或删除，请编辑任务重新选择');
      return sources.map(source => ({ ...source, urlOnly: true }));
    }
    const api = {
      get launching() { return launching; },
      cancelPending() { if (launching) cancelled = true; },
      list: () => serial(async () => {
        const plans = env.sources ? await env.sources.list() : [];
        return (await read()).map(task => ({ ...summary(task), legacyLinks: task.links?.length ? undefined : task.sourcePlanIds?.length ? task.sourcePlanIds.map(id => plans.find(p => p.id === id)).filter(Boolean).map(p => ({ sourceUrl: p.sourceUrl, note: p.name, enabled: p.enabled })) : [{ sourceUrl: task.sourceUrl, note: '原职位页', enabled: true }], sourceNames: (task.sourcePlanIds || []).map(id => plans.find(p => p.id === id)?.name || '已删除的方案') }));
      }),
      save: input => serial(async () => {
        const tasks = await read(), previous = input.id && tasks.find(task => task.id === input.id);
        if (input.id && !previous) throw Error('定时任务已不存在，请刷新列表');
        if (!previous && tasks.length >= 20) throw Error('最多保存 20 条定时任务');
        const normalized = input.links !== undefined ? env.plans.normalizeLinks(input.links, await env.sources.catalog()) : null;
        const targetJobs = normalized ? normalized.total : Number(input.targetJobs);
        if (!Number.isInteger(targetJobs) || targetJobs < 1 || targetJobs > 100) throw Error('投递人数应为 1–100 的整数');
        if (!['once', 'daily', 'weekdays'].includes(input.repeat)) throw Error('请选择重复方式');
        const sourcePlanIds = normalized ? [] : [...new Set(Array.isArray(input.sourcePlanIds) ? input.sourcePlanIds : [])];
        if (sourcePlanIds.length) {
          const plans = await env.sources.list();
          if (sourcePlanIds.some(id => !plans.some(p => p.id === id))) throw Error('选用的方案已删除，请刷新后重新选择');
          if (!sourcePlanIds.some(id => plans.some(p => p.id === id && p.enabled))) throw Error('请启用至少一个选用的搜索方案');
        } else if (!normalized && !env.core.isJobListUrl(input.sourceUrl)) throw Error('请添加职位列表链接');
        const config = env.core.config(previous && !input.useCurrentConfig ? previous.config : await env.getConfig());
        if (config.greetingMode === 'custom' && !config.greetingTemplate.trim()) throw Error('请先保存自定义消息配置');
        const rules = env.core.effectiveTitleGroupRules(config);
        if (rules.length && !rules.some(rule => rule.enabled)) throw Error('请先启用至少一个标题关键词组');
        const task = { ...previous, id: previous?.id || crypto.randomUUID(), time: input.time, date: input.date || '', repeat: input.repeat, targetJobs, links: normalized?.links, sourcePlanIds, sourceUrl: normalized || sourcePlanIds.length ? '' : input.sourceUrl, config, enabled: input.enabled !== false, updatedAt: Date.now(), createdAt: previous?.createdAt || Date.now() };
        task.nextRunAt = task.enabled ? nextTime(task) : 0;
        if (task.enabled && !task.nextRunAt) throw Error('开始时间已过去，请选择未来时间');
        const next = previous ? tasks.map(item => item.id === task.id ? task : item) : [...tasks, task];
        await write(next); await arm(task); return summary(task);
      }),
      toggle(id, enabled) {
        if (!enabled && activeId === id) cancelled = true;
        return serial(async () => {
          const tasks = await read(), task = tasks.find(item => item.id === id);
          if (!task) throw Error('定时任务已不存在');
          const next = enabled ? nextTime(task) : 0;
          if (enabled && !next) throw Error('执行时间已过去，请编辑日期和时间');
          task.enabled = Boolean(enabled); task.nextRunAt = next;
          await write(tasks); await arm(task); return summary(task);
        });
      },
      remove(id) {
        if (activeId === id) cancelled = true;
        return serial(async () => { await write((await read()).filter(task => task.id !== id)); await env.alarms?.clear(PREFIX + id); return true; });
      },
      restore: (skipPast = false) => serial(async () => {
        if (!env.alarms) return;
        const tasks = await read(), now = Date.now();
        let changed = false;
        for (const task of tasks) {
          if (['starting', 'running'].includes(task.lastRun?.status) && !env.busy()) {
            task.lastRun = { ...task.lastRun, status: 'interrupted', reason: '浏览器或扩展曾中断，未自动重发', finishedAt: now }; changed = true;
          }
          if (!task.enabled) continue;
          if (skipPast && task.nextRunAt <= now) {
            task.lastRun = { status: 'missed', scheduledAt: task.nextRunAt, finishedAt: now, sent: 0, reason: '启动时已错过执行时间，本次不补投' };
            task.nextRunAt = nextTime(task, now); task.enabled = Boolean(task.nextRunAt); changed = true;
          }
          // A due alarm may have just woken this worker. Leave it to onAlarm.
          if (task.nextRunAt > now || !task.enabled) await arm(task);
        }
        if (changed) await write(tasks);
      }),
      onAlarm: alarm => serial(async () => {
        if (!alarm.name.startsWith(PREFIX)) return;
        await env.ready();
        const tasks = await read(), task = tasks.find(item => PREFIX + item.id === alarm.name);
        if (!task?.enabled || !task.nextRunAt || Math.abs(alarm.scheduledTime - task.nextRunAt) > 1000 || task.lastOccurrenceAt === task.nextRunAt) return;
        const occurrence = task.nextRunAt, now = Date.now();
        if (now < occurrence) return;
        task.lastOccurrenceAt = occurrence;
        task.nextRunAt = nextTime(task, now); task.enabled = Boolean(task.nextRunAt);
        task.lastRun = { status: 'starting', scheduledAt: occurrence, startedAt: now, sent: 0, targetJobs: task.targetJobs, reason: '正在准备职位列表' };
        if (now - occurrence > 120000 || env.busy()) {
          task.lastRun.status = now - occurrence > 120000 ? 'missed' : 'skipped';
          task.lastRun.reason = task.lastRun.status === 'missed' ? '已错过执行时间超过 2 分钟，本次不补投' : '已有投递任务运行或暂停，本次定时已跳过';
          task.lastRun.finishedAt = now; await write(tasks); await arm(task); return;
        }
        launching = true; activeId = task.id; cancelled = false;
        try {
          await write(tasks); await arm(task);
          const sources = await sourcesFor(task);
          const prepared = env.prepareSources ? await env.prepareSources(sources, () => cancelled) : { tabId: await sourcePage(task), index: 0, results: [] };
          if (cancelled) throw Error('定时启动已取消');
          const result = await env.launch(prepared.tabId, env.core.config({ ...task.config, maxJobs: task.targetJobs }), { id: task.id, occurrence, sources, sourceIndex: prepared.index, sourceResults: prepared.results, sourcePageId: prepared.progress?.pageId });
          task.lastRun = { ...task.lastRun, status: 'running', runId: result.id, reason: '正在投递' };
        } catch (error) {
          task.lastRun = { ...task.lastRun, status: cancelled ? 'stopped' : 'error', reason: error.message, finishedAt: Date.now() };
        } finally { launching = false; activeId = ''; await write(tasks); }
      }),
      finish: result => serial(async () => {
        if (!result?.scheduleId) return;
        const tasks = await read(), task = tasks.find(item => item.id === result.scheduleId);
        if (!task || task.lastRun?.runId !== result.id) return;
        task.lastRun = { ...task.lastRun, status: result.status, sent: result.sent || 0, targetJobs: result.targetJobs, reason: result.message, sourceResults: result.sourceResults || [], finishedAt: Date.now() };
        await write(tasks);
      })
    };
    return api;
  }
  const api = { nextTime, create };
  scope.BossSchedules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
