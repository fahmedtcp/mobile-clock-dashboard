import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { countTsErrors, createTsBudget } from '../lib/tsbudget.js';

test('countTsErrors counts only error TS lines', () => {
  assert.equal(countTsErrors("a.ts(1,1): error TS2322: x\nb.ts(2,2): error TS7006: y\nFound 2 errors.\nwarning foo"), 2);
  assert.equal(countTsErrors(''), 0);
});

function setup({ tscOut = 'a.ts(1,1): error TS1: x\nb.ts(1,1): error TS2: y\nc.ts(1,1): error TS3: z\n', gate = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ts-'));
  const repoPath = path.join(dir, 'repo');
  mkdirSync(path.join(repoPath, 'node_modules'), { recursive: true });
  const calls = [];
  let shaN = 0;
  const exec = async (file, args, opts = {}) => {
    calls.push({ file, args, cwd: opts.cwd });
    if (args.includes('worktree') && args.includes('add')) mkdirSync(args.at(-2), { recursive: true });
    if (args.includes('FETCH_HEAD')) return { stdout: 'prsha\n', stderr: '', code: 0 };
    if (args.includes('rev-parse')) return { stdout: `sha${++shaN}\n`, stderr: '', code: 0 };
    if (file === 'node') { if (gate) await gate; return { stdout: tscOut, stderr: '', code: 2 }; }
    return { stdout: '', stderr: '', code: 0 };
  };
  let t = Date.parse('2026-11-06T12:00:00Z');
  const ts = createTsBudget({ repoPath, cacheDir: path.join(dir, 'cache'), historyFile: path.join(dir, 'data', 'h.json'), exec, now: () => t });
  return { ts, calls, repoPath, dir, advance: (ms) => { t += ms; } };
}

test('runDevelop runs fetch → worktree → tsc and appends history', async () => {
  const { ts, calls, repoPath, dir } = setup();
  ts.runDevelop();
  await ts.whenIdle();
  assert.deepEqual(calls.map((c) => [c.file, ...c.args.slice(0, 4)]).slice(0, 3), [
    ['git', '-C', repoPath, 'fetch', 'origin'],
    ['git', '-C', repoPath, 'rev-parse', 'origin/develop'],
    ['git', '-C', repoPath, 'worktree', 'add'],
  ]);
  const tsc = calls.find((c) => c.file === 'node');
  assert.ok(tsc.args[0].endsWith('node_modules/typescript/bin/tsc'));
  assert.deepEqual(tsc.args.slice(1), ['--noEmit', '-p', path.join(dir, 'cache', 'ts-wt', 'tsconfig.json')]);
  assert.ok(lstatSync(path.join(dir, 'cache', 'ts-wt', 'node_modules')).isSymbolicLink());
  assert.deepEqual(ts.history().map((h) => [h.sha, h.count]), [['sha1', 3]]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'data', 'h.json'), 'utf8')).map((h) => h.count), [3]);
  assert.equal(ts.status().running, null);
  assert.equal(ts.status().last.count, 3);
});

test('second run while running returns status and does not spawn', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ts, calls } = setup({ gate });
  const first = ts.runDevelop();
  await new Promise((r) => setTimeout(r, 10));
  const second = ts.runDevelop();
  assert.ok(first.running);
  assert.equal(second.running.target, 'develop');
  release();
  await ts.whenIdle();
  assert.equal(calls.filter((c) => c.file === 'node').length, 1);
});

test('reuses the worktree on later runs via checkout inside the worktree', async () => {
  const { ts, calls, repoPath } = setup();
  ts.runDevelop(); await ts.whenIdle();
  ts.runDevelop(); await ts.whenIdle();
  const checkout = calls.find((c) => c.args.includes('checkout'));
  assert.ok(checkout && !checkout.args.includes(repoPath));
});

test('runPr computes delta vs last develop and caches by sha', async () => {
  const { ts, calls } = setup();
  ts.runDevelop(); await ts.whenIdle();
  ts.runPr(1042); await ts.whenIdle();
  const fetch = calls.filter((c) => c.args.includes('fetch')).at(-1);
  assert.deepEqual(fetch.args.slice(-2), ['origin', 'pull/1042/head']);
  assert.deepEqual([ts.status().prResults[1042].sha, ts.status().prResults[1042].count, ts.status().prResults[1042].delta], ['prsha', 3, 0]);
  const tscRuns = calls.filter((c) => c.file === 'node').length;
  ts.runPr(1042); await ts.whenIdle();
  assert.equal(calls.filter((c) => c.file === 'node').length, tscRuns); // same sha → no new tsc
});

test('never runs git checkout/reset in repoPath itself', async () => {
  const { ts, calls, repoPath } = setup();
  ts.runDevelop(); await ts.whenIdle();
  ts.runPr(1); await ts.whenIdle();
  for (const c of calls) {
    if (c.file !== 'git') continue;
    const inRepo = c.args[0] === '-C' && c.args[1] === repoPath;
    assert.ok(!(inRepo && ['checkout', 'reset', 'switch', 'clean', 'stash'].includes(c.args[2])), c.args.join(' '));
  }
});

test('a failed git step records the error and clears running', async () => {
  const { ts, repoPath, dir } = setup();
  const bad = createTsBudget({ repoPath, cacheDir: path.join(dir, 'c2'), historyFile: path.join(dir, 'c2', 'h.json'), exec: async () => ({ stdout: '', stderr: 'fatal: not a git repository', code: 128 }), now: () => 0 });
  bad.runDevelop(); await bad.whenIdle();
  assert.match(bad.status().error, /not a git repository/);
  assert.equal(bad.status().running, null);
  assert.ok(ts);
});

test('missing local checkout is reported clearly', async () => {
  const ts = createTsBudget({ repoPath: '/definitely/missing', cacheDir: '/tmp/x', historyFile: '/tmp/x/h.json', exec: async () => ({ stdout: '', stderr: '', code: 0 }), now: () => 0 });
  ts.runDevelop(); await ts.whenIdle();
  assert.match(ts.status().error, /mobile-clock folder in Settings/);
});
