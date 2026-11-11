import { REPO, STALE_APPROVED_DAYS, STALE_OPEN_DAYS, BEHIND_TTL_MS } from '../config.js';

const DAY_MS = 864e5;
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PR_FIELDS = 'number,title,url,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,createdAt,reviewRequests,latestReviews';

export function isStale(pr, now) {
  const age = (iso) => (now - new Date(iso)) / DAY_MS;
  if (pr.approved && pr.approvedAt && age(pr.approvedAt) > STALE_APPROVED_DAYS) return true;
  return age(pr.createdAt) > STALE_OPEN_DAYS;
}

// Rollup items are either CheckRuns (status/conclusion) or StatusContexts (state).
export function checkState(rollup = []) {
  if (rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup) {
    const result = c.conclusion || c.state;
    if (FAILED.has(result)) return 'failure';
    if (!result || result === 'PENDING' || result === 'EXPECTED') pending = true;
  }
  return pending ? 'pending' : 'success';
}

export async function listPrs(gh) {
  const raw = await gh.json(['pr', 'list', '-R', REPO, '--state', 'open', '-L', '100', '--json', PR_FIELDS]);
  const now = new Date();
  return raw.map((p) => {
    const approvals = (p.latestReviews ?? []).filter((r) => r.state === 'APPROVED').map((r) => r.submittedAt).sort();
    const pr = {
      number: p.number,
      title: p.title,
      url: p.url,
      author: p.author?.login ?? '',
      headRefName: p.headRefName,
      baseRefName: p.baseRefName,
      isDraft: Boolean(p.isDraft),
      approved: p.reviewDecision === 'APPROVED',
      reviewDecision: p.reviewDecision ?? '',
      checks: checkState(p.statusCheckRollup),
      reviewRequestedLogins: (p.reviewRequests ?? []).filter((r) => r.login).map((r) => r.login),
      createdAt: p.createdAt,
      approvedAt: approvals.at(-1) ?? null,
    };
    pr.stale = isStale(pr, now);
    return pr;
  });
}

export function getPr(gh, number) {
  return gh.json(['pr', 'view', String(number), '-R', REPO, '--json', 'number,state,headRefName,baseRefName,reviewDecision,isCrossRepository']);
}

export function createBehindCache(gh, now = () => Date.now()) {
  const cache = new Map();
  return {
    async get(base, head) {
      const key = `${base}\0${head}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at <= BEHIND_TTL_MS) return hit.value;
      const path = `repos/${REPO}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
      const value = Number((await gh.run(['api', path, '--jq', '.behind_by'])).trim());
      cache.set(key, { value, at: now() });
      return value;
    },
    clear: () => cache.clear(),
  };
}

export async function updateBranch(gh, number) {
  await gh.run(['api', '-X', 'PUT', `repos/${REPO}/pulls/${number}/update-branch`]);
}
