import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { createSettings } from '../lib/settings.js';
import { JIRA } from '../config.js';
import { request } from './helpers.js';

async function boot(opts = {}) {
  const settings = opts.settings ?? createSettings({ file: null, env: {} });
  const server = createServer({
    gh: { json: async () => [], run: async () => 'me\n' }, tracker: { list: () => [] }, behind: {},
    timeDir: mkdtempSync(path.join(tmpdir(), 'setroutes-')), settings, ...opts,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (...a) => request(port)(...a);
  return { server, req };
}

test('GET returns the masked view and PUT applies it', async () => {
  const { server, req } = await boot();
  assert.equal((await req('GET', '/api/settings')).json().theme, 'light');
  const put = await req('PUT', '/api/settings', { theme: 'dark', tempo: { token: 'tok_abcdef9876' } });
  assert.equal(put.status, 200);
  assert.equal(put.json().theme, 'dark');
  assert.ok(!put.body.includes('tok_abcdef'));
  assert.equal(put.json().tempo.token.last4, '9876');
  assert.equal(server.ctx.tempo.configured, true);
  server.close();
});

test('saving jira rebuilds the client and clears account id', async () => {
  const { server, req } = await boot();
  assert.equal(server.ctx.jira.configured, false);
  server.ctx.tempoAccountId = 'old';
  const r = await req('PUT', '/api/settings', { jira: { baseUrl: 'https://tcp.atlassian.net', email: 'me@tcpsoftware.com', token: 'jiratoken1234' } });
  assert.equal(r.status, 200, r.body);
  assert.equal(server.ctx.jira.configured, true);
  assert.equal(JIRA.email, 'me@tcpsoftware.com');
  assert.equal(server.ctx.tempoAccountId, null);
  await req('PUT', '/api/settings', { jira: { baseUrl: null, email: null, token: null } });
  server.close();
});

test('PUT requires X-Dashboard, and invalid PUT returns 400 with the message', async () => {
  const { server, req } = await boot();
  assert.equal((await req('PUT', '/api/settings', { theme: 'dark' }, {})).status, 403);
  const bad = await req('PUT', '/api/settings', { theme: 'neon' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json().error, 'Theme must be light, dark, or system.');
  server.close();
});

test('teams prefs come from settings', async () => {
  const { server, req } = await boot();
  await req('PUT', '/api/settings', { teams: { never: ['x'], always: ['hashfaqtcp'] } });
  assert.deepEqual(server.ctx.teamsPrefs, { always: ['hashfaqtcp'], never: ['x'] });
  server.close();
});

test('builds-config follows defaultChecked and never checks the sim', async () => {
  const { server, req } = await boot();
  await req('PUT', '/api/settings', { builds: { defaultChecked: ['mcIos'] } });
  const cfg = (await req('GET', '/api/builds-config')).json();
  assert.deepEqual(cfg.filter((b) => b.defaultChecked).map((b) => b.key), ['mcIos']);
  assert.equal(cfg.find((b) => b.key === 'mcIosSim').defaultChecked, false);
  server.close();
});

test('empty settings and no env still serve every GET route', async () => {
  const { server, req } = await boot({ settings: createSettings({ file: null, env: {} }) });
  for (const p of ['/api/settings', '/api/time/month?ym=2026-11', '/api/time/pending', '/api/builds-config', '/api/me']) {
    const r = await req('GET', p);
    assert.ok(r.status < 500, `${p} → ${r.status} ${r.body.slice(0, 120)}`);
  }
  server.close();
});
