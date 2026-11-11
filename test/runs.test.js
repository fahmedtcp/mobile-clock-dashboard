import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeColor, listRuns, statusStrip, rerunFailed, cancelRun, getLogin } from '../lib/runs.js';

const REPO = 'tcp-software/mobile-clock';
function fakeGh(result = []) {
  const calls = [];
  return { calls, json: async (a) => { calls.push(a); return result; }, run: async (a) => { calls.push(a); return 'fahmedtcp\n'; } };
}

test('badgeColor', () => {
  assert.equal(badgeColor({ status: 'completed', conclusion: 'success' }), 'green');
  for (const c of ['failure', 'cancelled', 'timed_out', 'startup_failure']) assert.equal(badgeColor({ status: 'completed', conclusion: c }), 'red');
  assert.equal(badgeColor({ status: 'in_progress', conclusion: '' }), 'grey');
  assert.equal(badgeColor(null), 'grey');
});

test('listRuns passes filters as flags', async () => {
  const gh = fakeGh();
  await listRuns(gh, { workflow: 'run-tests.yml', branch: 'develop', user: 'fahmedtcp' });
  const args = gh.calls[0];
  assert.deepEqual(args.slice(0, 10), ['run', 'list', '-R', REPO, '-L', '50', '-w', 'run-tests.yml', '-b', 'develop']);
  assert.ok(args.includes('-u') && args.includes('fahmedtcp'));
});

test('listRuns without filters adds no filter flags', async () => {
  const gh = fakeGh();
  await listRuns(gh, {});
  assert.ok(!gh.calls[0].includes('-w') && !gh.calls[0].includes('-b') && !gh.calls[0].includes('-u'));
});

test('statusStrip queries develop only for devTests and returns grey when no runs', async () => {
  const gh = fakeGh([]);
  const badges = await statusStrip(gh);
  assert.deepEqual(badges.map((b) => [b.key, b.color, b.url]), [['nightly', 'grey', null], ['devTests', 'grey', null]]);
  const nightly = gh.calls.find((a) => a.includes('run-ios-mc-nightly.yml'));
  const dev = gh.calls.find((a) => a.includes('run-tests.yml'));
  assert.ok(!nightly.includes('-b'));
  assert.equal(dev[dev.indexOf('-b') + 1], 'develop');
});

test('statusStrip maps latest run to badge', async () => {
  const gh = fakeGh([{ status: 'completed', conclusion: 'failure', url: 'u1' }]);
  const [b] = await statusStrip(gh);
  assert.deepEqual([b.color, b.url, b.conclusion, b.label], ['red', 'u1', 'failure', 'iOS MC nightly']);
});

test('rerunFailed and cancelRun', async () => {
  const gh = fakeGh();
  await rerunFailed(gh, 123);
  await cancelRun(gh, 123);
  assert.deepEqual(gh.calls, [['run', 'rerun', '123', '--failed', '-R', REPO], ['run', 'cancel', '123', '-R', REPO]]);
});

test('getLogin caches after first call', async () => {
  const gh = fakeGh();
  assert.equal(await getLogin(gh), 'fahmedtcp');
  await getLogin(gh);
  assert.equal(gh.calls.length, 1);
});
