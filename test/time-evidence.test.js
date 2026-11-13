process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { request } from './helpers.js';

const DAY = '2026-11-10';
const KEY = 'TCPMOB-1768';
const SESSION = '3f2a9c11-0000-4000-8000-00000000c91e';

function fakeSources({ withMentionCounts = true } = {}) {
  const session = {
    sessionId: SESSION, start: '2026-11-10T16:05:00Z', end: '2026-11-10T18:35:00Z', activeMinutes: 150,
    keyCounts: { [KEY]: 12 }, segments: [{ key: KEY, start: '2026-11-10T16:05:00Z', end: '2026-11-10T18:35:00Z', activeMinutes: 150 }],
    ...(withMentionCounts ? { mentionCounts: { [KEY]: 41 } } : {}),
  };
  const commit = (sha, at, key, subject, branch) => ({ sha, at, key, subject, branch });
  return {
    async claude() { return new Map([[DAY, [session]]]); },
    async git() {
      return { byDay: new Map([[DAY, [
        commit('a1b2c3d4e5', '2026-11-10T17:48:00Z', KEY, 'Guard CSSO permission check', 'TCPMOB-1768-csso-guards'),
        commit('ffff000011', '2026-11-10T19:00:00Z', 'TCPMOB-1482', 'Other ticket', 'TCPMOB-1482-x'),
      ]]]), error: null };
    },
    async github() {
      return { byDay: new Map([[DAY, [
        { key: KEY, kind: 'build', at: '2026-11-10T20:30:00Z', runId: '4521', workflow: 'Run MC Android' }]]]) };
    },
    async jira() {
      const tickets = new Map([[KEY, { key: KEY, summary: 'CSSO', url: 'u' }], ['TCPMOB-1482', { key: 'TCPMOB-1482', summary: 'Other', url: 'u' }]]);
      const events = new Map([[KEY, [
        { at: '2026-11-10T15:12:00Z', kind: 'status', from: 'To Do', to: 'In Progress', by: 'Foad Ahmed', mine: true },
        { at: '2026-11-10T22:41:00Z', kind: 'status', from: 'In Progress', to: 'Dev Review', by: 'Pat', mine: false },
        { at: '2026-11-09T15:00:00Z', kind: 'status', from: 'Open', to: 'To Do', by: 'Pat', mine: false },
      ]]]);
      return { tickets, inProgressDays: new Map([[KEY, new Set([DAY])]]), activity: new Map(), events };
    },
  };
}

async function boot(options) {
  const server = createServer({
    gh: { json: async () => [], run: async () => '' }, tracker: { list: () => [] }, behind: {},
    timeDir: mkdtempSync(path.join(tmpdir(), 'evidence-')), timeSources: fakeSources(options), timeToday: () => DAY,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, req: request(server.address().port) };
}
const evidence = (req, key = KEY, date = DAY) => req('GET', `/api/time/evidence?date=${date}&key=${key}`);

test('evidence lists the day\'s events for one ticket in time order with plain text', async () => {
  const { server, req } = await boot();

  const body = (await evidence(req)).json();

  assert.deepEqual(body.events.map((e) => [e.source, e.text]), [
    ['jira', 'To Do → In Progress'],
    ['claude', 'Claude session 3f2a9c…c91e'],
    ['git', 'Commit a1b2c3d "Guard CSSO permission check"'],
    ['github', 'Build Run MC Android dispatched'],
    ['jira', 'In Progress → Dev Review'],
  ]);
  assert.equal(body.events[0].detail, 'by you');
  assert.equal(body.events[1].detail, '10:05 AM–12:35 PM · 2h 30m active · 41 mentions');
  assert.equal(body.events[2].detail, 'on TCPMOB-1768-csso-guards');
  assert.equal(body.events[3].url, 'https://github.com/tcp-software/mobile-clock/actions/runs/4521');
  assert.equal(body.events[4].detail, 'by Pat');
  server.close();
});

test('suggested day shows its points and hours', async () => {
  const { server, req } = await boot();

  const body = (await evidence(req)).json();
  const month = (await req('GET', '/api/time/month?ym=2026-11')).json();
  const row = month.days.find((d) => d.date === DAY).entries.find((e) => e.key === KEY);

  assert.equal(body.outcome.mode, 'suggested');
  assert.equal(body.outcome.hours, row.hours);
  assert.equal(body.outcome.dayHours, 7);
  assert.equal(body.total, body.parts.reduce((sum, p) => sum + p.points, 0));
  assert.ok(body.outcome.dayPoints >= body.total);
  server.close();
});

test('saved day shows what today\'s evidence would suggest', async () => {
  const { server, req } = await boot();
  await req('POST', `/api/time/day/${DAY}`, { leaveHours: 0, entries: [{ key: KEY, hours: 4 }, { key: 'TCPMOB-1482', hours: 3 }], confirm: true });

  const body = (await evidence(req)).json();

  assert.equal(body.outcome.mode, 'saved');
  assert.equal(body.outcome.hours, 4);
  assert.ok(body.outcome.suggestedHours > 4, `today's evidence favors ${KEY} (${body.outcome.suggestedHours})`);
  server.close();
});

test('a ticket that is not on the day is a maybe', async () => {
  const { server, req } = await boot();
  await req('POST', `/api/time/day/${DAY}`, { leaveHours: 0, entries: [{ key: 'TCPMOB-1482', hours: 7 }], confirm: true });

  const body = (await evidence(req)).json();

  assert.deepEqual(body.outcome, { mode: 'maybe' });
  assert.ok(body.events.length > 0);
  server.close();
});

test('old snapshots without mentionCounts show no count', async () => {
  const { server, req } = await boot({ withMentionCounts: false });

  const claudeLine = (await evidence(req)).json().events.find((e) => e.source === 'claude');

  assert.equal(claudeLine.detail, '10:05 AM–12:35 PM · 2h 30m active');
  assert.doesNotMatch(claudeLine.detail, /mention|undefined|NaN/);
  server.close();
});

test('bad date or key is 400', async () => {
  const { server, req } = await boot();

  assert.equal((await evidence(req, 'OPS-1')).status, 400);
  assert.equal((await evidence(req, KEY, '2026-13-40')).status, 400);
  assert.equal((await evidence(req, KEY, 'nope')).json().error, 'Expected date like 2026-11-10 and key like TCPMOB-123.');
  server.close();
});

test('month has generatedAt', async () => {
  const { server, req } = await boot();

  const month = (await req('GET', '/api/time/month?ym=2026-11')).json();

  assert.ok(!Number.isNaN(Date.parse(month.generatedAt)));
  server.close();
});

test('a status change with no author name never shows a bare "by"', async () => {
  const { ticketDayEvidence } = await import('../lib/time/evidence.js');
  const sources = { jira: { events: new Map([[KEY, [{ at: '2026-11-10T15:12:00Z', kind: 'status', from: 'A', to: 'B', by: '', mine: false }]]]) } };
  const signals = { inProgress: new Set(), commits: [], claude: [], activity: new Map(), github: [] };
  const day = { date: DAY, entries: [], suggested: true, dayHours: 7 };

  const [event] = ticketDayEvidence({ sources, signals, day, known: new Set(), key: KEY }).events;

  assert.equal(event.detail, 'by someone else');
});

test('time routes expose a cache peek that never builds', async () => {
  const { server } = await boot();

  assert.equal(server.ctx.timeMonthPeek('2026-11'), null);
  server.close();
});
