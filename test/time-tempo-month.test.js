process.env.TZ = 'America/Chicago';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { request } from './helpers.js';

const timeDir = mkdtempSync(path.join(tmpdir(), 'tempomonth-'));
const sources = {
  async claude() { return new Map([['2026-11-04', [{ segments: [{ key: 'TCPMOB-1', activeMinutes: 120 }] }]]]); },
  async git() { return { byDay: new Map(), error: null }; },
  async jira() { return { tickets: new Map([['TCPMOB-1', { key: 'TCPMOB-1', summary: 'One', url: 'u1' }]]), inProgressDays: new Map(), activity: new Map() }; },
};
const tempo = {
  configured: true, calls: 0, logs: [], fail: null,
  async worklogs() { this.calls++; if (this.fail) throw new Error(this.fail); return this.logs; },
};
const jira = {
  configured: true,
  async myself() { return { accountId: 'acc' }; },
  async search() { return [{ id: '363920', key: 'TCPMOB-1600', fields: { summary: 'Sixteen hundred' } }, { id: '364036', key: 'TCPMOB-1609', fields: { summary: 'Sixteen oh nine' } }, { id: '500', key: 'OPS-12', fields: { summary: 'Ops' } }]; },
};
const wl = (issueId, date, hours) => ({ issueId, date, hours });

let server, port;
before(async () => {
  server = createServer({ gh: { json: async () => [], run: async () => '' }, tracker: { list: () => [] }, behind: {}, timeDir, timeSources: sources, timeToday: () => '2026-11-10', tempo, jira });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());
beforeEach(() => { tempo.configured = true; tempo.fail = null; tempo.calls = 0; tempo.logs = [wl('363920', '2026-11-03', 3.13), wl('364036', '2026-11-03', 3.13)]; server.ctx.timeMonthCacheClear(); });

const req = (...a) => request(port)(...a);
const month = async () => (await req('GET', '/api/time/month?ym=2026-11')).json();
const dayOf = (m, date) => m.days.find((d) => d.date === date);

test('day with Tempo worklogs shows tempo state and Tempo hours', async () => {
  const m = await month();
  assert.deepEqual(m.tempo, { configured: true, status: 'ok' });
  const d = dayOf(m, '2026-11-03');
  assert.equal(d.state, 'tempo');
  assert.deepEqual(d.entries.map((e) => e.key), ['TCPMOB-1600', 'TCPMOB-1609']);
  assert.equal(d.entries[0].summary, 'Sixteen hundred');
  assert.equal(d.leaveHours, 0.74);
  assert.deepEqual(d.flags, []);
  assert.equal(dayOf(m, '2026-11-04').state, 'review');
});

test('old confirmed record on a Tempo day is ignored', async () => {
  server.ctx.timeStore.save('2026-11-03', { status: 'confirmed', leaveHours: 0, entries: [{ key: 'TCPMOB-1', hours: 7 }] });
  const d = dayOf(await month(), '2026-11-03');
  assert.equal(d.state, 'tempo');
  assert.deepEqual(d.entries.map((e) => e.key), ['TCPMOB-1600', 'TCPMOB-1609']);
  assert.deepEqual(d.flags, []);
});

test('tempo edits produce flags and clear when Tempo matches', async () => {
  tempo.logs = [wl('363920', '2026-11-05', 3.5)];
  server.ctx.tempoEdits.save('2026-11-05', { entries: [{ key: 'TCPMOB-1600', hours: 5 }] });
  let d = dayOf(await month(), '2026-11-05');
  assert.deepEqual(d.flags, [{ key: 'TCPMOB-1600', tempoHours: 3.5, yourHours: 5 }]);
  assert.equal(d.entries[0].hours, 5);
  tempo.logs = [wl('363920', '2026-11-05', 5)];
  server.ctx.timeMonthCacheClear();
  d = dayOf(await month(), '2026-11-05');
  assert.deepEqual(d.flags, []);
  assert.equal(server.ctx.tempoEdits.get('2026-11-05'), null);
});

test('flags cover removed and added keys', async () => {
  tempo.logs = [wl('363920', '2026-11-06', 3.5)];
  server.ctx.tempoEdits.save('2026-11-06', { entries: [{ key: 'TCPMOB-1609', hours: 2 }] });
  const d = dayOf(await month(), '2026-11-06');
  assert.deepEqual(d.flags, [{ key: 'TCPMOB-1600', tempoHours: 3.5, yourHours: 0 }, { key: 'TCPMOB-1609', tempoHours: 0, yourHours: 2 }]);
});

test('non-TCPMOB worklog is read-only', async () => {
  tempo.logs = [wl('500', '2026-11-09', 1), wl('363920', '2026-11-09', 6)];
  const d = dayOf(await month(), '2026-11-09');
  assert.deepEqual(d.readOnlyKeys, ['OPS-12']);
});

test('month loads when Tempo fails', async () => {
  tempo.fail = 'Tempo returned 500.';
  const m = await month();
  assert.equal(m.tempo.status, 'Tempo returned 500.');
  assert.equal(dayOf(m, '2026-11-04').state, 'review');
  assert.notEqual(dayOf(m, '2026-11-03').state, 'tempo');
});

test('no token means tempo off', async () => {
  tempo.configured = false;
  const m = await month();
  assert.deepEqual(m.tempo, { configured: false, status: 'off' });
  assert.equal(tempo.calls, 0);
});

test('pending skips days found in Tempo', async () => {
  await month();
  const p = (await req('GET', '/api/time/pending')).json();
  assert.ok(!p.days.includes('2026-11-03'));
  assert.ok(p.days.includes('2026-11-04'));
});
