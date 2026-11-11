process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubByDay } from '../lib/time/github.js';
import { dayWeights, evidenceText } from '../lib/time/allocate.js';

// Fake gh: answers by the endpoint in the args, records every call.
function fakeGh(routes) {
  const calls = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      const endpoint = args[args.indexOf('api') + 1] === '-X' ? args[args.indexOf('api') + 3] : args[args.indexOf('api') + 1];
      for (const [pattern, out] of routes) if (pattern.test(endpoint)) return out;
      throw new Error(`unexpected ${endpoint}`);
    },
  };
}

test('builds: my dispatched runs by local day, keyed by branch, one per run id', async () => {
  const gh = fakeGh([
    [/actions\/runs$/, [
      '101\tTCPMOB-1600-fix-thing\t2026-11-03T15:00:00Z',
      '101\tTCPMOB-1600-fix-thing\t2026-11-03T15:00:00Z',
      '102\tTCPMOB-1600-fix-thing\t2026-11-03T16:00:00Z',
      '103\tdevelop\t2026-11-04T15:00:00Z',
      '104\tTCPMOB-1609-other\t2026-11-05T03:00:00Z', // 9 PM Nov 4 in Chicago
    ].join('\n')],
    [/search\/issues$/, ''],
  ]);
  const { byDay } = await githubByDay(gh, { repo: 'o/r', login: 'me', ym: '2026-11' });
  assert.deepEqual(byDay.get('2026-11-03'), [{ key: 'TCPMOB-1600', kind: 'build' }, { key: 'TCPMOB-1600', kind: 'build' }]);
  assert.deepEqual(byDay.get('2026-11-04'), [{ key: 'TCPMOB-1609', kind: 'build' }]);
  const runs = gh.calls.find((a) => a.some((x) => /actions\/runs$/.test(x)));
  assert.ok(runs.includes('actor=me') && runs.includes('event=workflow_dispatch') && runs.includes('created=2026-11-01..2026-11-30'));
});

test('reviews: my reviews on other people\'s PRs, keyed by the PR branch', async () => {
  const gh = fakeGh([
    [/actions\/runs$/, ''],
    [/search\/issues$/, '7\n8'],
    [/pulls\/7$/, 'TCPMOB-1482-load-more\tSub Management 2.0'],
    [/pulls\/8$/, 'feature/no-key\tTCPMOB-1500 title key'],
    [/pulls\/7\/reviews$/, '2026-11-09T16:00:00Z\n2026-11-09T18:00:00Z\n2026-10-30T18:00:00Z'],
    [/pulls\/8\/reviews$/, '2026-11-10T16:00:00Z'],
  ]);
  const { byDay } = await githubByDay(gh, { repo: 'o/r', login: 'me', ym: '2026-11' });
  assert.deepEqual(byDay.get('2026-11-09'), [{ key: 'TCPMOB-1482', kind: 'review' }, { key: 'TCPMOB-1482', kind: 'review' }]);
  assert.deepEqual(byDay.get('2026-11-10'), [{ key: 'TCPMOB-1500', kind: 'review' }]);
  assert.equal(byDay.has('2026-10-30'), false);
  const search = gh.calls.find((a) => a.some((x) => /search\/issues$/.test(x)));
  assert.ok(search.some((x) => x.includes('reviewed-by:me') && x.includes('-author:me') && x.includes('repo:o/r')));
});

test('dayWeights: builds 0.5 capped at 1, reviews 1 capped at 2, with evidence', () => {
  const github = [
    ...Array(3).fill({ key: 'A', kind: 'build' }),
    ...Array(3).fill({ key: 'B', kind: 'review' }),
  ];
  const w = dayWeights({ inProgress: new Set(), commits: [], claude: [], activity: new Map(), github }, new Set(['A', 'B']));
  assert.equal(w.get('A').weight, 1);
  assert.equal(w.get('B').weight, 2);
  assert.equal(evidenceText(w.get('A').evidence), '3 builds');
  assert.equal(evidenceText(w.get('B').evidence), '3 PR reviews');
});

test('dayWeights still works without github signals', () => {
  const w = dayWeights({ inProgress: new Set(['A']), commits: [], claude: [], activity: new Map() }, new Set(['A']));
  assert.equal(w.get('A').weight, 2);
});

test('month uses GitHub builds and reviews as evidence, and reports the source', async () => {
  const { createServer } = await import('../server.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const http = await import('node:http');
  const timeSources = {
    async claude() { return new Map(); },
    async git() { return { byDay: new Map(), error: null }; },
    async jira() { return { tickets: new Map([['TCPMOB-1', { key: 'TCPMOB-1', summary: 'One', url: 'u' }], ['TCPMOB-2', { key: 'TCPMOB-2', summary: 'Two', url: 'u' }]]), inProgressDays: new Map(), activity: new Map() }; },
    async github() { return { byDay: new Map([['2026-11-04', [{ key: 'TCPMOB-1', kind: 'build' }, { key: 'TCPMOB-2', kind: 'review' }]]]) }; },
  };
  const server = createServer({ gh: { json: async () => [], run: async () => '' }, tracker: { list: () => [] }, behind: {}, timeDir: mkdtempSync(path.join(tmpdir(), 'ghtime-')), timeSources, timeToday: () => '2026-11-10' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const m = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/time/month?ym=2026-11', headers: { Host: `127.0.0.1:${port}` } }, (rs) => { let d = ''; rs.on('data', (c) => { d += c; }); rs.on('end', () => resolve(JSON.parse(d))); }));
  server.close();
  assert.equal(m.sources.github, 'ok');
  const day = m.days.find((d) => d.date === '2026-11-04');
  assert.deepEqual(day.entries.map((e) => [e.key, e.evidence]).sort(), [['TCPMOB-1', '1 build'], ['TCPMOB-2', '1 PR review']]);
  assert.equal(day.entries.reduce((a, e) => a + e.hours, 0), 7);
});
