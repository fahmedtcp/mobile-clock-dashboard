import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewQueue, latestBotSummary, fromGraphql } from '../lib/reviews.js';

const now = new Date('2026-11-06T12:00:00Z');
const daysAgo = (d) => new Date(now - d * 864e5).toISOString();
const pr = (number, requests, isDraft = false) => ({ number, title: `t${number}`, url: `u${number}`, author: 'a', isDraft, createdAt: daysAgo(10), requests });

test('reviewQueue counts per reviewer, oldest wait, overdue > 2 days, skips drafts', () => {
  const q = reviewQueue([
    pr(1, [{ login: 'ana', requestedAt: daysAgo(3) }, { login: 'bo', requestedAt: daysAgo(1) }]),
    pr(2, [{ login: 'ana', requestedAt: daysAgo(5) }]),
    pr(3, [{ login: 'bo', requestedAt: daysAgo(9) }], true),
    pr(4, []),
  ], now);
  assert.deepEqual(q.byReviewer, [{ login: 'ana', count: 2, oldestDays: 5 }, { login: 'bo', count: 1, oldestDays: 1 }]);
  assert.deepEqual(q.prs.map((p) => [p.number, p.waitingOn, p.waitingDays, p.overdue]), [[2, ['ana'], 5, true], [1, ['ana', 'bo'], 3, true]]);
});

test('fromGraphql uses latest request event per reviewer, falling back to PR creation', () => {
  const node = {
    number: 7, title: 'T', url: 'U', isDraft: false, createdAt: '2026-11-01T00:00:00Z', author: { login: 'me' },
    reviewRequests: { nodes: [{ requestedReviewer: { login: 'ana' } }, { requestedReviewer: { login: 'bo' } }, { requestedReviewer: { name: 'team' } }] },
    timelineItems: { nodes: [
      { createdAt: '2026-11-02T00:00:00Z', requestedReviewer: { login: 'ana' } },
      { createdAt: '2026-11-04T00:00:00Z', requestedReviewer: { login: 'ana' } },
    ] },
  };
  assert.deepEqual(fromGraphql(node).requests, [{ login: 'ana', requestedAt: '2026-11-04T00:00:00Z' }, { login: 'bo', requestedAt: '2026-11-01T00:00:00Z' }]);
});

test('latestBotSummary picks newest claude[bot] comment only', () => {
  const s = latestBotSummary([
    { id: 1, user: { login: 'claude[bot]' }, body: 'old', created_at: '2026-11-01T00:00:00Z' },
    { id: 2, user: { login: 'human' }, body: 'hi', created_at: '2026-11-05T00:00:00Z' },
    { id: 3, user: { login: 'claude[bot]' }, body: 'new', created_at: '2026-11-03T00:00:00Z' },
  ]);
  assert.deepEqual(s, { id: 3, body: 'new', createdAt: '2026-11-03T00:00:00Z' });
  assert.equal(latestBotSummary([]), null);
});
