import { REPO, BRANCH_TTL_MS } from '../config.js';

const MERGED_FIELDS = 'number,title,url,headRefName,baseRefName,mergedAt,mergeCommit,author';

export async function listMergedPrs(gh, { base = 'develop', sinceIso }) {
  const since = sinceIso.slice(0, 10);
  const prs = await gh.json(['pr', 'list', '-R', REPO, '--state', 'merged', '--base', base,
    '--search', `merged:>=${since}`, '-L', '500', '--json', MERGED_FIELDS]);
  return prs.map((p) => ({ ...p, author: p.author?.login ?? '' }));
}

export function createBranchList(gh, now = () => Date.now()) {
  let cached = null;
  return {
    async get() {
      if (cached && now() - cached.at <= BRANCH_TTL_MS) return cached.names;
      const out = await gh.run(['api', '--paginate', `repos/${REPO}/branches?per_page=100`, '--jq', '.[].name']);
      cached = { names: out.split('\n').filter(Boolean), at: now() };
      return cached.names;
    },
  };
}
