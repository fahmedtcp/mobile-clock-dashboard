import { REPO, STALE_APPROVED_DAYS, STALE_OPEN_DAYS, BEHIND_TTL_MS } from '../config.js';

const DAY_MS = 864e5;
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PR_FIELDS = [
  'number', 'title', 'url', 'author', 'headRefName', 'baseRefName', 'isDraft', 'reviewDecision',
  'statusCheckRollup', 'createdAt', 'reviewRequests', 'latestReviews',
].join(',');
const PR_VIEW_FIELDS = 'number,state,headRefName,baseRefName,reviewDecision,isCrossRepository';

export function isStale(pr, now) {
  const age = (iso) => (now - new Date(iso)) / DAY_MS;
  if (pr.approved && pr.approvedAt && age(pr.approvedAt) > STALE_APPROVED_DAYS) return true;
  return age(pr.createdAt) > STALE_OPEN_DAYS;
}

// Rollup items are either CheckRuns (status/conclusion) or StatusContexts (state).
export function checkState(rollup = []) {
  if (rollup.length === 0) return 'none';
  let pending = false;
  for (const check of rollup) {
    const result = check.conclusion || check.state;
    if (FAILED.has(result)) return 'failure';
    if (!result || result === 'PENDING' || result === 'EXPECTED') pending = true;
  }
  return pending ? 'pending' : 'success';
}

const failedChecks = (rollup = []) => rollup.filter((c) => FAILED.has(c.conclusion || c.state)).map((c) => c.name || c.context);

function toPr(ghPr, now) {
  const changes = (ghPr.latestReviews ?? []).filter((review) => review.state === 'CHANGES_REQUESTED')
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))[0];
  const approvals = (ghPr.latestReviews ?? [])
    .filter((review) => review.state === 'APPROVED')
    .map((review) => review.submittedAt)
    .sort();
  const pr = {
    number: ghPr.number,
    title: ghPr.title,
    url: ghPr.url,
    author: ghPr.author?.login ?? '',
    headRefName: ghPr.headRefName,
    baseRefName: ghPr.baseRefName,
    isDraft: Boolean(ghPr.isDraft),
    approved: ghPr.reviewDecision === 'APPROVED',
    reviewDecision: ghPr.reviewDecision ?? '',
    checks: checkState(ghPr.statusCheckRollup),
    failedChecks: failedChecks(ghPr.statusCheckRollup),
    changesBody: changes?.body || null,
    changesBy: changes?.author?.login ?? null,
    reviews: (ghPr.latestReviews ?? []).map((review) => ({
      by: review.author?.login ?? '', state: review.state, at: review.submittedAt, body: review.body ?? '',
    })),
    reviewRequestedLogins: (ghPr.reviewRequests ?? []).filter((r) => r.login).map((r) => r.login),
    createdAt: ghPr.createdAt,
    approvedAt: approvals.at(-1) ?? null,
  };
  pr.stale = isStale(pr, now);
  return pr;
}

export async function listPrs(gh) {
  const ghPrs = await gh.json(['pr', 'list', '-R', REPO, '--state', 'open', '-L', '100', '--json', PR_FIELDS]);
  const now = new Date();
  return ghPrs.map((ghPr) => toPr(ghPr, now));
}

export function getPr(gh, number) {
  return gh.json(['pr', 'view', String(number), '-R', REPO, '--json', PR_VIEW_FIELDS]);
}

export function createBehindCache(gh, now = () => Date.now()) {
  const cache = new Map();
  return {
    async get(base, head) {
      const key = `${base}\0${head}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at <= BEHIND_TTL_MS) return hit.value;
      const comparePath = `repos/${REPO}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
      const value = Number((await gh.run(['api', comparePath, '--jq', '.behind_by'])).trim());
      cache.set(key, { value, at: now() });
      return value;
    },
    clear: () => cache.clear(),
  };
}

export async function updateBranch(gh, number) {
  await gh.run(['api', '-X', 'PUT', `repos/${REPO}/pulls/${number}/update-branch`]);
}
