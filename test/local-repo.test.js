// Run Tests and Update from Develop, against a throwaway git repo with its own "origin". Never the real clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseJestSummary, createLocalRepo } from '../lib/local-repo.js';

const KEY = 'TCPMOB-1764';
const BRANCH = `${KEY}-deep-link`;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// origin (bare) ← seed pushes develop + the ticket branch; "clone" is the user's folder.
function repos({ conflict = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'localrepo-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' });
  for (const dir of [seed]) { git(dir, 'config', 'user.email', 't@x.co'); git(dir, 'config', 'user.name', 'T'); }
  writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'base'); git(seed, 'push', '-q', 'origin', 'HEAD:develop');
  git(seed, 'switch', '-qc', BRANCH);
  writeFileSync(path.join(seed, 'b.txt'), 'branch work\n');
  if (conflict) writeFileSync(path.join(seed, 'a.txt'), 'branch version\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'work'); git(seed, 'push', '-q', 'origin', BRANCH);
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
  git(clone, 'config', 'user.email', 't@x.co'); git(clone, 'config', 'user.name', 'T');
  // develop moves on after the clone was made
  git(seed, 'switch', '-q', 'develop');
  writeFileSync(path.join(seed, conflict ? 'a.txt' : 'c.txt'), 'develop moved\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'develop moves'); git(seed, 'push', '-q', 'origin', 'develop');
  return { root, origin, seed, clone };
}

function fakeJest(root, { fail = false } = {}) {
  const script = path.join(root, 'fake-jest.cjs');
  writeFileSync(script, `
console.log(${JSON.stringify(fail ? '  ● Login › shows an error on a bad PIN\n' : '')});
console.log('Test Suites: ${fail ? '1 failed, ' : ''}141 passed, ${fail ? 142 : 141} total');
console.log('Tests:       ${fail ? '1 failed, ' : ''}2 skipped, 1500 passed, ${fail ? 1503 : 1502} total');
console.log('All files                    |   78.12 |    65.4 |   70.1 |   78.9 |');
process.exit(${fail ? 1 : 0});`);
  return ['node', [script]];
}

const waitFor = async (local, states) => {
  for (let i = 0; i < 200; i++) {
    const job = local.job();
    if (job && states.includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job never reached ${states}: ${JSON.stringify(local.job())}`);
};

test('parseJestSummary reads counts, failing tests, and coverage, ignoring colors', () => {
  const out = '\u001b[31m  ● Login › shows an error on a bad PIN\u001b[39m\n  ● Login › shows an error on a bad PIN\n  ● Clock › rounds\n'
    + 'Test Suites: 1 failed, 141 passed, 142 total\nTests:       2 failed, 2 skipped, 1500 passed, 1504 total\n'
    + 'All files                    |   78.12 |    65.4 |   70.1 |   78.9 |';
  assert.deepEqual(parseJestSummary(out), {
    suites: { failed: 1, passed: 141, total: 142 },
    tests: { failed: 2, skipped: 2, passed: 1500, total: 1504 },
    failing: ['Login › shows an error on a bad PIN', 'Clock › rounds'],
    coverage: { statements: 78.12, branches: 65.4, functions: 70.1, lines: 78.9 },
  });
  assert.equal(parseJestSummary('nothing').tests, null);
});

test('status: current branch, the ticket branch, uncommitted changes, and whether a switch is needed', async () => {
  const { clone } = repos();
  const local = createLocalRepo({ repoPath: () => clone });
  let s = await local.status(KEY);
  assert.deepEqual([s.current, s.branch, s.onlyOnGitHub, s.dirty, s.needsSwitch], ['develop', BRANCH, true, 0, true]);
  writeFileSync(path.join(clone, 'a.txt'), 'edited\n');
  writeFileSync(path.join(clone, 'new.txt'), 'untracked is fine\n');
  s = await local.status(KEY);
  assert.equal(s.dirty, 1, 'only tracked changes count');
  await assert.rejects(local.status('TCPMOB-9999'), /No branch for TCPMOB-9999/);
});

test('run tests: switches when asked, passes and fails, and refuses with uncommitted changes', async () => {
  const { root, clone } = repos();
  const local = createLocalRepo({ repoPath: () => clone, testCommand: fakeJest(root) });
  await assert.rejects(local.start('tests', KEY, { switch: false }), /Switch to/);
  await local.start('tests', KEY, { switch: true });
  const job = await waitFor(local, ['passed', 'failed', 'error']);
  assert.equal(job.state, 'passed');
  assert.equal(git(clone, 'branch', '--show-current'), BRANCH);
  assert.equal(job.result.tests.passed, 1500);
  assert.equal(job.result.coverage.lines, 78.9);
  const failing = createLocalRepo({ repoPath: () => clone, testCommand: fakeJest(root, { fail: true }) });
  await failing.start('tests', KEY, { switch: false });
  const bad = await waitFor(failing, ['passed', 'failed', 'error']);
  assert.equal(bad.state, 'failed');
  assert.deepEqual(bad.result.failing, ['Login › shows an error on a bad PIN']);
  writeFileSync(path.join(clone, 'a.txt'), 'dirty\n');
  await assert.rejects(failing.start('tests', KEY, { switch: false }), /Commit or stash your changes first/);
});

test('one job at a time, and Stop ends a running test job', async () => {
  const { root, clone } = repos();
  const slow = path.join(root, 'slow.cjs');
  writeFileSync(slow, 'setTimeout(() => {}, 60000);');
  git(clone, 'switch', '-q', BRANCH);
  const local = createLocalRepo({ repoPath: () => clone, testCommand: ['node', [slow]] });
  await local.start('tests', KEY, { switch: false });
  await assert.rejects(local.start('update', KEY, { switch: false }), /already running/);
  local.stop();
  assert.equal((await waitFor(local, ['stopped'])).state, 'stopped');
});

test('update from develop: fast-forwards develop, merges it, and waits for OK before pushing', async () => {
  const { origin, clone } = repos();
  const local = createLocalRepo({ repoPath: () => clone });
  await local.start('update', KEY, { switch: true });
  const job = await waitFor(local, ['needs-push', 'conflict', 'up-to-date', 'error']);
  assert.equal(job.state, 'needs-push', JSON.stringify(job));
  assert.equal(job.result.ahead, 2, 'the develop commit and the merge commit');
  assert.equal(git(clone, 'rev-parse', 'develop'), git(origin, 'rev-parse', 'develop'), 'local develop fast-forwarded');
  assert.ok(readFileSync(path.join(clone, 'c.txt'), 'utf8').includes('develop moved'));
  assert.notEqual(git(origin, 'rev-parse', BRANCH), git(clone, 'rev-parse', 'HEAD'), 'nothing pushed yet');
  await local.push();
  assert.equal(git(origin, 'rev-parse', BRANCH), git(clone, 'rev-parse', 'HEAD'));
  assert.equal(local.job().state, 'pushed');
});

test('a conflict leaves the branch exactly as it was and lists the files; nothing is pushed', async () => {
  const { origin, clone } = repos({ conflict: true });
  git(clone, 'switch', '-q', BRANCH);
  const before = git(clone, 'rev-parse', 'HEAD');
  const local = createLocalRepo({ repoPath: () => clone });
  await local.start('update', KEY, { switch: false });
  const job = await waitFor(local, ['needs-push', 'conflict', 'error']);
  assert.equal(job.state, 'conflict');
  assert.deepEqual(job.result.conflicts, ['a.txt']);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), before);
  assert.equal(git(clone, 'status', '--porcelain'), '');
  await assert.rejects(local.push(), /Nothing to push/);
  assert.notEqual(git(origin, 'rev-parse', 'develop'), '');
});

test('push refuses when the branch moved after the merge, and never forces', async () => {
  const { clone } = repos();
  const local = createLocalRepo({ repoPath: () => clone });
  await local.start('update', KEY, { switch: true });
  await waitFor(local, ['needs-push']);
  writeFileSync(path.join(clone, 'd.txt'), 'later\n');
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'later');
  await assert.rejects(local.push(), /changed since the merge/);
});

// ---------- routes ----------
import { createServer } from '../server.js';
import { createSettings } from '../lib/settings.js';
import { request } from './helpers.js';

async function bootWith(clone, extra = {}) {
  const settings = createSettings({ file: null, env: {}, initial: { time: { dayHours: 7, mobileClockPath: clone } } });
  const server = createServer({
    gh: { json: async () => [], run: async () => '', clearCache: extra.onGhClear ?? (() => {}) }, tracker: { list: () => [] },
    behind: { get: async () => 0, clear: extra.onBehindClear ?? (() => {}) }, settings, timeDir: mkdtempSync(path.join(tmpdir(), 'lr-')),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, req: request(server.address().port) };
}

test('routes: status, start, job, push; bad keys are 400; a push refreshes behind counts', async () => {
  const { clone } = repos();
  let cleared = 0;
  const { server, req } = await bootWith(clone, { onBehindClear: () => { cleared++; } });
  assert.equal((await req('GET', '/api/local/OPS-1/status')).status, 400);
  const status = (await req('GET', `/api/local/${KEY}/status`)).json();
  assert.equal(status.branch, BRANCH);
  assert.equal((await req('POST', `/api/local/${KEY}/update`, { switch: false })).status, 409, 'needs a switch');
  assert.equal((await req('POST', `/api/local/${KEY}/update`, { switch: true })).status, 200);
  let job;
  for (let i = 0; i < 200; i++) { job = (await req('GET', '/api/local/job')).json(); if (job.state !== 'running') break; await new Promise((r) => setTimeout(r, 25)); }
  assert.equal(job.state, 'needs-push');
  assert.equal((await req('POST', '/api/local/job/push')).json().state, 'pushed');
  assert.ok(cleared >= 1);
  server.close();
});

test('Refresh also clears the behind counts', async () => {
  const { clone } = repos();
  let cleared = 0;
  const { server, req } = await bootWith(clone, { onBehindClear: () => { cleared++; } });
  await req('GET', '/api/home?fresh=1');
  assert.equal(cleared, 1);
  server.close();
});

test('the test output is visible while it runs and kept in the results', async () => {
  const { root, clone } = repos();
  const script = path.join(root, 'chatty.cjs');
  writeFileSync(script, "console.log('PASS src/a.test.ts'); setTimeout(() => { console.log('Tests:       1 passed, 1 total'); }, 400);");
  git(clone, 'switch', '-q', BRANCH);
  const local = createLocalRepo({ repoPath: () => clone, testCommand: ['node', [script]] });
  await local.start('tests', KEY, { switch: false });
  let live = '';
  for (let i = 0; i < 40 && !live.includes('PASS src/a.test.ts'); i++) { await new Promise((r) => setTimeout(r, 25)); live = local.job().output ?? ''; }
  assert.ok(live.includes('PASS src/a.test.ts'), 'seen before the run ends');
  assert.equal(local.job().state, 'running');
  const done = await waitFor(local, ['passed', 'failed']);
  assert.match(done.output, /PASS src\/a\.test\.ts[\s\S]*Tests: {7}1 passed/);
});
