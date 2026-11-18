import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCard, defaultReviewText, validText, validWebhookUrl, createTeams, mentionText, parsePeopleMap, parseLogins } from '../lib/teams.js';

const SUMMARY = 'SubSearch | Testing — Consume V7-31623 fix for substitute state after template selection or edit';
const TICKET_URL = 'https://timeclockplus.atlassian.net/browse/TCPMOB-1735';
const PR_URL = 'https://github.com/tcp-software/mobile-clock/pull/1085';
const args = {
  key: 'TCPMOB-1735',
  summary: SUMMARY,
  ticketUrl: TICKET_URL,
  prNumber: 1085,
  prUrl: PR_URL,
  people: [
    { name: 'Foad Ahmed', email: 'fahmed@tcpsoftware.com' },
    { name: 'Hamza Ashfaq', email: 'hashfaq@tcpsoftware.com' },
    { name: 'No Email', email: null },
  ],
};

test('card matches the user template: title, greeting, links, ready line, thanks, mentions', () => {
  const card = buildCard(args);
  assert.equal(card.type, 'message');
  const attachment = card.attachments[0];
  assert.equal(attachment.contentType, 'application/vnd.microsoft.card.adaptive');
  const body = attachment.content.body.map((b) => b.text);
  assert.deepEqual(body, [
    `TCPMOB-1735 ${SUMMARY}`,
    `Hey Team!\n\nTicket: [TCPMOB-1735](${TICKET_URL})\n\nPR: [PR#1085](${PR_URL})\n\nis ready for Dev-Review, Kindly take a peak at your convenience.\n\nThanks`,
    '<at>Foad Ahmed</at> <at>Hamza Ashfaq</at> No Email',
  ]);
  assert.equal(attachment.content.body[0].weight, 'Bolder');
  assert.ok(attachment.content.body.every((b) => b.wrap === true));
  assert.deepEqual(attachment.content.msteams.entities, [
    { type: 'mention', text: '<at>Foad Ahmed</at>', mentioned: { id: 'fahmed@tcpsoftware.com', name: 'Foad Ahmed' } },
    {
      type: 'mention',
      text: '<at>Hamza Ashfaq</at>',
      mentioned: { id: 'hashfaq@tcpsoftware.com', name: 'Hamza Ashfaq' },
    },
  ]);
});

test('defaultReviewText is the team wording, links included', () => {
  assert.equal(defaultReviewText({ key: 'TCPMOB-1735', ticketUrl: TICKET_URL, prNumber: 1085, prUrl: PR_URL }),
    `Hey Team!\n\nTicket: [TCPMOB-1735](${TICKET_URL})\n\nPR: [PR#1085](${PR_URL})\n\nis ready for Dev-Review, Kindly take a peak at your convenience.\n\nThanks`);
});

test('buildCard uses given text unescaped and keeps mentions after it', () => {
  const card = buildCard({ ...args, text: '**Hi** [x](https://e.x)' });
  const { body, msteams } = card.attachments[0].content;
  assert.equal(body.length, 3);
  assert.equal(body[1].text, '**Hi** [x](https://e.x)');
  assert.equal(body[2].text, '<at>Foad Ahmed</at> <at>Hamza Ashfaq</at> No Email');
  assert.equal(msteams.entities.length, 2);
});

test('title stays escaped even with custom text', () => {
  const card = buildCard({ ...args, summary: 'Fix [link](http://evil) a*b', text: 'Hi' });
  assert.equal(card.attachments[0].content.body[0].text, 'TCPMOB-1735 Fix \\[link\\](http://evil) a\\*b');
});

test('validText: missing gives the fallback; empty or over 2,000 characters is a 400', () => {
  assert.equal(validText(undefined, 'def'), 'def');
  assert.equal(validText('  hi  ', 'def'), 'hi');
  assert.throws(() => validText('   ', 'def'), (e) => e.status === 400 && /can't be empty/.test(e.message));
  assert.throws(() => validText('x'.repeat(2001), 'def'), (e) => e.status === 400 && /2,000/.test(e.message));
  assert.equal(validText('x'.repeat(2000), 'def').length, 2000);
  assert.throws(() => validText(5, 'def'), (e) => e.status === 400);
});

test('mention names are sanitized so they cannot break out of <at>', () => {
  assert.equal(mentionText('Evil</at><at>x'), '<at>Evilatatx</at>');
});

test('validWebhookUrl only allows Microsoft webhook hosts over https', () => {
  const logicApps = 'https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x';
  const powerPlatform = 'https://default123.environment.api.powerplatform.com'
    + '/powerautomate/automations/direct/workflows/abc';
  assert.equal(validWebhookUrl(logicApps), true);
  assert.equal(validWebhookUrl(powerPlatform), true);
  assert.equal(validWebhookUrl('https://tcp.webhook.office.com/webhookb2/abc'), true);
  assert.equal(validWebhookUrl('http://prod-12.westus.logic.azure.com/x'), false);
  assert.equal(validWebhookUrl('https://evil.com/?logic.azure.com'), false);
  assert.equal(validWebhookUrl('https://logic.azure.com.evil.com/x'), false);
  assert.equal(validWebhookUrl(''), false);
});

test('send posts JSON and treats 2xx as success, else throws with status', async () => {
  const calls = [];
  const ok = createTeams({
    webhookUrl: 'https://x.logic.azure.com/w',
    fetch: async (url, options) => { calls.push([url, options]); return new Response('', { status: 202 }); },
  });
  await ok.send({ a: 1 });
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0][1].body), { a: 1 });
  const rejecting = async () => new Response('nope', { status: 400 });
  const bad = createTeams({ webhookUrl: 'https://x.logic.azure.com/w', fetch: rejecting });
  await assert.rejects(bad.send({}), /400/);
  assert.equal(createTeams({ webhookUrl: 'https://evil.com/w' }).configured, false);
});

test('TEAMS_PEOPLE maps GitHub logins to emails, ignoring junk', () => {
  const raw = 'achavez9=achavez@tcpsoftware.com, mittal-shah = mshah@tcpsoftware.com,bad,x=notanemail';
  assert.deepEqual(parsePeopleMap(raw),
    new Map([['achavez9', 'achavez@tcpsoftware.com'], ['mittal-shah', 'mshah@tcpsoftware.com']]));
  assert.equal(parsePeopleMap('').size, 0);
});

test('parseLogins splits comma lists', () => {
  assert.deepEqual(parseLogins(' mittal-shah, achavez9 ,,'), ['mittal-shah', 'achavez9']);
  assert.deepEqual(parseLogins(undefined), []);
});
