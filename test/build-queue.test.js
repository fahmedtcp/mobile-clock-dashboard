import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createQueue } from '../lib/build-queue.js';
import { BuildRequestError } from '../lib/builds.js';

const T0 = Date.parse('2026-11-18T14:00:00Z');
const busyRun = (file) => ({ runId: 1, file, branch: 'TCPMOB-1-other', status: 'in_progress', actor: 'hamza' });

function setup({ file = null } = {}) {
  let t = T0;
  const notes = [];
  const tracker = {
    active: {},
    built: [],
    resumed: [],
    waiting: [],
    triggerError: null,
    onTrigger: null,
    list: () => [],
    async activeSnapshot() { return this.active; },
    waitingRetries() { return this.waiting; },
    async resumeRetry(b) { this.resumed.push(b.id); this.waiting = this.waiting.filter((w) => w !== b); },
    async trigger(prNumber, keys) {
      this.onTrigger?.();
      if (this.triggerError) throw this.triggerError;
      this.built.push([prNumber, keys]);
      return [{ id: 'b' }];
    },
  };
  const queue = createQueue({ tracker, file, now: () => t, notify: (n) => notes.push(n) });
  return { tracker, queue, notes, tick: (ms) => { t += ms; } };
}

test('starts head entry when slot free and notifies', async () => {
  const { tracker, queue, notes } = setup();
  queue.add({ prNumber: 5, key: 'mkIos', branch: 'TCPMOB-1780-x' });
  await queue.tick();
  assert.deepEqual(tracker.built, [[5, ['mkIos']]]);
  assert.deepEqual(queue.list(), []);
  assert.deepEqual(notes, [{ title: 'Build Started', body: 'iOS MobileKiosk build started for TCPMOB-1780' }]);
});

test('leaves entries while slot busy', async () => {
  const { tracker, queue } = setup();
  tracker.active = { 'run-mk-ios.yml': [busyRun('run-mk-ios.yml')] };
  queue.add({ prNumber: 5, key: 'mkIos', branch: 'b' });
  await queue.tick();
  assert.deepEqual(tracker.built, []);
  assert.equal(queue.list().length, 1);
});

test('only one start per slot per tick', async () => {
  const { tracker, queue } = setup();
  queue.add({ prNumber: 5, key: 'mcIos', branch: 'a' });
  queue.add({ prNumber: 6, key: 'mcIos', branch: 'b' });
  await queue.tick();
  assert.deepEqual(tracker.built, [[5, ['mcIos']]]);
  assert.equal(queue.list().length, 1);
});

test('mc and mk slots start independently', async () => {
  const { tracker, queue } = setup();
  tracker.active = { 'run-mc-ios.yml': [busyRun('run-mc-ios.yml')] };
  queue.add({ prNumber: 5, key: 'mcIos', branch: 'a' });
  queue.add({ prNumber: 6, key: 'mkIos', branch: 'b' });
  await queue.tick();
  assert.deepEqual(tracker.built, [[6, ['mkIos']]]);
});

test('retry wait queued earlier goes before a newer entry', async () => {
  const { tracker, queue, tick } = setup();
  const waiting = { id: 'w1', key: 'mcIos', file: 'run-mc-ios.yml', waitingSince: T0, branch: 'z' };
  tracker.waiting = [waiting];
  tick(1000);
  queue.add({ prNumber: 5, key: 'mcIos', branch: 'a' });
  await queue.tick();
  assert.deepEqual(tracker.resumed, ['w1']);
  assert.deepEqual(tracker.built, []);
  await queue.tick();
  assert.deepEqual(tracker.built, [[5, ['mcIos']]]);
});

test('a newer retry wait goes after an older entry', async () => {
  const { tracker, queue, tick } = setup();
  queue.add({ prNumber: 5, key: 'mcIos', branch: 'a' });
  tick(1000);
  tracker.waiting = [{ id: 'w1', key: 'mcIos', file: 'run-mc-ios.yml', waitingSince: T0 + 1000, branch: 'z' }];
  await queue.tick();
  assert.deepEqual(tracker.built, [[5, ['mcIos']]]);
  assert.deepEqual(tracker.resumed, []);
});

test('drops entry when trigger throws BuildRequestError and notifies with its message', async () => {
  const { tracker, queue, notes } = setup();
  tracker.triggerError = new BuildRequestError('PR #5 is not approved.', 409);
  queue.add({ prNumber: 5, key: 'mkIos', branch: 'TCPMOB-1780-x' });
  await queue.tick();
  assert.deepEqual(queue.list(), []);
  assert.deepEqual(notes, [{ title: 'Build Dropped', body: 'iOS MobileKiosk for TCPMOB-1780: PR #5 is not approved.' }]);
});

test('expires after 8 hours', async () => {
  const { tracker, queue, notes, tick } = setup();
  tracker.active = { 'run-mk-ios.yml': [busyRun('run-mk-ios.yml')] };
  queue.add({ prNumber: 5, key: 'mkIos', branch: 'TCPMOB-1780-x' });
  tick(8 * 3600e3 - 1);
  await queue.tick();
  assert.equal(queue.list().length, 1);
  tick(2);
  await queue.tick();
  assert.deepEqual(queue.list(), []);
  assert.deepEqual(notes, [{ title: 'Build Expired', body: 'iOS MobileKiosk build for TCPMOB-1780 expired' }]);
});

test('reload from file keeps entries', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'q-')), 'build-queue.json');
  const first = setup({ file });
  const entry = first.queue.add({ prNumber: 5, key: 'mkIos', branch: 'b' });
  const second = setup({ file });
  assert.deepEqual(second.queue.list(), [entry]);
});

test('entry removed from file before trigger runs', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'q-')), 'build-queue.json');
  const { tracker, queue } = setup({ file });
  queue.add({ prNumber: 5, key: 'mkIos', branch: 'b' });
  let seen = null;
  tracker.onTrigger = () => { seen = JSON.parse(readFileSync(file, 'utf8')); };
  await queue.tick();
  assert.deepEqual(seen, []);
});

test('add refuses Android keys', () => {
  const { queue } = setup();
  assert.throws(() => queue.add({ prNumber: 5, key: 'mcAndroid', branch: 'b' }), (e) => e instanceof BuildRequestError && e.status === 400);
});

test('cancel removes an entry', () => {
  const { queue } = setup();
  const e = queue.add({ prNumber: 5, key: 'mkIos', branch: 'b' });
  assert.equal(queue.cancel(e.id), true);
  assert.equal(queue.cancel(e.id), false);
  assert.deepEqual(queue.list(), []);
});

// ---------- routes ----------
import { createServer } from '../server.js';
import { request } from './helpers.js';

test('queue routes add, list, and cancel; DELETE also cancels a retry wait', async () => {
  const cancelled = [];
  const tracker = {
    list: () => [], refresh: async () => [], waitingRetries: () => [{ id: 'w1', key: 'mkIos' }],
    cancelWait: (id) => { cancelled.push(id); return id === 'w1'; },
  };
  const gh = { json: async (args) => (args[0] === 'pr' ? { number: 5, state: 'OPEN', headRefName: 'TCPMOB-1780-x' } : []), run: async () => '' };
  const notes = [];
  const server = createServer({ gh, tracker, behind: { get: async () => 0, clear() {} }, queueFile: null, notify: (n) => notes.push(n) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = request(server.address().port);
  try {
    const added = (await call('POST', '/api/build-queue', { prNumber: 5, key: 'mkIos' })).json();
    assert.equal(added.branch, 'TCPMOB-1780-x');
    assert.equal(added.key, 'mkIos');
    const listed = (await call('GET', '/api/build-queue')).json();
    assert.deepEqual(listed.entries.map((e) => e.id), [added.id]);
    assert.deepEqual(listed.retries.map((r) => r.id), ['w1']);
    assert.equal((await call('POST', '/api/build-queue', { prNumber: 5, key: 'mcAndroid' })).status, 400);
    assert.equal((await call('DELETE', `/api/build-queue/${added.id}`)).status, 200);
    assert.equal((await call('DELETE', '/api/build-queue/w1')).status, 200);
    assert.deepEqual(cancelled, ['w1']);
    assert.equal((await call('DELETE', '/api/build-queue/nope')).status, 404);
  } finally { server.close(); }
});
