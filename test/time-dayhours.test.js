process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, migrateDayHours } from '../server.js';
import { createSettings } from '../lib/settings.js';
import { createStore } from '../lib/time/store.js';
import { request } from './helpers.js';

const sources = {
  async claude() { return new Map(); },
  async git() { return { byDay: new Map(), error: null }; },
  async jira() { return { tickets: new Map([['TCPMOB-1', { key: 'TCPMOB-1', summary: 'One', url: 'u' }]]), inProgressDays: new Map([['TCPMOB-1', new Set(['2026-11-03', '2026-11-04'])]]), activity: new Map() }; },
};

async function boot({ dayHours, tempo } = {}) {
  const settings = createSettings({ file: null, env: {}, initial: dayHours ? { time: { dayHours } } : {} });
  const server = createServer({
    gh: { json: async () => [], run: async () => 'me\n' }, tracker: { list: () => [] }, behind: {},
    timeDir: mkdtempSync(path.join(tmpdir(), 'dayhours-')), timeSources: sources, timeToday: () => '2026-11-10', settings,
    ...(tempo ? { tempo, jira: { configured: true, myself: async () => ({ accountId: 'acc' }), search: async () => [{ id: '1', key: 'TCPMOB-1', fields: { summary: 'One' } }] } } : {}),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (...a) => request(port)(...a);
  return { server, req, month: async () => (await req('GET', '/api/time/month?ym=2026-11')).json() };
}
const day = (m, d) => m.days.find((x) => x.date === d);
const confirm = (req, date, hours) => req('POST', `/api/time/day/${date}`, { leaveHours: 0, entries: [{ key: 'TCPMOB-1', hours }], confirm: true });

test('time is off until dayHours is set', async () => {
  const { server, req, month } = await boot();
  const m = await month();
  assert.equal(m.dayHours, null);
  assert.equal(m.days.length, 0);
  assert.deepEqual((await req('GET', '/api/time/pending')).json(), { count: 0, days: [] });
  const r = await confirm(req, '2026-11-03', 7);
  assert.equal(r.status, 409);
  assert.equal(r.json().error, 'Set your workday hours in Settings first.');
  server.close();
});

test('saving a day stores the current dayHours', async () => {
  const { server, req } = await boot({ dayHours: 8 });
  assert.equal((await confirm(req, '2026-11-03', 8)).status, 200);
  assert.equal(server.ctx.timeStore.get('2026-11-03').dayHours, 8);
  assert.equal((await confirm(req, '2026-11-04', 7)).status, 400);
  server.close();
});

test('changing dayHours keeps past days\' targets', async () => {
  const { server, req, month } = await boot({ dayHours: 7 });
  assert.equal((await confirm(req, '2026-11-03', 7)).status, 200);
  assert.equal((await req('PUT', '/api/settings', { time: { dayHours: 8 } })).status, 200);
  const again = await confirm(req, '2026-11-03', 7);
  assert.equal(again.status, 200, again.body);
  const m = await month();
  assert.equal(m.dayHours, 8);
  assert.equal(day(m, '2026-11-03').target, 7);
  assert.equal(day(m, '2026-11-03').dayHours, 7);
  assert.equal(day(m, '2026-11-04').target, 8);
  assert.equal(day(m, '2026-11-04').entries.reduce((a, e) => a + e.hours, 0), 8);
  server.close();
});

test('records without dayHours count as 7', async () => {
  const { server, month } = await boot({ dayHours: 8 });
  server.ctx.timeStore.save('2026-11-05', { status: 'confirmed', leaveHours: 7, entries: [] });
  const d = day(await month(), '2026-11-05');
  assert.equal(d.state, 'leave');
  assert.equal(d.dayHours, 7);
  server.close();
});

test('tempo day leave uses the current setting', async () => {
  const tempo = { configured: true, async worklogs() { return [{ issueId: '1', date: '2026-11-06', hours: 7 }]; } };
  const { server, month } = await boot({ dayHours: 8, tempo });
  const d = day(await month(), '2026-11-06');
  assert.equal(d.state, 'tempo');
  assert.equal(d.leaveHours, 1);
  server.close();
});

test('migration sets 7 only when records exist', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-'));
  const store = createStore(path.join(dir, 'confirmed.json'));
  const fresh = createSettings({ file: null, env: {} });
  migrateDayHours(fresh, store);
  assert.equal(fresh.resolved().time.dayHours, null);
  store.save('2026-11-03', { status: 'confirmed', leaveHours: 0, entries: [{ key: 'TCPMOB-1', hours: 7 }] });
  migrateDayHours(fresh, store);
  assert.equal(fresh.resolved().time.dayHours, 7);
  const set = createSettings({ file: null, env: {}, initial: { time: { dayHours: 8 } } });
  migrateDayHours(set, store);
  assert.equal(set.resolved().time.dayHours, 8);
});
