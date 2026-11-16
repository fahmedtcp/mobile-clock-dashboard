import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workRows } from '../lib/home/work.js';

const NOW = new Date('2026-11-13T12:30:00Z');
const daysAgo = (n) => new Date(NOW - n * 864e5).toISOString();
const KEY = 'TCPMOB-1768';
const people = [
  { name: 'Sana Ali', github: 'sana-q', jiraEmail: 's@x.co', qa: true, accountId: 'sana' },
  { name: 'Hamza Ashfaq', github: 'hamza', jiraEmail: 'h@x.co', qa: false, accountId: 'hamza' },
];
const ticket = (o = {}) => ({ key: KEY, summary: 'CSSO guards', url: 'u', status: 'In Progress', assignee: { accountId: 'me', name: 'Foad' }, ...o });
const pr = (o = {}) => ({
  number: 1101, title: `${KEY} CSSO`, url: 'pr', author: 'fahmed', headRefName: `${KEY}-csso`, isDraft: false, approved: false,
  reviewDecision: '', checks: 'success', failedChecks: [], changesBody: null, changesBy: null, reviewRequestedLogins: ['hamza'], ...o,
});
const build = (number, platform, created = daysAgo(1), app = 'MobileClock') => ({ number, platform, app, created, destination: 'Firebase' });
const moved = (from, to, by, at = daysAgo(1), name = 'Sana Ali') => ({
  created: at, author: { accountId: by, displayName: name }, items: [{ field: 'status', fromString: from, toString: to }],
});

function input({ tickets = [ticket()], prs = [], merged = [], builds = {}, changelogs = {}, comments = {}, behind = {} } = {}) {
  return {
    me: { accountId: 'me', login: 'fahmed' }, people, tickets, prs, merged,
    buildComments: new Map(Object.entries(builds)), changelogs: new Map(Object.entries(changelogs)),
    comments: new Map(Object.entries(comments)), behind: new Map(Object.entries(behind).map(([k, v]) => [Number(k), v])), now: NOW,
  };
}
const one = (o) => workRows(input(o))[0];

test('one blocker per ticket by priority', () => {
  const row = one({
    prs: [pr({ checks: 'failure', failedChecks: ['eslint'] })], behind: { 1101: 9 },
    changelogs: { [KEY]: [moved('QA Review', 'In Progress', 'sana')] },
    comments: { [KEY]: [{ author: 'Sana Ali', authorId: 'sana', created: daysAgo(1), text: 'still shows on empty filter\nsteps below' }] },
  });
  assert.equal(row.blocker.kind, 'qa-bounce');
  assert.equal(row.blocker.text, 'Sana sent it back:');
  assert.equal(row.blocker.quote, 'still shows on empty filter');
  assert.equal(row.tone, 'bad');
  assert.equal(row.stageLabel, 'Back from QA');
  assert.deepEqual(row.action, { kind: 'request-pr-review', label: 'Request PR Review', key: KEY });
  assert.deepEqual(row.secondary, { kind: 'open-url', label: 'Open PR', url: 'pr' });
});

test('my own status change back to In Progress is not a bounce', () => {
  const row = one({ changelogs: { [KEY]: [moved('QA Review', 'In Progress', 'me', daysAgo(1), 'Foad')] } });
  assert.equal(row.blocker.kind, 'no-pr');
  assert.equal(row.blocker.text, 'No PR yet.');
});

test('a bounce older than 3 days is not shown as a bounce', () => {
  assert.equal(one({ changelogs: { [KEY]: [moved('QA Review', 'In Progress', 'sana', daysAgo(4))] } }).blocker.kind, 'no-pr');
});

test('failed checks name the checks and offer Update branch when behind', () => {
  const row = one({ prs: [pr({ checks: 'failure', failedChecks: ['eslint', 'unit'] })], behind: { 1101: 9 } });
  assert.equal(row.blocker.text, 'Checks failed · eslint, unit · 9 behind develop');
  assert.deepEqual(row.secondary, { kind: 'update-branch', label: 'Update branch', pr: 1101 });
  const notBehind = one({ prs: [pr({ checks: 'failure', failedChecks: ['eslint'] })] });
  assert.deepEqual(notBehind.secondary, { kind: 'open-url', label: 'Open checks', url: 'pr/checks' });
});

test('changes requested quotes the reviewer by name', () => {
  const row = one({ prs: [pr({ reviewDecision: 'CHANGES_REQUESTED', changesBy: 'hamza', changesBody: 'use the theme spacing token' })] });
  assert.equal(row.blocker.text, 'Hamza asked for changes');
  assert.equal(row.blocker.quote, 'use the theme spacing token');
  assert.equal(row.stageLabel, 'Changes asked');
});

test('QA testing with one platform built names the missing one', () => {
  const row = one({
    tickets: [ticket({ status: 'QA Review', assignee: { accountId: 'sana', name: 'Sana Ali' } })],
    prs: [pr({ approved: true })], builds: { [KEY]: [build('412', 'Android')] },
  });
  assert.equal(row.blocker.text, 'Sana is testing build 412 (Android). No iOS build yet.');
  assert.deepEqual(row.action, { kind: 'build', label: 'Build iOS', pr: 1101, keys: ['mcIos'] });
  assert.equal(row.stageIndex, 4);
  assert.equal(row.stageLabel, 'In QA');
});

test('QA testing both platforms says so, with QA when nobody on the team is assigned', () => {
  const row = one({ tickets: [ticket({ status: 'QA Review' })], builds: { [KEY]: [build('412', 'Android'), build('409', 'iOS')] } });
  assert.equal(row.blocker.kind, 'qa-testing');
  assert.equal(row.blocker.text, 'Sana is testing build 412.');
  const noTeam = workRows({ ...input({ tickets: [ticket({ status: 'QA Review' })] }), people: [] })[0];
  assert.equal(noTeam.blocker.text, 'With QA.');
});

test('merged with no build since offers Open ticket', () => {
  const row = one({
    tickets: [ticket({ status: 'QA Review' })],
    merged: [{ number: 1071, url: 'm', headRefName: `${KEY}-x`, title: KEY, mergedAt: daysAgo(5) }],
    builds: { [KEY]: [build('398', 'Android', daysAgo(6)), build('397', 'iOS', daysAgo(6))] },
  });
  assert.equal(row.blocker.kind, 'merged-not-built');
  assert.equal(row.blocker.text, 'Merged 5 days ago, no build since.');
  assert.equal(row.blocker.quote, null);
  assert.equal(row.blocker.detail, "QA's latest build doesn't have the fix.");
  assert.deepEqual(row.action, { kind: 'open-ticket', label: 'Open ticket', key: KEY });
});

test('approved Dev Review with a build is ready for QA', () => {
  const row = one({ tickets: [ticket({ status: 'Dev Review' })], prs: [pr({ approved: true })], builds: { [KEY]: [build('412', 'Android')] } });
  assert.equal(row.blocker.text, 'Approved with build 412. Ready for QA.');
  assert.deepEqual(row.action, { kind: 'build', label: 'Build', pr: 1101, keys: null });
  assert.deepEqual(row.secondary, { kind: 'send-to-qa', label: 'Send to QA', key: KEY });
  const noBuild = one({ tickets: [ticket({ status: 'Dev Review' })], prs: [pr({ approved: true })] });
  assert.equal(noBuild.blocker.text, 'Approved. No build yet.');
  assert.deepEqual(noBuild.action, { kind: 'build', label: 'Build', pr: 1101, keys: null });
  assert.deepEqual(noBuild.secondary, { kind: 'send-to-qa', label: 'Send to QA', key: KEY });
});

test('review states: waiting on a reviewer, or no reviewer yet', () => {
  assert.equal(one({ prs: [pr()] }).blocker.text, "Waiting on Hamza's review");
  assert.equal(one({ prs: [pr({ reviewRequestedLogins: [] })] }).blocker.text, 'No reviewer yet.');
  assert.equal(one({ prs: [pr()], behind: { 1101: 3 } }).blocker.text, '3 behind develop');
});

test('stage index follows status and PR', () => {
  assert.equal(one({ tickets: [ticket({ status: 'To Do' })] }).stageIndex, 0);
  assert.equal(one({ tickets: [ticket({ status: 'To Do' })] }).blocker.text, 'Not started.');
  assert.equal(one({}).stageIndex, 1);
  assert.equal(one({ prs: [pr()] }).stageIndex, 2);
  assert.equal(one({ tickets: [ticket({ status: 'Dev Review' })], prs: [pr({ approved: true })] }).stageIndex, 3);
});

test('rows sort bad, wait, now, ok', () => {
  const rows = workRows(input({
    tickets: [ticket({ key: 'TCPMOB-1', status: 'To Do' }), ticket({ key: 'TCPMOB-2' }), ticket({ key: 'TCPMOB-3' }), ticket({ key: 'TCPMOB-4' })],
    prs: [pr({ number: 3, headRefName: 'TCPMOB-3-x', title: 'TCPMOB-3', checks: 'failure', failedChecks: ['eslint'] }),
      pr({ number: 4, headRefName: 'TCPMOB-4-x', title: 'TCPMOB-4' })],
  }));
  assert.deepEqual(rows.map((r) => [r.key, r.tone]), [['TCPMOB-3', 'bad'], ['TCPMOB-4', 'wait'], ['TCPMOB-2', 'now'], ['TCPMOB-1', 'ok']]);
});

// ---------- review fixes ----------

test('a bounce clears once the ticket is back in QA', () => {
  const row = one({
    tickets: [ticket({ status: 'QA Review' })],
    changelogs: { [KEY]: [moved('QA Review', 'In Progress', 'sana', daysAgo(2)), moved('In Progress', 'QA Review', 'me', daysAgo(1), 'Foad')] },
  });
  assert.notEqual(row.blocker.kind, 'qa-bounce');
});

test('an approved PR on a ticket still In Progress says to move it to Dev Review', () => {
  const row = one({ prs: [pr({ approved: true, reviewRequestedLogins: [] })], builds: { [KEY]: [build('412', 'Android')] } });
  assert.equal(row.blocker.text, 'Approved. Move it to Dev Review.');
  assert.deepEqual(row.action, { kind: 'request-pr-review', label: 'Request PR Review', key: KEY }, 'it moves the ticket to Dev Review');
});

test('Dev Review without an approval offers neither Build nor Send to QA', () => {
  const row = one({ tickets: [ticket({ status: 'Dev Review' })], prs: [pr()] });
  const kinds = [row.action?.kind, row.secondary?.kind];
  assert.ok(!kinds.includes('build') && !kinds.includes('send-to-qa'), kinds.join(','));
  assert.deepEqual(row.action, { kind: 'open-url', label: 'Open PR', url: 'pr' }, 'waiting on a review: open the PR');
});

test('In Progress always leads with Request PR Review, with or without a PR', () => {
  assert.deepEqual(one({}).action, { kind: 'request-pr-review', label: 'Request PR Review', key: KEY });
  assert.equal(one({}).secondary, null, 'Open ticket is not repeated as a second button');
  assert.equal(one({ prs: [pr()] }).action.kind, 'request-pr-review');
});

test('QA testing one platform offers Build only when the PR is approved', () => {
  const qa = (approved) => one({
    tickets: [ticket({ status: 'QA Review', assignee: { accountId: 'sana', name: 'Sana Ali' } })],
    prs: [pr({ approved })], builds: { [KEY]: [build('412', 'Android')] },
  });
  assert.equal(qa(true).action.kind, 'build');
  assert.notEqual(qa(false).action?.kind, 'build');
});

test('a ticket in QA that already has builds can get a new one, once the PR is approved', () => {
  const qa = (approved) => one({
    tickets: [ticket({ status: 'QA Review', assignee: { accountId: 'sana', name: 'Sana Ali' } })],
    prs: [pr({ approved })], builds: { [KEY]: [build('412', 'Android'), build('409', 'iOS')] },
  });
  assert.equal(qa(true).blocker.kind, 'qa-testing');
  assert.deepEqual(qa(true).secondary, { kind: 'build', label: 'New Build', pr: 1101, keys: null });
  assert.equal(qa(false).secondary, null);
});
