import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { createSettings } from '../lib/settings.js';
import { buildQaCard } from '../lib/teams.js';
import { request } from './helpers.js';

const TICKET_URL = 'https://timeclockplus.atlassian.net/browse/TCPMOB-1768';
const QA = '/api/tickets/TCPMOB-1768/qa-request';

test('QA card: bold summary, link sentence, and a real tag mention when the tag id is known', () => {
  const tag = { name: 'MobileHardware_QA', id: 'MjQzMmYw' };
  const card = buildQaCard({ summary: 'CSSO | Permission *Guards*', ticketUrl: TICKET_URL, tag });
  const content = card.attachments[0].content;
  assert.deepEqual(content.body.map((b) => b.text), [
    'CSSO | Permission \\*Guards\\*',
    `[${TICKET_URL}](${TICKET_URL}) is ready for PRE-QA. Builds are mentioned in the ticket.`,
    '<at>MobileHardware_QA</at>',
  ]);
  assert.equal(content.body[0].weight, 'Bolder');
  assert.deepEqual(content.msteams.entities, [{
    type: 'mention',
    text: '<at>MobileHardware_QA</at>',
    mentioned: { id: 'MjQzMmYw', name: 'MobileHardware_QA', type: 'tag' },
  }]);
});

test('QA card: without a tag id the tag is bold text and nothing is mentioned', () => {
  const tag = { name: 'MobileHardware_QA', id: '' };
  const content = buildQaCard({ summary: 'S', ticketUrl: TICKET_URL, tag }).attachments[0].content;
  assert.equal(content.body.at(-1).text, '**MobileHardware\\_QA**');
  assert.deepEqual(content.msteams.entities, []);
});

function fakes({ status = 'Dev Review', builds = true } = {}) {
  const sent = { qa: [], test: [] };
  const jira = {
    configured: true,
    async getIssue(key) { return { key, fields: { summary: 'CSSO | Permission Guards', status: { name: status } } }; },
    async comments() {
      const text = 'pushed build number 412 for Mobile Clock Android to firebase distribution';
      return builds ? [{ text, created: 'x' }] : [];
    },
  };
  const teamsQa = { configured: true, async send(card) { sent.qa.push(card); } };
  const teamsTest = { configured: true, async send(card) { sent.test.push(card); } };
  return { jira, teamsQa, teamsTest, sent };
}

async function boot(opts = {}) {
  const { jira, teamsQa, teamsTest, sent } = fakes(opts);
  const settings = createSettings({ file: null, env: { JIRA_BASE_URL: 'https://timeclockplus.atlassian.net' } });
  const server = createServer({
    gh: { json: async () => [], run: async () => 'me\n' },
    tracker: { list: () => [] },
    behind: {},
    timeDir: mkdtempSync(path.join(tmpdir(), 'qa-')),
    settings, jira, teamsQa, teamsTest,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, req: request(server.address().port), sent };
}

test('preview returns title, link, tag, and which webhooks are set', async () => {
  const { server, req } = await boot();
  const preview = (await req('GET', QA)).json();
  assert.deepEqual(preview, {
    configured: true, testConfigured: true,
    key: 'TCPMOB-1768', title: 'CSSO | Permission Guards', ticketUrl: TICKET_URL,
    tag: { name: 'MobileHardware_QA', mention: false },
    ready: true, reason: null, cooldownUntil: null,
  });
  server.close();
});

test('test send goes to the test chat with no cooldown; a real send goes to QA once per 30 minutes', async () => {
  const { server, req, sent } = await boot();
  assert.equal((await req('POST', QA, { test: true })).status, 200);
  assert.equal((await req('POST', QA, { test: true })).status, 200);
  assert.equal(sent.test.length, 2);
  assert.equal(sent.qa.length, 0);
  assert.equal((await req('POST', QA, {})).status, 200);
  const again = await req('POST', QA, {});
  assert.equal(again.status, 429);
  assert.equal(sent.qa.length, 1);
  assert.match(JSON.stringify(sent.qa[0]), /is ready for PRE-QA/);
  server.close();
});

test('only Dev Review tickets with a dev build can be sent', async () => {
  let { server, req } = await boot({ status: 'In Progress' });
  let response = await req('POST', QA, { test: true });
  assert.equal(response.status, 409);
  assert.equal(response.json().error, 'TCPMOB-1768 is In Progress, not Dev Review.');
  server.close();
  ({ server, req } = await boot({ builds: false }));
  response = await req('POST', QA, { test: true });
  assert.equal(response.status, 409);
  assert.equal(response.json().error, 'TCPMOB-1768 has no dev build posted yet. Build it first.');
  assert.equal((await req('GET', QA)).json().ready, false);
  server.close();
});

test('bad keys are rejected and X-Dashboard is required', async () => {
  const { server, req } = await boot();
  assert.equal((await req('POST', '/api/tickets/OPS-1/qa-request', { test: true })).status, 400);
  assert.equal((await req('POST', QA, { test: true }, {})).status, 403);
  server.close();
});

test('settings: QA webhook is a masked secret; tag name and id are validated', () => {
  const settings = createSettings({ file: null, env: {} });
  const qaWebhookUrl = 'https://prod-01.westus.logic.azure.com/workflows/QASECRET/x';
  settings.update({ teams: { qaWebhookUrl, qaTagId: 'MjQzMmYw-abc==' } });
  const view = settings.publicView();
  assert.ok(!JSON.stringify(view).includes('QASECRET'));
  assert.equal(view.configured.teamsQa, true);
  assert.equal(view.teams.qaTagName, 'MobileHardware_QA');
  assert.throws(() => settings.update({ teams: { qaTagId: 'bad id with spaces' } }), { status: 400 });
  assert.throws(() => settings.update({ teams: { qaTagName: '<script>' } }), { status: 400 });
});
