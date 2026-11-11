import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffNotifications, pollDelay } from '../public/notify.js';

const b = (status) => ({ id: 'b1', label: 'Android MobileClock', prNumber: 1042, status, conclusion: null, url: 'u' });
const done = (conclusion) => ({ ...b('completed'), conclusion });
const badge = (color) => ({ key: 'nightly', label: 'iOS MC nightly', color, url: 'r' });

test('first load never notifies', () => {
  assert.deepEqual(diffNotifications(null, { builds: [done('success')], badges: [badge('red')] }), []);
});

test('build moving to completed notifies once with conclusion', () => {
  const n = diffNotifications({ builds: [b('in_progress')], badges: [] }, { builds: [done('failure')], badges: [] });
  assert.equal(n.length, 1);
  assert.match(n[0].title, /Android MobileClock/);
  assert.match(n[0].body, /failure/);
  assert.equal(n[0].url, 'u');
  assert.equal(diffNotifications({ builds: [done('failure')], badges: [] }, { builds: [done('failure')], badges: [] }).length, 0);
});

test('new build that is already completed on first sight notifies', () => {
  assert.equal(diffNotifications({ builds: [], badges: [] }, { builds: [done('success')], badges: [] }).length, 1);
});

test('badge turning red notifies; red staying red does not', () => {
  assert.equal(diffNotifications({ builds: [], badges: [badge('green')] }, { builds: [], badges: [badge('red')] }).length, 1);
  assert.equal(diffNotifications({ builds: [], badges: [badge('red')] }, { builds: [], badges: [badge('red')] }).length, 0);
});

test('pollDelay is 15s with active work, else 60s', () => {
  assert.equal(pollDelay([b('requested')], []), 15000);
  assert.equal(pollDelay([], [{ status: 'queued' }]), 15000);
  assert.equal(pollDelay([], [{ status: 'in_progress' }]), 15000);
  assert.equal(pollDelay([done('success')], [{ status: 'completed' }]), 60000);
});

import { submitState, behindStale } from '../public/notify.js';

test('submitState stays disabled while in flight regardless of checks', () => {
  assert.deepEqual(submitState(3, true), { disabled: true, label: 'Triggering...' });
  assert.deepEqual(submitState(3, false), { disabled: false, label: 'Trigger 3 builds' });
  assert.deepEqual(submitState(1, false), { disabled: false, label: 'Trigger 1 build' });
  assert.deepEqual(submitState(0, false), { disabled: true, label: 'Trigger 0 builds' });
});

test('behindStale refetches missing, failed-old, and expired entries', () => {
  assert.equal(behindStale(undefined, 1000), true);
  assert.equal(behindStale({ loading: true, at: 0 }, 999999), false);
  assert.equal(behindStale({ behind: 2, at: 0 }, 300000), false);
  assert.equal(behindStale({ behind: 2, at: 0 }, 300001), true);
  assert.equal(behindStale({ error: true, at: 0 }, 300001), true);
});

test('final failure notification names attempts and the reason', () => {
  const failed = { ...b('completed'), conclusion: 'failure', attempt: 3, retries: 2,
    reason: { step: 'IOS MobileKiosk Build › Release iOS Mobile Kiosk App Dev', lines: ['x', 'The Internet connection appears to be offline. (-1009)'] } };
  const [n] = diffNotifications({ builds: [b('in_progress')], badges: [] }, { builds: [failed], badges: [] });
  assert.equal(n.title, 'Android MobileClock failed after 3 attempts');
  assert.match(n.body, /Release iOS Mobile Kiosk App Dev/);
  assert.match(n.body, /offline/);
});

test('success after a retry says so', () => {
  const ok = { ...b('completed'), conclusion: 'success', attempt: 2, retries: 1 };
  const [n] = diffNotifications({ builds: [b('queued')], badges: [] }, { builds: [ok], badges: [] });
  assert.equal(n.title, 'Android MobileClock succeeded');
  assert.match(n.body, /after 1 automatic retry/);
});
