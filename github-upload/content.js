(function () {
  'use strict';
  const CONTENT_VERSION = '0.2.7';
  const previous = globalThis.__zhixiangLoaded;
  if (previous?.version === CONTENT_VERSION && previous?.alive?.()) return;
  previous?.dispose?.();
  document.getElementById('zhixiang-controls')?.remove();
  const C = BossCore;
  const pageId = crypto.randomUUID();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Read what the user sees: CSS and hidden decoys inside the JD are not job text.
  const text = el => (typeof el?.innerText === 'string' ? el.innerText : el?.textContent || '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
  const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const first = (selectors, scope = document) => {
    for (const s of selectors) { const el = [...scope.querySelectorAll(s)].find(visible); if (el) return el; }
    return null;
  };
  async function call(type, extra = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...extra });
    if (!result?.ok) throw new Error(result?.error || '扩展连接中断，请刷新页面');
    return result.data;
  }
  function blockReason(doc = document) {
    if ([...doc.querySelectorAll('.geetest_panel, .geetest_holder, #captcha, .verify-wrap')].some(visible)) return '页面需要验证码，请完成验证后重新启动';
    const dialogs = [...doc.querySelectorAll('[role="dialog"], .dialog-wrap, .toast, .ui-toast, .boss-dialog')].filter(visible).map(text).join('\n');
    if (/操作频繁|今日.*上限|沟通.*上限|账号异常|账号受限|请.*登录|安全验证|人机验证/.test(dialogs)) return '页面提示登录、验证或沟通限制，请手动处理后重试';
    if (/\/login|\/verify/.test(doc.defaultView.location.pathname)) return '页面需要登录或验证';
    return '';
  }
  function cardInfo(card) {
    const link = card.matches('a[href*="/job_detail/"]') ? card : card.querySelector('a[href*="/job_detail/"]');
    const identity = C.jobIdentity(link?.href);
    if (!identity) return null;
    const tags = [...card.querySelectorAll('.tag-list li, .job-limit li, .job-info .tag-list span')].map(text);
    const edu = tags.find(t => /^(学历不限|初中及以下|高中|中专\/中技|中专|大专|本科|硕士|博士)$/.test(t));
    const experience = tags.find(t => /经验不限|在校|应届|年以下|\d+[-~至]\d+年|\d+年以上/.test(t));
    return { ...identity,
      title: headingName(first(['.job-name', '.job-title', '.job-title a'], card)) || text(link).split('\n')[0],
      company: text(first(['.company-name', '.company-text .name', '.company-text'], card)),
      location: text(first(['.job-area', '.job-location', '.job-area-wrapper'], card)),
      salary: text(first(['.salary', '.job-salary'], card)),
      education: edu || '', experience: experience || '', ...C.jobSchedule(tags.join(' ')), hrActivity: activityText(card), description: ''
    };
  }
  async function resolveSalaries(entries) {
    const unresolved = entries.filter(entry => entry.node && !C.monthlySalary(entry.job.salary) && !/面议|保密|不限/.test(entry.job.salary));
    if (!unresolved.length) return;
    await Promise.race([document.fonts.ready, sleep(1000)]);
    for (let start = 0; start < unresolved.length; start += 200) {
      const batch = unresolved.slice(start, start + 200).map(entry => ({ ...entry, token: crypto.randomUUID() }));
      for (const entry of batch) entry.scope.setAttribute('data-zhixiang-salary', entry.token);
      let native = [];
      try { native = await call('READ_NATIVE_SALARIES', { items: batch.map(entry => ({ token: entry.token, id: entry.job.id })) }); }
      catch { /* Missing native metadata must still allow local font decoding. */ }
      finally { for (const entry of batch) entry.scope.removeAttribute('data-zhixiang-salary'); }
      for (const entry of batch) {
        const raw = text(entry.node);
        const data = native.find(item => item.token === entry.token)?.salary || '';
        const decoded = C.monthlySalary(data) ? data : BossSalary.read(entry.node);
        entry.job.salaryRaw = raw;
        entry.job.salary = decoded || raw;
        entry.job.salarySource = C.monthlySalary(data) ? 'native_job' : BossSalary.encoded(raw) && !BossSalary.encoded(decoded) ? 'rendered_font' : 'page_text';
      }
    }
  }
  function activityText(scope) {
    const online = first(['.boss-online-tag', '.boss-online-icon'], scope);
    if (online) return '在线';
    return text(first(['.boss-active-time', '.recruiter-activity', '.boss-info .active-time', '.job-boss-info .active-time'], scope));
  }
  function cards() {
    const candidates = [...document.querySelectorAll('.job-card-wrapper,li.job-card-box,li.job-card,.job-list-item')].filter(el => {
      const link = el.matches('a[href*="/job_detail/"]') ? el : el.querySelector('a[href*="/job_detail/"]');
      return Boolean(C.jobIdentity(link?.href)) && !el.querySelector('.job-sec-text,.job-detail-text,[class*="job-sec-text"],[class*="job-description"],.job-detail-body > p.desc') && ![...el.querySelectorAll('h1,h2,h3,h4,.title')].some(node => /^(职位描述|岗位描述|岗位职责)$/.test(text(node)));
    });
    // Layouts can mix wrapper cards and li cards. Keep one innermost card per link.
    return candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
  }
  function activeCard(card, list = cards()) {
    const activeSelector = '.active,.selected,.current,.card-active,.job-card-active,[aria-selected="true"]';
    if (card.matches(activeSelector) || card.querySelector(activeSelector)) return true;
    for (let wrapper = card.parentElement, depth = 0; wrapper && depth < 3 && wrapper !== document.body; wrapper = wrapper.parentElement, depth++) {
      if (!wrapper.matches('.job-card-wrap,.job-card-wrapper,.card-area')) break;
      // An active shared list is not proof that this particular card is selected.
      if (wrapper.matches(activeSelector)) return !list.some(el => el !== card && wrapper.contains(el));
    }
    return false;
  }
  function selectedCards(list = cards()) { return list.filter(card => activeCard(card, list)); }
  const listPage = () => C.isJobListUrl(location.href);
  let selection = null;
  const titleKey = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const cardSelector = '.job-card-wrapper,li.job-card-box,li.job-card,.job-list-item';
  const titleSelectors = ['.job-detail-header .job-name', '.job-detail-header .job-title', '.job-detail-header h1', '.job-detail-header .name', '.job-header .job-name', '.job-header .job-title', '.job-header h1', '.job-detail-top .job-name', '.job-detail-box .job-name', '.job-detail-box h1', '.job-banner-main .job-name', '.job-banner .name h1', '.job-banner .name', '.job-primary .name h1', '.job-primary .name', '.job-detail-container .job-name'];
  const headingName = el => text(el).replace(text(el?.querySelector('.salary,.job-salary')), '').trim();
  const descriptionSelector = '.job-sec-text,.job-detail-text,[class*="job-sec-text"],[class*="job-detail-text"],[class*="job-description"],.job-desc,.job-detail-body > p.desc,.job-detail-body .job-sec > .desc';
  const descriptionHeading = /^(职位描述|岗位描述|岗位职责|职位详情)$/;
  function chatButton(scope, list = cards()) {
    const candidates = [...scope.querySelectorAll('a.op-btn-chat,.op-btn-chat,.btn-startchat,a[ka="job-detail-chat"],.start-chat-btn,.btn-chat,a,button,[role="button"]')];
    return candidates.find(el => visible(el) && /^(立即沟通|打招呼|立即联系|继续沟通|已沟通)$/.test(text(el)) && !list.some(card => card.contains(el)) && !el.closest('.recommend,.recommend-list,.related-jobs')) || null;
  }
  function descriptionCandidates(list = cards()) {
    const eligible = el => visible(el) && text(el).length >= 20 && !list.some(card => card.contains(el)) && !el.closest('.job-label-list,.tag-list,.job-limit,.job-boss-info,.job-address,.recommend,.recommend-list,.related-jobs');
    const candidates = [...document.querySelectorAll(descriptionSelector)].filter(eligible);
    // Some layouts use a plain .text body after a semantic section heading.
    for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6,.section-title,.title,strong')) {
      if (!visible(heading) || !descriptionHeading.test(text(heading)) || list.some(card => card.contains(heading))) continue;
      let body = heading.nextElementSibling;
      // Native order is heading → technology labels → p.desc. Labels are not JD.
      while (body && body.matches('.job-label-list,.tag-list,.job-limit')) body = body.nextElementSibling;
      if (!eligible(body)) body = [...(heading.parentElement?.querySelectorAll('.desc,.text,.content,.description') || [])].find(eligible);
      if (eligible(body)) candidates.push(body);
    }
    return [...new Set(candidates)];
  }
  function detailParts(list = cards()) {
    for (const description of descriptionCandidates(list)) {
      // Stop before reaching a shared container that includes the left list.
      for (let root = description.parentElement, depth = 0; root && depth < 12 && root !== document.body && root !== document.documentElement; root = root.parentElement, depth++) {
        if (list.some(card => root.contains(card))) break;
        const eligible = el => visible(el) && !description.contains(el) && !list.some(card => card.contains(el)) && !el.closest('.recommend,.recommend-list,.related-jobs') && !descriptionHeading.test(headingName(el));
        const explicit = [...root.querySelectorAll(titleSelectors.join(',') + ',.job-name,.job-title,[class*="position-name"],[class*="position-title"]')].filter(eligible);
        let title = explicit.find(el => headingName(el) && headingName(el).length <= 160);
        if (!title) {
          const known = [...root.querySelectorAll('[class*="job-name"],[class*="job-title"],h1,h2,h3')].filter(eligible);
          title = known.find(el => headingName(el) && headingName(el).length <= 160);
        }
        if (!title) continue;
        const button = chatButton(root, list);
        // A tiny wrapper containing only JD and an unrelated heading is not a detail pane.
        if (!button && !root.matches('.job-detail-box,.job-detail-container,.job-detail-card,.job-detail-content')) continue;
        let header = title.closest('.job-detail-header,.job-header,.job-detail-top,.job-banner-main,.job-banner,.job-primary') || title.parentElement;
        if (button && !header.contains(button)) {
          let common = header;
          while (common && common !== root && !common.contains(button)) common = common.parentElement;
          if (common && !common.contains(description)) header = common;
        }
        const company = [...root.querySelectorAll('.sider-company .company-info a,.company-info .company-name,.company-info a[ka="job-detail-company"],.company-info .name,.company-name')].find(el => visible(el) && !list.some(card => card.contains(el)) && !el.closest('.recommend,.recommend-list,.related-jobs'));
        const bossAttr = first(['.job-boss-info .boss-info-attr'], root);
        const attrCompany = bossAttr && /[·|｜]/.test(text(bossAttr)) ? text(bossAttr).split(/[·|｜]/)[0].trim() : '';
        const companyName = text(company) || attrCompany;
        const name = headingName(title);
        const parts = { root, header, buttonNode: button, titleNode: title, descriptionNode: description, title: name, description: text(description), company: companyName };
        parts.summary = detailSummary(parts);
        return parts;
      }
    }
    return null;
  }
  function detailSummary(parts, decodeSalary = false) {
    const { header } = parts, headerText = text(header);
    const tags = [...header.querySelectorAll('.text span, .tag-list li, .job-limit li')].map(text);
    const education = tags.find(t => /^(学历不限|初中及以下|高中|中专\/中技|中专|大专|本科|硕士|博士)$/.test(t)) || headerText.match(/学历不限|初中及以下|中专\/中技|高中|大专|本科|硕士|博士/)?.[0] || '';
    const experience = tags.find(t => /^(经验不限|在校\/应届|应届生|1年以内|\d+[-~至]\d+年|\d+年以上)$/.test(t)) || headerText.match(/经验不限|在校\/应届|应届生|1年以内|\d+[-~至]\d+年|\d+年以上/)?.[0] || '';
    const region = tags.find(t => t && t !== education && t !== experience && !/薪|经验|学历|年|月|天|周|本科|大专|硕士|博士|元|\d+K/i.test(t)) || '';
    const salaryNode = first(['.salary', '.job-salary'], header);
    return { title: parts.title, company: parts.company,
      salary: decodeSalary ? BossSalary.read(salaryNode) || text(salaryNode) : text(salaryNode),
      location: text(first(['.job-area', '.job-location', '.job-area-wrapper'], header)) || region,
      education, experience, ...C.jobSchedule(headerText) };
  }
  function detailLoading(parts) {
    if (!parts) return false;
    const selectors = ['.loading', '.job-detail-loading', '.skeleton', '[aria-busy="true"]'];
    return (visible(parts.root) && parts.root.matches(selectors.join(','))) || Boolean(first(selectors, parts.root));
  }
  function detailIds(parts) {
    const ids = new Set();
    for (const el of [parts.root, parts.header, parts.titleNode, parts.descriptionNode, parts.buttonNode].filter(Boolean)) {
      const id = el.dataset.encryptJobId || el.dataset.jobId;
      if (id) ids.add(id);
    }
    for (const link of [parts.buttonNode, parts.titleNode.closest('a[href]')].filter(el => el?.matches('a[href]'))) {
      const identity = C.jobIdentity(link.href); if (identity) ids.add(identity.id);
      const url = new URL(link.href, location.href);
      for (const key of ['jobId', 'encryptJobId']) if (url.searchParams.get(key)) ids.add(url.searchParams.get(key));
    }
    return [...ids];
  }
  function selectedDetailReady(id) {
    if (!listPage() || selection?.job.id !== id || !selection.detailRead) return false;
    const parts = detailParts();
    if (!parts) return false;
    // Use the pane produced by the native card click. Display titles, IDs and
    // field comparisons do not authorize or block this list-page operation.
    selection.root = parts.root;
    return true;
  }
  let highlightJobId = '';
  function syncHighlight() {
    const card = highlightJobId ? cards().find(el => cardInfo(el)?.id === highlightJobId) : null;
    for (const previous of document.querySelectorAll('[data-zhixiang-current]')) if (previous !== card) previous.removeAttribute('data-zhixiang-current');
    if (card && card.getAttribute('data-zhixiang-current') !== highlightJobId) card.setAttribute('data-zhixiang-current', highlightJobId);
    return card;
  }
  async function markJob(job, runId) {
    await allowed(runId);
    ++updateSequence; // Discard panel reads that began before this card was focused.
    highlightJobId = job.id;
    syncHighlight();
  }
  let lastFocus = null;
  function cardViewport(card) {
    const view = { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
    const cardRect = card.getBoundingClientRect();
    for (let node = card.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (!/(auto|scroll|overlay|hidden|clip)/.test(getComputedStyle(node).overflowY)) continue;
      const rect = node.getBoundingClientRect();
      view.top = Math.max(view.top, rect.top); view.bottom = Math.min(view.bottom, rect.bottom);
      view.left = Math.max(view.left, rect.left); view.right = Math.min(view.right, rect.right);
    }
    for (const header of document.querySelectorAll('#header,.header,.job-search-header,.job-search-wrapper,.job-search-filter,.search-condition')) {
      if (header.contains(card)) continue;
      const style = getComputedStyle(header), rect = header.getBoundingClientRect();
      if (!['fixed', 'sticky'].includes(style.position) || !visible(header) || rect.height > innerHeight * 0.6) continue;
      if (rect.top <= view.top + 2 && rect.bottom > view.top && rect.left < Math.min(view.right, cardRect.right) && rect.right > Math.max(view.left, cardRect.left)) view.top = rect.bottom;
    }
    return view;
  }
  function cardInView(card) {
    if (!card?.isConnected || !visible(card)) return false;
    const view = cardViewport(card), rect = card.getBoundingClientRect();
    const title = first(['.job-name', '.job-title', 'a[href*="/job_detail/"]'], card);
    const heading = title?.getBoundingClientRect() || rect;
    const intersection = Math.min(heading.bottom, view.bottom) - Math.max(heading.top, view.top);
    return rect.width > 0 && rect.height > 0 && heading.height > 0 && view.right > view.left && Math.min(rect.right, view.right) > Math.max(rect.left, view.left) && intersection >= Math.min(12, heading.height * 0.5);
  }
  function scrollCardContainer(card) {
    const containers = [];
    for (let node = card.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 1 && /(auto|scroll|overlay|hidden)/.test(getComputedStyle(node).overflowY)) containers.push(node);
    }
    if (document.scrollingElement) containers.push(document.scrollingElement);
    for (const container of containers) {
      if (cardInView(card)) break;
      const view = cardViewport(card);
      const title = first(['.job-name', '.job-title', 'a[href*="/job_detail/"]'], card) || card;
      const rect = title.getBoundingClientRect();
      const delta = rect.top < view.top + 8 ? rect.top - view.top - 8 : rect.bottom > view.bottom - 8 ? rect.bottom - view.bottom + 8 : 0;
      if (delta) container.scrollTop += delta;
    }
  }
  async function focusJob(job, runId, instant = false) {
    await markJob(job, runId);
    let card = syncHighlight();
    const missing = () => Object.assign(new Error('岗位卡片已更新，正在重新读取列表'), { code: 'JOB_CARD_MISSING' });
    if (!card) throw missing();
    if (!cardInView(card)) {
      card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: instant || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      const deadline = Date.now() + (instant ? 160 : 600);
      while (!cardInView(card) && card.isConnected && Date.now() < deadline) await sleep(30);
      card = syncHighlight();
      if (!card) throw missing();
      if (!cardInView(card)) { scrollCardContainer(card); await sleep(32); card = syncHighlight(); }
    }
    if (!card) throw missing();
    lastFocus = { jobId: job.id, visible: cardInView(card), viewport: cardViewport(card), card: { top: card.getBoundingClientRect().top, bottom: card.getBoundingClientRect().bottom }, pageVisible: document.visibilityState !== 'hidden' };
    if (!lastFocus.visible) throw Object.assign(new Error('当前卡片未能定位，跳过该岗继续列表'), { code: 'JOB_CARD_UNREACHABLE' });
    shadow.getElementById('current-job').textContent = job.title + (job.company ? ' · ' + job.company : '');
    return card;
  }
  async function selectJob(message) {
    const card = message.focused ? cards().find(el => cardInfo(el)?.id === message.job.id) : await focusJob(message.job, message.runId, Number(message.browseIntervalSeconds) <= 0.5);
    if (!card) throw Object.assign(new Error('岗位卡片已更新，正在重新读取列表'), { code: 'JOB_CARD_MISSING' });
    await dismissExistingReceipt(message);
    selection?.stopDetailWatch?.();
    const before = detailParts();
    const beforeActive = selectedCards();
    selection = { job: message.job, card, detailRead: false, beforeDescriptionNode: before?.descriptionNode, beforeDescription: before?.description || '', renderUpdated: !before, loadingSeen: detailLoading(before) };
    // Re-clicking an already displayed job can launch a redundant native
    // request whose late response overwrites the next job's detail.
    if (before && beforeActive.length === 1 && beforeActive[0] === card && !detailLoading(before)) {
      selection.reusedDetail = true;
      return true;
    }
    // Capture the native render from before the click, including a loading
    // indicator that may appear and disappear between READ_DETAIL polls.
    // This observes rendering only; it never compares job identity fields.
    const pending = selection;
    const captureRender = () => {
      if (selection !== pending) return;
      const parts = detailParts();
      if (detailLoading(parts)) pending.loadingSeen = true;
      if (parts && (parts.descriptionNode !== pending.beforeDescriptionNode || parts.description !== pending.beforeDescription)) pending.renderUpdated = true;
    };
    const observer = new MutationObserver(captureRender);
    const watchRoot = before?.root.closest('.job-detail-container') || before?.root.parentElement || document.body;
    observer.observe(watchRoot, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'aria-busy'] });
    pending.stopDetailWatch = () => observer.disconnect();
    const link = card.querySelector('a[href*="/job_detail/"]') || card;
    try {
      await clickHere(link, { ...message, purpose: 'select' });
      captureRender();
      if (!listPage()) throw new Error('岗位列表已变化，请回到列表后启动');
    } catch (error) { pending.stopDetailWatch(); throw error; }
    return true;
  }
  async function scan(max, known = new Set()) {
    const blocked = blockReason(); if (blocked) throw new Error(blocked);
    if (!listPage()) throw new Error('请在 BOSS 职位列表中启动');
    const entries = cards().map(scope => ({ scope, node: first(['.salary', '.job-salary'], scope), job: cardInfo(scope) })).filter(entry => entry.job?.title && !known.has(entry.job.id)).slice(0, max);
    await resolveSalaries(entries);
    return entries.map(entry => entry.job);
  }
  function listLoading() {
    const root = document.querySelector('.job-list-container,.job-list-box,.job-list');
    return Boolean(root && ((visible(root) && root.matches('[aria-busy="true"]')) || first(['.loading', '.loading-more', '.job-list-loading', '.skeleton', '[aria-busy="true"]'], root)));
  }
  function nextPageButton() {
    const scopes = [...document.querySelectorAll('.options-pages,.pagination,.pager,.page-list,.page-container,.page-wrap,.page-box,[role="navigation"][aria-label*="分页"]')].filter(el => visible(el) && !el.closest('.recommend,.recommend-list,.related-jobs,.chat-container,.dialog-wrap,[role="dialog"]'));
    for (const scope of scopes) for (const item of scope.querySelectorAll('a,button,[role="button"],.ui-icon-arrow-right')) {
      const button = item.closest('a,button,[role="button"]') || item;
      if (!scope.contains(button) || !visible(button) || button.disabled || button.target === '_blank' || button.hasAttribute('disabled') || button.closest('.disabled,.is-disabled,[aria-disabled="true"]')) continue;
      const label = [text(button), button.getAttribute('aria-label'), button.getAttribute('title')].filter(Boolean).join(' ');
      if (!/下一页|下页|\bnext\b/i.test(label) && !button.matches('[rel="next"],.next,.page-next,.pagination-next') && !button.querySelector('.ui-icon-arrow-right')) continue;
      const href = button.getAttribute('href');
      if (href && !/^(?:#|javascript:)/i.test(href) && !C.isJobListUrl(new URL(href, location.href).href)) continue;
      return button;
    }
    return null;
  }
  function waitForListUpdate(ms) {
    return new Promise(resolve => {
      let timer;
      const observer = new MutationObserver(done);
      function done() { clearTimeout(timer); observer.disconnect(); resolve(); }
      const root = document.querySelector('.job-list-container,.job-list-box,.job-list')?.parentElement || document.body;
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-busy'] });
      timer = setTimeout(done, Math.max(1, ms));
    });
  }
  let paginationState = null;
  async function scanMore(message) {
    const known = new Set(message.known || []);
    const loadDelay = Math.max(2500, Math.min(120, Number(message.intervalSeconds) || 0.5) * 1000);
    let idleRounds = 0;
    for (let attempt = 0; idleRounds < 3 && attempt < Math.min(10, known.size + 6); attempt++) {
      await allowed(message.runId);
      const available = await scan(message.max, known);
      if (available.length) return available;
      const before = cards(), last = before.at(-1);
      const ids = new Set(before.map(card => cardInfo(card)?.id));
      let scroller = last?.parentElement;
      while (scroller && scroller !== document.body && scroller !== document.documentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
        scroller = scroller.parentElement;
      }
      if (!scroller || scroller === document.body || scroller === document.documentElement) scroller = document.scrollingElement;
      const beforeTop = scroller.scrollTop, beforeHeight = scroller.scrollHeight;
      last?.scrollIntoView({ block: 'end', behavior: 'instant' });
      const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      // A viewport can already be at the bottom before lazy loading is enabled.
      // Move slightly and return so the native loader receives a real scroll.
      if (scroller.scrollTop >= bottom - 1 && bottom > 0) {
        scroller.scrollTop = Math.max(0, bottom - 8);
        await sleep(80);
      }
      scroller.scrollTop = bottom;
      const deadline = Date.now() + loadDelay;
      while (Date.now() < deadline) {
        await allowed(message.runId);
        const newJobs = await scan(message.max, known);
        if (newJobs.length) return newJobs;
        await waitForListUpdate(Math.min(150, Math.max(1, deadline - Date.now())));
      }
      // A visible loader is not proof of exhaustion. Give its current request
      // a bounded extra window, without triggering another native scroll.
      const loadingDeadline = Date.now() + 10000;
      while (listLoading() && Date.now() < loadingDeadline) {
        await allowed(message.runId);
        const newJobs = await scan(message.max, known);
        if (newJobs.length) return newJobs;
        await waitForListUpdate(150);
      }
      if (listLoading()) throw new Error('岗位列表仍在加载，本轮已停止；尚不能确认没有更多岗位');
      const changed = cards().some(card => !ids.has(cardInfo(card)?.id));
      idleRounds = changed || scroller.scrollTop > beforeTop + 1 || scroller.scrollHeight > beforeHeight ? 0 : idleRounds + 1;
    }
    return nextPageButton() ? { jobs: [], nextPage: true } : [];
  }
  function waitForDetailUpdate(ms) {
    return new Promise(resolve => {
      let observer, timer;
      const done = () => { clearTimeout(timer); observer?.disconnect(); resolve(); };
      const root = document.querySelector('.job-detail-container') || document.querySelector('.job-detail-box')?.parentElement || document.body;
      observer = new MutationObserver(done);
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'aria-busy', 'data-job-id', 'data-encrypt-job-id', 'href'] });
      timer = setTimeout(done, Math.max(1, ms));
    });
  }
  async function detail(id, displayOnly = false) {
    if (!listPage() || selection?.job.id !== id) throw new Error('列表当前岗位不一致');
    const end = Date.now() + 12000;
    let parts, ready = false;
    try {
      while (Date.now() < end) {
        const blocked = blockReason(); if (blocked) throw new Error(blocked);
        parts = detailParts();
        const loading = detailLoading(parts);
        if (loading) selection.loadingSeen = true;
        if (parts && (parts.descriptionNode !== selection.beforeDescriptionNode || parts.description !== selection.beforeDescription)) selection.renderUpdated = true;
        const rendered = Boolean(selection.reusedDetail || selection.renderUpdated || selection.loadingSeen);
        ready = Boolean(rendered && parts && parts.description.length >= 20 && !loading);
        selection.lastCheck = { mode: 'native_render', title: parts?.title || '', descriptionLength: parts?.description.length || 0, loading, rendered, ready };
        if (ready) break;
        await waitForDetailUpdate(100);
      }
      if (!ready) throw new Error('等待本次点击的职位描述更新；本岗位尚未打招呼');
    } finally { selection.stopDetailWatch?.(); }
    if (displayOnly) return { title: selection.job.title, detailTitle: parts.title, company: parts.company || selection.job.company, description: parts.description, displayOnly: true };
    selection.root = parts.root;
    const { header, root, description } = parts;
    const summary = parts.summary;
    const salaryNode = first(['.salary', '.job-salary'], header);
    const salaryJob = { id, salary: text(salaryNode) || selection.job.salary };
    await resolveSalaries([{ scope: parts.root, node: salaryNode, job: salaryJob }]);
    selection.detailRead = true;
    return {
      title: selection.job.title, detailTitle: parts.title,
      company: parts.company || selection.job.company,
      location: summary.location || selection.job.location,
      salary: salaryJob.salary, salaryRaw: salaryJob.salaryRaw || selection.job.salaryRaw || '', salarySource: salaryJob.salarySource || selection.job.salarySource || 'page_text', education: summary.education || selection.job.education, experience: summary.experience || selection.job.experience, daysPerWeek: summary.daysPerWeek || selection.job.daysPerWeek, internshipMonths: summary.internshipMonths || selection.job.internshipMonths, hrActivity: activityText(root) || selection.job.hrActivity, description
    };
  }
  function recruiterName(element) {
    if (!element) return '';
    const copy = element.cloneNode(true);
    copy.querySelectorAll('.boss-active-time,.active-time,.boss-online-tag,.boss-online-icon,.online-tag,.icon-vip,.icon-v,svg,img,i').forEach(el => el.remove());
    return copy.textContent.replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  }
  function recipientFrom(button) {
    const scope = selection?.root || button.closest('.job-detail-box,.job-detail-container,.job-banner') || document;
    const name = recruiterName(first(['.job-boss-info .name', '.boss-info .name'], scope));
    try {
      const u = new URL(button.getAttribute('href') || '', location.href);
      const bossId = u.searchParams.get('bossId') || u.searchParams.get('encryptBossId') || button.dataset.encryptBossId || '';
      return { bossId, name };
    } catch { return { bossId: '', name }; }
  }
  async function readNativeChat(scope, message, frame = false, page = false) {
    const token = crypto.randomUUID();
    scope.setAttribute('data-zhixiang-chat', token);
    try { return await call('READ_NATIVE_CHAT', { token, frame, page, jobId: message.job.id, runId: message.runId }); }
    finally { scope.removeAttribute('data-zhixiang-chat'); }
  }
  function findChatInput(scope) {
    const selectors = ['#chat-input', 'div[contenteditable="true"][class*="chat-input"]', '.chat-input textarea', '.chat-editor [contenteditable="true"]', 'textarea[placeholder*="说点什么"]', 'textarea[class*="chat"]', '[contenteditable="true"]', '[contenteditable]:not([contenteditable="false"])', 'textarea'];
    for (const selector of selectors) {
      const inputs = [...scope.querySelectorAll(selector)].filter(el => visible(el) && !el.disabled && !el.readOnly && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'));
      if (inputs.length === 1) return inputs[0];
      if (inputs.length > 1) return null;
    }
    return null;
  }
  function findChatSend(scope) {
    const enabled = el => visible(el) && !el.disabled && !el.classList.contains('disabled') && el.getAttribute('aria-disabled') !== 'true';
    for (const selector of ['.btn-send', 'button[class*="btn-send"]', '.chat-send', 'button[class*="send"]', 'div[class*="send-btn"]', '.send-btn', 'button,a.btn,[role="button"]']) {
      const buttons = [...scope.querySelectorAll(selector)].filter(el => enabled(el) && (/^(发送|发送招呼|立即发送)$/.test(text(el)) || (!text(el) && el.matches('.btn-send,.chat-send,.send-btn,[class*="send-btn"]'))));
      if (buttons.length === 1) return buttons[0];
      if (buttons.length > 1) return null;
    }
    return null;
  }
  function chatScope(doc = document) {
    const input = findChatInput(doc);
    return input?.closest('.chat-conversation,.chat-window,.chat-container,.chat-box,.chat-im') || doc;
  }
  async function chatContext(job, recipient, runId, page = false) {
    const blocked = blockReason(); if (blocked) return { blocked: true, reason: blocked };
    if (!page || !/^\/web\/geek\/chat\/?$/.test(location.pathname)) return { ready: false, waitReason: '等待 BOSS 聊天页加载' };
    const pending = communication;
    if (!pending?.fullPage || !pending.handoffReady || pending.message.runId !== runId || pending.message.job.id !== job.id) return { ready: false, waitReason: '当前聊天页没有属于本任务的待发消息' };
    // Reference-plugin flow: resume the verified native click's saved task in
    // the same tab, then locate the editor directly. This path has no HR
    // header, company-label or Vue-component dependency.
    const input = findChatInput(document);
    const identityCheck = {
      strategy: 'saved_native_handoff',
      expected: { title: job.title, company: job.company, recruiter: recipient?.name || '', jobId: job.id, bossId: recipient?.bossId || '' },
      observed: { editorTag: input?.tagName || '', editorClass: input?.className || '' },
      matches: { savedTask: true, input: Boolean(input) }
    };
    return { ready: Boolean(input), page: true, waitReason: input ? '' : '等待聊天输入框加载', identityCheck };
  }
  async function restorePendingChat(message) {
    if (!/^\/web\/geek\/chat\/?$/.test(location.pathname)) return;
    if (communication?.fullPage && communication.message.runId === message.runId && communication.message.job.id === message.job.id) return;
    const pending = await call('GET_PENDING_CUSTOM', { runId: message.runId, jobId: message.job.id });
    communication = { message: { runId: pending.runId, job: pending.job, greeting: pending.greeting, customGreeting: true }, recipient: pending.recipient, fullPage: true, handoffReady: pending.handoffReady, chatOpenedAt: Date.now(), clicked: true, clickedAt: 0, before: new Map(), defaultSent: false, processing: false, sendStarted: pending.sendAttempted, sent: pending.delivered };
    const notice = shadow.getElementById('chat-notice');
    shadow.getElementById('panel').insertBefore(notice, shadow.getElementById('status'));
  }
  async function prepareCustomChat(pending) {
    if (pending.fullPage) {
      if (pending.sent) return { customSent: true };
      if (pending.sendStarted) throw new Error('本岗位已尝试发送，禁止自动重发；请人工核实');
      if (Date.now() - pending.chatOpenedAt < 2500) return { ready: false, waitReason: '等待聊天页加载并检查已有招呼' };
      const context = await chatContext(pending.message.job, pending.recipient, pending.message.runId, true);
      pending.chatCheck = context;
      if (context.ready) {
        const guard = existingGreetingGuard(document, pending);
        if (guard) return { ready: false, ...guard };
      }
      return { ...context, recipient: pending.recipient };
    }
    if (!pending.clicked || Date.now() - pending.clickedAt < 900) return { ready: false };
    if (!receiptBoundToJob(pending)) throw new Error('打开聊天前岗位信息已变化，未发送自定义消息');
    if (pending.opened) return { ready: false, waitReason: '独立聊天页正在发送，原列表保持不动' };
    const handoff = await call('READ_CUSTOM_HANDOFF', { runId: pending.message.runId, jobId: pending.message.job.id });
    const dialog = pending.nativeReceipt?.element?.isConnected && visible(pending.nativeReceipt.element)
      ? pending.nativeReceipt.element : receiptElements().find(el => visible(el) && !pending.before.has(el) && /沟通|招呼/.test(text(el)));
    const next = dialog && receiptActions(dialog).find(el => text(el) === '继续沟通');
    let address = handoff.url || pending.navigation || pending.target?.url || (next && C.chatTarget(next.getAttribute('href'), pending.message.job.id)?.url);
    if (!address && next && !pending.continued) {
      pending.continued = true;
      const result = await clickHere(next, pending.message);
      address = result.navigation || (await call('READ_CUSTOM_HANDOFF', { runId: pending.message.runId, jobId: pending.message.job.id })).url;
    }
    if (!address) return { ready: false, waitReason: '等待当前岗位原生沟通动作提供聊天入口' };
    pending.opened = true;
    // Match the baseline's stay-on-list flow. Never mark this popup as a custom
    // send; only the separately claimed chat task may report the actual text.
    const stay = dialog && receiptActions(dialog).find(el => /^留在(?:此页|当前页)$/.test(text(el)));
    if (stay) {
      await clickHere(stay, { ...pending.message, purpose: 'select' });
      const end = Date.now() + 1500;
      while (visible(dialog) && Date.now() < end) await sleep(50);
      if (visible(dialog)) throw new Error('沟通弹窗未关闭，原列表已保留；尚未发送自定义消息');
    }
    receiptObserver?.disconnect();
    await call('OPEN_CUSTOM_CHAT', { runId: pending.message.runId, jobId: pending.message.job.id, url: address });
    return { ready: false, waitReason: '在独立聊天页发送，原列表无需返回或重新扫描' };
  }
  async function allowed(runId) {
    while (true) {
      const result = await call('CAN_SEND', { runId });
      if (result.allowed) return;
      if (!result.paused) throw new Error('任务已停止，取消页面操作');
      await sleep(250);
    }
  }
  const receiptSelectors = '[role="dialog"], .dialog-wrap, .boss-dialog, .greet-dialog, .greeting-dialog, .dialog-container, .toast, .ui-toast, .toast-message, .notice-layer, .dialog-box, .dialog';
  let communication = null, receiptObserver = null;
  const sentNotice = /已向\s*BOSS\s*发送消息|打招呼成功|招呼(?:语)?(?:已)?发送成功|招呼已发送|已成功(?:发起沟通|打招呼)|沟通成功/i;
  const receiptActionLabel = /^(留在此页|留在当前页|继续沟通)$/;
  function receiptActions(scope) {
    return [...scope.querySelectorAll('button,a,[role="button"],.btn,.sure-btn,.cancel-btn,div,span')].filter(el => visible(el) && receiptActionLabel.test(text(el)) && ![...el.children].some(child => receiptActionLabel.test(text(child))));
  }
  function receiptElements() {
    const elements = new Set(document.querySelectorAll(receiptSelectors + ',.greet-boss-dialog'));
    // Discover native success dialogs by their title/actions, even when their
    // button classes and wrappers differ from earlier BOSS page versions.
    const anchors = [...document.querySelectorAll('button,a,[role="button"],h1,h2,h3,h4,h5,h6,strong,header,section,div,span,p')].filter(el => {
      const label = text(el);
      return label.length < 120 && (label === '继续沟通' || /^已向\s*BOSS\s*发送消息$/i.test(label)) && ![...el.children].some(child => text(child) === label);
    });
    for (const anchor of anchors) {
      if (!visible(anchor)) continue;
      for (let scope = anchor.parentElement, depth = 0; scope && depth < 6 && scope !== document.body; scope = scope.parentElement, depth++) {
        if (text(scope).length >= 1800) break;
        const actions = receiptActions(scope);
        if (actions.some(b => /^留在(?:此页|当前页)$/.test(text(b))) && actions.some(b => text(b) === '继续沟通') && (sentNotice.test(text(scope)) || scope.matches(receiptSelectors))) { elements.add(scope); break; }
      }
    }
    return [...elements];
  }
  async function dismissExistingReceipt(message) {
    // Dismiss a leftover native success notice before selecting a new job.
    // It is not a receipt for this run and must never increment its counter.
    for (const element of receiptElements()) {
      if (!visible(element) || !sentNotice.test(text(element)) || /未发送|失败|未成功/.test(text(element))) continue;
      const stay = receiptActions(element).find(button => /^留在(?:此页|当前页)$/.test(text(button)));
      if (!stay) continue;
      await clickHere(stay, { ...message, purpose: 'select' });
      await sleep(80);
    }
  }
  async function clickHere(button, message) {
    await allowed(message.runId);
    const token = crypto.randomUUID();
    button.setAttribute('data-zhixiang-click', token);
    try { return await call('CLICK_CURRENT_TAB', { token, jobId: message.job.id, runId: message.runId, purpose: message.purpose }); }
    finally { button.removeAttribute('data-zhixiang-click'); }
  }
  function receiptBoundToJob(pending) {
    // A newly observed receipt belongs to this task's communication click;
    // title/ID differences between the card and pane do not invalidate it.
    return Boolean(pending?.clicked && listPage() && selection?.detailRead && selection.job.id === pending.message.job.id);
  }
  function receiptEvidence(pending) {
    if (!receiptBoundToJob(pending)) return null;
    for (const element of receiptElements()) {
      if (!visible(element) || pending.before.get(element) === text(element)) continue;
      const label = text(element);
      if (/失败|未成功|未发送|需要登录|完善简历|上限|频繁|验证/.test(label)) continue;
      const buttons = receiptActions(element);
      const stay = buttons.find(b => /^(留在此页|留在当前页)$/.test(text(b)));
      const next = buttons.find(b => /^继续沟通$/.test(text(b)));
      if (stay && next && sentNotice.test(label)) return { proof: 'success_dialog', stay, next, element };
      if (sentNotice.test(label)) return { proof: 'success_notice', stay, next, element };
    }
    return null;
  }
  function concealReceipt(evidence) {
    if (!evidence.stay || !evidence.element) return () => {};
    let surface = evidence.element;
    // Include the native overlay when the confirmed dialog lives inside it.
    for (let parent = surface.parentElement, depth = 0; parent && parent !== document.body && depth < 3; parent = parent.parentElement, depth++) {
      if (text(parent) !== text(surface)) break;
      if (parent.matches('.dialog-wrap,.greet-boss-dialog,.dialog-container,.boss-dialog,[role="dialog"]') || getComputedStyle(parent).position === 'fixed') surface = parent;
    }
    const value = surface.style.getPropertyValue('visibility'), priority = surface.style.getPropertyPriority('visibility');
    surface.style.setProperty('visibility', 'hidden', 'important');
    return () => { if (value) surface.style.setProperty('visibility', value, priority); else surface.style.removeProperty('visibility'); };
  }
  async function checkReceipt() {
    const pending = communication;
    if (!pending || pending.processing || pending.defaultSent) return;
    const evidence = receiptEvidence(pending);
    if (!evidence) return;
    if (pending.message.customGreeting) {
      // The generic success heading alone does not identify what was sent.
      // Continue to the verified conversation and inspect its actual messages.
      pending.nativeReceipt = evidence;
      return;
    }
    pending.processing = true;
    const restoreReceipt = concealReceipt(evidence);
    try {
      await call('REPORT_DELIVERY', { runId: pending.message.runId, jobId: pending.message.job.id, proof: evidence.proof });
      pending.defaultSent = true;
      receiptObserver?.disconnect();
      if (evidence.stay) {
        await clickHere(evidence.stay, pending.message);
        // Wait for the native dialog/overlay to leave before touching another job.
        const end = Date.now() + 1500;
        while (evidence.element.isConnected && evidence.element.getClientRects().length && Date.now() < end) await sleep(50);
        restoreReceipt();
        if (visible(evidence.element)) throw new Error('招呼已发送并记录；成功弹窗未能自动关闭，请关闭后继续');
      }
    } catch (error) { pending.error = error.message; }
    finally { restoreReceipt(); pending.processing = false; }
  }
  let sendInFlight = false;
  const selfMessageSelector = '.message-item.is-self, .message-item.self, .message-item.item-myself, .message-item.message-right, .message-item.sent, .message-item .message-sent, .message-list .item-my';
  const nonTextMessageSelector = '.chat-job-info,.chat-job-card,.job-card,.job-message-card,.system-message,.message-system,[data-message-type="system"]';
  function chatMessageBody(message) {
    for (const selector of ['.message-text', '.text-content', '.text', '.message-content']) {
      const body = [...message.querySelectorAll(selector)].find(el => !el.closest(nonTextMessageSelector));
      if (body) return body;
    }
    return message;
  }
  function feedbackVisible(element) {
    if (!visible(element) || element.closest('[hidden],[aria-hidden="true"]')) return false;
    for (let node = element; node && node !== document.body; node = node.parentElement) if (getComputedStyle(node).opacity === '0') return false;
    return true;
  }
  function chatMessageItems(scope) {
    const selector = '.message-item,' + selfMessageSelector;
    return [...scope.querySelectorAll(selector)].filter(el => {
      if (!feedbackVisible(el) || el.closest('.user-list,.friend-list,.contact-list,.session-list') || el.parentElement?.closest(selector) || el.matches(nonTextMessageSelector)) return false;
      const label = text(el).replace(/\s/g, '');
      if (label.includes('你与该职位竞争者PK情况') && label.includes('查看详细分析')) return false;
      return Boolean(chatMessageText(el));
    });
  }
  function messageDeliveryState(message) {
    const statusText = [...message.querySelectorAll('[class*="status"],[class*="receipt"],[class*="state"],[data-status]')].filter(feedbackVisible).map(text);
    const hasVisible = selector => message.matches(selector) && feedbackVisible(message) || [...message.querySelectorAll(selector)].some(feedbackVisible);
    if (hasVisible('.status-error,.send-error,.message-error,[data-status="failed"]') || statusText.some(value => /^(发送失败|消息发送失败|重新发送|重发)$/.test(value))) return 'failed';
    if (hasVisible('.status-loading,.sending,[data-status="sending"]') || statusText.some(value => /^(发送中|正在发送|待发送)$/.test(value))) return 'pending';
    return statusText.some(value => /^(送达|已送达|已读|未读|已发送)$/.test(value)) ? 'delivered' : 'unknown';
  }
  function selfChatMessages(scope) {
    return chatMessageItems(scope).filter(el => el.matches(selfMessageSelector) || el.querySelector(selfMessageSelector) || messageDeliveryState(el) !== 'unknown');
  }
  function chatMessageText(message) {
    const body = chatMessageBody(message);
    const copy = body.cloneNode(true);
    copy.querySelectorAll(nonTextMessageSelector + ',.message-time,.message-status,[class*="message-status"],[class*="message-time"]').forEach(el => el.remove());
    return copy.textContent.replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
  }
  function confirmedChatMessage(message) {
    return !['pending', 'failed'].includes(messageDeliveryState(message));
  }
  const messageKey = value => String(value || '').normalize('NFKC').replace(/[\s\u200B-\u200F\uFEFF]/g, '');
  function deliveryHints(scope) {
    return [...scope.querySelectorAll('.status-loading,.sending,.status-error,.send-error,.message-error,[data-status="sending"],[data-status="failed"]')].filter(el => feedbackVisible(el) && !el.closest('.user-list,.friend-list,.contact-list,.session-list'));
  }
  function messageSnapshot(scope) {
    return { messages: new Map(chatMessageItems(scope).map(el => [el, messageKey(text(el))])), hints: new Map(deliveryHints(scope).map(el => [el, el.className + text(el)])) };
  }
  function customMessageReceipt(scope, greeting, before) {
    const expected = messageKey(greeting);
    const fresh = chatMessageItems(scope).filter(el => !before.messages.has(el) || before.messages.get(el) !== messageKey(text(el)));
    // Native bubbles can wrap words, append delivery labels, or have no
    // recognized self class. Inspect the reference plugins' generic items.
    const matching = expected ? fresh.filter(el => messageKey(chatMessageText(el)).includes(expected) || messageKey(text(el)).includes(expected)) : [];
    const hints = deliveryHints(scope).filter(el => !before.hints.has(el) || before.hints.get(el) !== el.className + text(el));
    const states = [...fresh, ...hints].map(messageDeliveryState);
    const failed = states.includes('failed'), pending = states.includes('pending');
    return { confirmed: !failed && !pending && matching.length > 0, failed, pending, matchingMessages: matching.length, newMessages: fresh.length };
  }
  function existingGreetingGuard(scope, pending) {
    const messages = selfChatMessages(scope);
    if (!messages.length) return null;
    const observedGreeting = chatMessageText(messages[0]).slice(0, 500);
    const same = observedGreeting === pending.message.greeting;
    const reason = (pending.nativeReceipt && confirmedChatMessage(messages[0])
      ? '检测到 BOSS 自动招呼仍在发送，插件已停止。'
      : '检测到当前聊天已有发出或待发送的消息，插件已停止。')
      + (same ? '现有内容与插件文案相同，未重复发送。' : '本岗位未补发自定义消息。')
      + '请关闭 BOSS App 的「打招呼语」，并确认网页端生效后再运行。';
    const notice = shadow.getElementById('chat-notice'); notice.textContent = reason; notice.hidden = false;
    return { blocked: true, reason, observedGreeting };
  }
  async function sendGreeting(message) {
    if (sendInFlight) throw new Error('该页面正在发送，禁止重复操作');
    sendInFlight = true;
    try {
      await restorePendingChat(message);
      const pending = communication;
      if (!pending?.message.customGreeting || pending.message.runId !== message.runId || pending.message.job.id !== message.job.id || pending.sendStarted) throw new Error('自定义发送不属于当前岗位或已经尝试发送');
      if (typeof message.greeting !== 'string' || !message.greeting.trim() || message.greeting.length > 300) throw new Error('自定义消息为空或超过 300 字');
      if (message.greeting !== pending.message.greeting) throw new Error('待发文案与已保存任务不一致，未发送');
      await allowed(message.runId);
      await checkReceipt(); if (pending.error) throw new Error(pending.error);
      message = { ...message, recipient: pending.recipient };
      const context = await chatContext(message.job, message.recipient, message.runId, pending.fullPage);
      if (!context.ready) throw new Error(context.reason || context.waitReason || '聊天输入框尚未准备好');
      const messageScope = document;
      const blocked = blockReason(); if (blocked) throw new Error(blocked);
      const input = findChatInput(document);
      if (!input) throw new Error('未找到当前会话可用的输入框，未发送');
      const current = input?.isContentEditable ? text(input) : input?.value?.trim();
      if (current) throw new Error('输入框已有草稿，已取消发送以保留草稿');
      const existing = existingGreetingGuard(messageScope, pending);
      if (existing) return { sent: false, ...existing };
      input.focus();
      if (input.isContentEditable) {
        input.ownerDocument.execCommand('insertText', false, message.greeting);
      } else {
        const window = input.ownerDocument.defaultView;
        const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, message.greeting);
      }
      input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
      input.dispatchEvent(new input.ownerDocument.defaultView.Event('change', { bubbles: true }));
      await sleep(250);
      const inserted = input.isContentEditable ? text(input) : input.value.trim();
      if (inserted !== message.greeting) throw new Error('招呼语未能完整写入输入框');
      let send = findChatSend(document);
      const controlDeadline = Date.now() + 1200;
      while (!send && Date.now() < controlDeadline) { await sleep(100); send = findChatSend(document); }
      const unavailableSend = !send && [...messageScope.querySelectorAll('.btn-send,.chat-send,.send-btn,[class*="send-btn"],button[class*="send"]')].some(el => visible(el) && (!text(el) || /^(发送|发送招呼|立即发送)$/.test(text(el))));
      if (unavailableSend) throw new Error('发送按钮暂不可用，已停止；招呼语已写入草稿');
      await allowed(message.runId);
      await checkReceipt(); if (pending.error) throw new Error(pending.error);
      if (!(await chatContext(message.job, message.recipient, message.runId, pending.fullPage)).ready) throw new Error('发送前聊天身份已变化');
      if (!input.isConnected || (send && !send.isConnected) || findChatInput(document) !== input || input.ownerDocument !== document || (input.isContentEditable ? text(input) : input.value.trim()) !== message.greeting) throw new Error('发送前输入框或消息内容已变化，未发送');
      const lateGreeting = existingGreetingGuard(messageScope, pending);
      if (lateGreeting) return { sent: false, ...lateGreeting };
      const before = messageSnapshot(messageScope);
      // Persist the one-send claim before clicking, including across page reloads.
      await call('CLAIM_CUSTOM_SEND', { runId: message.runId, jobId: message.job.id });
      pending.sendStarted = true;
      await allowed(message.runId);
      if (!(await chatContext(message.job, message.recipient, message.runId, pending.fullPage)).ready || (send && !send.isConnected) || !input.isConnected || findChatInput(document) !== input || (input.isContentEditable ? text(input) : input.value.trim()) !== message.greeting) throw new Error('发送前会话或草稿发生变化，已停止；请人工核实');
      const finalGuard = existingGreetingGuard(messageScope, pending);
      if (finalGuard) return { sent: false, ...finalGuard };
      // The references use the native send button or Enter. Choose one path
      // once; a button click must never be followed by an Enter retry.
      if (send) send.click();
      else {
        input.focus();
        const Keyboard = input.ownerDocument.defaultView.KeyboardEvent;
        const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const proceed = input.dispatchEvent(new Keyboard('keydown', key));
        // Match the reference's Enter sequence. A cancelled keydown or an
        // already-cleared editor must not cause a second send on keypress.
        if (proceed && (input.isContentEditable ? text(input) : input.value.trim()) === message.greeting && !customMessageReceipt(messageScope, message.greeting, before).confirmed) input.dispatchEvent(new Keyboard('keypress', key));
        input.dispatchEvent(new Keyboard('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
      const sentAt = Date.now(), end = sentAt + 7000; let clearedSince = 0;
      while (Date.now() < end) {
        if (!/^\/web\/geek\/chat\/?$/.test(location.pathname)) throw new Error('发送后页面已变化，请人工核实，禁止自动重发');
        const blocked = blockReason(); if (blocked) throw new Error(blocked);
        const receipt = customMessageReceipt(messageScope, message.greeting, before);
        const currentInput = findChatInput(document);
        const editorCleared = currentInput && !(currentInput.isContentEditable ? text(currentInput) : currentInput.value.trim());
        if (editorCleared) clearedSince ||= Date.now(); else clearedSince = 0;
        pending.receiptCheck = { ...receipt, editorCleared: Boolean(editorCleared), elapsedMs: Date.now() - sentAt };
        if (receipt.failed) return { sent: false, reason: '页面显示发送失败，已停止；不会自动重发', receiptCheck: pending.receiptCheck };
        const nativeAccepted = editorCleared && !receipt.pending && Date.now() - sentAt >= 2000 && Date.now() - clearedSince >= 1000;
        if (receipt.confirmed || nativeAccepted) {
          const proof = receipt.confirmed ? 'outgoing_message' : 'native_editor_cleared';
          // Persist before replying: navigation or a closed message port must not lose a successful send.
          await call('REPORT_DELIVERY', { runId: message.runId, jobId: message.job.id, proof, kind: 'custom' });
          pending.sent = true;
          const stay = pending.nativeReceipt?.stay;
          if (stay?.isConnected && visible(stay)) await clickHere(stay, pending.message);
          return { sent: true, proof, method: send ? 'button' : 'enter', receiptCheck: pending.receiptCheck, reason: receipt.confirmed ? '已在新增消息中识别到招呼语' : '已执行原生发送且输入框保持清空，按原插件流程继续' };
        }
        const currentContext = await chatContext(message.job, message.recipient, message.runId, pending.fullPage);
        if (currentContext.blocked || !/^\/web\/geek\/chat\/?$/.test(location.pathname)) throw new Error('发送后聊天窗口发生变化，请人工核实，禁止自动重发');
        await sleep(350);
      }
      return { sent: false, receiptCheck: pending.receiptCheck, reason: pending.receiptCheck?.pending ? '消息仍显示发送中，已保留待核实记录；不会自动重发' : '原生发送后输入框未清空，且未看到新增消息；请核实，禁止自动重发' };
    } finally { sendInFlight = false; }
  }
  const onCommand = (message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    if (message.type === 'RUN_CHANGED') { void update(); respond({ ok: true }); return; }
    if (message.type === 'NEXT_PAGE') {
      const button = listPage() && nextPageButton();
      if (!button) { respond({ ok: true, data: { clicked: false } }); return; }
      paginationState = { error: '', clicked: false };
      const pending = paginationState;
      // Acknowledge before a native page navigation can destroy this document.
      respond({ ok: true, data: { clicked: true } });
      setTimeout(async () => {
        try { await clickHere(button, { ...message, purpose: 'pagination' }); pending.clicked = true; }
        catch (error) { pending.error = error.message; }
      }, 0);
      return;
    }
    if (message.type === 'COMMUNICATE') {
      (async () => {
        await allowed(message.runId);
        if (!selectedDetailReady(message.job.id)) throw new Error('当前任务尚未读取岗位详情');
        const blocked = blockReason(); if (blocked) throw new Error(blocked);
        const button = chatButton(selection.root);
        if (!button) throw new Error('未找到立即沟通按钮，页面结构可能变化');
        if (/已沟通|继续沟通/.test(text(button))) { respond({ ok: true, data: { status: 'already_contacted' } }); return; }
        if (!/立即沟通|打招呼|立即联系/.test(text(button)) || button.disabled) throw new Error('沟通按钮不可用');
        let recipient = recipientFrom(button);
        let target = null;
        if (message.customGreeting) {
          const native = await readNativeChat(selection.root, message);
          target = C.chatTarget(button.getAttribute('href'), message.job.id) || C.chatTarget(native, message.job.id);
          if (native?.encryptBossId && recipient.bossId && native.encryptBossId !== recipient.bossId) throw new Error('岗位与招聘者标识冲突，未建立沟通');
          recipient.bossId ||= native?.encryptBossId || target?.bossId || '';
          await call('PREPARE_CUSTOM_HANDOFF', { runId: message.runId, jobId: message.job.id, recipient });
        }
        receiptObserver?.disconnect();
        communication = { message, recipient, target, root: selection.root, clicked: false, before: new Map(receiptElements().filter(visible).map(el => [el, text(el)])), defaultSent: false, processing: false };
        receiptObserver = new MutationObserver(() => { void checkReceipt(); });
        receiptObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        // Reply first so a full navigation cannot lose the outcome. The background polls the target tab.
        respond({ ok: true, data: { status: 'clicking', recipient } });
        setTimeout(async () => {
          try {
            if (!selectedDetailReady(message.job.id)) throw new Error('当前任务尚未读取岗位详情');
            const current = chatButton(selection.root);
            if (!current || !/立即沟通|打招呼|立即联系/.test(text(current)) || current.disabled) throw new Error('沟通按钮已变化，已停止');
            const pending = communication;
            const result = await clickHere(current, message);
            pending.navigation = result.navigation;
            pending.clicked = true;
            pending.clickedAt = Date.now();
            await checkReceipt();
          }
          catch (error) { if (communication) communication.error = error.message; }
        }, 80);
      })().catch(e => respond({ ok: false, error: e.message }));
      return true;
    }
    if (!['PING', 'LIST_PROGRESS', 'SHOW_PANEL', 'SHOW_SETTINGS', 'SCAN', 'SCAN_MORE', 'MARK_JOB', 'FOCUS_JOB', 'SELECT_JOB', 'READ_DETAIL', 'CHECK_CHAT', 'CHECK_DELIVERY', 'SEND_GREETING'].includes(message.type)) return;
    (async () => {
      if (message.type === 'PING') return { version: CONTENT_VERSION, pageId, list: listPage(), path: location.pathname };
      if (message.type === 'LIST_PROGRESS') return { pageId, url: location.href, ready: document.readyState === 'complete' && listPage(), visible: document.visibilityState !== 'hidden', ids: cards().map(card => cardInfo(card)?.id).filter(Boolean), loading: listLoading(), empty: [...document.querySelectorAll('.job-list-container .empty,.job-list-container .empty-result,.job-list-box .empty,.job-list .empty,.search-job-result .no-result')].some(el => visible(el) && /暂无|没有|无.*职位|无.*岗位/.test(text(el))), blocked: blockReason(), paginationError: paginationState?.error || '' };
      if (message.type === 'SHOW_PANEL') { host.style.display = ''; shadow.getElementById('panel').hidden = false; shadow.getElementById('launcher').hidden = true; await update(); return true; }
      if (message.type === 'SHOW_SETTINGS') { showSettings(); return true; }
      if (message.type === 'SCAN') return scan(message.max, new Set(message.known || []));
      if (message.type === 'SCAN_MORE') return scanMore(message);
      if (message.type === 'MARK_JOB') { await markJob(message.job, message.runId); return true; }
      if (message.type === 'FOCUS_JOB') { await focusJob(message.job, message.runId, message.instant === true); if (message.state) renderRun({ ...message.state, pageRole: 'source' }); return true; }
      if (message.type === 'SELECT_JOB') return selectJob(message);
      if (message.type === 'READ_DETAIL') return detail(message.id, message.displayOnly === true);
      if (message.type === 'CHECK_CHAT') return chatContext(message.job, message.recipient, message.runId, /^\/web\/geek\/chat\/?$/.test(location.pathname));
      if (message.type === 'CHECK_DELIVERY') {
        await restorePendingChat(message);
        await checkReceipt();
        if (communication?.message.runId === message.runId && communication?.message.job.id === message.job.id && communication.error) throw new Error(communication.error);
        if (communication?.message.runId === message.runId && communication?.message.job.id === message.job.id && communication.message.customGreeting) return { ...(await prepareCustomChat(communication)), defaultSent: communication.defaultSent };
        return { ready: false, defaultSent: Boolean(communication?.message.runId === message.runId && communication?.message.job.id === message.job.id && communication.defaultSent && !communication.processing) };
      }
      if (message.type === 'SEND_GREETING') return sendGreeting(message);
    })().then(data => respond({ ok: true, data }), e => respond({ ok: false, error: e.message, code: e.code }));
    return true;
  };
  chrome.runtime.onMessage.addListener(onCommand);
  // The controls use a shadow root so BOSS styles cannot override them.
  const host = document.createElement('div');
  host.id = 'zhixiang-controls';
  host.style.cssText = 'position:fixed;right:22px;bottom:24px;z-index:2147483646';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = '<style>:host{all:initial}*{box-sizing:border-box}section{width:280px;background:#fff;color:#263043;border:1px solid #e3e7ef;padding:16px;border-radius:14px;box-shadow:0 8px 30px #24365426;font:13px/1.6 "Microsoft YaHei",sans-serif}header{display:flex;justify-content:space-between;align-items:center}b{font-size:16px}p{margin:12px 0;color:#63718a;word-break:break-word;max-height:90px;overflow:auto}button{font:inherit;cursor:pointer;border:1px solid #e0e6f1;border-radius:7px;padding:7px 9px;background:#f5f7fc;color:#4a648e}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:2px solid #7392ff}nav{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}.primary{background:#3b64eb;color:#fff;border-color:#3b64eb}.stats{display:flex;justify-content:space-between;border-block:1px solid #edf0f5;padding:10px 0;color:#63718a}.stats strong{color:#263043}small{display:block;color:#8d98ab;margin-top:10px}#launcher{background:#3b64eb;color:white;box-shadow:0 4px 16px #24365426;padding:10px 15px}[hidden]{display:none!important}</style><button id="launcher" hidden>qu投 · 展开</button><section id="panel"><header><b>↗ qu投</b><div><button id="settings">设置</button> <button id="hide" aria-label="收起面板">−</button></div></header><p id="status" role="status" aria-live="polite">正在连接…</p><div class="stats"><span>已分析 <strong id="scanned">0</strong></span><span>符合 <strong id="matched">0</strong></span><span>已打招呼 <strong id="sent">0</strong></span></div><nav><button id="preview">仅分析岗位</button><button id="start" class="primary">开始全自动</button><button id="pause" disabled>暂停</button><button id="stop" disabled>停止</button></nav><small id="mode">当前页投递 · 自动保存记录</small></section>';
  document.documentElement.appendChild(host);
  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = '[data-zhixiang-current]{outline:2px solid #3b64eb!important;outline-offset:2px;scroll-margin-top:110px;box-shadow:0 0 0 5px #3b64eb12!important}';
  document.documentElement.appendChild(highlightStyle);
  const currentJob = document.createElement('div'); currentJob.id = 'current-job';
  currentJob.textContent = '当前岗位会在这里显示'; currentJob.setAttribute('aria-live', 'polite');
  shadow.getElementById('panel').insertBefore(currentJob, shadow.getElementById('status'));
  const scheduleNotice = document.createElement('div'); scheduleNotice.hidden = true;
  scheduleNotice.style.cssText = 'font-size:12px;line-height:1.6;color:#8294b2;margin:0 0 8px';
  shadow.getElementById('panel').insertBefore(scheduleNotice, shadow.getElementById('status'));
  const taskPageButton = document.createElement('button'); taskPageButton.id = 'task-page'; taskPageButton.textContent = '前往任务页'; taskPageButton.hidden = true; taskPageButton.style.cssText = 'width:100%;margin-bottom:10px';
  taskPageButton.onclick = () => call('FOCUS_TASK_PAGE').catch(showError);
  shadow.getElementById('panel').insertBefore(taskPageButton, shadow.querySelector('.stats'));
  shadow.getElementById('mode').textContent = '先筛卡片 · 符合才读 JD · 发送后继续队列';
  const drawerMarkup = document.createElement('div');
  drawerMarkup.innerHTML = '<style>#current-job{margin-top:12px;padding:8px 10px;border-radius:7px;background:#edf2ff;color:#35549a;font-size:12px;overflow-wrap:anywhere}#settings-overlay{position:fixed;inset:0;background:#1d2d451c;display:grid;place-items:center;z-index:2}.settings-shell{width:min(680px,calc(100vw - 40px));height:min(760px,calc(100vh - 56px));background:#f4f6fa;border:1px solid #e3e7ef;border-radius:14px;box-shadow:0 16px 60px #22344a30;display:flex;flex-direction:column;overflow:hidden}.drawer-head{display:flex;justify-content:space-between;align-items:center;padding:11px 16px;background:#fff;border-bottom:1px solid #e3e7ef;font:13px "Microsoft YaHei",sans-serif;color:#263043}.settings-shell iframe{border:0;width:100%;flex:1;min-height:0;background:white}</style><div id="settings-overlay" hidden><div class="settings-shell" role="dialog" aria-modal="true" aria-label="qu投设置"><div class="drawer-head"><strong>qu投 · 页面内设置</strong><button id="close-settings" aria-label="关闭设置">关闭 ×</button></div><div id="settings-loading" hidden></div></div></div>';
  shadow.append(...drawerMarkup.childNodes);
  const chatNotice = document.createElement('div'); chatNotice.id = 'chat-notice'; chatNotice.hidden = true;
  chatNotice.setAttribute('role', 'alert');
  chatNotice.style.cssText = 'padding:10px 14px;background:#fff4e8;color:#8d4f21;border-bottom:1px solid #f0dcc8;font:12px/1.7 "Microsoft YaHei",sans-serif;overflow-wrap:anywhere;flex-shrink:0';
  shadow.getElementById('panel').insertBefore(chatNotice, shadow.getElementById('status'));
  let settingsFrame = null;
  function showSettings() {
    host.style.display = '';
    if (!settingsFrame) {
      settingsFrame = document.createElement('iframe'); settingsFrame.title = 'qu投设置';
      settingsFrame.src = chrome.runtime.getURL('options.html?embedded=1');
      shadow.querySelector('.settings-shell').appendChild(settingsFrame);
    }
    shadow.getElementById('settings-overlay').hidden = false;
    shadow.getElementById('close-settings').focus();
  }
  const closeSettings = () => { shadow.getElementById('settings-overlay').hidden = true; void update(); };
  shadow.getElementById('close-settings').onclick = closeSettings;
  shadow.getElementById('settings-overlay').onclick = event => { if (event.target === shadow.getElementById('settings-overlay')) closeSettings(); };
  const settingsOrigin = new URL(chrome.runtime.getURL('')).origin;
  const onSettingsMessage = event => {
    if (event.origin === settingsOrigin && event.source === settingsFrame?.contentWindow && event.data?.type === 'ZHIXIANG_CLOSE_SETTINGS') closeSettings();
  };
  const onEscape = event => { if (event.key === 'Escape') closeSettings(); };
  window.addEventListener('message', onSettingsMessage); document.addEventListener('keydown', onEscape);
  shadow.getElementById('settings').onclick = () => call('OPEN_SETTINGS').catch(showError);
  shadow.getElementById('hide').onclick = () => { shadow.getElementById('panel').hidden = true; shadow.getElementById('launcher').hidden = false; };
  shadow.getElementById('launcher').onclick = () => { shadow.getElementById('panel').hidden = false; shadow.getElementById('launcher').hidden = true; };
  shadow.getElementById('preview').onclick = () => call('START', { preview: true }).then(update).catch(showError);
  shadow.getElementById('start').onclick = () => call('START', { preview: false }).then(update).catch(showError);
  shadow.getElementById('pause').onclick = async () => { try { const state = await call('GET_STATE'); await call(state.status === 'paused' ? 'RESUME' : 'PAUSE'); } catch (e) { showError(e); } };
  shadow.getElementById('stop').onclick = () => call('STOP').catch(showError);
  function pageDiagnostics() {
    const shape = el => el ? { tag: el.tagName?.toLowerCase() || '#document', class: typeof el.className === 'string' ? el.className.slice(0, 180) : '', children: [...el.children].slice(0, 18).map(child => ({ tag: child.tagName.toLowerCase(), class: typeof child.className === 'string' ? child.className.slice(0, 180) : '' })) } : null;
    const list = cards();
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,.job-name,.job-title,.title,.section-title')].filter(el => visible(el) && !list.some(card => card.contains(el))).slice(0, 30);
    const anchors = [...document.querySelectorAll('a,button,[role="button"]')].filter(el => visible(el) && /^(立即沟通|打招呼|继续沟通)$/.test(text(el)) && !list.some(card => card.contains(el))).slice(0, 5);
    const context = el => { const ancestors = []; for (let node = el, n = 0; node && n < 5 && node !== document.body; node = node.parentElement, n++) ancestors.push(shape(node)); return ancestors; };
    const parts = detailParts();
    const chat = chatScope();
    const chatStructure = /^\/web\/geek\/chat\/?$/.test(location.pathname) ? {
      structure: shape(chat), candidates: [...document.querySelectorAll('.chat-conversation,.chat-window,.chat-container,.chat-box,.chat-im')].filter(visible).map(shape),
      panels: chat ? [...chat.querySelectorAll('.chat-header,.user-info-wrap,.chat-user-info,.chat-position,.chat-job-info,.chat-job-card,.job-info')].filter(visible).slice(0, 12).map(el => ({ text: text(el).slice(0, 350), structure: context(el) })) : [],
      inputs: [...document.querySelectorAll('#chat-input,[contenteditable="true"],textarea')].filter(visible).slice(0, 8).map(context),
      send: chat ? shape(findChatSend(chat)) : null, check: communication?.chatCheck || pageState.pendingDelivery?.identityCheck || null,
      receipt: communication?.receiptCheck || pageState.pendingDelivery?.receiptCheck || null,
      messages: chatMessageItems(document).slice(-8).map(el => ({ structure: context(el), state: messageDeliveryState(el), length: messageKey(text(el)).length, matchesGreeting: Boolean(messageKey(communication?.message.greeting || pageState.pendingDelivery?.greeting) && messageKey(text(el)).includes(messageKey(communication?.message.greeting || pageState.pendingDelivery?.greeting))) }))
    } : null;
    return JSON.stringify({ version: chrome.runtime.getManifest().version, contentVersion: CONTENT_VERSION, extensionId: chrome.runtime.id, runVersion: pageState.version, path: location.pathname, pageRole: pageState.pageRole, viewerTabId: pageState.viewerTabId, focus: lastFocus, pageVisible: document.visibilityState !== 'hidden', progress: { runId: pageState.id, sourceTabId: pageState.sourceTabId, chatTabId: pageState.deliveryTabId, sourcePageId: pageState.sourcePageId, currentPageId: pageId, queuePosition: pageState.queuePosition, queueLength: pageState.queueLength, processed: pageState.processedCount }, trace: pageState.trace || [], expectedTitle: selection?.job.title || communication?.message.job.title || pageState.pendingDelivery?.job.title || '', expectedRecipient: communication?.recipient || pageState.pendingDelivery?.recipient || null, chat: chatStructure, delivery: communication ? { clicked: communication.clicked, confirmed: Boolean(communication.defaultSent || communication.sent), sendAttempted: Boolean(communication.sendStarted), processing: communication.processing, bound: receiptBoundToJob(communication), error: communication.error || '', notices: receiptElements().filter(visible).map(el => ({ success: sentNotice.test(text(el)), actions: receiptActions(el).map(text), structure: shape(el) })) } : null, listCards: list.length, selectedCards: selectedCards().map(card => ({ id: cardInfo(card)?.id, title: cardInfo(card)?.title, class: card.className, parentClass: card.parentElement?.className || '' })), lastCheck: selection?.lastCheck || null, detail: parts ? { title: parts.title, descriptionLength: parts.description.length, salary: text(first(['.salary','.job-salary'],parts.header)), salaryFont: first(['.salary','.job-salary'],parts.header) ? getComputedStyle(first(['.salary','.job-salary'],parts.header)).fontFamily : '', ids: detailIds(parts), structure: shape(parts.root) } : null, headings: headings.map(el => ({ text: text(el).slice(0, 160), structure: context(el) })), buttons: anchors.map(el => ({ text: text(el), structure: context(el) })), descriptions: descriptionCandidates(list).slice(0, 5).map(el => ({ length: text(el).length, structure: context(el) })) }, null, 2);
  }
  const diagnosticButton = document.createElement('button'); diagnosticButton.id = 'diagnostics'; diagnosticButton.textContent = '复制页面诊断'; diagnosticButton.hidden = true; diagnosticButton.style.marginTop = '10px';
  const diagnosticText = document.createElement('textarea'); diagnosticText.id = 'diagnostic-text'; diagnosticText.hidden = true; diagnosticText.readOnly = true; diagnosticText.style.cssText = 'width:100%;height:100px;margin-top:8px'; diagnosticText.setAttribute('aria-label', '页面诊断，请复制此文本');
  shadow.getElementById('panel').append(diagnosticButton, diagnosticText);
  diagnosticButton.onclick = async () => {
    try { pageState = await call('GET_STATE'); } catch { /* Preserve the last local snapshot if disconnected. */ }
    const value = pageDiagnostics();
    try { await navigator.clipboard.writeText(value); diagnosticButton.textContent = '诊断已复制'; }
    catch { diagnosticText.value = value; diagnosticText.hidden = false; diagnosticText.focus(); diagnosticText.select(); diagnosticButton.textContent = '请复制下方诊断文本'; }
  };
  function showError(e) { host.style.display = ''; shadow.getElementById('status').textContent = e.message; diagnosticButton.hidden = false; }
  let clickApply = false;
  let pageState = { status: 'idle' };
  let updateSequence = 0;
  function renderRun(state) {
    if (state.id === pageState.id && (state.viewRevision || 0) < (pageState.viewRevision || 0)) return;
    pageState = state;
    const elsewhere = state.pageRole === 'other' && Boolean(state.sourceTabId);
    highlightJobId = elsewhere || state.pageRole === 'delivery' ? '' : state.currentJob?.id || '';
    syncHighlight();
    diagnosticButton.hidden = state.status !== 'error';
    const active = ['running', 'paused', 'stopping'].includes(state.status);
    taskPageButton.hidden = !elsewhere;
    shadow.getElementById('current-job').textContent = elsewhere ? state.currentSource || '任务在另一个页面' : active && ['loading', 'restoring', 'pagination', 'source'].includes(state.phase)
      ? (state.phase === 'source' ? '正在切换职位链接' : state.phase === 'loading' ? '正在加载下一批岗位' : state.phase === 'pagination' ? '正在加载下一页岗位' : '正在恢复列表进度')
      : state.currentJob ? state.currentJob.title + (state.currentJob.company ? ' · ' + state.currentJob.company : '') : '当前岗位会在这里显示';
    shadow.getElementById('status').textContent = elsewhere ? active ? '任务正在另一个页面运行，点击「前往任务页」查看进度。本页未参与投递。' : '任务页' + (state.status === 'completed' ? '已完成：' : '已停止：') + state.message : state.status !== 'idle' ? state.message : clickApply ? '点击岗位后自动筛选，通过后直接打招呼。' : '在这里开始分析或自动打招呼。';
    shadow.getElementById('mode').textContent = elsewhere ? '本页可正常浏览 · 投递在任务页进行' : '先筛卡片 · 符合才读 JD · 发送后继续队列';
    if (state.status === 'error' && /关闭 BOSS/.test(state.message)) {
      chatNotice.textContent = state.message; chatNotice.hidden = false;
    } else if (!communication?.defaultSent) chatNotice.hidden = true;
    for (const key of ['scanned', 'matched', 'sent']) shadow.getElementById(key).textContent = key === 'sent' && state.targetJobs && !state.preview ? (state.sent || 0) + ' / ' + state.targetJobs : state[key] || 0;
    for (const key of ['start', 'preview']) shadow.getElementById(key).disabled = active;
    shadow.getElementById('pause').disabled = !['running', 'paused'].includes(state.status);
    shadow.getElementById('pause').textContent = state.status === 'paused' ? '继续' : '暂停';
    shadow.getElementById('stop').disabled = !active;
  }
  async function update() {
    const sequence = ++updateSequence;
    try {
      const config = await call('GET_PAGE_CONFIG');
      const state = await call('GET_STATE');
      if (sequence !== updateSequence) return;
      clickApply = config.clickApply;
      scheduleNotice.hidden = !config.nextSchedule;
      if (config.nextSchedule) scheduleNotice.textContent = '下次定时：' + new Date(config.nextSchedule.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) + ' · ' + config.nextSchedule.targetJobs + ' 人';
      renderRun(state);
    } catch { /* extension can be reloaded while a page remains open */ }
  }
  update();
  const refreshTimer = setInterval(update, 3000);
  let highlightTimer = null;
  const highlightObserver = new MutationObserver(changes => {
    if (!highlightJobId || highlightTimer) return;
    const affectsCards = node => node.nodeType === 1 && (node.matches(cardSelector) || node.querySelector(cardSelector));
    if (!changes.some(change => [...change.addedNodes, ...change.removedNodes].some(affectsCards))) return;
    highlightTimer = setTimeout(() => { highlightTimer = null; syncHighlight(); }, 120);
  });
  highlightObserver.observe(document.body, { childList: true, subtree: true });
  const onJobClick = event => {
    if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href*="/job_detail/"]');
    if (!link || !listPage()) return;
    const card = link.closest('.job-card-wrapper, li.job-card-box, li.job-card, .job-list-item');
    const job = cardInfo(card || link);
    if (!job) return;
    if (['running', 'paused', 'stopping'].includes(pageState.status)) {
      if (pageState.pageRole === 'other') return;
      event.preventDefault(); event.stopImmediatePropagation(); showError(new Error('任务正在处理当前岗位；请先停止后再选择其他岗位')); return;
    }
    if (!clickApply) return;
    event.preventDefault(); event.stopImmediatePropagation();
    host.style.display = '';
    call('CLICK_JOB', { job }).catch(showError);
  };
  document.addEventListener('click', onJobClick, true);
  globalThis.__zhixiangLoaded = {
    version: CONTENT_VERSION,
    alive: () => Boolean(chrome.runtime.id),
    dispose: () => {
      clearInterval(refreshTimer); clearTimeout(highlightTimer); highlightObserver.disconnect(); receiptObserver?.disconnect(); selection?.stopDetailWatch?.(); document.removeEventListener('click', onJobClick, true); document.removeEventListener('keydown', onEscape); window.removeEventListener('message', onSettingsMessage);
      for (const card of document.querySelectorAll('[data-zhixiang-current]')) card.removeAttribute('data-zhixiang-current');
      highlightStyle.remove(); host.remove();
      try { chrome.runtime.onMessage.removeListener(onCommand); } catch { /* The previous context may already be invalid. */ }
      globalThis.__zhixiangLoaded = null;
    }
  };
})();
