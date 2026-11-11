import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts } from '../lib/alerts.js';

const T = (key, status) => ({ key, status, url: `j/${key}` });
const pr = (number, ticketKey, extra = {}) => ({ number, ticketKey, url: `p/${number}`, author: 'me', isDraft: false, ...extra });
const base = { openPrs: [], mergedPrs: [], tickets: new Map(), sprintTickets: [], branches: [], login: 'me', scope: 'mine' };

test('finished ticket with open non-draft PR alerts; draft does not', () => {
  const tickets = new Map([['TCPMOB-1', T('TCPMOB-1', 'Release Candidate')]]);
  const a = computeAlerts({ ...base, tickets, openPrs: [pr(10, 'TCPMOB-1')] });
  assert.deepEqual(a.map((x) => [x.kind, x.key, x.pr]), [['finished-but-open', 'TCPMOB-1', 10]]);
  assert.match(a[0].text, /TCPMOB-1 is Release Candidate, but PR #10 is still open/);
  assert.equal(computeAlerts({ ...base, tickets, openPrs: [pr(10, 'TCPMOB-1', { isDraft: true })] }).length, 0);
});

test('merged PR whose ticket is still In Progress alerts', () => {
  const tickets = new Map([['TCPMOB-2', T('TCPMOB-2', 'In Progress')]]);
  const a = computeAlerts({ ...base, tickets, mergedPrs: [pr(11, 'TCPMOB-2')] });
  assert.deepEqual(a.map((x) => x.kind), ['merged-but-active']);
  assert.equal(a[0].url, 'j/TCPMOB-2');
});

test('merged PR whose ticket is QA Review does not alert', () => {
  const tickets = new Map([['TCPMOB-2', T('TCPMOB-2', 'QA Review')]]);
  assert.equal(computeAlerts({ ...base, tickets, mergedPrs: [pr(11, 'TCPMOB-2')] }).length, 0);
});

test('open non-draft PR without key alerts; scope mine filters to my PRs', () => {
  const openPrs = [pr(12, null), pr(13, null, { author: 'other' })];
  assert.deepEqual(computeAlerts({ ...base, openPrs }).map((x) => x.pr), [12]);
  assert.deepEqual(computeAlerts({ ...base, openPrs, scope: 'team' }).map((x) => x.pr), [12, 13]);
});

test('my sprint ticket in Dev Review with no matching branch alerts; branch match is case-insensitive', () => {
  const sprintTickets = [T('TCPMOB-1725', 'Dev Review'), T('TCPMOB-9', 'Dev Review'), T('TCPMOB-8', 'To Do')];
  const a = computeAlerts({ ...base, sprintTickets, branches: ['tcpmob-1725-ios-date', 'develop'] });
  assert.deepEqual(a.map((x) => [x.kind, x.key]), [['ticket-no-branch', 'TCPMOB-9']]);
});

test('branch match does not confuse TCPMOB-17 with TCPMOB-1725', () => {
  const a = computeAlerts({ ...base, sprintTickets: [T('TCPMOB-17', 'Open')], branches: ['TCPMOB-1725-x'] });
  assert.equal(a.length, 1);
});
