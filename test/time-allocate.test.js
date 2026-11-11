import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWeights, allocate, rebalance, evidenceText } from '../lib/time/allocate.js';

const sum = (r) => r.reduce((a, x) => a + x.hours, 0);

test('allocate sums exactly to target in 0.5 steps, min 0.5, max 5 tickets', () => {
  const r = allocate(new Map([['A', 6], ['B', 1], ['C', 1], ['D', 1], ['E', 1], ['F', 1]]), 7);
  assert.equal(r.length, 5);
  assert.equal(sum(r), 7);
  assert.ok(r.every((x) => x.hours >= 0.5 && (x.hours * 2) % 1 === 0));
  assert.equal(r[0].key, 'A');
});

test('allocate is proportional', () => {
  assert.deepEqual(allocate(new Map([['A', 3], ['B', 1]]), 7), [{ key: 'A', hours: 5 }, { key: 'B', hours: 2 }]);
});

test('6.5h leave with three tickets keeps only the top one at 0.5h', () => {
  assert.deepEqual(allocate(new Map([['A', 3], ['B', 2], ['C', 1]]), 0.5), [{ key: 'A', hours: 0.5 }]);
});

test('zero target, empty weights, zero weights return []', () => {
  assert.deepEqual(allocate(new Map([['A', 1]]), 0), []);
  assert.deepEqual(allocate(new Map(), 7), []);
  assert.deepEqual(allocate(new Map([['A', 0]]), 7), []);
});

test('dayWeights applies caps, keeps only known tickets, and records evidence', () => {
  const commits = Array.from({ length: 9 }, () => ({ key: 'TCPMOB-1' })).concat([{ key: 'TCPMOB-99' }, { key: null }]);
  const claude = [{ segments: [{ key: 'TCPMOB-1', activeMinutes: 400 }, { key: 'TCPMOB-2', activeMinutes: 45 }, { key: 'TCPMOB-5', activeMinutes: 60 }] }];
  const w = dayWeights({ inProgress: new Set(['TCPMOB-1']), commits, claude, activity: new Map([['TCPMOB-2', 5]]) }, new Set(['TCPMOB-1', 'TCPMOB-2']));
  assert.deepEqual([...w.keys()].sort(), ['TCPMOB-1', 'TCPMOB-2']); // TCPMOB-99 and TCPMOB-5 aren't real tickets for the user
  assert.equal(w.get('TCPMOB-1').weight, 2 + 5 + 6);
  assert.equal(w.get('TCPMOB-2').weight, 1.5 + 1);
  assert.deepEqual(w.get('TCPMOB-1').evidence, { commits: 9, claudeMinutes: 400, inProgress: true, activity: 0, builds: 0, reviews: 0 });
});

test('rebalance keeps manual hours and fills the rest to target', () => {
  assert.deepEqual(rebalance([{ key: 'A', hours: 3, manual: true }, { key: 'B', hours: 2, manual: false }, { key: 'C', hours: 2, manual: false }], 5),
    [{ key: 'A', hours: 3, manual: true }, { key: 'B', hours: 1, manual: false }, { key: 'C', hours: 1, manual: false }]);
});

test('rebalance with manual over target leaves entries unchanged', () => {
  const e = [{ key: 'A', hours: 6, manual: true }, { key: 'B', hours: 1, manual: false }];
  assert.deepEqual(rebalance(e, 3), e);
});

test('rebalance drops auto entries that no longer fit at 0.5h', () => {
  assert.deepEqual(rebalance([{ key: 'A', hours: 6, manual: true }, { key: 'B', hours: 0.5, manual: false }, { key: 'C', hours: 0.5, manual: false }], 6.5),
    [{ key: 'A', hours: 6, manual: true }, { key: 'B', hours: 0.5, manual: false }]);
});

test('evidenceText formats', () => {
  assert.equal(evidenceText({ commits: 4, claudeMinutes: 100, inProgress: true, activity: 1 }), '4 commits · 1h 40m in Claude · In Progress · 1 Jira update');
  assert.equal(evidenceText({ commits: 1, claudeMinutes: 25, inProgress: false, activity: 2 }), '1 commit · 25m in Claude · 2 Jira updates');
  assert.equal(evidenceText({ commits: 0, claudeMinutes: 0, inProgress: false, activity: 0 }), 'Added by you');
});
