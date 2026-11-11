// GitHub evidence for time tracking: builds the user started (workflow_dispatch) and PR reviews the user
// left on other people's PRs, per local day, keyed by the PR or run branch. Read-only `gh api` calls.
import { dayKey, monthBounds } from './days.js';
import { ticketKey } from '../tickets.js';

const LOGIN = /^[A-Za-z0-9-]+$/;
const lines = (out) => String(out ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

export async function githubByDay(gh, { repo, login, ym }) {
  if (!LOGIN.test(login)) throw new Error('Unexpected GitHub login.');
  const { from, to } = monthBounds(ym);
  const byDay = new Map();
  const add = (iso, key, kind) => {
    const day = dayKey(new Date(iso));
    if (!key || !day.startsWith(ym)) return;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ key, kind });
  };

  // Builds: one per run id (a re-run keeps its id, so retries don't add hours).
  // ponytail: `created` filters by UTC date, so a run late on the last evening of a month can be missed.
  const runs = await gh.run(['api', '-X', 'GET', `repos/${repo}/actions/runs`, '-f', `actor=${login}`, '-f', 'event=workflow_dispatch',
    '-f', `created=${from}..${to}`, '-f', 'per_page=100', '--paginate', '--jq', '.workflow_runs[] | [(.id|tostring), .head_branch, .created_at] | @tsv']);
  const seen = new Set();
  for (const line of lines(runs)) {
    const [id, branch, created] = line.split('\t');
    if (seen.has(id)) continue;
    seen.add(id);
    add(created, ticketKey(branch), 'build');
  }

  // Reviews: PRs by others that the user reviewed and that changed this month.
  const prs = lines(await gh.run(['api', '-X', 'GET', 'search/issues', '-f', `q=repo:${repo} type:pr reviewed-by:${login} -author:${login} updated:>=${from}`,
    '--paginate', '--jq', '.items[].number'])).filter((n) => /^\d+$/.test(n));
  for (const n of prs) {
    const [branch, title] = String(await gh.run(['api', `repos/${repo}/pulls/${n}`, '--jq', '[.head.ref, .title] | @tsv'])).trim().split('\t');
    const key = ticketKey(branch, title);
    const times = lines(await gh.run(['api', `repos/${repo}/pulls/${n}/reviews`, '--paginate', '--jq', `.[] | select(.user.login == "${login}") | .submitted_at`]));
    for (const t of times) add(t, key, 'review');
  }
  return { byDay };
}
