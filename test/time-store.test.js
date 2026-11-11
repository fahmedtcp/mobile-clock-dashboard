process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore, validateDay } from '../lib/time/store.js';

test('validateDay rejects weekend, future, bad leave, bad key, bad hours, duplicate key, wrong confirmed total', () => {
  const today = '2026-11-10';
  const d = (rec) => ({ status: 'draft', leaveHours: 0, entries: [], ...rec });
  assert.match(validateDay('2026-11-07', d({}), today), /weekend/i);
  assert.match(validateDay('2026-11-11', d({}), today), /future/i);
  assert.match(validateDay('2026-13-45', d({}), today), /date/i);
  assert.match(validateDay('2026-11-10', d({ leaveHours: 0.3 }), today), /leave/i);
  assert.match(validateDay('2026-11-10', d({ leaveHours: 7.5 }), today), /leave/i);
  assert.match(validateDay('2026-11-10', d({ entries: [{ key: 'HR-1', hours: 1 }] }), today), /key/i);
  assert.match(validateDay('2026-11-10', d({ entries: [{ key: 'TCPMOB-1', hours: 0.7 }] }), today), /hours/i);
  assert.match(validateDay('2026-11-10', d({ entries: [{ key: 'TCPMOB-1', hours: 1 }, { key: 'TCPMOB-1', hours: 1 }] }), today), /twice/i);
  assert.match(validateDay('2026-11-10', d({ status: 'confirmed', leaveHours: 1, entries: [{ key: 'TCPMOB-1', hours: 5 }] }), today), /6/);
  assert.equal(validateDay('2026-11-10', d({ status: 'confirmed', leaveHours: 7 }), today), null);
  assert.equal(validateDay('2026-11-10', d({ status: 'confirmed', leaveHours: 1.5, entries: [{ key: 'TCPMOB-1', hours: 5.5 }] }), today), null);
});

test('store round-trips and writes atomically (no leftover tmp file)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'store-'));
  const file = path.join(dir, 'time', 'confirmed.json');
  const s = createStore(file);
  assert.equal(s.get('2026-11-10'), null);
  s.save('2026-11-10', { status: 'confirmed', leaveHours: 0, entries: [{ key: 'TCPMOB-1', hours: 7, manual: false }], confirmedAt: 'x' });
  assert.equal(createStore(file).get('2026-11-10').entries[0].hours, 7);
  assert.deepEqual(readdirSync(path.join(dir, 'time')), ['confirmed.json']);
});

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
test('a corrupt confirmed.json is preserved, not wiped by the next save', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'store-'));
  const file = path.join(dir, 'confirmed.json');
  writeFileSync(file, '{"2026-11-02":{"status":"confirmed","leaveHours":0,"entr');
  const s = createStore(file);
  s.save('2026-11-09', { status: 'draft', leaveHours: 0, entries: [], confirmedAt: null });
  const kept = readdirSync(dir).find((f) => f.startsWith('confirmed.json.corrupt-'));
  assert.ok(kept, 'corrupt file kept aside');
  assert.match(readFileSync(path.join(dir, kept), 'utf8'), /2026-11-02/);
  assert.ok(createStore(file).get('2026-11-09'));
});

test('a draft with full-day leave and ticket entries is rejected', () => {
  assert.match(validateDay('2026-11-10', { status: 'draft', leaveHours: 7, entries: [{ key: 'TCPMOB-1', hours: 1 }] }, '2026-11-10'), /leave/i);
});
