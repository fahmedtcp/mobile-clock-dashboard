process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRemind, reminderText, notify } from '../lib/time/reminder.js';

const at = (iso) => new Date(iso);
const base = { reminderAt: '20:30', pending: [], todayRecord: null };

test('sends at 20:30 on an unconfirmed workday, once', () => {
  assert.deepEqual(shouldRemind({ ...base, now: at('2026-11-10T20:29:00-06:00'), lastSentDay: null }), { send: false, day: null });
  assert.deepEqual(shouldRemind({ ...base, now: at('2026-11-10T20:31:00-06:00'), lastSentDay: null }), { send: true, day: '2026-11-10' });
  assert.equal(shouldRemind({ ...base, now: at('2026-11-10T21:00:00-06:00'), lastSentDay: '2026-11-10' }).send, false);
});

test('never for a confirmed or leave day, on weekends, or when off', () => {
  const late = at('2026-11-10T21:00:00-06:00');
  assert.equal(shouldRemind({ ...base, now: late, lastSentDay: null, todayRecord: { status: 'confirmed', leaveHours: 0 } }).send, false);
  assert.equal(shouldRemind({ ...base, now: late, lastSentDay: null, todayRecord: { status: 'draft', leaveHours: 7 } }).send, false);
  assert.equal(shouldRemind({ ...base, now: at('2026-11-07T21:00:00-06:00'), lastSentDay: null }).send, false);
  assert.equal(shouldRemind({ ...base, reminderAt: 'off', now: late, lastSentDay: null, pending: ['2026-11-09'] }).send, false);
});

test('catch-up on next start for the most recent unconfirmed past workday', () => {
  const r = shouldRemind({ ...base, now: at('2026-11-11T09:00:00-06:00'), lastSentDay: '2026-11-09', pending: ['2026-11-05', '2026-11-10'] });
  assert.deepEqual(r, { send: true, day: '2026-11-10' });
  assert.equal(shouldRemind({ ...base, now: at('2026-11-11T09:00:00-06:00'), lastSentDay: '2026-11-10', pending: ['2026-11-10'] }).send, false);
});

test('reminderText', () => {
  assert.deepEqual(reminderText('2026-11-10', { tickets: 3, hours: 7 }, '2026-11-10'), { title: "Confirm today's hours", body: '3 tickets, 7h suggested' });
  assert.equal(reminderText('2026-11-09', { tickets: 1, hours: 7 }, '2026-11-10').title, 'Confirm hours for Mon, Nov 9');
});

test('notify escapes quotes and backslashes and uses execFile args, not a shell', async () => {
  const calls = [];
  await notify({ title: 'T "x"', body: 'he said "hi" \\ ok' }, async (file, args) => { calls.push([file, args]); return { code: 0 }; });
  assert.equal(calls[0][0], 'osascript');
  assert.deepEqual(calls[0][1].slice(0, 1), ['-e']);
  assert.equal(calls[0][1][1], 'display notification "he said \\"hi\\" \\\\ ok" with title "T \\"x\\""');
});

test('at most one reminder per calendar day, even after a catch-up that morning', () => {
  // Monday was missed; Tuesday 09:00 sends the catch-up; Tuesday 20:31 must not send again.
  const morning = shouldRemind({ ...base, now: at('2026-11-10T09:00:00-06:00'), lastSentDay: null, lastSentOn: null, pending: ['2026-11-09'] });
  assert.deepEqual(morning, { send: true, day: '2026-11-09' });
  const evening = shouldRemind({ ...base, now: at('2026-11-10T20:31:00-06:00'), lastSentDay: '2026-11-09', lastSentOn: '2026-11-10', pending: ['2026-11-09'] });
  assert.equal(evening.send, false);
});
