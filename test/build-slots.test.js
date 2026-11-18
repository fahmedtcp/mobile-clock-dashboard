import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentRuns, findConflicts, slotBusy, ticketKeyOf, isActive, BUILD_FILES, IOS_SLOTS } from '../lib/build-slots.js';

const restRun = {
  id: 9, html_url: 'u', head_branch: 'TCPMOB-1764-x', actor: { login: 'hamza' }, status: 'in_progress', conclusion: null,
  created_at: 'c', run_started_at: 's', updated_at: 'd', run_attempt: 1,
};
const run = (over = {}) => ({
  runId: 9, file: 'run-mc-ios.yml', url: 'u', branch: 'TCPMOB-1764-x', actor: 'hamza', status: 'in_progress',
  conclusion: null, createdAt: 'c', startedAt: 's', updatedAt: 'd', attempt: 1, ...over,
});
const BRANCH = 'TCPMOB-1800-mine';

test('constants name the four build workflows and two iOS slots', () => {
  assert.deepEqual(BUILD_FILES, ['run-mc-ios.yml', 'run-mk-ios.yml', 'run-mc-android.yml', 'run-mk-android.yml']);
  assert.deepEqual(IOS_SLOTS, { 'run-mc-ios.yml': 'iOS MobileClock', 'run-mk-ios.yml': 'iOS MobileKiosk' });
});

test('recentRuns maps REST runs', async () => {
  const calls = [];
  const gh = { json: async (args, opts) => { calls.push([args, opts]); return { workflow_runs: [restRun] }; } };
  assert.deepEqual(await recentRuns(gh, 'run-mc-ios.yml'), [run()]);
  assert.deepEqual(calls[0][0], ['api', 'repos/tcp-software/mobile-clock/actions/workflows/run-mc-ios.yml/runs', '-X', 'GET', '-f', 'per_page=30']);
  await recentRuns(gh, 'run-mc-ios.yml', { actor: 'me', since: '2026-11-04', fresh: true });
  assert.deepEqual(calls[1][0].slice(4), ['-f', 'per_page=30', '-f', 'actor=me', '-f', 'created=>=2026-11-04']);
  assert.deepEqual(calls[1][1], { fresh: true });
});

test('recentRuns gives [] for odd responses', async () => {
  assert.deepEqual(await recentRuns({ json: async () => [] }, 'run-mc-ios.yml'), []);
  assert.deepEqual(await recentRuns({ json: async () => ({}) }, 'run-mc-ios.yml'), []);
});

test('isActive covers the in-flight statuses', () => {
  for (const s of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) assert.equal(isActive({ status: s }), true);
  assert.equal(isActive({ status: 'completed' }), false);
});

test('ios slot conflicts across branches, not across apps', () => {
  const c = findConflicts({ keys: ['mcIos', 'mkIos'], branch: BRANCH, active: { 'run-mc-ios.yml': [run()] }, tracked: [] });
  assert.equal(c.mcIos.length, 1);
  assert.equal(c.mcIos[0].rule, 'ios-slot');
  assert.equal(c.mcIos[0].ticketKey, 'TCPMOB-1764');
  assert.equal(c.mcIos[0].actor, 'hamza');
  assert.deepEqual(c.mkIos, []);
});

test('sim start never trips the ios slot rule', () => {
  const other = findConflicts({ keys: ['mcIosSim'], branch: BRANCH, active: { 'run-mc-ios.yml': [run()] }, tracked: [] });
  assert.deepEqual(other.mcIosSim, []);
  const same = findConflicts({ keys: ['mcIosSim'], branch: BRANCH, active: { 'run-mc-ios.yml': [run({ branch: BRANCH })] }, tracked: [] });
  assert.deepEqual(same.mcIosSim.map((x) => x.rule), ['same-branch']);
});

test('same-branch applies to android', () => {
  const mine = run({ file: 'run-mc-android.yml', branch: BRANCH });
  const c = findConflicts({ keys: ['mcAndroid', 'mkAndroid'], branch: BRANCH, active: { 'run-mc-android.yml': [mine] }, tracked: [] });
  assert.deepEqual(c.mcAndroid.map((x) => x.rule), ['same-branch']);
  assert.deepEqual(c.mkAndroid, []);
  const elsewhere = findConflicts({ keys: ['mcAndroid'], branch: BRANCH, active: { 'run-mc-android.yml': [run({ file: 'run-mc-android.yml' })] }, tracked: [] });
  assert.deepEqual(elsewhere.mcAndroid, []);
});

test('same branch ios run is one conflict, reported as same-branch', () => {
  const c = findConflicts({ keys: ['mcIos'], branch: BRANCH, active: { 'run-mc-ios.yml': [run({ branch: BRANCH })] }, tracked: [] });
  assert.deepEqual(c.mcIos.map((x) => x.rule), ['same-branch']);
});

test('requested tracker build holds its slot', () => {
  const tracked = [{ id: 't1', key: 'mkIos', status: 'requested', runId: null, branch: 'TCPMOB-1780-b2', triggeredAt: Date.now() }];
  const c = findConflicts({ keys: ['mkIos'], branch: BRANCH, active: {}, tracked });
  assert.equal(c.mkIos.length, 1);
  assert.equal(c.mkIos[0].rule, 'ios-slot');
  assert.equal(c.mkIos[0].runId, null);
  assert.equal(c.mkIos[0].ticketKey, 'TCPMOB-1780');
});

test('tracker build between retry attempts holds its slot', () => {
  const tracked = [{ id: 't1', key: 'mcIos', status: 'queued', runId: 50, attempt: 1, waitAttempt: 2, branch: 'b', triggeredAt: 5 }];
  assert.ok(slotBusy({ file: 'run-mc-ios.yml', active: {}, tracked }));
});

test('tracked sim run frees the ios slot', () => {
  const tracked = [{ id: 's', key: 'mcIosSim', status: 'in_progress', runId: 9, branch: 'TCPMOB-1764-x' }];
  const c = findConflicts({ keys: ['mcIos'], branch: BRANCH, active: { 'run-mc-ios.yml': [run()] }, tracked });
  assert.deepEqual(c.mcIos, []);
});

test('waiting-slot tracker build does not hold the slot', () => {
  const tracked = [{ id: 'w', key: 'mcIos', status: 'waiting-slot', runId: 50, branch: 'b' }];
  assert.equal(slotBusy({ file: 'run-mc-ios.yml', active: {}, tracked }), null);
});

test('slotBusy ignores excludeBuildId and dedupes by runId', () => {
  const tracked = [{ id: 'me', key: 'mcIos', status: 'requested', runId: null, branch: 'b' }];
  assert.equal(slotBusy({ file: 'run-mc-ios.yml', active: {}, tracked, excludeBuildId: 'me' }), null);
  const both = [{ id: 'x', key: 'mcIos', status: 'queued', runId: 9, attempt: 1, waitAttempt: 2, branch: 'TCPMOB-1764-x' }];
  const c = findConflicts({ keys: ['mcIos'], branch: BRANCH, active: { 'run-mc-ios.yml': [run()] }, tracked: both });
  assert.equal(c.mcIos.length, 1);
});

test('ticketKeyOf reads the key from a branch name', () => {
  assert.equal(ticketKeyOf('TCPMOB-1764-fix-thing'), 'TCPMOB-1764');
  assert.equal(ticketKeyOf('tcpmob-12_x'), 'TCPMOB-12');
  assert.equal(ticketKeyOf('develop'), null);
  assert.equal(ticketKeyOf(null), null);
});

test('requested tracker build on the same branch is a same-branch conflict', () => {
  const tracked = [{ id: 't1', key: 'mcIos', status: 'requested', runId: null, branch: BRANCH, triggeredAt: Date.now() }];
  const c = findConflicts({ keys: ['mcIos'], branch: BRANCH, active: {}, tracked });
  assert.deepEqual(c.mcIos.map((x) => x.rule), ['same-branch']);
});

test('a requested build holds its slot only for 10 minutes', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const fresh = [{ id: 'a', key: 'mcIos', status: 'requested', runId: null, branch: 'b', triggeredAt: now - 9 * 60e3 }];
  const stale = [{ id: 'a', key: 'mcIos', status: 'requested', runId: null, branch: 'b', triggeredAt: now - 11 * 60e3 }];
  assert.ok(slotBusy({ file: 'run-mc-ios.yml', active: {}, tracked: fresh, now }));
  assert.equal(slotBusy({ file: 'run-mc-ios.yml', active: {}, tracked: stale, now }), null);
});
