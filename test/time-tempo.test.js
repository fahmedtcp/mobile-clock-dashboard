import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTempo, tempoByDay, statusAtEndOfDay, toPayload } from '../lib/time/tempo.js';

const BASE = 'https://tempo.test/4';
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const wl = (id, issueId, date, seconds) => ({ tempoWorklogId: id, issue: { id: Number(issueId) }, startDate: date, timeSpentSeconds: seconds });

test('worklogs follows metadata.next and maps fields', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return json(200, { metadata: { next: `${BASE}/worklogs/user/acc?offset=2` }, results: [wl(1, 363920, '2026-08-12', 11250), wl(2, 364036, '2026-08-12', 11250)] });
    return json(200, { metadata: {}, results: [wl(3, 363920, '2026-08-13', 12600)] });
  };
  const tempo = createTempo({ token: 't0k', baseUrl: BASE, fetch });
  const out = await tempo.worklogs('acc', '2026-08-01', '2026-08-31');
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { tempoId: 1, issueId: '363920', date: '2026-08-12', hours: 3.13 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/worklogs\/user\/acc\?from=2026-08-01&to=2026-08-31&limit=1000$/);
  assert.equal(calls[1].url, `${BASE}/worklogs/user/acc?offset=2`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t0k');
});

test('401 throws a token message without the token', async () => {
  const tempo = createTempo({ token: 't0k', baseUrl: BASE, fetch: async () => json(401, { errors: ['t0k bad'] }) });
  await assert.rejects(tempo.worklogs('acc', '2026-08-01', '2026-08-31'), (e) => /Tempo token in Settings/.test(e.message) && !e.message.includes('t0k'));
});

test('other errors give the status only', async () => {
  const tempo = createTempo({ token: 't0k', baseUrl: BASE, fetch: async () => json(500, { secret: 'x' }) });
  await assert.rejects(tempo.create({}), { message: 'Tempo returned 500.' });
});

test('unconfigured client reports configured false', () => {
  assert.equal(createTempo({ token: '' }).configured, false);
  assert.equal(createTempo({ token: 'x' }).configured, true);
});

test('create posts JSON to /worklogs', async () => {
  let seen;
  const tempo = createTempo({ token: 't0k', baseUrl: BASE, fetch: async (url, init) => { seen = { url, init }; return json(200, { tempoWorklogId: 1 }); } });
  const payload = toPayload({ issueId: '363920', hours: 3.5, date: '2026-08-12', description: 'In Progress', accountId: 'acc' });
  await tempo.create(payload);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.url, `${BASE}/worklogs`);
  assert.deepEqual(JSON.parse(seen.init.body), payload);
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
});

test('tempoByDay merges same key per day and labels unknown ids', () => {
  const m = tempoByDay([
    { issueId: '1', date: '2026-08-12', hours: 2 },
    { issueId: '1', date: '2026-08-12', hours: 1.5 },
    { issueId: '9', date: '2026-08-12', hours: 1 },
    { issueId: '1', date: '2026-08-13', hours: 7 },
  ], new Map([['1', 'TCPMOB-1600']]));
  assert.deepEqual(m.get('2026-08-12'), [{ key: 'TCPMOB-1600', hours: 3.5 }, { key: '#9', hours: 1 }]);
  assert.deepEqual(m.get('2026-08-13'), [{ key: 'TCPMOB-1600', hours: 7 }]);
});

test('statusAtEndOfDay picks last change by end of day, falls back to fromString, then current', () => {
  const h = [
    { created: '2026-08-13T09:00:00', items: [{ field: 'status', fromString: 'In Progress', toString: 'Dev Review' }] },
    { created: '2026-08-12T10:00:00', items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }, { field: 'assignee' }] },
  ];
  assert.equal(statusAtEndOfDay(h, 'QA Review', '2026-08-12'), 'In Progress');
  assert.equal(statusAtEndOfDay(h, 'QA Review', '2026-08-13'), 'Dev Review');
  assert.equal(statusAtEndOfDay(h, 'QA Review', '2026-08-11'), 'To Do');
  assert.equal(statusAtEndOfDay([], 'QA Review', '2026-08-11'), 'QA Review');
});

test('toPayload converts hours to seconds', () => {
  const p = toPayload({ issueId: '363920', hours: 3.5, date: '2026-08-12', description: 'In Progress', accountId: 'acc' });
  assert.deepEqual(p, { issueId: 363920, timeSpentSeconds: 12600, startDate: '2026-08-12', startTime: '09:00:00', authorAccountId: 'acc', description: 'In Progress' });
  assert.equal(toPayload({ issueId: '1', hours: 2.33, date: 'd', description: '', accountId: 'a' }).timeSpentSeconds, 8388);
});
