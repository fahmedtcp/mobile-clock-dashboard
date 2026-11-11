import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { REPO, BUILDS, MAX_RETRIES } from '../config.js';
import { getPr } from './prs.js';
import { rerunFailed } from './runs.js';

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
  { re: /Internet connection appears to be offline|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|Could not resolve host|network is unreachable|socket hang up/i, label: 'Network issue' },
  { re: /lost communication with the server|runner has received a shutdown signal|The operation was canceled\.?$/im, label: 'Runner lost' },
  { re: /No space left on device/i, label: 'Disk full' },
  { re: /\b(502|503|504)\b.*(Bad Gateway|Service Unavailable|Gateway Time-?out)|status code does not indicate success: 5\d\d/i, label: 'Server error' },
];

const BY_CONCLUSION = { timed_out: 'Timed out', startup_failure: 'Failed to start' };

export function classifyFailure(conclusion, reason) {
  if (BY_CONCLUSION[conclusion]) return { kind: 'infra', label: BY_CONCLUSION[conclusion] };
  const text = (reason?.lines ?? []).join('\n');
  for (const p of CODE_PATTERNS) if (p.re.test(text)) return { kind: 'code', label: p.label };
  for (const p of INFRA_PATTERNS) if (p.re.test(text)) return { kind: 'infra', label: p.label };
  return { kind: 'unknown', label: 'Unknown failure' };
}

const SKEW_MS = 10000;
const RETRYABLE = new Set(['failure', 'timed_out', 'startup_failure']);
const ERROR_LINE = /error|failed|failure|fatal|exception/i;
const GENERIC_LINE = /Process completed with exit code/;

// Pull the most telling lines out of a `gh run view --log-failed` dump.
// Each line looks like "<job>\t<step>\t<timestamp> <message>".
export function extractReason(log, max = 3) {
  const lines = log.split('\n').map((line) => {
    const parts = line.split('\t');
    const msg = parts.length >= 3 ? parts.slice(2).join('\t') : line;
    return msg
      .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '')
      .replace(/(\u001b|\^\[)\[[0-9;]*m/g, '')
      .replace(/^##\[error\]/, '')
      .trim()
      .slice(0, 300);
  }).filter((l) => l.replace(/\[[^\]]*\]:?/g, '').trim()); // drop lines that are only [tags]

  const pick = (candidates) => {
    const out = [];
    for (let i = candidates.length - 1; i >= 0 && out.length < max; i--) {
      if (!out.includes(candidates[i])) out.unshift(candidates[i]);
    }
    return out;
  };
  const errors = pick(lines.filter((l) => ERROR_LINE.test(l) && !GENERIC_LINE.test(l)));
  return errors.length ? errors : pick(lines.filter((l) => !GENERIC_LINE.test(l)));
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
    .filter((r) => !claimed.has(r.databaseId) && Date.parse(r.createdAt) >= earliest)
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

// Builds started here, saved to `file` so a restart keeps watching (and retrying) them.
export function createTracker(gh, now = () => Date.now(), { file = null } = {}) {
  const builds = load(file, now());
  let seq = builds.length;
  const save = () => {
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(builds), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };

  async function trigger(prNumber, keys) {
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => Object.hasOwn(BUILDS, k))) {
      throw new BuildRequestError('Pick at least one known build.', 400);
    }
    const pr = await getPr(gh, prNumber);
    if (pr.state !== 'OPEN') throw new BuildRequestError(`PR #${prNumber} is not open.`, 409);
    if (pr.reviewDecision !== 'APPROVED') throw new BuildRequestError(`PR #${prNumber} is not approved.`, 409);
    if (pr.isCrossRepository) throw new BuildRequestError(`PR #${prNumber} comes from a fork; build it from GitHub directly.`, 409);

    const made = [];
    for (const key of keys) {
      const { file, label, buildType } = BUILDS[key];
      try {
        await gh.run(['workflow', 'run', file, '-R', REPO, '--ref', pr.headRefName,
          '-f', `buildType=${buildType}`, '-f', 'sendReleaseUpdates=false']);
      } catch (err) {
        const sent = made.map((b) => b.label).join(', ') || 'none';
        const error = new BuildRequestError(`${label} failed to start: ${err.message}. Started: ${sent}.`, 502);
        error.started = made.map((b) => b.key);
        throw error;
      }
      const build = { id: `${now()}-${++seq}`, prNumber, key, label, file, branch: pr.headRefName,
        triggeredAt: now(), runId: null, url: null, status: 'requested', conclusion: null,
        attempt: 1, retries: 0, maxRetries: MAX_RETRIES, waitAttempt: 0, reason: null, classification: null };
      builds.push(build);
      made.push(build);
      save(); // per build, so a later failed start can't lose the ones already sent
    }
    return made;
  }

  async function settle(b, run) {
    b.attempt = run.attempt ?? b.attempt;
    if (run.status !== 'completed') {
      b.status = run.status;
      b.conclusion = null;
      return;
    }
    const failed = RETRYABLE.has(run.conclusion);
    if (failed) {
      const { fullText, ...reason } = await failureReason(gh, run.databaseId);
      b.reason = reason;
      // A compile error can sit far above the last few error lines, so classify the whole log.
      b.classification = classifyFailure(run.conclusion, { lines: [fullText ?? reason.lines.join('\n')] });
    }
    if (failed && b.classification.kind !== 'code' && b.retries < MAX_RETRIES) {
      try {
        await rerunFailed(gh, run.databaseId);
        b.retries += 1;
        b.waitAttempt = b.attempt + 1;
        b.status = 'queued';
        b.conclusion = null;
        return;
      } catch (err) {
        Object.assign(b, { status: 'completed', conclusion: run.conclusion, reason: { step: 'Automatic retry failed', lines: [err.message] } });
        return;
      }
    }
    b.status = 'completed';
    b.conclusion = run.conclusion || null;
  }

  async function refreshOnce() {
    const claimed = new Set(builds.filter((b) => b.runId).map((b) => b.runId));
    for (const b of builds) {
      if (b.status === 'completed') continue;
      const runs = await gh.json(['run', 'list', '-R', REPO, '-w', b.file, '-b', b.branch,
        '-e', 'workflow_dispatch', '-L', '10', '--json', 'databaseId,createdAt,status,conclusion,url,attempt']);
      const run = b.runId ? runs.find((r) => r.databaseId === b.runId) : matchRun(runs, b, claimed);
      if (!run) continue;
      claimed.add(run.databaseId);
      b.runId = run.databaseId;
      b.url = run.url;
      // After a rerun, GitHub briefly still reports the old attempt; wait for the new one.
      if ((run.attempt ?? 1) < b.waitAttempt) continue;
      await settle(b, run);
      save();
    }
    return builds;
  }

  // The page and the server's background loop both refresh; share one pass so a failure is rerun once.
  let inFlight = null;
  function refresh() {
    inFlight ??= refreshOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { trigger, refresh, list: () => builds };
}
