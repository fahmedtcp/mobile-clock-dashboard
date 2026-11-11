import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { createSettings } from '../lib/settings.js';

async function boot(opts = {}) {
  const settings = createSettings({ file: null, env: {} });
  if (opts.saved) settings.update(opts.saved);
  const server = createServer({
    gh: opts.gh ?? { json: async () => [], run: async () => 'pat\n' }, tracker: { list: () => [] }, behind: {},
    timeDir: mkdtempSync(path.join(tmpdir(), 'setconn-')), settings,
  });
  Object.assign(server.ctx, opts.ctx ?? {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (service, body = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/settings/test/${service}`, headers: { Host: `127.0.0.1:${port}`, 'X-Dashboard': '1', 'Content-Type': 'application/json' } }, (rs) => {
      let d = ''; rs.on('data', (c) => { d += c; }); rs.on('end', () => resolve({ status: rs.statusCode, body: d, json: () => JSON.parse(d) }));
    });
    r.on('error', reject);
    r.write(JSON.stringify(body));
    r.end();
  });
  return { server, post };
}
const SAVED_JIRA = { jira: { baseUrl: 'https://tcp.atlassian.net', email: 'me@tcpsoftware.com', token: 'savedtoken0000' } };

test('jira test uses typed token merged with saved email and never stores it', async () => {
  let seen;
  const { server, post } = await boot({ saved: SAVED_JIRA, ctx: { makeJira: (cfg) => { seen = cfg; return { configured: true, myself: async () => ({ displayName: 'Pat' }) }; } } });
  const r = (await post('jira', { token: 'typedtoken1111' })).json();
  assert.deepEqual(r, { ok: true, message: 'Connected as Pat.' });
  assert.equal(seen.token, 'typedtoken1111');
  assert.equal(seen.email, 'me@tcpsoftware.com');
  assert.equal(server.ctx.settings.raw().jira.token, 'savedtoken0000');
  server.close();
});

test('test errors never echo the candidate token', async () => {
  const { server, post } = await boot({ saved: SAVED_JIRA, ctx: { makeJira: (cfg) => ({ configured: true, myself: async () => { throw new Error(`bad ${cfg.token}`); } }) } });
  const res = await post('jira', { token: 'leakytoken2222' });
  assert.ok(!res.body.includes('leakytoken'));
  assert.deepEqual(res.json(), { ok: false, message: 'Couldn\'t connect to Jira.' });
  server.close();
});

test('invalid candidates fail validation without storing', async () => {
  const { server, post } = await boot();
  assert.deepEqual((await post('jira', { token: 'has space' })).json(), { ok: false, message: 'That token doesn\'t look right. Paste it again without spaces.' });
  assert.equal(server.ctx.settings.raw().jira, undefined);
  server.close();
});

test('tempo test needs Jira first', async () => {
  const { server, post } = await boot();
  assert.deepEqual((await post('tempo', { token: 'tempotoken3333' })).json(), { ok: false, message: 'Connect Jira first. Tempo uses your Jira account to find your worklogs.' });
  server.close();
});

test('tempo test reads today with the typed token', async () => {
  let token;
  const { server, post } = await boot({ saved: SAVED_JIRA, ctx: {
    makeJira: () => ({ configured: true, myself: async () => ({ accountId: 'acc', displayName: 'Pat' }) }),
    makeTempo: (cfg) => { token = cfg.token; return { configured: true, worklogs: async () => [] }; },
  } });
  assert.deepEqual((await post('tempo', { token: 'tempotoken3333' })).json(), { ok: true, message: 'Connected.' });
  assert.equal(token, 'tempotoken3333');
  server.close();
});

test('teams test never fetches', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('fetch called'); };
  try {
    const { server, post } = await boot();
    assert.deepEqual((await post('teams', { webhookUrl: 'https://prod-01.westus.logic.azure.com/workflows/x' })).json(), { ok: true, message: 'Looks right. To see a real message, use test mode in Request Review.' });
    assert.deepEqual((await post('teamsTest', { testWebhookUrl: 'https://evil.com/x' })).json(), { ok: false, message: 'Use a Teams Workflows webhook address.' });
    server.close();
  } finally { globalThis.fetch = real; }
});

test('github test reports login, or how to sign in', async () => {
  let { server, post } = await boot({ gh: { run: async () => 'pat\n', json: async () => [] } });
  assert.deepEqual((await post('github')).json(), { ok: true, message: 'Signed in as pat.' });
  server.close();
  ({ server, post } = await boot({ gh: { run: async () => { throw new Error('not logged in'); }, json: async () => [] } }));
  assert.deepEqual((await post('github')).json(), { ok: false, message: 'Not signed in. Run gh auth login in Terminal.' });
  server.close();
});

test('unknown service is 404', async () => {
  const { server, post } = await boot();
  assert.equal((await post('slack')).status, 404);
  server.close();
});
