import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { claimIntervalMs, claimRetryAt, discoverAccounts } from '../src/claim-automation.js';

const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const timers = new Map();
let serial = 0;
const listeners = new Map();
const toasts = [];
const deliver = payload => listeners.get('claim://result')({payload});
const context = vm.createContext({
  Date, Set, Map, JSON, Number, claimIntervalMs, claimRetryAt, discoverAccounts,
  claimProgress() {}, recordClaim() {}, updateClaimStatus() {},
  setTimeout(fn, ms) { const id = ++serial; if (ms <= 5000) queueMicrotask(fn); else timers.set(id, fn); return id; },
  clearTimeout(id) { timers.delete(id); },
  invoke: async () => {}, render() {}, uiLocked: () => true,
  listen: (event, handler) => listeners.set(event, handler),
  toast: (...args) => toasts.push(args), t: key => key, localeTag: () => 'en-US',
  loadAcctQuota() {}, loadClaimPreview: async () => {}, scheduleNext() {},
});
vm.runInContext(`
let claimWaiter = null;
let state = {auto_claim:true, accounts:[{id:'a'}]};
let claimable = {}, autoClaimCooldown = {}, autoClaimPlanCooldown = {};
let autoClaimRunning = false, claimActive = false, claimAllRunning = false, autoAbortRequested = false;
let refreshClaim = {running:false}, lastAutoRound = null;
let currentAttempt = null, autoClaimDue = {}, claimFailures = {}, autoClaimTimer = null, autoScheduleKey = "", autoScheduleRoute = null;
let preparedDiscoveries = new Map();
const AUTO_CLAIM_INTERVAL_MS=600000, AUTO_CLAIM_WAIT_MS=45000, AUTO_CLAIM_PER_ACCOUNT_CAP=5, AUTO_CLAIM_ACCT_GAP_MS=5000;
${slice('function waitForClaimResult(', 'async function awaitClaimPreviewFresh')}
${slice('async function awaitClaimPreviewFresh(', 'const accountName')}
${slice('function autoInterval(', 'function claimStatusHtml(')}
${slice('async function discoverClaimAccount(', 'function quotaBarHtml(')}
${slice('listen("claim://result"', 'listen("captcha://interactive"')}
globalThis.api = {startClaimAndWait, autoClaimTick, discoverClaimAccount, route:claimRouteKey,
  setRoute:(on,url)=>{state.service_proxy_on=on;state.auth_proxy_url=url;},
  prepare:(id,route,value)=>preparedDiscoveries.set(id,{route,value,at:Date.now()}),
  snapshot:()=>({claimWaiter, autoClaimCooldown,autoClaimPlanCooldown,lastAutoRound}), due:()=>{autoClaimDue={};}, reset:()=>{clearTimeout(autoClaimTimer); preparedDiscoveries.clear();claimable={};autoClaimCooldown={};autoClaimPlanCooldown={};autoClaimDue={};claimFailures={};lastAutoRound=null;}};
`, context);

// The backend can emit synchronously before its command promise resolves.
context.invoke = async () => { deliver({accountId:"a", planId:"fast", ok:true}); };
assert.equal((await context.api.startClaimAndWait('a','fast')).ok, true);
assert.equal(timers.size, 0);
context.invoke = async () => { throw Error('start failed'); };
await assert.rejects(context.api.startClaimAndWait('a','bad'), /start failed/);
assert.equal(context.api.snapshot().claimWaiter, null);
assert.equal(timers.size, 0);

// Exercise the real event listener: a late result for A cannot complete B.
context.invoke = async () => {};
const pendingB = context.api.startClaimAndWait('a', 'planB');
deliver({accountId:'a', planId:'planA', ok:true});
assert.equal(context.api.snapshot().claimWaiter?.planId, 'planB');
deliver({accountId:'other', planId:'planB', ok:true});
assert.equal(context.api.snapshot().claimWaiter?.planId, 'planB');
deliver({accountId:'a', ok:true});
assert.equal(context.api.snapshot().claimWaiter?.planId, 'planB');
deliver({accountId:'a', planId:'planB', ok:true});
assert.equal((await pendingB).planId, 'planB');
assert.equal(timers.size, 0);
toasts.length = 0;
deliver({accountId:'a', planId:'malformed'});
assert.equal(toasts.length, 1);
assert.equal(toasts[0][1], 'err', 'missing ok must not show a success toast');

const starts = [];
let previews = 0;
context.invoke = async (command, args) => {
  if (command === 'claim_refresh') return {plans:['fail','success','missing','throws'].map(plan_id=>({plan_id}))};
  if (command === 'claim_preview') { previews++; return ['fail','missing','throws'].map(plan_id=>({plan_id})); }
  if (command === 'claim_start') {
    starts.push(args.planId);
    if(args.planId==='throws') throw Error('invoke failed');
    deliver({accountId:args.id, planId:args.planId, ...(args.planId==='fail' ? {ok:false,code:1001} : args.planId==='success' ? {ok:true} : {})});
  }
};
await context.api.autoClaimTick();
assert.deepEqual(starts, ['fail','success','missing','throws']);
assert.equal(context.api.snapshot().lastAutoRound.claimed, 1);
assert.equal(previews, 1, 'only an explicit success refreshes plans');
assert.equal(Object.keys(context.api.snapshot().autoClaimPlanCooldown).length, 3);
assert.equal(Object.keys(context.api.snapshot().autoClaimCooldown).length, 0);
starts.length=0;
context.api.due();
await context.api.autoClaimTick();
assert.deepEqual(starts, ['success'], 'cooled failed plans do not block another plan');
context.api.reset();
assert.equal(timers.size, 0);
context.invoke = async () => { throw Error('query failed'); };
await context.api.autoClaimTick();
assert.ok(context.api.snapshot().autoClaimCooldown.a > Date.now());
assert.equal(context.api.snapshot().lastAutoRound.claimed, 0);
context.api.reset();
context.api.setRoute(false, 'http://127.0.0.1:7897');
context.api.prepare('a', context.api.route(), {plans:[{plan_id:'old-direct-offer'}]});
context.api.setRoute(true, 'http://127.0.0.1:7897');
let freshRouteQueries = 0;
context.invoke = async () => { freshRouteQueries++; return {plans:[{plan_id:'proxy-offer'}]}; };
assert.equal((await context.api.discoverClaimAccount('a',true)).plans[0].plan_id, 'proxy-offer');
assert.equal(freshRouteQueries, 1, 'switching routes must query again instead of reusing prepared data');
context.invoke = async () => { context.api.setRoute(false, 'http://127.0.0.1:7897'); return {plans:[{plan_id:'outdated-result'}]}; };
assert.equal((await context.api.discoverClaimAccount('a')).routeChanged, true, 'in-flight results must be discarded if the route changes');
context.api.reset();
assert.match(source, /if \(p\.ok !== true\)/, 'result toast also requires explicit success');
assert.match(source, /AUTO_CLAIM_FIRST_DELAY_MS = 1_000/);
console.log('PASS claim flow: fast event, late event isolation, cleanup, plan cooldown, strict success, query cooldown');
