// Explicit live verification, using the same backend and official passive
// captcha as the desktop app. No desktop input or focus is requested.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = key => args[args.indexOf(key) + 1];
for (const key of ['--exe', '--id', '--plan-id', '--out']) {
  if (!args.includes(key) || !arg(key) || arg(key).startsWith('--')) throw Error(`Missing ${key}`);
}
const exe = resolve(arg('--exe')), id = arg('--id'), planId = arg('--plan-id');
const output = resolve(arg('--out'));
const exec = promisify(execFile);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const accountDir = join(process.env.USERPROFILE, '.zcode-switch', 'accounts');
const fingerprints = () => Object.fromEntries(readdirSync(accountDir).filter(p => p.endsWith('.json'))
  .map(p => [p, hash(join(accountDir, p))]));
const beforeHashes = fingerprints();
const settingsPath = join(process.env.USERPROFILE, '.zcode-switch', 'settings.json');
const settingsHash = hash(settingsPath);
const report = { accountId: id, planId, executable: exe, sha256: hash(exe),
  startedAt: new Date().toISOString(), renderer: 'WebView2 (default renderer, GPU not disabled)',
  input: 'Official passive verification in hidden, non-focusable window; no desktop input' };
mkdirSync(dirname(output), { recursive: true });
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const run = async argv => {
  try {
    const { stdout } = await exec(exe, argv, { windowsHide: true, timeout: 65000, maxBuffer: 2 ** 20 });
    return JSON.parse(stdout.trim());
  } catch (error) {
    if (error.stdout?.trim()) {
      try { return JSON.parse(error.stdout.trim()); } catch { /* report process error */ }
    }
    throw Error(`Process failed: ${error.code ?? error.message}`);
  }
};
try {
  report.before = await run(['--cli', 'quota', '--id', id]);
  if (report.before.ok !== true) throw Error('Before quota query failed; no claim attempted');
  report.hadPlanBefore = report.before.plans?.some(p => p.plan_id === planId) ?? false;
  if (report.hadPlanBefore) throw Error('Requested plan already exists; no claim attempted');
  const preview = await run(['--cli', 'claim-preview', '--id', id]);
  const account = preview.accounts?.find(a => a.id === id);
  if (!preview.ok || account?.error || !account) throw Error(account?.error || 'Preview failed');
  report.discoveredPlans = account.plans;
  const plan = account.plans.find(p => p.plan_id === planId);
  if (!plan) throw Error('Requested plan is not currently offered; no claim attempted');
  save();
  if (!args.includes('--execute')) {
    report.status = 'preflight_only';
  } else {
    report.result = await run(['--claim-once', '--id', id, '--plan-id', planId]);
    delete report.result.accountName;
    report.after = await run(['--cli', 'quota', '--id', id]);
    const afterPreview = await run(['--cli', 'claim-preview', '--id', id]);
    const remaining = afterPreview.accounts?.find(a => a.id === id);
    report.stillOffered = remaining?.plans?.some(p => p.plan_id === planId) ?? null;
    const received = report.after.plans?.find(p => p.plan_id === planId);
    const grants = plan.grant_items || [];
    report.grantsVerified = grants.length > 0 && grants.every(grant =>
      received?.items?.some(item => item.name === grant.name && item.total === grant.units));
    report.status = report.result.ok === true && report.result.planId === planId
      && report.result.accountId === id && report.hadPlanBefore === false
      && report.after.ok === true && report.grantsVerified
      && afterPreview.ok === true && !remaining?.error && report.stillOffered === false
      ? 'PASS' : 'NOT_VERIFIED';
  }
} catch (error) {
  report.status = 'ERROR';
  report.error = error.message;
} finally {
  const afterHashes = fingerprints();
  report.accountFilesUnchanged = Object.keys(beforeHashes).length === Object.keys(afterHashes).length
    && Object.entries(beforeHashes).every(([p, h]) => afterHashes[p] === h);
  report.settingsUnchanged = hash(settingsPath) === settingsHash;
  if (report.status === 'PASS' && (!report.accountFilesUnchanged || !report.settingsUnchanged)) {
    report.status = 'NOT_VERIFIED';
  }
  report.finishedAt = new Date().toISOString();
  save();
}
console.log(JSON.stringify({status: report.status, output, result: report.result,
  grantsVerified: report.grantsVerified, accountFilesUnchanged: report.accountFilesUnchanged,
  settingsUnchanged: report.settingsUnchanged}, null, 2));
if (!['PASS', 'preflight_only'].includes(report.status)) process.exitCode = 1;
