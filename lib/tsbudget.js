import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import path from 'node:path';

const DAY_MS = 864e5;

// Never throws on a non-zero exit: tsc exits 2 when it finds errors, and that's the normal case here.
function defaultExec(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000, ...opts }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
    });
  });
}

function readHistory(historyFile) {
  try { return JSON.parse(readFileSync(historyFile, 'utf8')); } catch { return []; }
}

function writeHistory(historyFile, history) {
  mkdirSync(path.dirname(historyFile), { recursive: true });
  writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

function readMarker(marker) {
  try { return readFileSync(marker, 'utf8').trim(); } catch { return null; }
}

function isSymlink(file) {
  try { return lstatSync(file).isSymbolicLink(); } catch { return false; }
}

export function countTsErrors(output) {
  return (String(output).match(/error TS\d+:/g) ?? []).length;
}

const output = (result) => (result.stderr || result.stdout).trim();

export function createTsBudget({ repoPath, cacheDir, historyFile, exec = defaultExec, now = () => Date.now() }) {
  // A function lets Settings change the clone folder without a restart.
  const repo = () => (typeof repoPath === 'function' ? repoPath() : repoPath);
  const worktree = path.join(cacheDir, 'ts-wt');
  const history = readHistory(historyFile);
  const state = { running: null, prResults: {}, error: null };
  let job = Promise.resolve();
  const isoNow = () => new Date(now()).toISOString();

  async function git(args, cwd) {
    const result = await exec('git', args, cwd ? { cwd } : {});
    if (result.code !== 0) throw new Error(`git ${args.slice(2).join(' ')} failed: ${output(result)}`);
    return result.stdout.trim();
  }

  // The worktree belongs to one clone. If Settings points at a different clone, start it over from the new one.
  async function dropWorktreeFromOtherClone(marker) {
    if (!existsSync(worktree) || readMarker(marker) === repo()) return;
    rmSync(worktree, { recursive: true, force: true });
    await git(['-C', repo(), 'worktree', 'prune']);
  }

  // Check out `sha` in the dashboard's own worktree; the user's working tree is never touched.
  async function prepare(sha) {
    state.running.phase = 'worktree';
    const marker = path.join(worktree, '.dashboard-repo');
    await dropWorktreeFromOtherClone(marker);
    if (!existsSync(worktree)) {
      mkdirSync(cacheDir, { recursive: true });
      await git(['-C', repo(), 'worktree', 'add', '--detach', worktree, sha]);
      writeFileSync(marker, repo());
    } else {
      await git(['-C', worktree, 'checkout', '--detach', '--force', sha]);
    }
    // ponytail: reuses the checkout's node_modules; counts drift if a branch changes dependencies.
    const link = path.join(worktree, 'node_modules');
    if (!isSymlink(link) && !existsSync(link)) symlinkSync(path.join(repo(), 'node_modules'), link, 'dir');
  }

  async function countAt(sha) {
    await prepare(sha);
    state.running.phase = 'tsc';
    const tsc = path.join(worktree, 'node_modules', 'typescript', 'bin', 'tsc');
    const result = await exec('node', [tsc, '--noEmit', '-p', path.join(worktree, 'tsconfig.json')], { cwd: worktree });
    if (result.code !== 0 && result.code !== 2) throw new Error(`tsc failed to run: ${output(result).slice(0, 300)}`);
    return countTsErrors(result.stdout);
  }

  async function runJob(work) {
    try {
      if (!existsSync(repo())) {
        const hint = 'Set your mobile-clock folder in Settings.';
        throw new Error(`Local mobile-clock checkout not found at ${repo()}. ${hint}`);
      }
      await work();
    } catch (err) {
      state.error = err.message;
    } finally {
      state.running = null;
    }
  }

  function start(target, work) {
    if (state.running) return status();
    state.running = { target, phase: 'fetch', startedAt: isoNow() };
    state.error = null;
    job = runJob(work);
    return status();
  }

  function status() {
    const running = state.running && { ...state.running };
    return { running, last: history.at(-1) ?? null, prResults: state.prResults, error: state.error };
  }

  async function countDevelop() {
    await git(['-C', repo(), 'fetch', 'origin', 'develop']);
    const sha = await git(['-C', repo(), 'rev-parse', 'origin/develop']);
    const count = await countAt(sha);
    history.push({ at: isoNow(), sha, count });
    writeHistory(historyFile, history);
  }

  async function countPr(prNumber) {
    await git(['-C', repo(), 'fetch', 'origin', `pull/${prNumber}/head`]);
    const sha = await git(['-C', repo(), 'rev-parse', 'FETCH_HEAD']);
    if (state.prResults[prNumber]?.sha === sha) return;
    const count = await countAt(sha);
    const base = history.at(-1)?.count;
    const delta = base === undefined ? null : count - base;
    state.prResults[prNumber] = { sha, count, delta, at: isoNow() };
  }

  return {
    status,
    history: () => history,
    whenIdle: () => job,
    runDevelop: () => start('develop', countDevelop),
    runPr: (prNumber) => start(`pr-${prNumber}`, () => countPr(prNumber)),
    // For the server's daily auto-run.
    isStale: () => !history.length || now() - Date.parse(history.at(-1).at) > DAY_MS,
  };
}

export function routes(ctx) {
  if (!ctx.ts) return [];
  return [
    ['GET', /^\/api\/ts$/, () => ({ status: ctx.ts.status(), history: ctx.ts.history() })],
    ['POST', /^\/api\/ts\/run$/, () => ctx.ts.runDevelop()],
    ['POST', /^\/api\/prs\/([^/]+)\/ts$/, (m) => ctx.ts.runPr(ctx.id(m[1]))],
  ];
}
