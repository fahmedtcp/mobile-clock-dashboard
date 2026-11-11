process.env.TZ = 'America/Chicago';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { request } from './helpers.js';

const timeDir = mkdtempSync(path.join(tmpdir(), 'timeroutes-'));
const seg = (key, activeMinutes) => ({ segments: [{ key, activeMinutes }] });
const sources = {
  jiraFails: false, gitError: null,
  async claude() { return new Map([['2026-11-09', [seg('TCPMOB-1', 120), seg('TCPMOB-2', 30)]], ['2026-11-04', [seg('TCPMOB-1', 60)]]]); },
  async git() { return { byDay: new Map([['2026-11-09', [{ key: 'TCPMOB-1' }, { key: 'TCPMOB-2' }]]]), error: this.gitError }; },
  async jira() {
    if (this.jiraFails) throw new Error('Jira is not configured.');
    return {
      tickets: new Map([['TCPMOB-1', { key: 'TCPMOB-1', summary: 'One', url: 'u1' }], ['TCPMOB-2', { key: 'TCPMOB-2', summary: 'Two', url: 'u2' }]]),
      inProgressDays: new Map([['TCPMOB-1', new Set(['2026-11-09'])]]),
      activity: new Map(),
    };
  },
};

let server, port;
before(async () => {
  server = createServer({ gh: { json: async () => [], run: async () => '' }, tracker: { list: () => [] }, behind: {}, timeDir, timeSources: sources, timeToday: () => '2026-11-10' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());
beforeEach(() => { sources.jiraFails = false; sources.gitError = null; });

const req = (...a) => request(port)(...a);
const dayOf = (month, date) => month.days.find((d) => d.date === date);

test('month: suggested day sums to 7 with evidence; quiet day is nodata; future days are future', async () => {
  const res = await req('GET', '/api/time/month?ym=2026-11');
  assert.equal(res.status, 200);
  const m = res.json();
  const d9 = dayOf(m, '2026-11-09');
  assert.equal(d9.state, 'review');
  assert.equal(d9.entries.reduce((a, e) => a + e.hours, 0), 7);
  assert.equal(d9.entries[0].key, 'TCPMOB-1');
  assert.equal(d9.entries[0].summary, 'One');
  assert.match(d9.entries[0].evidence, /commit/);
  assert.equal(dayOf(m, '2026-11-05').state, 'nodata');
  assert.equal(dayOf(m, '2026-11-11').state, 'future');
  assert.deepEqual(m.sources, { claude: 'ok', git: 'ok', jira: 'ok', github: 'ok' });
});

test('malformed ym is 400', async () => {
  assert.equal((await req('GET', '/api/time/month?ym=2026-13')).status, 400);
});

test('POST day: invalid → 400 and nothing saved; confirm with right total → confirmed; leave day → leave', async () => {
  const bad = await req('POST', '/api/time/day/2026-11-09', { leaveHours: 0, entries: [{ key: 'TCPMOB-1', hours: 6 }], confirm: true });
  assert.equal(bad.status, 400);
  assert.equal(dayOf((await req('GET', '/api/time/month?ym=2026-11')).json(), '2026-11-09').state, 'review');
  const ok = await req('POST', '/api/time/day/2026-11-09', { leaveHours: 1, entries: [{ key: 'TCPMOB-1', hours: 4, manual: true }, { key: 'TCPMOB-2', hours: 2 }], confirm: true });
  assert.equal(ok.status, 200);
  const d9 = dayOf((await req('GET', '/api/time/month?ym=2026-11')).json(), '2026-11-09');
  assert.equal(d9.state, 'confirmed');
  assert.equal(d9.leaveHours, 1);
  assert.deepEqual(d9.entries.map((e) => [e.key, e.hours, e.manual]), [['TCPMOB-1', 4, true], ['TCPMOB-2', 2, false]]);
  await req('POST', '/api/time/day/2026-11-06', { leaveHours: 7, entries: [], confirm: true });
  assert.equal(dayOf((await req('GET', '/api/time/month?ym=2026-11')).json(), '2026-11-06').state, 'leave');
});

test('editing a confirmed day without confirm makes it a draft again', async () => {
  await req('POST', '/api/time/day/2026-11-04', { leaveHours: 0, entries: [{ key: 'TCPMOB-1', hours: 7 }], confirm: true });
  await req('POST', '/api/time/day/2026-11-04', { leaveHours: 0, entries: [{ key: 'TCPMOB-1', hours: 6.5, manual: true }], confirm: false });
  const d4 = dayOf((await req('GET', '/api/time/month?ym=2026-11')).json(), '2026-11-04');
  assert.equal(d4.state, 'review');
  assert.equal(d4.entries[0].hours, 6.5);
});

test('month still renders when Jira fails and git is missing', async () => {
  sources.jiraFails = true;
  sources.gitError = 'Local mobile-clock clone not found';
  const res = await req('GET', '/api/time/month?ym=2026-10');
  assert.equal(res.status, 200);
  const m = res.json();
  assert.match(m.sources.jira, /not configured/);
  assert.match(m.sources.git, /not found/);
});

test('pending counts only this month after the 5th (no October backlog on Nov 10)', async () => {
  const p = (await req('GET', '/api/time/pending')).json();
  assert.ok(p.days.every((d) => d.startsWith('2026-11')));
});

test('pending counts past unconfirmed non-leave workdays only', async () => {
  const p = (await req('GET', '/api/time/pending')).json();
  assert.ok(!p.days.includes('2026-11-09')); // confirmed
  assert.ok(!p.days.includes('2026-11-06')); // leave
  assert.ok(!p.days.includes('2026-11-10')); // today isn't past
  assert.ok(p.days.includes('2026-11-05'));
  assert.equal(p.count, p.days.length);
});

test('export json and csv contain confirmed entries and LEAVE rows', async () => {
  const j = await req('GET', '/api/time/export?ym=2026-11&format=json');
  assert.match(j.headers['content-disposition'], /tempo-2026-11\.json/);
  const rows = JSON.parse(j.body);
  assert.ok(rows.some((r) => r.date === '2026-11-09' && r.key === 'LEAVE' && r.hours === 1));
  assert.ok(rows.some((r) => r.date === '2026-11-09' && r.key === 'TCPMOB-1' && r.hours === 4 && r.summary === 'One'));
  assert.ok(!rows.some((r) => r.date === '2026-11-04')); // draft, not confirmed
  const c = await req('GET', '/api/time/export?ym=2026-11&format=csv');
  assert.match(c.headers['content-type'], /text\/csv/);
  assert.match(c.body.split('\n')[0], /^date,key,hours,summary,evidence$/);
});

test('a saved leave day still returns its ticket pool so lowering leave can refill after a reload', async () => {
  await req('POST', '/api/time/day/2026-11-03', { leaveHours: 7, entries: [], confirm: false });
  sources._pool = true;
  const m = (await req('GET', '/api/time/month?ym=2026-11')).json();
  const d3 = m.days.find((d) => d.date === '2026-11-03');
  assert.deepEqual(d3.entries, []);
  assert.ok(Array.isArray(d3.pool));
});

test('csv export neutralizes formulas and quotes CR', async () => {
  const { csvCell } = await import('../lib/time/routes.js');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('a\rb'), '"a\rb"');
  assert.equal(csvCell('plain'), 'plain');
});
