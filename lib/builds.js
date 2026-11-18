import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { REPO, BUILDS, MAX_RETRIES } from '../config.js';
import { getPr } from './prs.js';
import { rerunFailed } from './runs.js';
import { BUILD_FILES, recentRuns, isActive, findConflicts, slotBusy } from './build-slots.js';

// Decide whether a failed build is worth an automatic retry.
// Code patterns are checked first: a real compile or test error isn't fixed by rerunning.

const CODE_PATTERNS = [
  { re: /error TS\d+:/, label: 'TypeScript error' },
  { re: /^Tests:\s+\d+ failed/m, label: 'Test failures' },
  { re: /^e: \S+:\d+:\d+/m, label: 'Compile error' },
  { re: /\.(swift|m|mm|h|kt|java):\d+(:\d+)?: error:/, label: 'Compile error' },
  { re: /Compilation failed|BUILD FAILED.*compil/i, label: 'Compile error' },
  { re: /✖ \d+ problems? \(\d+ errors?/, label: 'Lint errors' },
];

const INFRA_PATTERNS = [
  {
    re: new RegExp([
      'Internet connection appears to be offline', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
      'Could not resolve host', 'network is unreachable', 'socket hang up',
    ].join('|'), 'i'),
    label: 'Network issue',
  },
  {
    re: /lost communication with the server|runner has received a shutdown signal|The operation was canceled\.?$/im,
    label: 'Runner lost',
  },
  { re: /No space left on device/i, label: 'Disk full' },
  {
    re: new RegExp([
      /\b(502|503|504)\b.*(Bad Gateway|Service Unavailable|Gateway Time-?out)/.source,
      /status code does not indicate success: 5\d\d/.source,
    ].join('|'), 'i'),
    label: 'Server error',
  },
];

const BY_CONCLUSION = { timed_out: 'Timed out', startup_failure: 'Failed to start' };

export function classifyFailure(conclusion, reason) {
  if (BY_CONCLUSION[conclusion]) return { kind: 'infra', label: BY_CONCLUSION[conclusion] };
  const text = (reason?.lines ?? []).join('\n');
  for (const pattern of CODE_PATTERNS) if (pattern.re.test(text)) return { kind: 'code', label: pattern.label };
  for (const pattern of INFRA_PATTERNS) if (pattern.re.test(text)) return { kind: 'infra', label: pattern.label };
  return { kind: 'unknown', label: 'Unknown failure' };
}

const SKEW_MS = 10000;
const RETRYABLE = new Set(['failure', 'timed_out', 'startup_failure']);
const ERROR_LINE = /error|failed|failure|fatal|exception/i;
const GENERIC_LINE = /Process completed with exit code/;

// Pull the most telling lines out of a `gh run view --log-failed` dump.
// Each line looks like "<job>\t<step>\t<timestamp> <message>".
function cleanLogLine(line) {
  const parts = line.split('\t');
  const message = parts.length >= 3 ? parts.slice(2).join('\t') : line;
  return message
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '')
    .replace(/(\u001b|\^\[)\[[0-9;]*m/g, '')
    .replace(/^##\[error\]/, '')
    .trim()
    .slice(0, 300);
}

// The last `max` distinct lines, in their original order.
function lastDistinct(candidates, max) {
  const out = [];
  for (let i = candidates.length - 1; i >= 0 && out.length < max; i--) {
    if (!out.includes(candidates[i])) out.unshift(candidates[i]);
  }
  return out;
}

export function extractReason(log, max = 3) {
  const lines = log.split('\n').map(cleanLogLine)
    .filter((l) => l.replace(/\[[^\]]*\]:?/g, '').trim()); // drop lines that are only [tags]
  const useful = lines.filter((l) => !GENERIC_LINE.test(l));
  const errors = lastDistinct(useful.filter((l) => ERROR_LINE.test(l)), max);
  return errors.length ? errors : lastDistinct(useful, max);
}

async function failureReason(gh, runId) {
  try {
    const { jobs = [] } = await gh.json(['run', 'view', String(runId), '-R', REPO, '--json', 'jobs']);
    const job = jobs.find((j) => RETRYABLE.has(j.conclusion));
    if (!job) return { step: 'Unknown step', lines: [] };
    const step = job.steps?.find((st) => RETRYABLE.has(st.conclusion));
    const log = await gh.run(['run', 'view', '-R', REPO, '--job', String(job.databaseId), '--log-failed']);
    // fullText is only for classification; it's dropped before the build is stored.
    return { step: step ? `${job.name} › ${step.name}` : job.name, lines: extractReason(log), fullText: log };
  } catch (err) {
    return { step: 'Could not read the failure log', lines: [err.message] };
  }
}

export class BuildRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BuildRequestError';
    this.status = status;
  }
}

export function matchRun(runs, build, claimed) {
  const earliest = build.triggeredAt - SKEW_MS;
  return runs
    .filter((run) => !claimed.has(run.databaseId) && Date.parse(run.createdAt) >= earliest)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
}

const KEEP_MS = 7 * 864e5; // finished builds stay in the list for a week

function load(file, at) {
  if (!file) return [];
  let saved;
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; } // missing or unreadable: start empty
  if (!Array.isArray(saved)) return [];
  return saved.filter((b) => b && b.status !== 'completed' || at - (b?.triggeredAt ?? 0) < KEEP_MS);
}

export function save(file, builds) {
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(builds), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function checkKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => Object.hasOwn(BUILDS, k))) {
    throw new BuildRequestError('Pick at least one known build.', 400);
  }
}

function checkBuildable(pr, prNumber) {
  if (pr.state !== 'OPEN') throw new BuildRequestError(`PR #${prNumber} is not open.`, 409);
  if (pr.reviewDecision !== 'APPROVED') throw new BuildRequestError(`PR #${prNumber} is not approved.`, 409);
  if (pr.isCrossRepository) {
    throw new BuildRequestError(`PR #${prNumber} comes from a fork; build it from GitHub directly.`, 409);
  }
}

function dispatchWorkflow(gh, { file, buildType }, ref) {
  return gh.run(['workflow', 'run', file, '-R', REPO, '--ref', ref,
    '-f', `buildType=${buildType}`, '-f', 'sendReleaseUpdates=false']);
}

function startFailedError(label, err, made) {
  const sent = made.map((b) => b.label).join(', ') || 'none';
  const error = new BuildRequestError(`${label} failed to start: ${err.message}. Started: ${sent}.`, 502);
  error.started = made.map((b) => b.key);
  return error;
}

function listDispatchRuns(gh, build) {
  return gh.json(['run', 'list', '-R', REPO, '-w', build.file, '-b', build.branch,
    '-e', 'workflow_dispatch', '-L', '10', '--json', 'databaseId,createdAt,status,conclusion,url,attempt']);
}

function markRunning(build, run) {
  build.status = run.status;
  build.conclusion = null;
}

function markQueuedForRetry(build) {
  build.retries += 1;
  build.waitAttempt = build.attempt + 1;
  build.status = 'queued';
  build.conclusion = null;
}

// Builds started here, saved to `file` so a restart keeps watching (and retrying) them.
export function createTracker(gh, now = () => Date.now(), { file = null } = {}) {
  const builds = load(file, now());
  let seq = builds.length;

  function newBuild(prNumber, key, branch) {
    const { file: workflowFile, label } = BUILDS[key];
    return {
      id: `${now()}-${++seq}`, prNumber, key, label, file: workflowFile, branch,
      triggeredAt: now(), runId: null, url: null, status: 'requested', conclusion: null,
      attempt: 1, retries: 0, maxRetries: MAX_RETRIES, waitAttempt: 0, reason: null, classification: null,
    };
  }

  // Fresh reads: a cached list could miss a build that started seconds ago.
  async function activeSnapshot() {
    const lists = await Promise.all(BUILD_FILES.map((f) => recentRuns(gh, f, { fresh: true })));
    return Object.fromEntries(BUILD_FILES.map((f, i) => [f, lists[i].filter(isActive)]));
  }

  async function check(prNumber) {
    const pr = await getPr(gh, prNumber);
    const active = await activeSnapshot();
    return { branch: pr.headRefName, conflicts: findConflicts({ keys: Object.keys(BUILDS), branch: pr.headRefName, active, tracked: builds }) };
  }

  async function trigger(prNumber, keys, { force = [] } = {}) {
    checkKeys(keys);
    const pr = await getPr(gh, prNumber);
    checkBuildable(pr, prNumber);
    const found = findConflicts({ keys, branch: pr.headRefName, active: await activeSnapshot(), tracked: builds });
    const blocked = Object.fromEntries(Object.entries(found).filter(([key, list]) => list.length && !force.includes(key)));
    if (Object.keys(blocked).length) {
      throw Object.assign(new BuildRequestError('A build like this is already running. Nothing was started.', 409), { conflicts: blocked });
    }
    const made = [];
    for (const key of keys) {
      try {
        await dispatchWorkflow(gh, BUILDS[key], pr.headRefName);
      } catch (err) {
        throw startFailedError(BUILDS[key].label, err, made);
      }
      const build = newBuild(prNumber, key, pr.headRefName);
      builds.push(build);
      made.push(build);
      save(file, builds); // per build, so a later failed start can't lose the ones already sent
    }
    return made;
  }

  async function recordFailure(build, run) {
    const { fullText, ...reason } = await failureReason(gh, run.databaseId);
    build.reason = reason;
    // A compile error can sit far above the last few error lines, so classify the whole log.
    build.classification = classifyFailure(run.conclusion, { lines: [fullText ?? reason.lines.join('\n')] });
  }

  async function retry(build, run) {
    try {
      await rerunFailed(gh, run.databaseId);
      markQueuedForRetry(build);
    } catch (err) {
      const reason = { step: 'Automatic retry failed', lines: [err.message] };
      Object.assign(build, { status: 'completed', conclusion: run.conclusion, reason });
    }
  }

  // A second iOS build of the same app fails on TestFlight, so an iOS retry waits for its slot; the queue resumes it.
  async function slotFree(build) {
    if (!['mcIos', 'mkIos'].includes(build.key)) return true;
    return !slotBusy({ file: build.file, active: await activeSnapshot(), tracked: builds, excludeBuildId: build.id });
  }

  async function settle(build, run) {
    build.attempt = run.attempt ?? build.attempt;
    if (run.status !== 'completed') return markRunning(build, run);
    const failed = RETRYABLE.has(run.conclusion);
    if (failed) await recordFailure(build, run);
    if (failed && build.classification.kind !== 'code' && build.retries < MAX_RETRIES) {
      if (await slotFree(build)) return retry(build, run);
      return Object.assign(build, { status: 'waiting-slot', waitingSince: now(), pendingRun: run.databaseId, conclusion: run.conclusion });
    }
    build.status = 'completed';
    build.conclusion = run.conclusion || null;
  }

  async function refreshOnce() {
    const claimed = new Set(builds.filter((b) => b.runId).map((b) => b.runId));
    for (const build of builds) {
      if (build.status === 'completed' || build.status === 'waiting-slot') continue;
      const runs = await listDispatchRuns(gh, build);
      const run = build.runId ? runs.find((r) => r.databaseId === build.runId) : matchRun(runs, build, claimed);
      if (!run) continue;
      claimed.add(run.databaseId);
      build.runId = run.databaseId;
      build.url = run.url;
      // After a rerun, GitHub briefly still reports the old attempt; wait for the new one.
      if ((run.attempt ?? 1) < build.waitAttempt) continue;
      await settle(build, run);
      save(file, builds);
    }
    return builds;
  }

  // The page and the server's background loop both refresh; share one pass so a failure is rerun once.
  let inFlight = null;
  function refresh() {
    inFlight ??= refreshOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function resumeRetry(build) {
    await retry(build, { databaseId: build.pendingRun, conclusion: build.conclusion });
    delete build.waitingSince;
    delete build.pendingRun;
    save(file, builds);
  }

  function cancelWait(id) {
    const build = builds.find((b) => b.id === id && b.status === 'waiting-slot');
    if (!build) return false;
    Object.assign(build, { status: 'completed', reason: { ...build.reason, step: 'Retry cancelled' } });
    delete build.waitingSince;
    delete build.pendingRun;
    save(file, builds);
    return true;
  }

  return {
    trigger, check, activeSnapshot, refresh, resumeRetry, cancelWait,
    list: () => builds,
    waitingRetries: () => builds.filter((b) => b.status === 'waiting-slot').sort((a, b) => a.waitingSince - b.waitingSince),
  };
}
