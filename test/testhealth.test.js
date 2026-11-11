import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passRate, flakyRuns } from '../lib/testhealth.js';

const now = Date.parse('2026-11-06T12:00:00Z');
const run = (conclusion, status = 'completed', createdAt = '2026-11-05T12:00:00Z', extra = {}) => ({ conclusion, status, createdAt, url: 'u', ...extra });

test('passRate ignores cancelled/skipped/in-progress and reports latest age', () => {
  const r = passRate([run('success'), run('failure', 'completed', '2026-11-01T12:00:00Z'), run('cancelled'), run('skipped'), run('', 'in_progress')], now);
  assert.equal(r.passed, 1);
  assert.equal(r.total, 2);
  assert.equal(r.rate, 0.5);
  assert.equal(r.latest.conclusion, 'success');
  assert.equal(r.latestAgeDays, 1);
});

test('passRate of no runs is null rate', () => {
  assert.deepEqual(passRate([], now), { recent: [], rate: null, passed: 0, total: 0, latest: null, latestAgeDays: null });
});

test('flakyRuns pairs failure+success on same workflow+sha only', () => {
  const runs = [
    run('failure', 'completed', 'a', { workflowName: 'Run unit tests', headSha: 's1', headBranch: 'b', url: 'f1' }),
    run('success', 'completed', 'b', { workflowName: 'Run unit tests', headSha: 's1', headBranch: 'b', url: 'p1' }),
    run('failure', 'completed', 'a', { workflowName: 'Run unit tests', headSha: 's2', headBranch: 'b', url: 'f2' }),
    run('success', 'completed', 'b', { workflowName: 'PR Review', headSha: 's2', headBranch: 'b', url: 'p2' }),
  ];
  assert.deepEqual(flakyRuns(runs), [{ workflowName: 'Run unit tests', headSha: 's1', branch: 'b', failedUrl: 'f1', passedUrl: 'p1' }]);
});

test('passRate exposes the recent outcomes oldest→newest for the run strip', () => {
  const r = passRate([
    run('success', 'completed', '2026-11-05T12:00:00Z'),
    run('failure', 'completed', '2026-11-03T12:00:00Z'),
    run('cancelled', 'completed', '2026-11-04T12:00:00Z'),
    run('', 'in_progress', '2026-11-06T11:00:00Z'),
  ], now);
  assert.deepEqual(r.recent, ['failure', 'cancelled', 'success', 'in_progress']);
});
