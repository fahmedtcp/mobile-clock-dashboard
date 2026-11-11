process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inProgressWindows, daysTouched, ownActivityByDay, jiraByDay } from '../lib/time/jira.js';

const h = (created, from, to, id = 'me') => ({ created, author: { accountId: id }, items: [{ field: 'status', fromString: from, toString: to }] });

test('In Progress windows open and close on any move out, including back to To Do', () => {
  const w = inProgressWindows([
    h('2026-11-04T18:00:00Z', 'In Progress', 'To Do'),
    h('2026-11-03T15:00:00Z', 'To Do', 'In Progress'),
    h('2026-11-10T15:00:00Z', 'To Do', 'In Progress'),
  ], '2026-11-12T00:00:00Z');
  assert.deepEqual(w, [{ start: '2026-11-03T15:00:00Z', end: '2026-11-04T18:00:00Z' }, { start: '2026-11-10T15:00:00Z', end: '2026-11-12T00:00:00Z' }]);
});

test('non-status changelog items are ignored', () => {
  assert.deepEqual(inProgressWindows([{ created: 'x', items: [{ field: 'assignee', toString: 'In Progress' }] }], 'n'), []);
});

test('daysTouched lists only workdays the window overlaps', () => {
  const days = daysTouched([{ start: '2026-11-06T15:00:00Z', end: '2026-11-10T15:00:00Z' }], ['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11']);
  assert.deepEqual([...days], ['2026-11-06', '2026-11-09', '2026-11-10']);
});

test('ownActivityByDay counts only my transitions and comments, by local day', () => {
  const m = ownActivityByDay(
    [h('2026-11-06T05:00:00Z', 'To Do', 'In Progress', 'me'), h('2026-11-06T16:00:00Z', 'In Progress', 'Dev Review', 'other')],
    [{ authorId: 'me', created: '2026-11-06T16:00:00Z' }, { authorId: 'other', created: '2026-11-06T17:00:00Z' }],
    'me');
  assert.deepEqual([...m.entries()], [['2026-11-05', 1], ['2026-11-06', 1]]);
});

test('jiraByDay queries worked tickets (no epics) and builds windows and activity', async () => {
  const jqls = [];
  const jira = {
    configured: true,
    async search(jql) { jqls.push(jql); return [{ key: 'TCPMOB-5', fields: { summary: 'S', issuetype: { name: 'Bug' }, assignee: { accountId: 'me' } } }]; },
    async changelog() { return [h('2026-11-03T15:00:00Z', 'To Do', 'In Progress')]; },
    async comments() { return [{ authorId: 'me', created: '2026-11-04T15:00:00Z' }]; },
  };
  const r = await jiraByDay(jira, { ym: '2026-11', accountId: 'me', baseUrl: 'https://x', now: '2026-11-05T00:00:00Z' });
  assert.match(jqls[0], /issuetype not in \(Epic, Initiative\)/);
  assert.match(jqls[0], /updated >= "2026-11-01"/);
  assert.deepEqual([...r.inProgressDays.get('TCPMOB-5')], ['2026-11-03', '2026-11-04']);
  assert.equal(r.activity.get('TCPMOB-5').get('2026-11-03'), 1);
  assert.equal(r.tickets.get('TCPMOB-5').url, 'https://x/browse/TCPMOB-5');
});

const asg = (created, fromId, toId) => ({ created, author: { accountId: 'lead' }, items: [{ field: 'assignee', from: fromId, to: toId }] });

test('a window counts when the user is the assignee during it, whoever moved it; windows under 10 minutes are ignored', () => {
  const histories = [
    asg('2026-10-30T15:00:00Z', null, 'me'),
    h('2026-10-30T16:20:00Z', 'To Do', 'In Progress', 'anthony'), // someone else moves MY ticket → counts
    h('2026-11-05T14:34:00Z', 'In Progress', 'Dev Review', 'lead'),
    h('2026-11-05T15:00:00Z', 'Dev Review', 'In Progress', 'me'), h('2026-11-05T15:03:00Z', 'In Progress', 'Dev Review', 'me'), // 3-minute walk → ignored
  ];
  assert.deepEqual(inProgressWindows(histories, '2026-11-12T00:00:00Z', { accountId: 'me', currentAssignee: 'me' }),
    [{ start: '2026-10-30T16:20:00Z', end: '2026-11-05T14:34:00Z' }]);
});

test("someone else's ticket doesn't count even if the user changed its status once", () => {
  const histories = [asg('2026-11-01T15:00:00Z', null, 'abdul'), h('2026-11-02T15:00:00Z', 'To Do', 'In Progress', 'me'), h('2026-11-04T15:00:00Z', 'In Progress', 'Dev Review', 'abdul')];
  assert.deepEqual(inProgressWindows(histories, 'n', { accountId: 'me', currentAssignee: 'abdul' }), []);
});

test('with no assignee history, the current assignee decides', () => {
  const histories = [h('2026-11-02T15:00:00Z', 'To Do', 'In Progress', 'x'), h('2026-11-04T15:00:00Z', 'In Progress', 'Dev Review', 'x')];
  assert.equal(inProgressWindows(histories, 'n', { accountId: 'me', currentAssignee: 'me' }).length, 1);
  assert.equal(inProgressWindows(histories, 'n', { accountId: 'me', currentAssignee: 'other' }).length, 0);
});

test('own actions on a ticket within 10 minutes count as one', () => {
  const m = ownActivityByDay([
    h('2026-11-03T15:00:00Z', 'To Do', 'In Progress', 'me'), h('2026-11-03T15:01:00Z', 'In Progress', 'Dev Review', 'me'),
    h('2026-11-03T15:02:00Z', 'Dev Review', 'QA Review', 'me'), h('2026-11-03T19:00:00Z', 'QA Review', 'Done', 'me'),
  ], [{ authorId: 'me', created: '2026-11-03T15:05:00Z' }], 'me');
  assert.equal(m.get('2026-11-03'), 2); // the 15:00–15:05 burst, then 19:00
});
