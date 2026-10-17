(function (scope) {
  'use strict';
  // Serialized into the native page's MAIN world. Only the current task's BOSS
  // chat destination is captured; other destinations and back/forward stay native.
  function chatNavigation(action, token) {
    const key = '__qutouChatNavigation';
    const previous = window[key];
    if (action !== 'arm') {
      if (!previous || previous.token !== token) return { error: '当前岗位的聊天跳转任务不存在' };
      if (action === 'clear') { previous.dispose(); return { cleared: true }; }
      previous.renew();
      return { url: previous.url, method: previous.method, error: previous.error };
    }
    previous?.dispose();
    if (!window.navigation?.addEventListener) throw new Error('当前浏览器不支持保留列表的聊天跳转，请更新 Edge 后再试');
    const nativeOpen = window.open;
    const state = { token, url: '', method: '', error: '' };
    function chatUrl(value) {
      try {
        const url = new URL(value, location.href);
        return url.origin === 'https://www.zhipin.com' && !url.username && !url.password && /^\/web\/geek\/chat\/?$/.test(url.pathname) ? url.href : '';
      } catch { return ''; }
    }
    function capture(url, method) {
      if (state.url && state.url !== url) {
        const identity = value => {
          const params = new URL(value).searchParams;
          return { job: params.get('jobId') || params.get('encryptJobId'), boss: params.get('id') || params.get('bossId') || params.get('encryptBossId') };
        };
        const before = identity(state.url), after = identity(url);
        if (!before.job || !before.boss || before.job !== after.job || before.boss !== after.boss) {
          state.error = '同一次沟通出现不同聊天入口，已停止'; return;
        }
      }
      state.url = url; state.method = method;
    }
    const navigate = event => {
      const url = chatUrl(event.destination.url);
      if (!url || event.navigationType === 'traverse') return;
      if (!event.cancelable) { state.error = '浏览器未允许阻止本次聊天跳转，原列表可能已变化'; return; }
      event.preventDefault();
      capture(url, 'navigation:' + event.navigationType);
    };
    const open = function (value, ...args) {
      const url = chatUrl(value);
      if (!url) return nativeOpen.call(this, value, ...args);
      capture(url, 'window.open'); return null;
    };
    window.navigation.addEventListener('navigate', navigate);
    window.open = open;
    let timer;
    state.renew = () => { clearTimeout(timer); timer = setTimeout(() => state.dispose(), 45000); };
    state.dispose = () => {
      clearTimeout(timer);
      window.navigation.removeEventListener('navigate', navigate);
      if (window.open === open) window.open = nativeOpen;
      if (window[key] === state) delete window[key];
    };
    window[key] = state;
    state.renew();
    return { armed: true };
  }
  scope.BossChatNavigation = chatNavigation;
  if (typeof module !== 'undefined' && module.exports) module.exports = chatNavigation;
})(globalThis);
