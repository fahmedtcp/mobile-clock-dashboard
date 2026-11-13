process.env.TZ = 'Asia/Karachi';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftState } from '../public/shared.js';

const cfg = { start: '13:00', end: '22:00', wrapMinutes: 40 };
const at = (iso) => shiftState(new Date(iso), cfg);

test('moments across the shift', () => {
  const rows = [
    ['2026-11-13T12:59:00+05:00', 'start', 'before'],
    ['2026-11-13T13:00:00+05:00', 'start', 'during'],
    ['2026-11-13T13:59:00+05:00', 'start', 'during'],
    ['2026-11-13T14:00:00+05:00', 'mid', 'during'],
    ['2026-11-13T21:19:00+05:00', 'mid', 'during'],
    ['2026-11-13T21:20:00+05:00', 'wrap', 'during'],
    ['2026-11-13T22:00:00+05:00', 'wrap', 'after'],
    ['2026-11-14T00:30:00+05:00', 'mid', 'weekend'],
    ['2026-11-16T00:30:00+05:00', 'start', 'before'],
    ['2026-11-14T15:00:00+05:00', 'mid', 'weekend'],
  ];
  for (const [iso, moment, phase] of rows) assert.deepEqual([at(iso).moment, at(iso).phase], [moment, phase], iso);
});

test('progress, minutes left, and starts-in', () => {
  const mid = at('2026-11-13T17:30:00+05:00');
  assert.equal(mid.progress, 0.5);
  assert.equal(mid.minutesLeft, 270);
  assert.equal(mid.startsInMinutes, null);
  const early = at('2026-11-13T11:00:00+05:00');
  assert.equal(early.startsInMinutes, 120);
  assert.equal(early.progress, 0);
  const after = at('2026-11-13T23:00:00+05:00');
  assert.equal(after.progress, 1);
  assert.equal(after.minutesLeft, 0);
});

test('prevShiftEnd is the last shift end before now, skipping weekends', () => {
  assert.equal(at('2026-11-16T13:05:00+05:00').prevShiftEnd.toISOString(), new Date('2026-11-13T22:00:00+05:00').toISOString());
  assert.equal(at('2026-11-13T23:00:00+05:00').prevShiftEnd.toISOString(), new Date('2026-11-13T22:00:00+05:00').toISOString());
  assert.equal(at('2026-11-12T13:30:00+05:00').prevShiftEnd.toISOString(), new Date('2026-11-11T22:00:00+05:00').toISOString());
});

test('labelRows puts touching labels on the next free row', async () => {
  const { labelRows } = await import('../public/shared.js');
  // [left, right] in pixels, any order; 6px gap required between labels on one row.
  assert.deepEqual(labelRows([[600, 700], [720, 820], [690, 780], [900, 980]]), [0, 0, 1, 0]);
  assert.deepEqual(labelRows([[0, 100], [50, 150], [60, 160]]), [0, 1, 2]);
  assert.deepEqual(labelRows([[0, 100], [103, 200]]), [0, 1], 'closer than 6px counts as touching');
  assert.deepEqual(labelRows([]), []);
});
