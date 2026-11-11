// Fixes from the final review of Tempo sync.
process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { createTempo } from '../lib/time/tempo.js';
import { request } from './helpers.js';

const BASE = 'https://tempo.test/4';
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// ---------- client ----------

test('worklogs throws on a 200 that is not a worklog page', async () => {
  const tempo = createTempo({ token: 't', baseUrl: BASE, fetch: async () => res(200, '<html>Sign in</html>') });
  await assert.rejects(tempo.worklogs('acc', '2026-11-01', '2026-11-30'), /unexpected/i);
});

test('create throws when Tempo returns no worklog id', async () => {
  const tempo = createTempo({ token: 't', baseUrl: BASE, fetch: async () => res(200, {}) });
  await assert.rejects(tempo.create({}), /unexpected/i);
});

test('worklogs never follows a next link off the Tempo host, or in a loop', async () => {
  const calls = [];
  const page = (next) => res(200, { results: [], metadata: { next } });
  let tempo = createTempo({ token: 't', baseUrl: BASE, fetch: async (url) => { calls.push(url); return page('https://evil.test/steal'); } });
  await assert.rejects(tempo.worklogs('acc', '2026-11-01', '2026-11-30'), /unexpected/i);
  assert.equal(calls.length, 1);
  calls.length = 0;
  tempo = createTempo({ token: 't', baseUrl: BASE, fetch: async (url) => { calls.push(url); return page(`${BASE}/worklogs/user/acc?offset=0`); } });
  await assert.rejects(tempo.worklogs('acc', '2026-11-01', '2026-11-30'), /unexpected/i);
  assert.ok(calls.length <= 2);
});

test('a 429 is retried once after Retry-After', async () => {
  let n = 0;
  const waits = [];
  const tempo = createTempo({ token: 't', baseUrl: BASE, sleep: async (ms) => { waits.push(ms); }, fetch: async () => (++n === 1 ? res(429, {}, { 'retry-after': '2' }) : res(200, { tempoWorklogId: 9 })) });
  await tempo.create({});
  assert.equal(n, 2);
  assert.deepEqual(waits, [2000]);
});

test('requests carry a timeout signal', async () => {
  let signal;
  const tempo = createTempo({ token: 't', baseUrl: BASE, fetch: async (url, init) => { signal = init.signal; return res(200, { tempoWorklogId: 1 }); } });
  await tempo.create({});
  assert.ok(signal instanceof AbortSignal);
});

// ---------- server ----------

async function boot({ tempo, jira, store = {} }) {
  const timeDir = mkdtempSync(path.join(tmpdir(), 'temporev-'));
  const timeSources = {
    async claude() { return new Map(); },
    async git() { return { byDay: new Map(), error: null }; },
    async jira() { return { tickets: new Map(), inProgressDays: new Map(), activity: new Map() }; },
  };
  const server = createServer({ gh: { json: async () => [], run: async () => '' }, tracker: { list: () => [] }, behind: {}, timeDir, timeSources, timeToday: () => '2026-11-10', tempo, jira });
  for (const [d, r] of Object.entries(store)) server.ctx.timeStore.save(d, r);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (...a) => request(port)(...a);
  return { server, req };
}
const ISSUES = { 'TCPMOB-1600': '363920', 'TCPMOB-1609': '364036' };
const fakeJira = (extra = {}) => ({
  configured: true,
  async myself() { return { accountId: 'acc' }; },
  async search(jql) {
    // Like Jira Cloud: one unknown id or key fails the whole query.
    const all = Object.entries(ISSUES).map(([key, id]) => ({ id, key, fields: { summary: key, status: { name: 'Dev Review' } } }));
    const asked = jql.match(/\(([^)]*)\)/)[1].split(',');
    if (asked.some((v) => !all.some((i) => i.id === v || i.key === v))) throw Object.assign(new Error('Bad JQL'), { status: 400 });
    return all.filter((i) => asked.includes(i.id) || asked.includes(i.key));
  },
  async getIssue(idOrKey) {
    const hit = Object.entries(ISSUES).find(([key, id]) => key === idOrKey || id === idOrKey);
    if (!hit) throw Object.assign(new Error('Not found'), { status: 404 });
    return { id: hit[1], key: hit[0], fields: { summary: hit[0], status: { name: 'Dev Review' } } };
  },
  async changelog() { return []; },
  ...extra,
});
const fakeTempo = (logs = []) => ({
  configured: true, logs, created: [], failDate: null,
  async worklogs(acc, from, to) { if (this.failDate && from === this.failDate) throw new Error('Tempo returned 503.'); return this.logs.filter((w) => w.date >= from && w.date <= to); },
  async create(p) { this.created.push(p); this.logs.push({ issueId: String(p.issueId), date: p.startDate, hours: p.timeSpentSeconds / 3600 }); },
});
const confirmed = (entries) => ({ status: 'confirmed', leaveHours: 0, entries, confirmedAt: 'x' });

test('pending skips Tempo days even before the month was opened', async () => {
  const { server, req } = await boot({ tempo: fakeTempo([{ issueId: '363920', date: '2026-11-03', hours: 7 }]), jira: fakeJira() });
  const p = (await req('GET', '/api/time/pending')).json();
  assert.ok(!p.days.includes('2026-11-03'));
  assert.ok(p.days.includes('2026-11-04'));
  assert.ok(!(await server.ctx.timePending()).includes('2026-11-03'));
  server.close();
});

test('one failing day does not lose the results of the others', async () => {
  const tempo = fakeTempo();
  tempo.failDate = '2026-11-04';
  const { server, req } = await boot({ tempo, jira: fakeJira(), store: { '2026-11-03': confirmed([{ key: 'TCPMOB-1600', hours: 7 }]), '2026-11-04': confirmed([{ key: 'TCPMOB-1609', hours: 7 }]) } });
  const r = await req('POST', '/api/time/tempo/send', { dates: ['2026-11-03', '2026-11-04'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json().results.map((x) => [x.date, x.status]), [['2026-11-03', 'sent'], ['2026-11-04', 'failed']]);
  assert.match(r.json().results[1].errors[0], /503/);
  assert.equal(tempo.created.length, 1);
  server.close();
});

test('an unknown key fails only its own worklog; month maps known ids around a missing one', async () => {
  const tempo = fakeTempo([{ issueId: '363920', date: '2026-11-05', hours: 3 }, { issueId: '999', date: '2026-11-05', hours: 4 }]);
  const { server, req } = await boot({ tempo, jira: fakeJira(), store: { '2026-11-03': confirmed([{ key: 'TCPMOB-1600', hours: 3.5 }, { key: 'TCPMOB-99999', hours: 3.5 }]) } });
  const m = (await req('GET', '/api/time/month?ym=2026-11')).json();
  assert.equal(m.tempo.status, 'ok');
  assert.deepEqual(m.days.find((d) => d.date === '2026-11-05').entries.map((e) => e.key), ['TCPMOB-1600', '#999']);
  const r = (await req('POST', '/api/time/tempo/send', { dates: ['2026-11-03'] })).json().results[0];
  assert.equal(r.status, 'partial');
  assert.match(r.errors[0], /TCPMOB-99999 3\.5h: not found in Jira/);
  server.close();
});

test('stale Tempo edits are cleared on a full send and on days no longer in Tempo', async () => {
  const tempo = fakeTempo();
  const { server, req } = await boot({ tempo, jira: fakeJira(), store: { '2026-11-03': confirmed([{ key: 'TCPMOB-1600', hours: 7 }]) } });
  server.ctx.tempoEdits.save('2026-11-03', { entries: [{ key: 'TCPMOB-1609', hours: 2 }] });
  server.ctx.tempoEdits.save('2026-11-04', { entries: [{ key: 'TCPMOB-1609', hours: 2 }] });
  await req('GET', '/api/time/month?ym=2026-11');
  assert.equal(server.ctx.tempoEdits.get('2026-11-04'), null);
  server.ctx.tempoEdits.save('2026-11-03', { entries: [{ key: 'TCPMOB-1609', hours: 2 }] });
  assert.equal((await req('POST', '/api/time/tempo/send', { dates: ['2026-11-03'] })).json().results[0].status, 'sent');
  assert.equal(server.ctx.tempoEdits.get('2026-11-03'), null);
  const day = (await req('GET', '/api/time/month?ym=2026-11')).json().days.find((d) => d.date === '2026-11-03');
  assert.deepEqual(day.flags, []);
  server.close();
});

test('edits on a day with an unmapped worklog are accepted', async () => {
  const { server, req } = await boot({ tempo: fakeTempo([{ issueId: '999', date: '2026-11-05', hours: 1 }, { issueId: '363920', date: '2026-11-05', hours: 6 }]), jira: fakeJira() });
  const r = await req('POST', '/api/time/tempo/edits/2026-11-05', { entries: [{ key: '#999', hours: 1 }, { key: 'TCPMOB-1600', hours: 5 }] });
  assert.equal(r.status, 200, r.body);
  server.close();
});

test('export includes days already in Tempo', async () => {
  const { server, req } = await boot({ tempo: fakeTempo([{ issueId: '363920', date: '2026-11-03', hours: 6.5 }]), jira: fakeJira() });
  const rows = JSON.parse((await req('GET', '/api/time/export?ym=2026-11&format=json')).body);
  assert.deepEqual(rows.filter((r) => r.date === '2026-11-03').map((r) => [r.key, r.hours]), [['LEAVE', 0.5], ['TCPMOB-1600', 6.5]]);
  server.close();
});
