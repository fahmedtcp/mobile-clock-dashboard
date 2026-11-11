import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { createSettings } from '../lib/settings.js';
import { buildQaCard } from '../lib/teams.js';
import { request } from './helpers.js';

const URL_ = 'https://timeclockplus.atlassian.net/browse/TCPMOB-1768';

test('QA card: bold summary, link sentence, and a real tag mention when the tag id is known', () => {
  const card = buildQaCard({ summary: 'CSSO | Permission *Guards*', ticketUrl: URL_, tag: { name: 'MobileHardware_QA', id: 'MjQzMmYw' } });
  const c = card.attachments[0].content;
  assert.deepEqual(c.body.map((b) => b.text), [
    'CSSO | Permission \\*Guards\\*',
    `[${URL_}](${URL_}) is ready for PRE-QA. Builds are mentioned in the ticket.`,
    '<at>MobileHardware_QA</at>',
  ]);
  assert.equal(c.body[0].weight, 'Bolder');
  assert.deepEqual(c.msteams.entities, [{ type: 'mention', text: '<at>MobileHardware_QA</at>', mentioned: { id: 'MjQzMmYw', name: 'MobileHardware_QA', type: 'tag' } }]);
});

test('QA card: without a tag id the tag is bold text and nothing is mentioned', () => {
  const c = buildQaCard({ summary: 'S', ticketUrl: URL_, tag: { name: 'MobileHardware_QA', id: '' } }).attachments[0].content;
  assert.equal(c.body.at(-1).text, '**MobileHardware\\_QA**');
  assert.deepEqual(c.msteams.entities, []);
});

function fakes({ status = 'Dev Review', builds = true } = {}) {
  const sent = { qa: [], test: [] };
  const jira = {
    configured: true,
    async getIssue(key) { return { key, fields: { summary: 'CSSO | Permission Guards', status: { name: status } } }; },
    async comments() { return builds ? [{ text: 'pushed build number 412 for Mobile Clock Android to firebase distribution', created: 'x' }] : []; },
  };
  const teamsQa = { configured: true, async send(p) { sent.qa.push(p); } };
  const teamsTest = { configured: true, async send(p) { sent.test.push(p); } };
  return { jira, teamsQa, teamsTest, sent };
}

async function boot(opts = {}) {
  const f = fakes(opts);
  const settings = createSettings({ file: null, env: { JIRA_BASE_URL: 'https://timeclockplus.atlassian.net' } });
  const server = createServer({ gh: { json: async () => [], run: async () => 'me\n' }, tracker: { list: () => [] }, behind: {}, timeDir: mkdtempSync(path.join(tmpdir(), 'qa-')), settings, jira: f.jira, teamsQa: f.teamsQa, teamsTest: f.teamsTest });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, req: request(server.address().port), sent: f.sent };
}

test('preview returns title, link, tag, and which webhooks are set', async () => {
  const { server, req } = await boot();
  const r = (await req('GET', '/api/tickets/TCPMOB-1768/qa-request')).json();
  assert.deepEqual(r, { configured: true, testConfigured: true, key: 'TCPMOB-1768', title: 'CSSO | Permission Guards', ticketUrl: URL_, tag: { name: 'MobileHardware_QA', mention: false }, ready: true, reason: null, cooldownUntil: null });
  server.close();
});

test('test send goes to the test chat with no cooldown; a real send goes to QA once per 30 minutes', async () => {
  const { server, req, sent } = await boot();
  assert.equal((await req('POST', '/api/tickets/TCPMOB-1768/qa-request', { test: true })).status, 200);
  assert.equal((await req('POST', '/api/tickets/TCPMOB-1768/qa-request', { test: true })).status, 200);
  assert.equal(sent.test.length, 2);
  assert.equal(sent.qa.length, 0);
  assert.equal((await req('POST', '/api/tickets/TCPMOB-1768/qa-request', {})).status, 200);
  const again = await req('POST', '/api/tickets/TCPMOB-1768/qa-request', {});
  assert.equal(again.status, 429);
  assert.equal(sent.qa.length, 1);
  assert.match(JSON.stringify(sent.qa[0]), /is ready for PRE-QA/);
  server.close();
});

test('only Dev Review tickets with a dev build can be sent', async () => {
  let { server, req } = await boot({ status: 'In Progress' });
  let r = await req('POST', '/api/tickets/TCPMOB-1768/qa-request', { test: true });
  assert.equal(r.status, 409);
  assert.equal(r.json().error, 'TCPMOB-1768 is In Progress, not Dev Review.');
  server.close();
  ({ server, req } = await boot({ builds: false }));
  r = await req('POST', '/api/tickets/TCPMOB-1768/qa-request', { test: true });
  assert.equal(r.status, 409);
  assert.equal(r.json().error, 'TCPMOB-1768 has no dev build posted yet. Build it first.');
  assert.equal((await req('GET', '/api/tickets/TCPMOB-1768/qa-request')).json().ready, false);
  server.close();
});

test('bad keys are rejected and X-Dashboard is required', async () => {
  const { server, req } = await boot();
  assert.equal((await req('POST', '/api/tickets/OPS-1/qa-request', { test: true })).status, 400);
  assert.equal((await req('POST', '/api/tickets/TCPMOB-1768/qa-request', { test: true }, {})).status, 403);
  server.close();
});

test('settings: QA webhook is a masked secret; tag name and id are validated', () => {
  const s = createSettings({ file: null, env: {} });
  s.update({ teams: { qaWebhookUrl: 'https://prod-01.westus.logic.azure.com/workflows/QASECRET/x', qaTagId: 'MjQzMmYw-abc==' } });
  const v = s.publicView();
  assert.ok(!JSON.stringify(v).includes('QASECRET'));
  assert.equal(v.configured.teamsQa, true);
  assert.equal(v.teams.qaTagName, 'MobileHardware_QA');
  assert.throws(() => s.update({ teams: { qaTagId: 'bad id with spaces' } }), { status: 400 });
  assert.throws(() => s.update({ teams: { qaTagName: '<script>' } }), { status: 400 });
});
