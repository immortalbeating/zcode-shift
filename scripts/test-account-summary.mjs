import assert from 'node:assert/strict';
import { accountSummary, syncAge } from '../src/account-summary.js';

const now = Date.UTC(2026, 9, 29, 12);
const account = { has_user_info: true };
const grant = { name: 'GLM-5.3-Flash', units: 300000000, unit: 'token', effective_at: now + 60000 };
const data = { refreshed_at: now - 120000, plans: [{ tier_code: 'start', scheduled_grants: [grant] }], items: [] };
const summarize = (value, extra = {}) => accountSummary(account, { data: value, ...extra }, null, now);
assert.equal(summarize(data).kind, 'scheduled', 'future tokens cannot be shown as spendable');
assert.equal(summarize(data).refreshedAt, now - 120000, 'last sync must come from response');
assert.equal(accountSummary(account, { data }, null, now + 120000).kind, 'awaitingRefresh', 'time alone never creates a balance');
assert.equal(summarize({ ...data, items: [{ name: 'GLM-5.3', remaining: 21, total: 100 }, { name: 'Flash', remaining: 31, total: 100 }] }).item.remaining, 31,
  'a compact summary selects a model, never sums distinct models');
assert.equal(summarize({ items: [{ name: 'Flash', remaining: 0 }] }).kind, 'exhausted');
assert.equal(summarize({ items: [{ name: 'Flash', remaining: null }] }).kind, 'empty', 'unknown is not exhausted');
assert.equal(summarize({ remaining: 80, items: [], plans: [{ total: 100, used: 20, remaining: 80, items: [] }] }).remaining, 80, 'native scalar-only balances must remain visible');
assert.equal(summarize({ plans: [{ remaining: 0.4, items: [] }] }).kind, 'aggregate');
assert.equal(summarize({ plans: [{ remaining: 0, items: [] }] }).kind, 'exhausted');
assert.equal(summarize({ remaining: 80, items: [{ name: 'Flash', remaining: 0 }], plans: [
  { tier: 'Start', remaining: 0, items: [{ name: 'Flash', remaining: 0 }] },
  { tier: 'Pro', remaining: 80, items: [] },
] }).kind, 'aggregate', 'one exhausted named pool cannot hide another scalar-only balance');
assert.equal(summarize({ plan_tier: 'Max', plans: [{ tier: 'Start', tier_code: 'start' }, { tier: 'Max', tier_code: 'max' }] }).tier, 'max', 'respect native primary tier');
assert.equal(summarize({ plans: [{ tier_code: 'start' }, { tier_code: 'max' }] }).tier, 'max');
assert.equal(accountSummary(account, { data: { refreshed_at: 0 }, receivedAt: now }, null, now).refreshedAt, now, 'a successful empty result records actual receipt time');
assert.equal(summarize({ items: [{ name: 'Requests', kind: 'prompt_count', percent_used: 97 }, { name: 'Hours', kind: 'duration', percent_used: 42 }] }).remaining, 3,
  'rate limits show the tightest known window');
assert.equal(summarize(data, { err: 'network failed' }).kind, 'error', 'a stale success cannot hide a failed refresh');
assert.equal(summarize(data, { err: 'network failed' }).refreshedAt, now - 120000, 'failure never changes the success timestamp');
assert.equal(accountSummary({ has_user_info: false }, { data }, { plans: [{}] }, now).kind, 'relogin');
assert.equal(accountSummary(account, {}, { plans: [{}] }, now).kind, 'claimable');
assert.equal(accountSummary(account, { busy: true }, null, now).kind, 'loading');
assert.equal(accountSummary(account, {}, null, now).kind, 'unknown');
assert.equal(summarize({ plans: [{ scheduled_grants: [{ ...grant, units: NaN }] }] }).kind, 'empty');
assert.deepEqual(syncAge(null, now), { kind: 'unknown' });
assert.deepEqual(syncAge(now, now), { kind: 'now' });
assert.deepEqual(syncAge(now - 120000, now), { kind: 'minutes', count: 2 });
assert.deepEqual(syncAge(now - 7200000, now), { kind: 'hours', count: 2 });
assert.deepEqual(syncAge(now - 172800000, now), { kind: 'days', count: 2 });
console.log('PASS account summaries: future grants, model separation, rate limits, errors and honest timestamps');
