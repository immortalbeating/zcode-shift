// Synthetic IPC adapter for browser-only checks. Never reads local accounts.
export function installFixture({ language = 'zh', scenario = 'accounts' } = {}) {
  const accounts = [
    ['demo-primary', '日常开发', 'demo@example.invalid'],
    ['demo-secondary', '备用账号', 'backup@example.invalid'],
    ['demo-long-name', '用于验证很长的账号名称是否可以正确截断的测试账号', 'long-name@example.invalid'],
  ].map(([id, name, email], index) => ({ id, name, created_at: '2026-10-25 09:30',
    updated_at: '2026-10-25 09:30', is_active: index === 0, has_config: true,
    has_user_info: true, identity: { provider: 'zai', email } }));
  const state = { zcode_running: scenario === 'running', live_exists: true, live_logged_in: true,
    active_account_id: 'demo-primary', accounts: scenario === 'empty' ? [] : accounts,
    zcode_path: 'C:\\Apps\\ZCode\\ZCode.exe', zcode_path_ok: true,
    store_dir: '<synthetic fixture>', launch_after_switch: true, close_to_tray: true,
    hot_switch: true, auto_claim: scenario === 'running', auth_proxy_on: false, auth_proxy_url: '', language };
  const callbacks = new Map(), listeners = new Map();
  let callbackId = 0;
  const quota = id => ({ is_empty: false, source: 'synthetic-fixture',
    refreshed_at: Date.now(), percent_used: id === 'demo-primary' ? 24 : 6,
    items: [
      { name: 'GLM-5.3', total: 3000000, remaining: 2280000, percent_used: 24 },
      { name: 'GLM-5.3-Flash', total: 5000000, remaining: 4700000, percent_used: 6 },
    ],
    plans: [{ name: 'ZCode Start Plan', plan_id: 'demo-start', tier: 'Start', tier_code: 'start',
      expire: '2026-11-01 09:00', items: [
        { name: 'GLM-5.3', total: 3000000, remaining: 2280000, percent_used: 24 },
        { name: 'GLM-5.3-Flash', total: 5000000, remaining: 4700000, percent_used: 6 },
      ] }, ...(id === 'demo-primary' ? [{ name: 'ZCode 1024 Dev Day', plan_id: 'demo-event',
      tier: 'Start', tier_code: 'start', expire: '2026-10-26 09:00', items: [
        { name: 'GLM-5.3-Flash', total: 300000000, remaining: 282000000, percent_used: 6 },
        { name: 'GLM-5.3', total: 200000000, remaining: 152000000, percent_used: 24 },
      ] }] : [])] });
  const plan = { plan_id: 'demo-campaign', name: '周末体验礼包', description: '仅用于界面验证的合成活动',
    grants: ['GLM-5.3 · 2亿 Token'], grant_items: [{ name: 'GLM-5.3', units: 200000000, period: 'one_time' }] };
  window.__fixtureCalls = [];
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback, once) {
      const id = ++callbackId;
      callbacks.set(id, (...args) => { if (once) callbacks.delete(id); callback(...args); });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(command, args = {}) {
      window.__fixtureCalls.push({ command, args });
      if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return args.handler; }
      if (command === 'plugin:event|unlisten') return;
      if (command === 'app_version') return '1.0.1';
      if (command === 'get_state') return structuredClone(state);
      if (command === 'get_account_quota') {
        if (scenario === 'loading') return new Promise(() => {});
        if (scenario === 'error' && args.id === 'demo-secondary') throw Error('示例网络错误，请重试');
        return quota(args.id);
      }
      if (command === 'claim_preview') return args.id === 'demo-secondary' && scenario === 'accounts' ? [plan] : [];
      if (command === 'claim_refresh') return { plans: scenario !== 'running' && args.id === 'demo-secondary' ? [plan] : [] };
      if (command === 'set_language') { state.language = args.lang; return; }
      if (command === 'set_behavior') { if ('autoClaim' in args) state.auto_claim = args.autoClaim; return; }
      if (command === 'rename_account') {
        accounts.find(a => a.id === args.id).name = args.name;
        return { id: args.id, name: args.name };
      }
      if (command === 'autostart_status') return false;
      if (['reveal_main', 'open_settings', 'open_external', 'claim_cancel'].includes(command)) return;
      throw Error(`Fixture has no implementation for ${command}`);
    },
  };
}
