// Before You Log Off: what would otherwise wait a whole night. Git here is read-only; pushing stays in the terminal.
import { ticketKey } from '../tickets.js';

const GIT_TIMEOUT_MS = 10000;
const RECENT_MS = 14 * 864e5; // older local branches are abandoned work, not tonight's
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

// Recent ticket branches with commits not on their upstream (or, with no upstream, not on origin/develop).
export async function unpushedBranches(exec, repoPath, now = Date.now()) {
  const git = (...args) => exec('git', ['-C', repoPath, ...args], { timeout: GIT_TIMEOUT_MS });
  const refs = await git('for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)');
  if (refs.code !== 0) return [];
  const out = [];
  for (const line of refs.stdout.split('\n').filter(Boolean)) {
    const [branch, upstream, track = '', committed = '0'] = line.split('\t');
    const key = ticketKey(branch);
    if (!key || track.includes('gone') || now - Number(committed) * 1000 > RECENT_MS) continue;
    let ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
    if (!upstream) {
      const count = await git('rev-list', '--count', `origin/develop..${branch}`);
      ahead = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0;
    }
    if (ahead > 0) out.push({ branch, key, ahead });
  }
  return out;
}

export function wrapChecklist({ unpushed, hoursPending, rows }) {
  const pushes = unpushed.map(({ branch, key, ahead }) => ({
    id: `push:${branch}`, done: false, title: `Push ${key} and open the PR`,
    sub: `${plural(ahead, 'commit')} only on this Mac. Push so your reviewer has it next shift.`,
    action: { kind: 'copy', label: 'Copy push command', text: `git push -u origin ${branch}` },
  }));
  const qa = rows.filter((r) => r.blocker.kind === 'ready-for-qa').map((r) => ({
    id: `qa:${r.key}`, done: false, title: `Ask QA to test ${r.key}`, sub: 'Approved with a build', action: r.action,
  }));
  const hours = {
    id: 'hours', done: !hoursPending, title: "Confirm today's hours",
    sub: hoursPending ? 'Not confirmed yet' : 'Confirmed', action: { kind: 'go', label: 'Open Time', view: 'time' },
  };
  return [...pushes, ...qa, hours];
}
