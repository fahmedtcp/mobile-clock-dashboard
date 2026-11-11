process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, isWorkday, workdays, monthRange } from '../lib/time/days.js';

test('workdays lists Mon–Fri of November 2026', () => {
  const w = workdays('2026-11');
  assert.equal(w[0], '2026-11-02');
  assert.equal(w.at(-1), '2026-11-30');
  assert.equal(w.length, 21);
  assert.ok(!w.includes('2026-11-07'));
});

test('dayKey uses local time', () => {
  assert.equal(dayKey('2026-11-06T05:30:00Z'), '2026-11-05');
  assert.equal(dayKey(new Date('2026-11-06T18:00:00Z')), '2026-11-06');
});

test('isWorkday and monthRange', () => {
  assert.equal(isWorkday('2026-11-07'), false);
  assert.equal(isWorkday('2026-11-09'), true);
  const r = monthRange('2026-11');
  assert.equal(dayKey(r.start), '2026-11-01');
  assert.equal(dayKey(r.end), '2026-11-30');
});
