// The user's own non-merge commits from the local mobile-clock clone, grouped by local day.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dayKey } from './days.js';
import { ticketKey } from '../tickets.js';


function defaultExec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 });
    });
  });
}


// Lines of `%H\t%aI\t%S\t%s`. A key in the subject wins: the user sometimes commits the next ticket on the old branch.
export function parseLog(stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, at, source, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    return { sha, at, day: dayKey(at), key: ticketKey(subject, source), subject };
  });
}

export async function commitsByDay(exec = defaultExec, repoPath, { since, until }) {
  const byDay = new Map();
  if (!existsSync(repoPath)) return { byDay, error: `Local mobile-clock clone not found at ${repoPath}. Set your mobile-clock folder in Settings.` };
  const cfg = await exec('git', ['-C', repoPath, 'config', 'user.email']);
  if (cfg.code !== 0 && cfg.stderr.trim()) return { byDay, error: `git failed: ${cfg.stderr.trim().slice(0, 200)}` };
  const email = cfg.stdout.trim();
  if (!email) return { byDay, error: 'git user.email is not set in the local clone.' };
  const r = await exec('git', ['-C', repoPath, 'log', '--all', '--source', '--no-merges', `--author=${email}`,
    `--since=${since}`, `--until=${until}`, '--format=%H%x09%aI%x09%S%x09%s']);
  if (r.code !== 0) return { byDay, error: `git log failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
  const seen = new Set();
  for (const c of parseLog(r.stdout)) {
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push(c);
  }
  return { byDay, error: null };
}
