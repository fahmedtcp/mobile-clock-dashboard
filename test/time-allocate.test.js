import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWeights, allocate, rebalance, evidenceText } from '../lib/time/allocate.js';

const sum = (entries) => entries.reduce((total, e) => total + e.hours, 0);
const entry = (key, hours, manual) => ({ key, hours, manual });

test('allocate sums exactly to target in 0.5 steps, min 0.5, max 5 tickets', () => {
  const entries = allocate(new Map([['A', 6], ['B', 1], ['C', 1], ['D', 1], ['E', 1], ['F', 1]]), 7);
  assert.equal(entries.length, 5);
  assert.equal(sum(entries), 7);
  assert.ok(entries.every((e) => e.hours >= 0.5 && (e.hours * 2) % 1 === 0));
  assert.equal(entries[0].key, 'A');
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
  const segments = [
    { key: 'TCPMOB-1', activeMinutes: 400 },
    { key: 'TCPMOB-2', activeMinutes: 45 },
    { key: 'TCPMOB-5', activeMinutes: 60 },
  ];
  const activity = new Map([['TCPMOB-2', 5]]);
  const signals = { inProgress: new Set(['TCPMOB-1']), commits, claude: [{ segments }], activity };

  const weights = dayWeights(signals, new Set(['TCPMOB-1', 'TCPMOB-2']));

  assert.deepEqual([...weights.keys()].sort(), ['TCPMOB-1', 'TCPMOB-2']); // TCPMOB-99 and TCPMOB-5 aren't the user's
  assert.equal(weights.get('TCPMOB-1').weight, 2 + 5 + 6);
  assert.equal(weights.get('TCPMOB-2').weight, 1.5 + 1);
  assert.deepEqual(weights.get('TCPMOB-1').evidence,
    { commits: 9, claudeMinutes: 400, inProgress: true, activity: 0, builds: 0, reviews: 0 });
});

test('rebalance keeps manual hours and fills the rest to target', () => {
  assert.deepEqual(rebalance([entry('A', 3, true), entry('B', 2, false), entry('C', 2, false)], 5),
    [entry('A', 3, true), entry('B', 1, false), entry('C', 1, false)]);
});

test('rebalance with manual over target leaves entries unchanged', () => {
  const entries = [entry('A', 6, true), entry('B', 1, false)];
  assert.deepEqual(rebalance(entries, 3), entries);
});

test('rebalance drops auto entries that no longer fit at 0.5h', () => {
  assert.deepEqual(rebalance([entry('A', 6, true), entry('B', 0.5, false), entry('C', 0.5, false)], 6.5),
    [entry('A', 6, true), entry('B', 0.5, false)]);
});

test('evidenceText formats', () => {
  assert.equal(evidenceText({ commits: 4, claudeMinutes: 100, inProgress: true, activity: 1 }),
    '4 commits · 1h 40m in Claude · In Progress · 1 Jira update');
  assert.equal(evidenceText({ commits: 1, claudeMinutes: 25, inProgress: false, activity: 2 }),
    '1 commit · 25m in Claude · 2 Jira updates');
  assert.equal(evidenceText({ commits: 0, claudeMinutes: 0, inProgress: false, activity: 0 }), 'Added by you');
});
