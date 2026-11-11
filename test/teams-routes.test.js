import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { createTeams } from '../lib/teams.js';
import { request } from './helpers.js';

const pr = { number: 1085, title: 'TCPMOB-1735-Subsearch-Consume', url: 'https://github.com/tcp-software/mobile-clock/pull/1085', author: { login: 'me' }, headRefName: 'TCPMOB-1735-consume', isDraft: false, state: 'OPEN', reviewRequests: [{ login: 'mittal-shah' }, { name: 'mobile-team' }] };
const gh = {
  pr: { ...pr },
  async json(args) {
    if (args[0] === 'pr' && args[1] === 'view') return this.pr;
    return [];
  },
  async run(args) {
    if (args[0] === 'api' && args[1] === 'user') return 'me\n';
    if (args[0] === 'api' && args[1] === 'users/hashfaqtcp') return 'Hamza Ashfaq\n';
    if (args[0] === 'api' && String(args[1]).startsWith('users/')) return '\n';
    return '';
  },
};
const jira = {
  configured: true,
  async myself() { return { accountId: 'me-acc', displayName: 'Foad Ahmed', emailAddress: 'fahmed@tcpsoftware.com' }; },
  async getIssue(key) { return { key, fields: { summary: 'SubSearch | Testing — Consume V7-31623 fix', status: { name: 'Dev Review' } } }; },
  async userSearch(q) { return q === 'Hamza Ashfaq' ? [{ displayName: 'Hamza Ashfaq', emailAddress: 'hashfaq@tcpsoftware.com' }, { displayName: 'Hamza Ashfaq Jr', emailAddress: 'x@y' }] : []; },
};
const sent = [];
const testSent = [];
const teams = createTeams({ webhookUrl: 'https://prod.westus.logic.azure.com/workflows/x', fetch: async (url, opt) => { sent.push(JSON.parse(opt.body)); return new Response('', { status: 202 }); } });
const teamsTest = createTeams({ webhookUrl: 'https://prod.westus.logic.azure.com/workflows/test', fetch: async (url, opt) => { testSent.push(JSON.parse(opt.body)); return new Response('', { status: 202 }); } });

let server, port;
before(async () => {
  server = createServer({ gh, tracker: { list: () => [] }, behind: {}, jira, teams, teamsTest, teamsPrefs: { always: ['hashfaqtcp'], never: ['mittal-shah'] } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());
beforeEach(() => { gh.pr = { ...pr }; });

const req = (...a) => request(port)(...a);

test('TEAMS_NEVER drops requested reviewers and TEAMS_ALWAYS adds people', async () => {
  const p = (await req('GET', '/api/prs/1085/review-request')).json();
  assert.deepEqual(p.people.map((x) => x.login), ['me', 'hashfaqtcp']);
  assert.equal(p.testConfigured, true);
});

test('test sends go to the test webhook and do not start the cooldown', async () => {
  gh.pr = { ...pr, number: 1086 };
  sent.length = 0; testSent.length = 0;
  assert.equal((await req('POST', '/api/prs/1086/review-request', { logins: ['me'], test: true })).status, 200);
  assert.equal((await req('POST', '/api/prs/1086/review-request', { logins: ['me'], test: true })).status, 200);
  assert.equal(testSent.length, 2);
  assert.equal(sent.length, 0);
  assert.equal((await req('POST', '/api/prs/1086/review-request', { logins: ['me'] })).status, 200);
  assert.equal(sent.length, 1);
});

test('preview shows title from the Jira summary and me + requested reviewers with emails', async () => {
  const p = (await req('GET', '/api/prs/1085/review-request')).json();
  assert.equal(p.configured, true);
  assert.equal(p.title, 'TCPMOB-1735 SubSearch | Testing — Consume V7-31623 fix');
  assert.equal(p.ticketUrl, 'https://timeclockplus.atlassian.net/browse/TCPMOB-1735');
  assert.deepEqual(p.people.map((x) => [x.login, x.name, x.email, x.selected]), [
    ['me', 'Foad Ahmed', 'fahmed@tcpsoftware.com', true],
    ['hashfaqtcp', 'Hamza Ashfaq', 'hashfaq@tcpsoftware.com', true],
  ]);
});

test('send posts the card with chosen mentions and a note, then a 30-minute cooldown', async () => {
  sent.length = 0;
  const res = await req('POST', '/api/prs/1085/review-request', { logins: ['me', 'hashfaqtcp'], note: 'Small one' });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  const body = sent[0].attachments[0].content.body.map((b) => b.text);
  assert.equal(body[0], 'TCPMOB-1735 SubSearch | Testing — Consume V7-31623 fix');
  assert.equal(body.at(-1), '<at>Foad Ahmed</at> <at>Hamza Ashfaq</at>');
  assert.ok(body.includes('Small one'));
  const again = await req('POST', '/api/prs/1085/review-request', { logins: ['me'] });
  assert.equal(again.status, 429);
  assert.equal(sent.length, 1);
});

test('refuses PRs that are not mine, drafts, or closed — and unknown people', async () => {
  gh.pr = { ...pr, number: 1, author: { login: 'someone' } };
  assert.equal((await req('POST', '/api/prs/1/review-request', { logins: [] })).status, 409);
  gh.pr = { ...pr, number: 2, isDraft: true };
  assert.equal((await req('POST', '/api/prs/2/review-request', { logins: [] })).status, 409);
  gh.pr = { ...pr, number: 3, state: 'MERGED' };
  assert.equal((await req('POST', '/api/prs/3/review-request', { logins: [] })).status, 409);
  gh.pr = { ...pr, number: 4 };
  assert.equal((await req('POST', '/api/prs/4/review-request', { logins: ['stranger'] })).status, 400);
});

test('note is limited to 500 characters', async () => {
  gh.pr = { ...pr, number: 5 };
  assert.equal((await req('POST', '/api/prs/5/review-request', { logins: [], note: 'x'.repeat(501) })).status, 400);
});
