process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWeights, weightParts } from '../lib/time/allocate.js';
import { jiraEvents } from '../lib/time/jira.js';
import { parseLog } from '../lib/time/git.js';
import { githubByDay } from '../lib/time/github.js';
import { summarizeSessions } from '../lib/time/claude.js';
import { parseBuildComments } from '../lib/tickets.js';

test('weightParts sums to the dayWeights weight', () => {
  const signals = {
    inProgress: new Set(['K-1']),
    commits: Array.from({ length: 7 }, () => ({ key: 'K-1' })),
    claude: [{ segments: [{ key: 'K-1', activeMinutes: 150 }] }],
    activity: new Map([['K-1', 1]]),
    github: [1, 2, 3].map(() => ({ key: 'K-1', kind: 'build' })),
  };

  const { weight, evidence } = dayWeights(signals, new Set(['K-1'])).get('K-1');
  const parts = weightParts(evidence);

  assert.deepEqual(parts.map((p) => p.label), ['In Progress', '7 commits', 'Claude 2h 30m', '1 Jira update', '3 builds']);
  assert.deepEqual(parts.map((p) => p.points), [2, 5, 5, 0.5, 1]);
  assert.equal(parts.reduce((sum, p) => sum + p.points, 0), weight);
});

test('jira events keep status changes with author names and only my comment times', () => {
  const histories = [
    { created: '2026-11-10T09:12:00-06:00', author: { accountId: 'me', displayName: 'Foad Ahmed' },
      items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }] },
    { created: '2026-11-10T16:41:00-06:00', author: { accountId: 'pat', displayName: 'Pat' },
      items: [{ field: 'status', fromString: 'In Progress', toString: 'Dev Review' }, { field: 'assignee' }] },
  ];
  const comments = [
    { authorId: 'me', created: '2026-11-10T11:00:00-06:00', text: 'secret note' },
    { authorId: 'pat', created: '2026-11-10T12:00:00-06:00', text: 'other' },
  ];

  const events = jiraEvents(histories, comments, 'me');

  assert.deepEqual(events.filter((e) => e.kind === 'status').map(({ from, to, by, mine }) => ({ from, to, by, mine })), [
    { from: 'To Do', to: 'In Progress', by: 'Foad Ahmed', mine: true },
    { from: 'In Progress', to: 'Dev Review', by: 'Pat', mine: false },
  ]);
  const myComments = events.filter((e) => e.kind === 'comment');
  assert.equal(myComments.length, 1);
  assert.equal('text' in myComments[0], false, 'comment text is never kept');
});

test('commits carry their branch', () => {
  const [commit] = parseLog('abc123\t2026-11-10T11:48:00-06:00\trefs/remotes/origin/TCPMOB-1-x\tFix it\n');

  assert.equal(commit.branch, 'TCPMOB-1-x');
});

test('github items keep run id, workflow, and PR number', async () => {
  const routes = [
    [/actions\/runs$/, '101\tTCPMOB-1-x\t2026-11-10T20:30:00Z\tRun MC Android'],
    [/search\/issues$/, '7'],
    [/pulls\/7$/, 'TCPMOB-2-y\tTitle'],
    [/pulls\/7\/reviews$/, '2026-11-10T18:00:00Z'],
  ];
  const gh = { async run(args) {
    const at = args.indexOf('api');
    const endpoint = args[at + 1] === '-X' ? args[at + 3] : args[at + 1];
    return routes.find(([re]) => re.test(endpoint))[1];
  } };

  const { byDay } = await githubByDay(gh, { repo: 'o/r', login: 'me', ym: '2026-11' });

  const items = byDay.get('2026-11-10');
  assert.deepEqual(items.find((i) => i.kind === 'build'), {
    key: 'TCPMOB-1', kind: 'build', at: '2026-11-10T20:30:00Z', runId: '101', workflow: 'Run MC Android' });
  assert.deepEqual(items.find((i) => i.kind === 'review'), {
    key: 'TCPMOB-2', kind: 'review', at: '2026-11-10T18:00:00Z', pr: 7 });
});

test('claude sessions keep raw mention counts', () => {
  const record = (ts, mentions) => ({ type: 'user', sessionId: 's1', timestamp: ts, gitBranch: 'x', mentions });
  const typed = { key: 'TCPMOB-1', weight: 1 };
  const toolOutput = { key: 'TCPMOB-1', weight: 0.1 };
  const records = [
    record('2026-11-10T15:00:00Z', [typed]),
    record('2026-11-10T15:05:00Z', [typed, toolOutput]),
    record('2026-11-10T15:10:00Z', [toolOutput, toolOutput]),
  ];

  const [session] = summarizeSessions(records).get('2026-11-10');

  assert.equal(session.mentionCounts['TCPMOB-1'], 5);
  assert.equal(session.keyCounts['TCPMOB-1'], 2.3);
});

test('build comments keep the destination', () => {
  const builds = parseBuildComments([
    { text: 'pushed build number 412 for Mobile Clock Android to firebase distribution', created: 'a' },
    { text: 'pushed build number 409 for MobileClock IOS to testflight', created: 'b' },
  ]);

  assert.deepEqual(builds.map((b) => b.destination), ['Firebase', 'TestFlight']);
});
