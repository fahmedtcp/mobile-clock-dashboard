// Run Tests and Update from Develop on the user's own mobile-clock folder, one job at a time.
// Safety: never stash, reset, discard, or force-push; refuse with uncommitted changes; a conflicting merge is aborted
// so the branch is exactly as it was; pushing waits for the user's OK and refuses if the branch moved since the merge.
import { execFile, spawn } from 'node:child_process';
import { HttpError } from './http.js';

const GIT_TIMEOUT_MS = 120000;
const TEST_TIMEOUT_MS = 45 * 60000;
const OUTPUT_MAX = 2 * 1024 * 1024;
const OUTPUT_SHOWN = 60000; // the end of the output the page shows, live and afterwards
const ANSI = /\u001b\[[0-9;]*m/g;

function run(file, args, cwd, timeout = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

const counts = (line) => Object.fromEntries([...line.matchAll(/(\d+) (failed|passed|skipped|todo|total)/g)].map(([, n, k]) => [k, Number(n)]));

// The end of a Jest run: suite and test counts, failing test names, and the "All files" coverage row.
export function parseJestSummary(raw) {
  const out = String(raw).replace(ANSI, '');
  const suites = out.match(/^Test Suites:(.*)$/m);
  const tests = out.match(/^Tests:(.*)$/m);
  const failing = [...new Set([...out.matchAll(/^\s*● (.+?)\s*$/gm)].map((m) => m[1]).filter((name) => name.includes(' › ')))];
  const cov = out.match(/^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m);
  return {
    suites: suites ? counts(suites[1]) : null,
    tests: tests ? counts(tests[1]) : null,
    failing,
    coverage: cov ? { statements: Number(cov[1]), branches: Number(cov[2]), functions: Number(cov[3]), lines: Number(cov[4]) } : null,
  };
}

export function createLocalRepo({ repoPath, testCommand = ['npm', ['run', 'test-cov']], onPushed = () => {} }) {
  let job = null;   // the current or last job
  let child = null; // the running test process
  const git = (...args) => run('git', args, repoPath());
  const ok = async (...args) => {
    const res = await git(...args);
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ') || `git ${args[0]} failed`);
    return res.stdout.trim();
  };

  // The ticket's branch: a local one if there is one, else the one on GitHub (created locally on switch).
  async function branchFor(key) {
    const pick = (names) => names.filter((n) => n === key || n.toUpperCase().startsWith(`${key}-`)).sort((a, b) => a.length - b.length)[0];
    const local = pick((await ok('for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n'));
    if (local) return { branch: local, onlyOnGitHub: false };
    const remote = pick((await ok('for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin')).split('\n').map((n) => n.replace(/^origin\//, '')));
    if (remote) return { branch: remote, onlyOnGitHub: true };
    throw new HttpError(404, `No branch for ${key} in your mobile-clock folder or on GitHub. Fetch or push it first.`);
  }

  async function status(key) {
    const { branch, onlyOnGitHub } = await branchFor(key);
    const current = await ok('branch', '--show-current');
    const dirty = (await ok('status', '--porcelain')).split('\n').filter((l) => l && !l.startsWith('??')).length;
    return { repo: repoPath(), key, branch, onlyOnGitHub, current, dirty, needsSwitch: current !== branch, job: snapshot() };
  }

  async function switchTo(s) {
    if (s.onlyOnGitHub) await ok('switch', '--track', '-c', s.branch, `origin/${s.branch}`);
    else await ok('switch', s.branch);
  }

  // develop may be checked out in another worktree: fast-forward it there; otherwise update the ref directly.
  async function updateDevelop() {
    const blocks = (await ok('worktree', 'list', '--porcelain')).split('\n\n');
    const holder = blocks.find((b) => b.split('\n').includes('branch refs/heads/develop'));
    if (holder) {
      const dir = holder.split('\n')[0].replace(/^worktree /, '');
      const res = await run('git', ['merge', '--ff-only', 'origin/develop'], dir);
      if (res.code !== 0) throw new Error(`Your local develop (in ${dir}) can't fast-forward to origin/develop.`);
      return;
    }
    const res = await git('fetch', 'origin', 'develop:develop');
    if (res.code !== 0) throw new Error('Your local develop has commits that aren\'t on origin/develop, so it can\'t fast-forward.');
  }

  async function updateFlow(s) {
    job.step = 'Fetching from GitHub';
    await ok('fetch', 'origin', '--prune');
    if (s.needsSwitch) { job.step = `Switching to ${s.branch}`; await switchTo(s); }
    job.step = 'Updating develop';
    await updateDevelop();
    job.step = `Merging develop into ${s.branch}`;
    const merge = await git('merge', '--no-edit', 'develop');
    if (merge.code !== 0) {
      const conflicts = (await ok('diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
      await git('merge', '--abort');
      return { state: 'conflict', result: { conflicts } };
    }
    const upstream = await git('rev-parse', '--abbrev-ref', '@{upstream}');
    const base = upstream.code === 0 ? upstream.stdout.trim() : 'develop';
    const ahead = Number(await ok('rev-list', '--count', `${base}..HEAD`));
    const head = await ok('rev-parse', 'HEAD');
    return ahead > 0
      ? { state: 'needs-push', result: { ahead, head, hasUpstream: upstream.code === 0 } }
      : { state: 'up-to-date', result: { ahead: 0 } };
  }

  function testFlow(s) {
    return new Promise((resolve) => {
      job.step = 'Running npm run test-cov';
      let output = '';
      const [cmd, args] = testCommand;
      child = spawn(cmd, args, { cwd: repoPath(), env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }, detached: true });
      const take = (chunk) => {
        output = (output + chunk).slice(-OUTPUT_MAX);
        job.output = output.replace(ANSI, '').slice(-OUTPUT_SHOWN);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const timer = setTimeout(() => stop(), TEST_TIMEOUT_MS);
      child.on('close', (code) => {
        clearTimeout(timer);
        const stopped = job.state === 'stopping';
        child = null;
        const summary = parseJestSummary(output);
        resolve({ state: stopped ? 'stopped' : code === 0 ? 'passed' : 'failed', result: { ...summary, exitCode: code, tail: output.slice(-4000) } });
      });
      child.on('error', (err) => { clearTimeout(timer); child = null; resolve({ state: 'error', result: { error: err.message } }); });
    });
  }

  async function start(kind, key, { switch: allowSwitch = false } = {}) {
    if (job && ['running', 'stopping'].includes(job.state)) throw new HttpError(409, 'Another job is already running.');
    const s = await status(key);
    if (s.dirty) throw new HttpError(409, 'Commit or stash your changes first. The dashboard never touches uncommitted work.');
    if (s.needsSwitch && !allowSwitch) throw new HttpError(409, `Switch to ${s.branch} first.`);
    job = { id: Date.now(), kind, key, branch: s.branch, state: 'running', step: 'Starting', startedAt: Date.now(), finishedAt: null, result: null };
    const current = job;
    (async () => {
      try {
        if (kind === 'tests' && s.needsSwitch) { current.step = `Switching to ${s.branch}`; await switchTo(s); }
        const outcome = kind === 'tests' ? await testFlow(s) : await updateFlow(s);
        Object.assign(current, outcome);
      } catch (err) {
        Object.assign(current, { state: 'error', result: { error: err.message } });
      }
      current.finishedAt = Date.now();
      current.step = null;
    })();
    return snapshot();
  }

  function stop() {
    if (!child || job?.state !== 'running') return snapshot();
    job.state = 'stopping';
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    return snapshot();
  }

  async function push() {
    if (job?.state !== 'needs-push') throw new HttpError(409, 'Nothing to push. Run Update from Develop first.');
    const current = await ok('branch', '--show-current');
    const head = await ok('rev-parse', 'HEAD');
    if (current !== job.branch || head !== job.result.head) {
      throw new HttpError(409, `${job.branch} changed since the merge. Run Update from Develop again.`);
    }
    const args = job.result.hasUpstream ? ['push', 'origin', job.branch] : ['push', '-u', 'origin', job.branch];
    const res = await git(...args);
    if (res.code !== 0) throw new HttpError(409, `Push failed: ${(res.stderr || res.stdout).trim().split('\n').slice(-2).join(' ')}`);
    Object.assign(job, { state: 'pushed', finishedAt: Date.now() });
    onPushed();
    return snapshot();
  }

  function snapshot() {
    return job ? { ...job, output: job.output ?? '', result: job.result ? { ...job.result } : null, elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt } : null;
  }

  return { status, start, stop, push, job: snapshot };
}

// ---------- routes ----------

const KEY = /^TCPMOB-\d+$/;
function keyOf(raw) {
  const key = String(raw).toUpperCase();
  if (!KEY.test(key)) throw new HttpError(400, 'Expected a ticket key like TCPMOB-123.');
  return key;
}

export function routes(ctx) {
  const repoPath = () => {
    const folder = ctx.settings.resolved().time.mobileClockPath;
    if (!folder) throw new HttpError(409, 'Set your mobile-clock folder in Settings first.');
    return folder;
  };
  ctx.localRepo ??= createLocalRepo({
    repoPath,
    onPushed: () => { ctx.behind?.clear?.(); ctx.gh?.clearCache?.(); }, // the new behind count shows right away
  });
  const local = ctx.localRepo;
  return [
    ['GET', /^\/api\/local\/job$/, () => local.job()],
    ['POST', /^\/api\/local\/job\/stop$/, () => local.stop()],
    ['POST', /^\/api\/local\/job\/push$/, () => local.push()],
    ['GET', /^\/api\/local\/([^/]+)\/status$/, (m) => local.status(keyOf(m[1]))],
    ['POST', /^\/api\/local\/([^/]+)\/(tests|update)$/, async (m, req) => {
      const body = (await ctx.readJson(req)) ?? {};
      return local.start(m[2], keyOf(m[1]), { switch: body.switch === true });
    }],
  ];
}
