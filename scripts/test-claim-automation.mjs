import assert from 'node:assert/strict';
import { claimIntervalMs, claimRetryAt, discoverAccounts } from '../src/claim-automation.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
assert.equal(claimIntervalMs(2), 120000);
assert.equal(claimIntervalMs(10), 600000);
assert.equal(claimIntervalMs(3), 300000);

// Discovery can run in parallel but the consumer serializes actual submissions.
const gates = new Map(['a', 'b', 'c'].map(id => [id, deferred()]));
const started = [], consumed = [];
let inFlight = 0, maxInFlight = 0, submitting = 0, maxSubmitting = 0;
const consumeGate = deferred();
const run = (async () => {
  for await (const result of discoverAccounts(['a', 'b', 'c'], async id => {
    started.push(id); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try { return await gates.get(id).promise; } finally { inFlight--; }
  })) {
    submitting++; maxSubmitting = Math.max(maxSubmitting, submitting); consumed.push(result.id);
    if (result.id === 'a') await consumeGate.promise;
    submitting--;
  }
})();
await turn();
assert.deepEqual(started, ['a', 'b']);
gates.get('a').resolve('a'); await turn();
assert.deepEqual(consumed, ['a']);
assert.deepEqual(started, ['a', 'b', 'c']);
gates.get('b').resolve('b'); gates.get('c').resolve('c'); await turn();
assert.deepEqual(consumed, ['a']);
consumeGate.resolve(); await run;
assert.equal(maxInFlight, 2);
assert.equal(maxSubmitting, 1);
assert.deepEqual(new Set(consumed), new Set(['a', 'b', 'c']));

// Closing a round waits for outstanding discovery, including rejection, before a new round can start.
let active = true, finished = false;
const cancelGates = [deferred(), deferred()];
const unhandled = [];
const onUnhandled = reason => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
const cancelled = (async () => {
  for await (const item of discoverAccounts(['a', 'b', 'c'], id => cancelGates[id === 'a' ? 0 : 1].promise, () => active)) {
    assert.equal(item.id, 'a'); active = false;
  }
  finished = true;
})();
await turn(); cancelGates[0].resolve('a'); await turn();
assert.equal(finished, false, 'cancel must drain pending discovery before the round completes');
cancelGates[1].reject(new Error('simulated discovery failure'));
await cancelled; await turn();
assert.equal(finished, true);
assert.deepEqual(unhandled, []);
process.removeListener('unhandledRejection', onUnhandled);

const now = 100000;
assert.equal(claimRetryAt({code: 429, nextAt: now + 123}, 1, now), now + 123);
assert.equal(claimRetryAt({code: 1005, nextAt: now + 123}, 1, now), now + 123);
assert.equal(claimRetryAt({code: 503, nextAt: now + 123}, 1, now), now + 123);
assert.equal(claimRetryAt({code: 429, nextAt: now - 1}, 2, now), now + 120000);
assert.equal(claimRetryAt({message: 'HTTP 429'}, 20, now), now + 900000);
assert.equal(claimRetryAt({code: 'interactive'}, 1, now), now + 3600000);
assert.equal(claimRetryAt({code: 401}, 1, now), now + 3600000);
assert.equal(claimRetryAt({message: 'HTTP 401 Unauthorized'}, 1, now), now + 3600000);
assert.equal(claimRetryAt({message: 'HTTP 403 Forbidden'}, 1, now), now + 3600000);
assert.equal(claimRetryAt({code: 503, nextAt: now + 456}, 1, now), now + 456);
assert.equal(claimRetryAt({code: 500}, 1, now), now + 30000);
assert.equal(claimRetryAt({code: 500}, 20, now), now + 600000);

// Load fresh module instances to exercise malformed and unavailable storage.
const storage = new Map([['zshift.claim-monitor.v1', '{not-json']]);
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } };
const monitor = await import('../src/claim-monitor.js?test=corrupt');
assert.deepEqual(monitor.claimSnapshot().records, []);
for (let i = 0; i < 35; i++) monitor.recordClaim({accountId:'a', planId:`p${i}`, status:'success', at:i, credentials:'secret', token:'secret'});
const saved = JSON.parse(storage.get('zshift.claim-history.v1'));
assert.equal(saved.records.length, 30);
assert.equal(saved.records[0].planId, 'p34');
assert.equal(saved.records[29].planId, 'p5');
assert.ok(saved.records.every(record => !('credentials' in record) && !('token' in record)));
const copy = monitor.claimSnapshot(); copy.records[0].planId = 'changed';
assert.equal(monitor.claimSnapshot().records[0].planId, 'p34');
const staleWindow = await import('../src/claim-monitor.js?test=stale-window');
assert.equal(staleWindow.claimSnapshot().records.length, 30);
monitor.clearClaimRecords();
// Simulate a progress write before the stale window receives a storage event.
staleWindow.claimProgress({ phase: 'discovering' });
assert.deepEqual(JSON.parse(storage.get('zshift.claim-history.v1')).records, []);
assert.deepEqual(staleWindow.claimSnapshot().records, []);
// Pause a stale record write just before it stores, then clear from the other window.
monitor.recordClaim({accountId:'a', planId:'before-clear', status:'success'});
let injectedClear = false, staleWrite;
globalThis.localStorage.setItem = (key, value) => {
  if (key === 'zshift.claim-history.v1' && !injectedClear) {
    injectedClear = true;
    staleWrite = JSON.parse(value);
    monitor.clearClaimRecords();
  }
  storage.set(key, value);
};
staleWindow.recordClaim({accountId:'a', planId:'racing-write', status:'success'});
assert.equal(injectedClear, true);
assert.ok(staleWrite.records.some(record => record.planId === 'before-clear'));
assert.notEqual(staleWrite.epoch, storage.get('zshift.claim-history-clear.v1'));
assert.deepEqual(monitor.claimSnapshot().records, []);
assert.deepEqual(staleWindow.claimSnapshot().records, []);
globalThis.localStorage = { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); } };
const disabled = await import('../src/claim-monitor.js?test=disabled');
disabled.recordClaim({accountId:'a', planId:'b', status:'success'});
assert.equal(disabled.claimSnapshot().records.length, 1);
console.log('PASS claim automation: bounded discovery, serialized consumer, cancellation drain, retry classes, safe history');
