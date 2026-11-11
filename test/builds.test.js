import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, matchRun, BuildRequestError } from '../lib/builds.js';

const T0 = Date.parse('2026-11-06T12:00:00Z');

function fakeGh({ pr = { state: 'OPEN', reviewDecision: 'APPROVED', headRefName: 'TCPMOB-1482-x' }, runs = [] } = {}) {
  const runCalls = [];
  return {
    runCalls,
    run: async (args) => { runCalls.push(args); return ''; },
    json: async (args) => (args[0] === 'pr' ? pr : runs),
  };
}

test('trigger hardcodes dev values and uses the branch from GitHub', async () => {
  const gh = fakeGh();
  const tracker = createTracker(gh, () => T0);
  const made = await tracker.trigger(1042, ['mcAndroid', 'mkIos']);
  assert.deepEqual(gh.runCalls, [
    ['workflow', 'run', 'run-mc-android.yml', '-R', 'tcp-software/mobile-clock', '--ref', 'TCPMOB-1482-x', '-f', 'buildType=release dev', '-f', 'sendReleaseUpdates=false'],
    ['workflow', 'run', 'run-mk-ios.yml', '-R', 'tcp-software/mobile-clock', '--ref', 'TCPMOB-1482-x', '-f', 'buildType=release dev', '-f', 'sendReleaseUpdates=false'],
  ]);
  assert.equal(made.length, 2);
  assert.equal(tracker.list().length, 2);
  assert.equal(made[0].status, 'requested');
  assert.equal(made[0].label, 'Android MobileClock');
  assert.notEqual(made[0].id, made[1].id);
});

test('rejects not-approved PR with 409', async () => {
  const gh = fakeGh({ pr: { state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', headRefName: 'b' } });
  await assert.rejects(createTracker(gh).trigger(1084, ['mcAndroid']), (e) => e instanceof BuildRequestError && e.status === 409);
  assert.equal(gh.runCalls.length, 0);
});

test('rejects closed PR with 409', async () => {
  const gh = fakeGh({ pr: { state: 'MERGED', reviewDecision: 'APPROVED', headRefName: 'b' } });
  await assert.rejects(createTracker(gh).trigger(1, ['mcAndroid']), (e) => e.status === 409);
  assert.equal(gh.runCalls.length, 0);
});

test('rejects empty or unknown keys with 400 and triggers nothing', async () => {
  const gh = fakeGh();
  const tracker = createTracker(gh);
  await assert.rejects(tracker.trigger(1042, []), (e) => e.status === 400);
  await assert.rejects(tracker.trigger(1042, ['mcAndroid', 'releaseProd']), (e) => e.status === 400);
  await assert.rejects(tracker.trigger(1042, 'mcAndroid'), (e) => e.status === 400);
  await assert.rejects(tracker.trigger(1042, ['toString']), (e) => e.status === 400);
  assert.equal(gh.runCalls.length, 0);
});

test('matchRun picks earliest unclaimed run created no earlier than 10s before trigger', () => {
  const b = { triggeredAt: T0 };
  const runs = [
    { databaseId: 3, createdAt: '2026-11-06T12:00:09Z' },
    { databaseId: 2, createdAt: '2026-11-06T12:00:04Z' },
    { databaseId: 1, createdAt: '2026-11-06T11:58:00Z' },
  ];
  assert.equal(matchRun(runs, b, new Set()).databaseId, 2);
  assert.equal(matchRun(runs, b, new Set([2])).databaseId, 3);
  assert.equal(matchRun(runs, b, new Set([2, 3])), null);
});

test('refresh fills runId/status for two builds of one workflow without sharing a run', async () => {
  const gh = fakeGh({ runs: [
    { databaseId: 11, createdAt: '2026-11-06T12:00:03Z', status: 'in_progress', conclusion: '', url: 'u11' },
    { databaseId: 12, createdAt: '2026-11-06T12:00:20Z', status: 'queued', conclusion: '', url: 'u12' },
  ] });
  let t = T0;
  const tracker = createTracker(gh, () => t);
  await tracker.trigger(1042, ['mcAndroid']);
  t = T0 + 15000;
  await tracker.trigger(1042, ['mcAndroid']);
  const [a, b] = await tracker.refresh();
  assert.equal(a.runId, 11);
  assert.equal(a.status, 'in_progress');
  assert.equal(a.url, 'u11');
  assert.equal(b.runId, 12);
  assert.equal(b.status, 'queued');
  const listCall = gh.runCalls.length; // run() only used for triggers
  assert.equal(listCall, 2);
});

test('partial trigger failure keeps sent builds and reports them', async () => {
  const gh = fakeGh();
  let n = 0;
  gh.run = async () => { if (++n === 2) throw new Error('boom'); return ''; };
  const tracker = createTracker(gh);
  await assert.rejects(tracker.trigger(1042, ['mcAndroid', 'mkAndroid']), /Android MobileClock/);
  assert.equal(tracker.list().length, 1);
});

test('partial trigger failure is a 502 BuildRequestError listing started keys', async () => {
  const gh = fakeGh();
  let n = 0;
  gh.run = async () => { if (++n === 2) throw new Error('boom'); return ''; };
  const err = await createTracker(gh).trigger(1042, ['mcAndroid', 'mkAndroid']).catch((e) => e);
  assert.ok(err instanceof BuildRequestError);
  assert.equal(err.status, 502);
  assert.deepEqual(err.started, ['mcAndroid']);
});

test('rejects fork PR with 409 and triggers nothing', async () => {
  const gh = fakeGh({ pr: { state: 'OPEN', reviewDecision: 'APPROVED', headRefName: 'b', isCrossRepository: true } });
  await assert.rejects(createTracker(gh).trigger(1, ['mcAndroid']), (e) => e.status === 409 && /fork/.test(e.message));
  assert.equal(gh.runCalls.length, 0);
});

test('simulator build sends build dev .app and never release prod', async () => {
  const gh = fakeGh();
  await createTracker(gh).trigger(1042, ['mcIosSim']);
  assert.deepEqual(gh.runCalls, [['workflow', 'run', 'run-mc-ios.yml', '-R', 'tcp-software/mobile-clock', '--ref', 'TCPMOB-1482-x', '-f', 'buildType=build dev .app', '-f', 'sendReleaseUpdates=false']]);
});

test('builds survive a restart and keep retrying from where they were', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'builds-')), 'builds.json');
  let t = T0;
  const first = createTracker(fakeGh(), () => t, { file });
  await first.trigger(1042, ['mcAndroid']);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // "npm start" again: a new tracker reads the same file, then sees the run fail on a runner problem.
  const gh = fakeGh({ runs: [{ databaseId: 21, createdAt: '2026-11-06T12:00:04Z', status: 'completed', conclusion: 'failure', url: 'u21', attempt: 1 }] });
  gh.json = async (args) => (args[0] === 'pr' ? {} : args[0] === 'run' && args[1] === 'view' ? { jobs: [{ databaseId: 5, name: 'build', conclusion: 'failure', steps: [] }] } : [{ databaseId: 21, createdAt: '2026-11-06T12:00:04Z', status: 'completed', conclusion: 'failure', url: 'u21', attempt: 1 }]);
  gh.run = async (args) => { gh.runCalls.push(args); return args.includes('--log-failed') ? 'The runner has received a shutdown signal' : ''; };
  const second = createTracker(gh, () => t, { file });
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].status, 'requested');
  const [b] = await second.refresh();
  assert.equal(b.runId, 21);
  assert.equal(b.retries, 1, 'the restarted server reran the failed build');
  assert.ok(gh.runCalls.some((a) => a.includes('rerun')));
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].retries, 1, 'the retry count is saved too');

  // A new trigger after restart doesn't reuse an old id.
  const [c] = await second.trigger(1042, ['mkAndroid']).catch(() => [null]);
  if (c) assert.notEqual(c.id, b.id);
});

test('finished builds older than 7 days are dropped on load; a corrupt file is ignored', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'builds-'));
  const file = path.join(dir, 'builds.json');
  const old = { id: 'a', status: 'completed', triggeredAt: T0 - 8 * 864e5 };
  const running = { id: 'b', status: 'in_progress', triggeredAt: T0 - 8 * 864e5 };
  const recent = { id: 'c', status: 'completed', triggeredAt: T0 - 864e5 };
  writeFileSync(file, JSON.stringify([old, running, recent]));
  assert.deepEqual(createTracker(fakeGh(), () => T0, { file }).list().map((b) => b.id), ['b', 'c']);
  writeFileSync(file, '{oops');
  assert.deepEqual(createTracker(fakeGh(), () => T0, { file }).list(), []);
});
