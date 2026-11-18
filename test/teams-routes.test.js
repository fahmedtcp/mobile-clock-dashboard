import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { createTeams } from '../lib/teams.js';
import { request } from './helpers.js';

const pr = {
  number: 1085,
  title: 'TCPMOB-1735-Subsearch-Consume',
  url: 'https://github.com/tcp-software/mobile-clock/pull/1085',
  author: { login: 'me' },
  headRefName: 'TCPMOB-1735-consume',
  isDraft: false,
  state: 'OPEN',
  reviewRequests: [{ login: 'mittal-shah' }, { name: 'mobile-team' }],
};
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
  async getIssue(key) {
    return { key, fields: { summary: 'SubSearch | Testing — Consume V7-31623 fix', status: { name: 'Dev Review' } } };
  },
  async userSearch(query) {
    if (query !== 'Hamza Ashfaq') return [];
    return [
      { displayName: 'Hamza Ashfaq', emailAddress: 'hashfaq@tcpsoftware.com' },
      { displayName: 'Hamza Ashfaq Jr', emailAddress: 'x@y' },
    ];
  },
};

// A Teams client whose webhook records each posted card into `into`.
const recordingTeams = (webhookUrl, into) => createTeams({
  webhookUrl,
  fetch: async (url, options) => { into.push(JSON.parse(options.body)); return new Response('', { status: 202 }); },
});
const sent = [];
const testSent = [];
const teams = recordingTeams('https://prod.westus.logic.azure.com/workflows/x', sent);
const teamsTest = recordingTeams('https://prod.westus.logic.azure.com/workflows/test', testSent);

let server, port;
before(async () => {
  const teamsPrefs = { always: ['hashfaqtcp'], never: ['mittal-shah'] };
  server = createServer({ gh, tracker: { list: () => [] }, behind: {}, jira, teams, teamsTest, teamsPrefs });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => server.close());
beforeEach(() => { gh.pr = { ...pr }; });

const req = (...a) => request(port)(...a);

test('TEAMS_NEVER drops requested reviewers and TEAMS_ALWAYS adds people', async () => {
  const preview = (await req('GET', '/api/prs/1085/review-request')).json();
  assert.deepEqual(preview.people.map((person) => person.login), ['me', 'hashfaqtcp']);
  assert.equal(preview.testConfigured, true);
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
  const preview = (await req('GET', '/api/prs/1085/review-request')).json();
  assert.equal(preview.configured, true);
  assert.equal(preview.title, 'TCPMOB-1735 SubSearch | Testing — Consume V7-31623 fix');
  assert.equal(preview.ticketUrl, 'https://timeclockplus.atlassian.net/browse/TCPMOB-1735');
  assert.deepEqual(preview.people.map((person) => [person.login, person.name, person.email, person.selected]), [
    ['me', 'Foad Ahmed', 'fahmed@tcpsoftware.com', true],
    ['hashfaqtcp', 'Hamza Ashfaq', 'hashfaq@tcpsoftware.com', true],
  ]);
});

test('send posts the card with chosen mentions and edited text, then a 30-minute cooldown', async () => {
  sent.length = 0;
  const res = await req('POST', '/api/prs/1085/review-request', { logins: ['me', 'hashfaqtcp'], text: 'Small one' });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  const body = sent[0].attachments[0].content.body.map((b) => b.text);
  assert.equal(body[0], 'TCPMOB-1735 SubSearch | Testing — Consume V7-31623 fix');
  assert.equal(body.at(-1), '<at>Foad Ahmed</at> <at>Hamza Ashfaq</at>');
  assert.equal(body[1], 'Small one');
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

test('send with empty text or over 2,000 characters is 400', async () => {
  gh.pr = { ...pr, number: 5 };
  assert.equal((await req('POST', '/api/prs/5/review-request', { logins: [], text: '  ' })).status, 400);
  assert.equal((await req('POST', '/api/prs/5/review-request', { logins: [], text: 'x'.repeat(2001) })).status, 400);
});

test('preview returns defaultText; send without text uses it', async () => {
  gh.pr = { ...pr, number: 6 };
  const preview = (await req('GET', '/api/prs/6/review-request')).json();
  assert.match(preview.defaultText, /^Hey Team!\n\nTicket: \[TCPMOB-1735\]/);
  sent.length = 0;
  assert.equal((await req('POST', '/api/prs/6/review-request', { logins: [] })).status, 200);
  assert.equal(sent[0].attachments[0].content.body[1].text, preview.defaultText);
});

test('within the cooldown a second send is 429; with force it sends and restarts the timer', async () => {
  gh.pr = { ...pr, number: 7 };
  sent.length = 0;
  assert.equal((await req('POST', '/api/prs/7/review-request', { logins: [] })).status, 200);
  assert.equal((await req('POST', '/api/prs/7/review-request', { logins: [] })).status, 429);
  assert.equal((await req('POST', '/api/prs/7/review-request', { logins: [], force: true })).status, 200);
  assert.equal(sent.length, 2);
  const preview = (await req('GET', '/api/prs/7/review-request')).json();
  assert.ok(preview.cooldownUntil > Date.now() + 29 * 60000);
  assert.equal((await req('POST', '/api/prs/7/review-request', { logins: [] })).status, 429);
});

test('a person added just for this message is looked up, mentioned, and only for this send', async () => {
  const person = (await req('GET', '/api/people/hashfaqtcp')).json();
  assert.deepEqual(person, { login: 'hashfaqtcp', name: 'Hamza Ashfaq', email: 'hashfaq@tcpsoftware.com' });
  assert.equal((await req('GET', '/api/people/bad%20login!')).status, 400);
  gh.pr = { ...pr, number: 6, reviewRequests: [] };
  testSent.length = 0;
  const res = await req('POST', '/api/prs/6/review-request', { logins: ['me', 'raja-tcp'], added: ['raja-tcp'], test: true });
  assert.equal(res.status, 200);
  assert.equal(testSent[0].attachments[0].content.body.at(-1).text, '<at>Foad Ahmed</at> raja-tcp');
  assert.equal((await req('POST', '/api/prs/7/review-request', { logins: ['raja-tcp'], added: ['bad login!'], test: true })).status, 400);
  assert.equal((await req('POST', '/api/prs/7/review-request', { logins: [], added: Array.from({ length: 6 }, (_, i) => `p${i}`), test: true })).status, 400);
  const preview = (await req('GET', '/api/prs/6/review-request')).json();
  assert.ok(!preview.people.some((p) => p.login === 'raja-tcp'), 'nothing is remembered');
});
