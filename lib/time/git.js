// The user's own non-merge commits from the local mobile-clock clone, grouped by local day.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dayKey } from './days.js';
import { ticketKey } from '../tickets.js';

const exitCode = (err) => (err ? (typeof err.code === 'number' ? err.code : 1) : 0);

function defaultExec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: exitCode(err) });
    });
  });
}

// Lines of `%H\t%aI\t%S\t%s`. A key in the subject wins: the user sometimes commits the next ticket on the old branch.
export function parseLog(stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, at, source, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    const branch = String(source ?? '').replace(/^refs\/(heads|remotes\/origin)\//, '');
    return { sha, at, day: dayKey(at), key: ticketKey(subject, source), subject, branch };
  });
}

export async function commitsByDay(exec = defaultExec, repoPath, { since, until }) {
  const byDay = new Map();
  if (!existsSync(repoPath)) {
    const error = `Local mobile-clock clone not found at ${repoPath}. Set your mobile-clock folder in Settings.`;
    return { byDay, error };
  }
  const cfg = await exec('git', ['-C', repoPath, 'config', 'user.email']);
  if (cfg.code !== 0 && cfg.stderr.trim()) return { byDay, error: `git failed: ${cfg.stderr.trim().slice(0, 200)}` };
  const email = cfg.stdout.trim();
  if (!email) return { byDay, error: 'git user.email is not set in the local clone.' };
  const log = await exec('git', ['-C', repoPath, 'log', '--all', '--source', '--no-merges', `--author=${email}`,
    `--since=${since}`, `--until=${until}`, '--format=%H%x09%aI%x09%S%x09%s']);
  if (log.code !== 0) return { byDay, error: `git log failed: ${(log.stderr || log.stdout).trim().slice(0, 200)}` };
  const seen = new Set();
  for (const commit of parseLog(log.stdout)) {
    if (seen.has(commit.sha)) continue;
    seen.add(commit.sha);
    if (!byDay.has(commit.day)) byDay.set(commit.day, []);
    byDay.get(commit.day).push(commit);
  }
  return { byDay, error: null };
}
