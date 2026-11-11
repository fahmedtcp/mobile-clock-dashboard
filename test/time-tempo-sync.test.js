process.env.TZ = 'America/Chicago';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { request } from './helpers.js';

const timeDir = mkdtempSync(path.join(tmpdir(), 'temposync-'));
const sources = {
  async claude() { return new Map(); },
  async git() { return { byDay: new Map(), error: null }; },
  async jira() { return { tickets: new Map(), inProgressDays: new Map(), activity: new Map() }; },
};
const tempo = {
  configured: true, logs: [], created: [], failOn: null, gate: null,
  // Each call can return a different list, so tests can simulate a log appearing between preview and send.
  queue: [],
  async worklogs(acc, from, to) {
    const logs = this.queue.length ? this.queue.shift() : this.logs;
    return logs.filter((w) => w.date >= from && w.date <= to);
  },
  async create(p) {
    if (this.gate) await this.gate;
    if (this.failOn === p.issueId) throw new Error('Tempo returned 400.');
    this.created.push(p);
    this.logs.push({ issueId: String(p.issueId), date: p.startDate, hours: p.timeSpentSeconds / 3600 });
  },
};
const ISSUES = { 'TCPMOB-1600': '363920', 'TCPMOB-1609': '364036' };
const jira = {
  configured: true,
  async myself() { return { accountId: 'acc' }; },
  async search(jql) {
    const all = Object.entries(ISSUES).map(([key, id]) => ({ id, key, fields: { summary: key, status: { name: 'QA Review' } } }));
    if (jql.startsWith('id in')) return all;
    return all.filter((i) => jql.includes(i.key));
  },
  async changelog(key) {
    if (key !== 'TCPMOB-1600') return [];
    return [
      { created: '2026-11-03T10:00:00', items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }] },
      { created: '2026-11-04T10:00:00', items: [{ field: 'status', fromString: 'In Progress', toString: 'Dev Review' }] },
    ];
  },
};

let server, port;
before(async () => {
  server = createServer({ gh: { json: async () => [], run: async () => '' }, tracker: { list: () => [] }, behind: {}, timeDir, timeSources: sources, timeToday: () => '2026-11-10', tempo, jira });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

const confirmed = (entries, leaveHours = 0) => ({ status: 'confirmed', leaveHours, entries, confirmedAt: 'x' });
beforeEach(() => {
  Object.assign(tempo, { configured: true, logs: [], created: [], failOn: null, gate: null, queue: [] });
  const s = server.ctx.timeStore;
  s.save('2026-11-03', confirmed([{ key: 'TCPMOB-1600', hours: 3.5 }, { key: 'TCPMOB-1609', hours: 3.5 }]));
  s.save('2026-11-04', confirmed([{ key: 'TCPMOB-1600', hours: 7 }]));
  s.save('2026-11-05', { status: 'draft', leaveHours: 0, entries: [{ key: 'TCPMOB-1600', hours: 7 }] });
  s.save('2026-11-06', confirmed([], 7));
  server.ctx.tempoEdits.save('2026-11-03', null);
  server.ctx.timeMonthCacheClear();
});

const req = (...a) => request(port)(...a);
const send = (dates, extra = {}) => req('POST', '/api/time/tempo/send', { dates, ...extra });

test('preview lists worklogs with status descriptions and skips with reasons', async () => {
  tempo.logs = [{ issueId: '363920', date: '2026-11-07', hours: 1 }];
  const res = await req('GET', '/api/time/tempo/preview?dates=2026-11-03,2026-11-05');
  assert.equal(res.status, 200);
  const p = res.json();
  assert.deepEqual(p.days[0], { date: '2026-11-03', ok: true, worklogs: [{ key: 'TCPMOB-1600', hours: 3.5, description: 'In Progress' }, { key: 'TCPMOB-1609', hours: 3.5, description: 'QA Review' }] });
  assert.deepEqual(p.days[1], { date: '2026-11-05', ok: false, reason: 'Not confirmed', worklogs: [] });
  assert.equal(p.totalHours, 7);
});

test('send posts each entry with payload fields', async () => {
  const res = await send(['2026-11-04']);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json().results, [{ date: '2026-11-04', status: 'sent', sent: 1 }]);
  assert.deepEqual(tempo.created, [{ issueId: 363920, timeSpentSeconds: 25200, startDate: '2026-11-04', startTime: '09:00:00', authorAccountId: 'acc', description: 'Dev Review' }]);
});

test('send skips a day that gained Tempo worklogs after preview', async () => {
  const pre = (await req('GET', '/api/time/tempo/preview?dates=2026-11-04')).json();
  assert.equal(pre.days[0].ok, true);
  tempo.logs = [{ issueId: '363920', date: '2026-11-04', hours: 7 }];
  const r = (await send(['2026-11-04'])).json().results[0];
  assert.equal(r.status, 'skipped');
  assert.equal(r.reason, 'Already in Tempo');
  assert.equal(tempo.created.length, 0);
});

test('concurrent sends of one day post once', async () => {
  let open;
  tempo.gate = new Promise((r) => { open = r; });
  const first = send(['2026-11-03']);
  await new Promise((r) => setTimeout(r, 30));
  const second = await send(['2026-11-03']);
  assert.equal(second.status, 409);
  open();
  assert.equal((await first).status, 200);
  assert.equal(tempo.created.length, 2);
});

test('send ignores entries in the request body', async () => {
  await send(['2026-11-04'], { entries: [{ key: 'TCPMOB-1', hours: 7 }] });
  assert.deepEqual(tempo.created.map((p) => p.issueId), [363920]);
});

test('partial failure reports unsent keys and flags them', async () => {
  tempo.failOn = 364036;
  const r = (await send(['2026-11-03'])).json().results[0];
  assert.equal(r.status, 'partial');
  assert.equal(r.sent, 1);
  assert.match(r.errors[0], /TCPMOB-1609 3\.5h/);
  server.ctx.timeMonthCacheClear();
  const day = (await req('GET', '/api/time/month?ym=2026-11')).json().days.find((d) => d.date === '2026-11-03');
  assert.equal(day.state, 'tempo');
  assert.deepEqual(day.flags, [{ key: 'TCPMOB-1609', tempoHours: 0, yourHours: 3.5 }]);
});

test('unconfirmed, future, weekend, and full-leave days are skipped with exact reasons', async () => {
  const rs = (await send(['2026-11-05', '2026-11-11', '2026-11-08', '2026-11-06'])).json().results;
  assert.deepEqual(rs.map((r) => [r.date, r.status, r.reason]), [
    ['2026-11-05', 'skipped', 'Not confirmed'],
    ['2026-11-11', 'skipped', 'Future day'],
    ['2026-11-08', 'skipped', 'Not a workday'],
    ['2026-11-06', 'skipped', 'Full day of leave'],
  ]);
  assert.equal(tempo.created.length, 0);
});

test('bad send bodies are rejected', async () => {
  assert.equal((await send([])).status, 400);
  assert.equal((await send(['nope'])).status, 400);
  assert.equal((await req('POST', '/api/time/tempo/send', { dates: 'x' })).status, 400);
});

test('send without a token returns 503', async () => {
  tempo.configured = false;
  const res = await send(['2026-11-04']);
  assert.equal(res.status, 503);
  assert.match(res.json().error, /Tempo token in Settings/);
  assert.equal((await req('GET', '/api/time/tempo/preview?dates=2026-11-04')).status, 503);
  assert.equal(tempo.created.length, 0);
});

test('send requires X-Dashboard', async () => {
  const res = await req('POST', '/api/time/tempo/send', { dates: ['2026-11-04'] }, {});
  assert.equal(res.status, 403);
  assert.equal(tempo.created.length, 0);
});

test('edits route rejects bad keys and hours and non-Tempo days', async () => {
  tempo.logs = [{ issueId: '363920', date: '2026-11-07', hours: 1 }, { issueId: '363920', date: '2026-11-09', hours: 7 }];
  const ok = await req('POST', '/api/time/tempo/edits/2026-11-09', { entries: [{ key: 'TCPMOB-1600', hours: 5 }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(server.ctx.tempoEdits.get('2026-11-09'), { entries: [{ key: 'TCPMOB-1600', hours: 5 }] });
  assert.equal((await req('POST', '/api/time/tempo/edits/2026-11-09', { entries: [{ key: 'bad', hours: 1 }] })).status, 400);
  assert.equal((await req('POST', '/api/time/tempo/edits/2026-11-09', { entries: [{ key: 'TCPMOB-1', hours: 30 }] })).status, 400);
  assert.equal((await req('POST', '/api/time/tempo/edits/2026-11-04', { entries: [] })).status, 400);
});
