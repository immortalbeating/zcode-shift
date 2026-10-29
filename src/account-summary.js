// Pick one truthful signal; never add different models or future grants together.
export function accountSummary(account, quota, preview, now = Date.now()) {
  const data = quota?.data;
  const plans = data?.plans || [];
  const ranks = { max: 5, pro: 4, lite: 3, start: 2, trial: 1 };
  const tierPlan = plans.find(p => data.plan_tier && p.tier === data.plan_tier) ||
    (data?.plan_tier ? null : [...plans].sort((a, b) => (ranks[b.tier_code] || 0) - (ranks[a.tier_code] || 0))[0]);
  const tier = tierPlan?.tier_code && ['max', 'pro', 'lite', 'start', 'trial'].includes(tierPlan.tier_code)
    ? tierPlan.tier_code : data?.plan_tier || tierPlan?.tier || (data ? 'Free' : '');
  const base = { tier, refreshedAt: Number(data?.refreshed_at) || quota?.receivedAt || null, tone: 'neutral' };
  if (account.has_user_info === false) return { ...base, kind: 'relogin', tone: 'warning' };
  if (quota?.err) return { ...base, kind: 'error', tone: 'error', detail: quota.err };
  if (!data && quota?.busy) return { ...base, kind: 'loading' };
  if (preview?.plans?.length) return { ...base, kind: 'claimable', tone: 'warning' };
  if (!data) return { ...base, kind: 'unknown' };
  const scheduled = plans.flatMap(p => p.scheduled_grants || []).filter(g =>
    Number.isFinite(g.effective_at) && Number.isFinite(g.units) && g.units > 0);
  const items = [...(data.items || []), ...plans.flatMap(p => p.items || [])];
  const windows = items.filter(it => it.kind && it.kind !== 'raw' && Number.isFinite(it.percent_used));
  if (windows.length) {
    const item = windows.reduce((a, b) => a.percent_used > b.percent_used ? a : b);
    return { ...base, kind: 'window', item, remaining: Math.max(0, Math.min(100, 100 - item.percent_used)),
      tone: item.percent_used >= 90 ? 'warning' : 'neutral' };
  }
  const pools = items.filter(it => (!it.kind || it.kind === 'raw') && Number.isFinite(it.remaining));
  const usable = pools.filter(it => it.remaining > 0).sort((a, b) => b.remaining - a.remaining)[0];
  if (usable) return { ...base, kind: 'balance', item: usable };
  const scalarPlans = plans.filter(p => !(p.items || []).length && Number.isFinite(p.remaining));
  const aggregate = scalarPlans.find(p => p.remaining > 0) ||
    (!items.length && Number.isFinite(data.remaining) ? data : scalarPlans[0]);
  if (aggregate?.remaining > 0) return { ...base, kind: 'aggregate', remaining: aggregate.remaining };
  const future = scheduled.filter(g => g.effective_at > now).sort((a, b) => a.effective_at - b.effective_at)[0];
  if (future) return { ...base, kind: 'scheduled', grant: future };
  if (scheduled.length) return { ...base, kind: 'awaitingRefresh', tone: 'warning' };
  if (pools.length || aggregate?.remaining === 0) return { ...base, kind: 'exhausted', tone: 'warning' };
  return { ...base, kind: 'empty' };
}

export function syncAge(refreshedAt, now = Date.now()) {
  if (!Number.isFinite(refreshedAt) || refreshedAt <= 0) return { kind: 'unknown' };
  const minutes = Math.floor(Math.max(0, now - refreshedAt) / 60000);
  if (minutes < 1) return { kind: 'now' };
  if (minutes < 60) return { kind: 'minutes', count: minutes };
  if (minutes < 1440) return { kind: 'hours', count: Math.floor(minutes / 60) };
  return { kind: 'days', count: Math.floor(minutes / 1440) };
}
