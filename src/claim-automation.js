export const claimIntervalMs = (minutes) => ([2, 5, 10].includes(minutes) ? minutes : 5) * 60_000;

// Discovery can overlap. The consumer still awaits each actual claim in turn.
export async function* discoverAccounts(ids, discover, canContinue = () => true, concurrency = 2) {
  const pending = new Map();
  let cursor = 0;
  const launch = () => {
    while (pending.size < concurrency && cursor < ids.length && canContinue()) {
      const id = ids[cursor++];
      pending.set(id, Promise.resolve().then(() => discover(id)).then(
        value => ({ id, value }), error => ({ id, error })));
    }
  };
  launch();
  try {
    while (pending.size && canContinue()) {
      const result = await Promise.race(pending.values());
      pending.delete(result.id);
      launch();
      yield result;
    }
  } finally {
    // Do not declare a round finished while its in-flight queries still run.
    await Promise.allSettled(pending.values());
  }
}

export function claimRetryAt(result, failures = 1, now = Date.now()) {
  const code = result?.code ?? Number(String(result?.message || "").match(/HTTP\s+(\d{3})\b/i)?.[1]);
  result = { ...result, code };
  if ([1005, 429, 503].includes(result?.code) && Number.isFinite(result.nextAt) && result.nextAt > now) return result.nextAt;
  if (result?.code === 429 || /HTTP\s*429/i.test(String(result?.message || ""))) return now + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(4, failures - 1));
  if (result?.code === "interactive" || [401, 403].includes(code) || (Number.isFinite(code) && code >= 1000)) return now + 60 * 60_000;
  return now + Math.min(10 * 60_000, 30_000 * 2 ** Math.min(5, failures - 1));
}
