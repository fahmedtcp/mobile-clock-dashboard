import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, checkState, listPrs, createBehindCache, getPr, updateBranch } from '../lib/prs.js';

const now = new Date('2026-11-06T12:00:00Z');
const daysAgo = (d) => new Date(now - d * 864e5).toISOString();

test('approved more than 7 days ago is stale', () => {
  assert.equal(isStale({ approved: true, approvedAt: daysAgo(8), createdAt: daysAgo(9) }, now), true);
});

test('approved 6 days ago and open 10 days is not stale', () => {
  assert.equal(isStale({ approved: true, approvedAt: daysAgo(6), createdAt: daysAgo(10) }, now), false);
});

test('unapproved but open 15 days is stale', () => {
  assert.equal(isStale({ approved: false, approvedAt: null, createdAt: daysAgo(15) }, now), true);
});

test('checkState: any failure wins, then pending, empty is none', () => {
  assert.equal(checkState([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'failure');
  assert.equal(checkState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(checkState([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' }]), 'success');
  assert.equal(checkState([{ state: 'PENDING' }]), 'pending');
  assert.equal(checkState([]), 'none');
});

test('listPrs maps approved and approvedAt from latest APPROVED review', async () => {
  const gh = { json: async () => [{ number: 1042, title: 't', url: 'u', author: { login: 'fahmedtcp' }, headRefName: 'h', baseRefName: 'develop', isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [], createdAt: daysAgo(3), reviewRequests: [{ login: 'achavez9' }, { name: 'team' }], latestReviews: [{ state: 'APPROVED', submittedAt: daysAgo(4) }, { state: 'APPROVED', submittedAt: daysAgo(2) }, { state: 'COMMENTED', submittedAt: daysAgo(1) }] }] };
  const [pr] = await listPrs(gh);
  assert.equal(pr.approved, true);
  assert.equal(pr.approvedAt, daysAgo(2));
  assert.equal(pr.author, 'fahmedtcp');
  assert.deepEqual(pr.reviewRequestedLogins, ['achavez9']);
  assert.equal(pr.checks, 'none');
});

test('empty reviewDecision is not approved', async () => {
  const gh = { json: async () => [{ number: 875, author: { login: 'x' }, reviewDecision: '', statusCheckRollup: [], reviewRequests: [], latestReviews: [], createdAt: daysAgo(1) }] };
  assert.equal((await listPrs(gh))[0].approved, false);
});

test('behind cache encodes slashed branch names and caches for TTL', async () => {
  const args = []; let t = 0;
  const gh = { run: async (a) => { args.push(a); return '3\n'; } };
  const cache = createBehindCache(gh, () => t);
  assert.equal(await cache.get('epic/TCPMOB-1423-technical-debt', 'TCPMOB-1/x'), 3);
  await cache.get('epic/TCPMOB-1423-technical-debt', 'TCPMOB-1/x');
  assert.equal(args.length, 1);
  assert.ok(args[0].includes('repos/tcp-software/mobile-clock/compare/epic%2FTCPMOB-1423-technical-debt...TCPMOB-1%2Fx'));
  t = 300001;
  await cache.get('epic/TCPMOB-1423-technical-debt', 'TCPMOB-1/x');
  assert.equal(args.length, 2);
  cache.clear();
  await cache.get('epic/TCPMOB-1423-technical-debt', 'TCPMOB-1/x');
  assert.equal(args.length, 3);
});

test('getPr and updateBranch call the right gh commands', async () => {
  const calls = [];
  const gh = { json: async (a) => { calls.push(a); return { number: 5 }; }, run: async (a) => { calls.push(a); return ''; } };
  await getPr(gh, 5);
  await updateBranch(gh, 5);
  assert.deepEqual(calls[0], ['pr', 'view', '5', '-R', 'tcp-software/mobile-clock', '--json', 'number,state,headRefName,baseRefName,reviewDecision,isCrossRepository']);
  assert.deepEqual(calls[1], ['api', '-X', 'PUT', 'repos/tcp-software/mobile-clock/pulls/5/update-branch']);
});
