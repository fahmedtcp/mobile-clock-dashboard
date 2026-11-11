import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCard, validWebhookUrl, createTeams, mentionText } from '../lib/teams.js';

const args = {
  key: 'TCPMOB-1735', summary: 'SubSearch | Testing — Consume V7-31623 fix for substitute state after template selection or edit',
  ticketUrl: 'https://timeclockplus.atlassian.net/browse/TCPMOB-1735', prNumber: 1085, prUrl: 'https://github.com/tcp-software/mobile-clock/pull/1085',
  people: [{ name: 'Foad Ahmed', email: 'fahmed@tcpsoftware.com' }, { name: 'Hamza Ashfaq', email: 'hashfaq@tcpsoftware.com' }, { name: 'No Email', email: null }],
};

test('card matches the user template: title, greeting, links, ready line, thanks, mentions', () => {
  const card = buildCard(args);
  assert.equal(card.type, 'message');
  const c = card.attachments[0];
  assert.equal(c.contentType, 'application/vnd.microsoft.card.adaptive');
  const body = c.content.body.map((b) => b.text);
  assert.deepEqual(body, [
    'TCPMOB-1735 SubSearch | Testing — Consume V7-31623 fix for substitute state after template selection or edit',
    'Hey Team!',
    'Ticket: [TCPMOB-1735](https://timeclockplus.atlassian.net/browse/TCPMOB-1735)\n\nPR: [PR#1085](https://github.com/tcp-software/mobile-clock/pull/1085)',
    'is ready for Dev-Review, Kindly take a peak at your convenience.',
    'Thanks',
    '<at>Foad Ahmed</at> <at>Hamza Ashfaq</at> No Email',
  ]);
  assert.equal(c.content.body[0].weight, 'Bolder');
  assert.ok(c.content.body.every((b) => b.wrap === true));
  assert.deepEqual(c.content.msteams.entities, [
    { type: 'mention', text: '<at>Foad Ahmed</at>', mentioned: { id: 'fahmed@tcpsoftware.com', name: 'Foad Ahmed' } },
    { type: 'mention', text: '<at>Hamza Ashfaq</at>', mentioned: { id: 'hashfaq@tcpsoftware.com', name: 'Hamza Ashfaq' } },
  ]);
});

test('optional note goes before Thanks; markdown in untrusted text is escaped', () => {
  const card = buildCard({ ...args, summary: 'Fix [link](http://evil) *bold*', note: 'Focus on the [retry](x) logic' });
  const body = card.attachments[0].content.body.map((b) => b.text);
  assert.equal(body[0], 'TCPMOB-1735 Fix \\[link\\](http://evil) \\*bold\\*');
  assert.equal(body[4], 'Focus on the \\[retry\\](x) logic');
  assert.equal(body[5], 'Thanks');
});

test('mention names are sanitized so they cannot break out of <at>', () => {
  assert.equal(mentionText('Evil</at><at>x'), '<at>Evilatatx</at>');
});

test('validWebhookUrl only allows Microsoft webhook hosts over https', () => {
  assert.equal(validWebhookUrl('https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x'), true);
  assert.equal(validWebhookUrl('https://default123.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc'), true);
  assert.equal(validWebhookUrl('https://tcp.webhook.office.com/webhookb2/abc'), true);
  assert.equal(validWebhookUrl('http://prod-12.westus.logic.azure.com/x'), false);
  assert.equal(validWebhookUrl('https://evil.com/?logic.azure.com'), false);
  assert.equal(validWebhookUrl('https://logic.azure.com.evil.com/x'), false);
  assert.equal(validWebhookUrl(''), false);
});

test('send posts JSON and treats 2xx as success, else throws with status', async () => {
  const calls = [];
  const ok = createTeams({ webhookUrl: 'https://x.logic.azure.com/w', fetch: async (url, opt) => { calls.push([url, opt]); return new Response('', { status: 202 }); } });
  await ok.send({ a: 1 });
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0][1].body), { a: 1 });
  const bad = createTeams({ webhookUrl: 'https://x.logic.azure.com/w', fetch: async () => new Response('nope', { status: 400 }) });
  await assert.rejects(bad.send({}), /400/);
  assert.equal(createTeams({ webhookUrl: 'https://evil.com/w' }).configured, false);
});

import { parsePeopleMap } from '../lib/teams.js';
test('TEAMS_PEOPLE maps GitHub logins to emails, ignoring junk', () => {
  assert.deepEqual(parsePeopleMap('achavez9=achavez@tcpsoftware.com, mittal-shah = mshah@tcpsoftware.com,bad,x=notanemail'),
    new Map([['achavez9', 'achavez@tcpsoftware.com'], ['mittal-shah', 'mshah@tcpsoftware.com']]));
  assert.equal(parsePeopleMap('').size, 0);
});

import { parseLogins } from '../lib/teams.js';
test('parseLogins splits comma lists', () => {
  assert.deepEqual(parseLogins(' mittal-shah, achavez9 ,,'), ['mittal-shah', 'achavez9']);
  assert.deepEqual(parseLogins(undefined), []);
});
