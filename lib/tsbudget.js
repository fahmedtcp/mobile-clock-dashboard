import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import path from 'node:path';

const DAY_MS = 864e5;

// Never throws on a non-zero exit: tsc exits 2 when it finds errors, and that's the normal case here.
function defaultExec(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000, ...opts }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 });
    });
  });
}

export function countTsErrors(output) {
  return (String(output).match(/error TS\d+:/g) ?? []).length;
}

export function createTsBudget({ repoPath: repoPathOpt, cacheDir, historyFile, exec = defaultExec, now = () => Date.now() }) {
  // A function lets Settings change the clone folder without a restart.
  const repo = () => (typeof repoPathOpt === 'function' ? repoPathOpt() : repoPathOpt);
  const wt = path.join(cacheDir, 'ts-wt');
  let history = [];
  try { history = JSON.parse(readFileSync(historyFile, 'utf8')); } catch { history = []; }
  const state = { running: null, prResults: {}, error: null };
  let job = Promise.resolve();

  async function git(args, cwd) {
    const r = await exec('git', args, cwd ? { cwd } : {});
    if (r.code !== 0) throw new Error(`git ${args.slice(2).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  }

  // Check out `sha` in the dashboard's own worktree; the user's working tree is never touched.
  async function prepare(sha) {
    state.running.phase = 'worktree';
    // The worktree belongs to one clone. If Settings points at a different clone, start it over from the new one.
    const marker = path.join(wt, '.dashboard-repo');
    if (existsSync(wt)) {
      let from = null;
      try { from = readFileSync(marker, 'utf8').trim(); } catch { from = null; }
      if (from !== repo()) {
        rmSync(wt, { recursive: true, force: true });
        await git(['-C', repo(), 'worktree', 'prune']);
      }
    }
    if (!existsSync(wt)) {
      mkdirSync(cacheDir, { recursive: true });
      await git(['-C', repo(), 'worktree', 'add', '--detach', wt, sha]);
      writeFileSync(marker, repo());
    } else {
      await git(['-C', wt, 'checkout', '--detach', '--force', sha]);
    }
    // ponytail: reuses the checkout's node_modules; counts drift if a branch changes dependencies.
    const link = path.join(wt, 'node_modules');
    let linked = false;
    try { linked = lstatSync(link).isSymbolicLink(); } catch { linked = false; }
    if (!linked && !existsSync(link)) symlinkSync(path.join(repo(), 'node_modules'), link, 'dir');
  }

  async function countAt(sha) {
    await prepare(sha);
    state.running.phase = 'tsc';
    const r = await exec('node', [path.join(wt, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', path.join(wt, 'tsconfig.json')], { cwd: wt });
    if (r.code !== 0 && r.code !== 2) throw new Error(`tsc failed to run: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return countTsErrors(r.stdout);
  }

  function start(target, work) {
    if (state.running) return status();
    state.running = { target, phase: 'fetch', startedAt: new Date(now()).toISOString() };
    state.error = null;
    job = (async () => {
      try {
        if (!existsSync(repo())) throw new Error(`Local mobile-clock checkout not found at ${repo()}. Set your mobile-clock folder in Settings.`);
        await work();
      } catch (err) {
        state.error = err.message;
      } finally {
        state.running = null;
      }
    })();
    return status();
  }

  function status() {
    return { running: state.running && { ...state.running }, last: history.at(-1) ?? null, prResults: state.prResults, error: state.error };
  }

  return {
    status,
    history: () => history,
    whenIdle: () => job,
    runDevelop: () => start('develop', async () => {
      await git(['-C', repo(), 'fetch', 'origin', 'develop']);
      const sha = await git(['-C', repo(), 'rev-parse', 'origin/develop']);
      const count = await countAt(sha);
      history.push({ at: new Date(now()).toISOString(), sha, count });
      mkdirSync(path.dirname(historyFile), { recursive: true });
      writeFileSync(historyFile, JSON.stringify(history, null, 2));
    }),
    runPr: (n) => start(`pr-${n}`, async () => {
      await git(['-C', repo(), 'fetch', 'origin', `pull/${n}/head`]);
      const sha = await git(['-C', repo(), 'rev-parse', 'FETCH_HEAD']);
      if (state.prResults[n]?.sha === sha) return;
      const count = await countAt(sha);
      const base = history.at(-1)?.count;
      state.prResults[n] = { sha, count, delta: base === undefined ? null : count - base, at: new Date(now()).toISOString() };
    }),
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
