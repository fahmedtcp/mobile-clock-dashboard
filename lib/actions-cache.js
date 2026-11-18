// GitHub Actions caches for the repo: see what's there by branch, and clear one branch or all of them.
// Caches rebuild on the next run, so clearing only costs that run some time.
import { REPO } from '../public/shared.js';

const PER_PAGE = 100;
const MAX_PAGES = 10;
const branchOf = (ref) => String(ref ?? '').replace(/^refs\/heads\//, '');

async function listCaches(gh) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await gh.json(['api', `repos/${REPO}/actions/caches`, '-X', 'GET', '-f', `per_page=${PER_PAGE}`, '-f', `page=${page}`], { fresh: true });
    const batch = Array.isArray(res?.actions_caches) ? res.actions_caches : [];
    all.push(...batch);
    if (batch.length < PER_PAGE || all.length >= (res?.total_count ?? 0)) break;
  }
  return all;
}

export async function cacheSummary(gh) {
  const caches = await listCaches(gh);
  const byRef = new Map();
  for (const c of caches) {
    const r = byRef.get(c.ref) ?? { ref: c.ref, branch: branchOf(c.ref), count: 0, bytes: 0, lastAccessedAt: null };
    r.count += 1;
    r.bytes += c.size_in_bytes ?? 0;
    if (!r.lastAccessedAt || c.last_accessed_at > r.lastAccessedAt) r.lastAccessedAt = c.last_accessed_at;
    byRef.set(c.ref, r);
  }
  return {
    count: caches.length,
    bytes: caches.reduce((sum, c) => sum + (c.size_in_bytes ?? 0), 0),
    refs: [...byRef.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

// ref: one branch's caches (full ref, like refs/heads/develop); none means every cache in the repo.
export async function clearCaches(gh, { ref = null } = {}) {
  const targets = (await listCaches(gh)).filter((c) => !ref || c.ref === ref);
  let failed = 0;
  for (const c of targets) {
    try { await gh.run(['api', `repos/${REPO}/actions/caches/${c.id}`, '-X', 'DELETE']); } catch { failed += 1; }
  }
  return { deleted: targets.length - failed, failed };
}

export function routes(ctx) {
  return [
    ['GET', /^\/api\/actions-cache$/, () => cacheSummary(ctx.gh)],
    ['DELETE', /^\/api\/actions-cache$/, (m, req, url) => clearCaches(ctx.gh, { ref: url.searchParams.get('ref') || null })],
  ];
}
