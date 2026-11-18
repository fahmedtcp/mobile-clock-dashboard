// Which build runs are in flight, and which new builds would collide with them.
// iOS: one TestFlight build per app at a time, on any branch, by anyone. Every build: one per workflow per branch.
import { REPO } from '../public/shared.js';
import { BUILDS } from '../config.js';

export const BUILD_FILES = ['run-mc-ios.yml', 'run-mk-ios.yml', 'run-mc-android.yml', 'run-mk-android.yml'];
export const IOS_SLOTS = { 'run-mc-ios.yml': 'iOS MobileClock', 'run-mk-ios.yml': 'iOS MobileKiosk' };
const SLOT_KEYS = new Set(['mcIos', 'mkIos']); // the Simulator .app build doesn't upload to TestFlight
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

export const isActive = (run) => ACTIVE.has(run.status);
export const ticketKeyOf = (branch) => String(branch ?? '').match(/^(tcpmob-\d+)/i)?.[1].toUpperCase() ?? null;

// `gh api` rather than `gh run list`: only the REST shape carries the actor, on both the direct path and the CLI.
export async function recentRuns(gh, file, { fresh = false, actor = null, since = null, perPage = 30 } = {}) {
  const args = ['api', `repos/${REPO}/actions/workflows/${file}/runs`, '-X', 'GET', '-f', `per_page=${perPage}`];
  if (actor) args.push('-f', `actor=${actor}`);
  if (since) args.push('-f', `created=>=${since}`);
  const res = await gh.json(args, fresh ? { fresh: true } : undefined);
  return (Array.isArray(res?.workflow_runs) ? res.workflow_runs : []).map((r) => ({
    runId: r.id, file, url: r.html_url, branch: r.head_branch, actor: r.actor?.login ?? null, status: r.status,
    conclusion: r.conclusion ?? null, createdAt: r.created_at, startedAt: r.run_started_at, updatedAt: r.updated_at, attempt: r.run_attempt,
  }));
}

const conflict = (rule, { runId = null, url = null, branch, actor = null, startedAt = null }) =>
  ({ rule, runId, url, branch, actor, startedAt, ticketKey: ticketKeyOf(branch) });

const REQUESTED_HOLD_MS = 10 * 60000; // a dispatch whose run never shows up stops holding the slot after this

// Tracker builds GitHub may not list yet (just dispatched) or lists as finished (between retry attempts).
function heldByTracker(file, tracked, excludeBuildId, now) {
  return tracked.filter((b) => b.id !== excludeBuildId && BUILDS[b.key]?.file === file && SLOT_KEYS.has(b.key)
    && ((b.status === 'requested' && now - (b.triggeredAt ?? 0) < REQUESTED_HOLD_MS) || (b.status === 'queued' && b.waitAttempt > b.attempt)))
    .map((b) => ({ runId: b.runId ?? null, url: b.url ?? null, branch: b.branch, startedAt: b.triggeredAt ? new Date(b.triggeredAt).toISOString() : null }));
}

function slotHolders(file, active, tracked, excludeBuildId, now = Date.now()) {
  const simRuns = new Set(tracked.filter((b) => b.key === 'mcIosSim' && b.runId).map((b) => b.runId));
  const own = new Set(tracked.filter((b) => b.id === excludeBuildId && b.runId).map((b) => b.runId));
  const runs = (active[file] ?? []).filter((r) => !simRuns.has(r.runId) && !own.has(r.runId));
  const seen = new Set(runs.map((r) => r.runId));
  return [...runs, ...heldByTracker(file, tracked, excludeBuildId, now).filter((h) => h.runId === null || !seen.has(h.runId))];
}

export function slotBusy({ file, active, tracked, excludeBuildId = null, now = Date.now() }) {
  const holder = slotHolders(file, active, tracked, excludeBuildId, now)[0];
  return holder ? conflict('ios-slot', holder) : null;
}

export function findConflicts({ keys, branch, active, tracked, now = Date.now() }) {
  return Object.fromEntries(keys.map((key) => {
    const { file } = BUILDS[key];
    const holders = SLOT_KEYS.has(key) ? slotHolders(file, active, tracked, null, now) : (active[file] ?? []);
    const out = holders.filter((r) => r.branch === branch).map((r) => conflict('same-branch', r));
    if (SLOT_KEYS.has(key)) out.push(...holders.filter((r) => r.branch !== branch).map((r) => conflict('ios-slot', r)));
    return [key, out];
  }));
}
