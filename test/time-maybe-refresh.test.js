process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { request } from './helpers.js';

const D = '2026-11-04';
const seg = (key, activeMinutes) => ({ key, activeMinutes });
function boot() {
  const calls = { claude: 0 };
  const sources = {
    async claude() {
      calls.claude++;
      // One session on TCPMOB-1 that also mentioned TCPMOB-50 a lot in tool output (never won a segment).
      return new Map([[D, [{ keyCounts: { 'TCPMOB-1': 9, 'TCPMOB-50': 0.8, 'TCPMOB-51': 0.2 }, segments: [seg('TCPMOB-1', 120)] }]]]);
    },
    async git() { return { byDay: new Map([[D, ['TCPMOB-1', 'TCPMOB-2', 'TCPMOB-3', 'TCPMOB-4', 'TCPMOB-5', 'TCPMOB-6'].map((key) => ({ key }))]]), error: null }; },
    async jira() {
      const keys = ['TCPMOB-1', 'TCPMOB-2', 'TCPMOB-3', 'TCPMOB-4', 'TCPMOB-5', 'TCPMOB-6'];
      return { tickets: new Map(keys.map((k) => [k, { key: k, summary: `Mine ${k}`, url: `u/${k}` }])), inProgressDays: new Map(), activity: new Map() };
    },
    // A review on a teammate's ticket: not "mine" in Jira, so it never gets hours on its own.
    async github() { return { byDay: new Map([[D, [{ key: 'TCPMOB-90', kind: 'review' }, { key: 'TCPMOB-77', kind: 'review' }]]]) }; },
  };
  const jira = {
    configured: true,
    async myself() { return { accountId: 'a' }; },
    async search(jql) {
      const all = [
        { key: 'TCPMOB-50', id: '50', fields: { summary: 'Light mention ticket', issuetype: { name: 'Bug' } } },
        { key: 'TCPMOB-90', id: '90', fields: { summary: 'Teammate ticket', issuetype: { name: 'Story' } } },
        { key: 'TCPMOB-77', id: '77', fields: { summary: 'An epic', issuetype: { name: 'Epic' } } },
      ];
      return all.filter((i) => jql.includes(i.key));
    },
  };
  const server = createServer({ gh: { json: async () => [], run: async () => '' }, tracker: { list: () => [] }, behind: {}, timeDir: mkdtempSync(path.join(tmpdir(), 'maybe-')), timeSources: sources, timeToday: () => '2026-11-10', jira });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, req: request(server.address().port), calls })));
}
const day = (m) => m.days.find((d) => d.date === D);

test('maybe lists tickets with weak or unattributed evidence, with summaries, not the ones already suggested', async () => {
  const { server, req } = await boot();
  const d = day((await req('GET', '/api/time/month?ym=2026-11')).json());
  const suggested = new Set(d.entries.map((e) => e.key));
  assert.equal(suggested.size, 5, 'five tickets fit the day');
  const maybe = d.maybe.map((m) => m.key);
  assert.ok(maybe.includes('TCPMOB-90'), 'teammate review shows as maybe');
  assert.ok(maybe.includes('TCPMOB-50'), 'light Claude mention shows as maybe');
  assert.ok(maybe.some((k) => ['TCPMOB-2', 'TCPMOB-3', 'TCPMOB-4', 'TCPMOB-5', 'TCPMOB-6'].includes(k) && !suggested.has(k)), 'the 6th ticket, cut by the 5-ticket cap, shows as maybe');
  assert.ok(!maybe.includes('TCPMOB-77'), 'epics never show');
  assert.ok(!maybe.includes('TCPMOB-51'), 'one stray tool-output mention is noise');
  assert.ok(maybe.every((k) => !suggested.has(k)));
  const m90 = d.maybe.find((m) => m.key === 'TCPMOB-90');
  assert.equal(m90.summary, 'Teammate ticket');
  assert.equal(m90.evidence, '1 PR review');
  assert.equal(d.maybe.find((m) => m.key === 'TCPMOB-50').evidence, 'Mentioned in Claude');
  assert.ok(d.maybe.length <= 4);
  server.close();
});

test('fresh=1 rebuilds the month instead of using the cache', async () => {
  const { server, req, calls } = await boot();
  await req('GET', '/api/time/month?ym=2026-11');
  await req('GET', '/api/time/month?ym=2026-11');
  assert.equal(calls.claude, 1);
  await req('GET', '/api/time/month?ym=2026-11&fresh=1');
  assert.equal(calls.claude, 2);
  server.close();
});

test('reset drops a draft day back to fresh suggestions; confirmed days are kept', async () => {
  const { server, req } = await boot();
  await req('POST', `/api/time/day/${D}`, { leaveHours: 0, entries: [{ key: 'TCPMOB-6', hours: 7, manual: true }], confirm: false });
  assert.equal(day((await req('GET', '/api/time/month?ym=2026-11&fresh=1')).json()).entries[0].key, 'TCPMOB-6');
  assert.equal((await req('POST', `/api/time/day/${D}/reset`)).status, 200);
  const d = day((await req('GET', '/api/time/month?ym=2026-11')).json());
  assert.equal(d.suggested, true);
  assert.equal(server.ctx.timeStore.get(D), null);
  await req('POST', `/api/time/day/${D}`, { leaveHours: 0, entries: [{ key: 'TCPMOB-1', hours: 7 }], confirm: true });
  const r = await req('POST', `/api/time/day/${D}/reset`);
  assert.equal(r.status, 409);
  assert.equal(server.ctx.timeStore.get(D).status, 'confirmed');
  assert.equal((await req('POST', '/api/time/day/nope/reset')).status, 400);
  server.close();
});
