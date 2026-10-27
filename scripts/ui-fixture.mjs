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
    hot_switch: true, auto_claim: scenario === 'running', auto_claim_interval_minutes: 5, zcode_path_custom: false, auth_proxy_on: false, auth_proxy_url: 'http://127.0.0.1:7000', language };
  if (scenario === 'long-settings') {
    state.zcode_path = `C:\\Applications\\${'Long directory name\\'.repeat(16)}ZCode.exe`;
    state.auth_proxy_url = 'http://127.0.0.1:7890';
    state.auth_proxy_on = true;
  }
  const callbacks = new Map(), listeners = new Map();
  let autostartEnabled = false;
  let callbackId = 0;
  const quota = id => {
    if (id === 'demo-primary' && ['scheduled', 'global-active'].includes(scenario)) {
      const scheduled = scenario === 'scheduled';
      const items = scheduled ? [] : [{ name: 'GLM-5.3-Flash', total: 300000000,
        remaining: 300000000, percent_used: 0 }];
      return { is_empty: scheduled, source: 'synthetic-fixture', refreshed_at: Date.now(),
        plan_tier: 'Start Plan', plan_expire: '2026-10-27 09:00', items,
        plans: [{ name: 'ZCODE GLOBAL BUILD', plan_id: 'demo-global-build', tier: 'Start Plan',
          tier_code: 'start', expire: '2026-10-27 09:00', items,
          scheduled_grants: scheduled ? [{ name: 'GLM-5.3-Flash', units: 300000000,
            unit: 'token', effective_at: 1793026800000 }] : [] }] };
    }
    const overview = { is_empty: false, source: 'synthetic-fixture',
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
      ] }] : [])] };
    if (scenario === 'scheduled' && id === 'demo-secondary') {
      overview.plans.push(quota('demo-primary').plans[0]);
    }
    return overview;
  };
  const plan = { plan_id: 'demo-campaign', name: '周末体验礼包', description: '仅用于界面验证的合成活动',
    grants: ['GLM-5.3 · 2亿 Token'], grant_items: [{ name: 'GLM-5.3', units: 200000000, period: 'one_time' }] };
  window.__fixtureCalls = [];
  window.__fixtureControl = { pathError: false, proxyError: false, proxyReachable: true, updateStatus: 'available' };
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
      if (command === 'app_version') return '1.0.4';
      if (command === 'get_state') return structuredClone(state);
      if (command === 'get_account_quota') {
        if (scenario === 'loading') return new Promise(() => {});
        if (scenario === 'error' && args.id === 'demo-secondary') throw Error('示例网络错误，请重试');
        return quota(args.id);
      }
      if (command === 'claim_preview') return args.id === 'demo-secondary' && scenario === 'accounts' ? [plan] : [];
      if (command === 'claim_refresh') return { plans: scenario !== 'running' && args.id === 'demo-secondary' ? [plan] : [] };
      if (command === 'set_language') { state.language = args.lang; return; }
      if (command === 'set_behavior') {
        for (const [argument, field] of Object.entries({autoClaim: 'auto_claim',
          launchAfterSwitch: 'launch_after_switch', closeToTray: 'close_to_tray', hotSwitch: 'hot_switch', autoClaimIntervalMinutes: 'auto_claim_interval_minutes'})) {
          if (args[argument] != null) state[field] = args[argument];
        }
        return;
      }
      if (command === 'set_auth_proxy') { if (window.__fixtureControl.proxyError) throw Error('invalid_proxy'); state.auth_proxy_on = args.on; state.auth_proxy_url = args.url; return; }
      if (command === 'set_zcode_path') { if (window.__fixtureControl.pathError) throw Error('path_missing'); state.zcode_path_custom = Boolean(args.path); state.zcode_path = args.path || 'C:\\Apps\\ZCode\\ZCode.exe'; return; }
      if (command === 'test_auth_proxy') return { reachable: window.__fixtureControl.proxyReachable, elapsedMs: 25 };
      if (command === 'check_updates') {
        const status = window.__fixtureControl.updateStatus;
        if (status === 'error') throw Error('update_network_failed');
        return { status, currentVersion: '1.0.4', latestVersion: status === 'unpublished' ? null : 'v1.0.5', releaseUrl: status === 'available' ? 'https://github.com/immortalbeating/zcode-shift/releases/tag/v1.0.5' : null };
      }
      if (command === 'autostart_set') { autostartEnabled = args.enable; return autostartEnabled; }
      if (['pick_zcode_path', 'import_pick_files', 'export_all_pick_path'].includes(command)) return {picked: false};
      if (command === 'rename_account') {
        accounts.find(a => a.id === args.id).name = args.name;
        return { id: args.id, name: args.name };
      }
      if (command === 'autostart_status') return autostartEnabled;
      if (['reveal_main', 'open_settings', 'open_external', 'claim_cancel'].includes(command)) return;
      throw Error(`Fixture has no implementation for ${command}`);
    },
  };
}
