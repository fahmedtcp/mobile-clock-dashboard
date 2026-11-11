import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { GhError } from '../lib/gh.js';
import { request } from './helpers.js';

// ---- fakes ----
const jira = {
  configured: true,
  issues: {},
  commentsBy: {},
  calls: [],
  types: ['Bug', 'Story'],
  async myself() { return { accountId: 'me-acc', displayName: 'Me' }; },
  async search(jql) { this.calls.push(['search', jql]); return Object.values(this.issues); },
  async getIssue(key) { this.calls.push(['getIssue', key]); const i = this.issues[key]; if (!i) throw Object.assign(new Error('nope'), { status: 404 }); return i; },
  async comments(key) { return this.commentsBy[key] ?? []; },
  async transitions() { return [{ id: '181', to: { name: 'Open' } }, { id: '41', to: { name: 'QA Review' } }]; },
  async transition(key, id) { this.calls.push(['transition', key, id]); },
  async assign(key, acc) { this.calls.push(['assign', key, acc]); },
  async issueTypes() { return this.types; },
  async createIssue(fields) { this.calls.push(['createIssue', fields]); return { key: 'TCPMOB-999' }; },
  async link(type, a, b) { this.calls.push(['link', type, a, b]); },
};
const issue = (key, status, extra = {}) => ({ key, fields: { summary: 'Fix thing', status: { name: status }, assignee: null, fixVersions: [], issuetype: { name: 'Bug' }, ...extra } });

const gh = {
  calls: [],
  refExists: false,
  async run(args) {
    this.calls.push(args);
    if (args.join(' ').includes('git/ref/heads/develop')) return 'abc123\n';
    if (args.includes('POST') && args.join(' ').includes('git/refs')) { if (this.refExists) throw new GhError('Reference already exists', 'Reference already exists'); return '{}'; }
    if (args[0] === 'api' && args[1] === 'user') return 'me\n';
    return '';
  },
  async json(args) { this.calls.push(args); return []; },
};

const builds = [];
const tracker = { list: () => builds, async refresh() { return builds; }, async trigger() { return []; } };

let server, port;
before(async () => {
  server = createServer({ gh, tracker, behind: {}, jira });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());
beforeEach(() => { jira.calls = []; gh.calls = []; gh.refExists = false; jira.issues = {}; jira.commentsBy = {}; builds.length = 0; });

const req = (...a) => request(port)(...a);
const buildComment = { author: 'F', created: '2026-11-06T10:00:00Z', text: 'fahmedtcp pushed build number 4521 for MobileClock IOS to testflight' };

// ---- Send to QA ----
test('qa refuses when ticket is not Dev Review', async () => {
  jira.issues['TCPMOB-5'] = issue('TCPMOB-5', 'Open');
  jira.commentsBy['TCPMOB-5'] = [buildComment];
  const res = await req('POST', '/api/tickets/TCPMOB-5/qa');
  assert.equal(res.status, 409);
  assert.ok(!jira.calls.some((c) => c[0] === 'transition'));
});

test('qa refuses when there is no build comment', async () => {
  jira.issues['TCPMOB-5'] = issue('TCPMOB-5', 'Dev Review');
  const res = await req('POST', '/api/tickets/TCPMOB-5/qa');
  assert.equal(res.status, 409);
  assert.match(res.json().error, /build/i);
});

test('qa applies the transition whose target is QA Review, and never comments', async () => {
  jira.issues['TCPMOB-5'] = issue('TCPMOB-5', 'Dev Review');
  jira.commentsBy['TCPMOB-5'] = [buildComment];
  const res = await req('POST', '/api/tickets/tcpmob-5/qa');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, from: 'Dev Review', to: 'QA Review' });
  assert.deepEqual(jira.calls.filter((c) => c[0] === 'transition'), [['transition', 'TCPMOB-5', '41']]);
});

test('bad key in path → 400 and no Jira call', async () => {
  const res = await req('POST', '/api/tickets/HR-1/qa');
  assert.equal(res.status, 400);
  assert.equal(jira.calls.length, 0);
});

// ---- Start ----
test('start creates branch from develop sha, assigns if unassigned, never transitions', async () => {
  jira.issues['TCPMOB-5'] = issue('TCPMOB-5', 'To Do');
  const res = await req('POST', '/api/tickets/TCPMOB-5/start');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, branch: 'TCPMOB-5-fix-thing', assigned: true });
  const post = gh.calls.find((a) => a.includes('POST'));
  assert.deepEqual(post, ['api', '-X', 'POST', 'repos/tcp-software/mobile-clock/git/refs', '-f', 'ref=refs/heads/TCPMOB-5-fix-thing', '-f', 'sha=abc123']);
  assert.deepEqual(jira.calls.filter((c) => c[0] === 'assign'), [['assign', 'TCPMOB-5', 'me-acc']]);
  assert.ok(!jira.calls.some((c) => c[0] === 'transition'));
});

test('start does not reassign an assigned ticket', async () => {
  jira.issues['TCPMOB-5'] = issue('TCPMOB-5', 'Open', { assignee: { accountId: 'x', displayName: 'X' } });
  const res = await req('POST', '/api/tickets/TCPMOB-5/start');
  assert.equal(res.json().assigned, false);
  assert.ok(!jira.calls.some((c) => c[0] === 'assign'));
});

test('start refuses tickets past To Do/Open', async () => {
  jira.issues['TCPMOB-5'] = issue('TCPMOB-5', 'Dev Review');
  assert.equal((await req('POST', '/api/tickets/TCPMOB-5/start')).status, 409);
  assert.ok(!gh.calls.some((a) => a.includes('POST')));
});

test('start on existing branch still assigns, so a retry after a failed assign finishes the job', async () => {
  jira.issues['TCPMOB-5'] = issue('TCPMOB-5', 'To Do');
  gh.refExists = true;
  const res = await req('POST', '/api/tickets/TCPMOB-5/start');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, branch: 'TCPMOB-5-fix-thing', assigned: true, existed: true });
  assert.deepEqual(jira.calls.filter((c) => c[0] === 'assign'), [['assign', 'TCPMOB-5', 'me-acc']]);
});

// ---- Bug ----
const failedBuild = { id: '1-1', prNumber: 1042, label: 'iOS MobileKiosk', branch: 'TCPMOB-5-x', status: 'completed', conclusion: 'failure', url: 'u', reason: { step: 's', lines: ['offline'] } };

test('bug requires a finished failed build', async () => {
  builds.push({ ...failedBuild, status: 'in_progress', conclusion: null });
  assert.equal((await req('POST', '/api/builds/1-1/bug', { summary: 's', description: 'd' })).status, 409);
  assert.equal((await req('POST', '/api/builds/9-9/bug', { summary: 's', description: 'd' })).status, 404);
  assert.equal((await req('POST', '/api/builds/abc/bug', { summary: 's', description: 'd' })).status, 400);
});

test('bug validates summary', async () => {
  builds.push(failedBuild);
  assert.equal((await req('POST', '/api/builds/1-1/bug', { summary: '  ', description: 'd' })).status, 400);
  assert.equal((await req('POST', '/api/builds/1-1/bug', { summary: 'x'.repeat(256), description: 'd' })).status, 400);
});

test('bug refuses when Bug type is unavailable', async () => {
  builds.push(failedBuild);
  jira.types = ['Story'];
  const res = await req('POST', '/api/builds/1-1/bug', { summary: 's', description: 'd' });
  jira.types = ['Bug', 'Story'];
  assert.equal(res.status, 409);
  assert.match(res.json().error, /Story/);
});

test('bug creates a TCPMOB Bug with ADF description and links Relates to the PR ticket', async () => {
  builds.push(failedBuild);
  const res = await req('POST', '/api/builds/1-1/bug', { summary: ' CI build failure ', description: 'Line one\n```\noffline\n```' });
  assert.equal(res.status, 200);
  assert.equal(res.json().key, 'TCPMOB-999');
  const [, fields] = jira.calls.find((c) => c[0] === 'createIssue');
  assert.equal(fields.summary, 'CI build failure');
  assert.deepEqual(fields.project, { key: 'TCPMOB' });
  assert.deepEqual(fields.issuetype, { name: 'Bug' });
  assert.equal(fields.description.type, 'doc');
  assert.deepEqual(fields.description.content.map((n) => n.type), ['paragraph', 'codeBlock']);
  assert.deepEqual(jira.calls.find((c) => c[0] === 'link'), ['link', 'Relates', 'TCPMOB-999', 'TCPMOB-5']);
});

// ---- reads ----
test('tickets/mine and lookup return JSON; Jira unconfigured → 503', async () => {
  jira.issues['TCPMOB-5'] = issue('TCPMOB-5', 'Dev Review');
  jira.commentsBy['TCPMOB-5'] = [buildComment];
  const mine = await req('GET', '/api/tickets/mine');
  assert.equal(mine.status, 200);
  assert.equal(mine.json()[0].key, 'TCPMOB-5');
  const look = await req('GET', '/api/lookup/TCPMOB-5');
  assert.equal(look.status, 200);
  assert.deepEqual(look.json().jiraBuilds.map((b) => b.number), ['4521']);
  jira.configured = false;
  const off = await req('GET', '/api/tickets/mine');
  jira.configured = true;
  assert.equal(off.status, 503);
  assert.match(off.json().error, /token in Settings/);
});

test('bug: a failed link after creating the issue still returns 200 with the key, so no duplicate bug', async () => {
  builds.push(failedBuild);
  const origLink = jira.link;
  jira.link = async () => { throw Object.assign(new Error('Issue does not exist'), { status: 404 }); };
  const res = await req('POST', '/api/builds/1-1/bug', { summary: 's', description: 'd' });
  jira.link = origLink;
  assert.equal(res.status, 200);
  assert.equal(res.json().key, 'TCPMOB-999');
  assert.match(res.json().linkError, /does not exist/);
  assert.equal(jira.calls.filter((c) => c[0] === 'createIssue').length, 1);
});

test('alerts survive a Jira failure and still return GitHub-only alerts', async () => {
  const origSearch = jira.search;
  jira.search = async () => { throw Object.assign(new Error('Jira rejected the token'), { status: 401 }); };
  gh.json = async (args) => { gh.calls.push(args); return args[1] === 'list' && args.includes('open') ? [{ number: 77, title: 'no key', url: 'u', author: { login: 'me' }, headRefName: 'fix', baseRefName: 'develop', isDraft: false, reviewDecision: '', statusCheckRollup: [], createdAt: '2026-11-01T00:00:00Z', reviewRequests: [], latestReviews: [] }] : []; };
  gh.run = async (args) => (args[0] === 'api' && args[1] === 'user' ? 'me\n' : '');
  const res = await req('GET', '/api/alerts');
  jira.search = origSearch;
  assert.equal(res.status, 200);
  assert.deepEqual(res.json().map((a) => [a.kind, a.pr]), [['pr-no-ticket', 77]]);
});
