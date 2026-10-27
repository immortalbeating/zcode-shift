const KEY = "zshift.claim-monitor.v1";
const HISTORY_KEY = "zshift.claim-history.v1";
const CLEAR_KEY = "zshift.claim-history-clear.v1";
const MAX_RECORDS = 30;
const empty = () => ({ phase: "idle", checkedAt: null, nextAt: null, done: 0, total: 0, records: [] });
const safeText = value => typeof value === "string" ? value.slice(0, 160) : "";
const safeNumber = value => Number.isFinite(value) && value >= 0 ? value : null;
function cleanRecord(record) {
  return { accountId: safeText(record.accountId), planId: safeText(record.planId), planName: safeText(record.planName),
    status: ["success", "failed", "timeout", "interactive"].includes(record.status) ? record.status : "failed",
    at: safeNumber(record.at), elapsedMs: safeNumber(record.elapsedMs), discoveryMs: safeNumber(record.discoveryMs),
    submitMs: safeNumber(record.submitMs), code: typeof record.code === "number" ? record.code : safeText(record.code) };
}
function readHistory(fallback = []) {
  try {
    const epoch = localStorage.getItem(CLEAR_KEY) || "";
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw === null) return fallback;
    const saved = JSON.parse(raw);
    if ((localStorage.getItem(CLEAR_KEY) || "") !== epoch) return [];
    const records = Array.isArray(saved) && !epoch ? saved : saved?.epoch === epoch ? saved.records : [];
    return Array.isArray(records) ? records.filter(record => record && typeof record === "object").slice(0, MAX_RECORDS).map(cleanRecord) : [];
  } catch { return fallback; }
}
function read() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    const live = Number.isFinite(saved?.updatedAt) && Date.now() - saved.updatedAt < 120_000;
    return { ...empty(), checkedAt: safeNumber(saved?.checkedAt),
      ...(live ? { phase: ["idle", "discovering", "verifying", "submitting"].includes(saved.phase) ? saved.phase : "idle",
        accountId: safeText(saved.accountId), nextAt: safeNumber(saved.nextAt), done: safeNumber(saved.done) || 0, total: safeNumber(saved.total) || 0 } : {}),
      records: readHistory() };
  } catch { return empty(); }
}
let snapshot = read();
export const claimSnapshot = () => ({ ...snapshot, records: readHistory(snapshot.records).map(record => ({ ...record })) });
export function claimProgress(patch) {
  snapshot = { ...snapshot, ...patch, records: readHistory(snapshot.records) };
  // Progress never writes history, so a stale window cannot undo a clear.
  try { localStorage.setItem(KEY, JSON.stringify({ checkedAt: snapshot.checkedAt,
    phase: snapshot.phase, accountId: safeText(snapshot.accountId), nextAt: snapshot.nextAt,
    done: snapshot.done, total: snapshot.total, updatedAt: Date.now() })); } catch { /* available in memory when storage is disabled */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event("claim-monitor"));
}
export function recordClaim(record) {
  let epoch = "";
  try { epoch = localStorage.getItem(CLEAR_KEY) || ""; } catch { /* keep in memory */ }
  snapshot.records = [cleanRecord(record), ...readHistory(snapshot.records)].slice(0, MAX_RECORDS);
  // A concurrent clear advances a separate epoch. An old read/write cannot revive old entries.
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify({ epoch, records: snapshot.records })); } catch { /* keep in memory */ }
  claimProgress({});
}
export function clearClaimRecords() {
  snapshot.records = [];
  try {
    const epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLEAR_KEY, epoch);
    localStorage.setItem(HISTORY_KEY, JSON.stringify({ epoch, records: [] }));
  } catch { /* keep in memory */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event("claim-monitor"));
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === KEY || event.key === HISTORY_KEY || event.key === CLEAR_KEY) { snapshot = read(); window.dispatchEvent(new Event("claim-monitor")); }
});
