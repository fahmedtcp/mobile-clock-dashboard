import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJira, JiraError } from '../lib/jira.js';

const cfg = { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', token: 't' };
const json = (body, status = 200, headers = {}) => new Response(status === 204 ? null : (typeof body === 'string' ? body : JSON.stringify(body)), { status, headers });
function recorder(responses) {
  const calls = [];
  const fetch = async (url, opt = {}) => { calls.push({ url, method: opt.method ?? 'GET', body: opt.body ? JSON.parse(opt.body) : undefined, headers: opt.headers }); return responses.shift() ?? json({}); };
  return { calls, fetch };
}

test('unconfigured client reports configured=false and every call throws 503', async () => {
  const j = createJira({ baseUrl: '', email: '', token: '' });
  assert.equal(j.configured, false);
  await assert.rejects(j.myself(), (e) => e instanceof JiraError && e.status === 503);
});

test('sends basic auth and JSON to the site URL', async () => {
  const r = recorder([json({ displayName: 'F' })]);
  const j = createJira({ ...cfg, fetch: r.fetch });
  assert.equal((await j.myself()).displayName, 'F');
  assert.equal(r.calls[0].url, 'https://x.atlassian.net/rest/api/3/myself');
  assert.equal(r.calls[0].headers.Authorization, 'Basic ' + Buffer.from('a@b.c:t').toString('base64'));
  assert.equal(r.calls[0].headers.Accept, 'application/json');
});

test('trailing slash in base URL is tolerated', async () => {
  const r = recorder([json({})]);
  await createJira({ ...cfg, baseUrl: 'https://x.atlassian.net/', fetch: r.fetch }).myself();
  assert.equal(r.calls[0].url, 'https://x.atlassian.net/rest/api/3/myself');
});

test('search posts to /rest/api/3/search/jql and follows nextPageToken', async () => {
  const r = recorder([json({ issues: [{ key: 'A-1' }, { key: 'A-2' }], nextPageToken: 'p2' }), json({ issues: [{ key: 'A-3' }] })]);
  const issues = await createJira({ ...cfg, fetch: r.fetch }).search('project = A', ['status'], 500);
  assert.deepEqual(issues.map((i) => i.key), ['A-1', 'A-2', 'A-3']);
  assert.equal(r.calls[0].url, 'https://x.atlassian.net/rest/api/3/search/jql');
  assert.equal(r.calls[0].method, 'POST');
  assert.deepEqual(r.calls[0].body, { jql: 'project = A', fields: ['status'], maxResults: 100 });
  assert.equal(r.calls[1].body.nextPageToken, 'p2');
});

test('search stops at max', async () => {
  const r = recorder([json({ issues: [{ key: 'A-1' }, { key: 'A-2' }], nextPageToken: 'p2' })]);
  const issues = await createJira({ ...cfg, fetch: r.fetch }).search('x', [], 2);
  assert.equal(issues.length, 2);
  assert.equal(r.calls.length, 1);
});

test('429 retries once after Retry-After (capped 10s) then succeeds', async () => {
  const waits = [];
  const r = recorder([json('', 429, { 'Retry-After': '30' }), json({ ok: 1 })]);
  const j = createJira({ ...cfg, fetch: r.fetch, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await j.myself(), { ok: 1 });
  assert.deepEqual(waits, [10000]);
});

test('second 429 becomes JiraError 429', async () => {
  const r = recorder([json('', 429, { 'Retry-After': '1' }), json('', 429)]);
  const j = createJira({ ...cfg, fetch: r.fetch, sleep: async () => {} });
  await assert.rejects(j.myself(), (e) => e instanceof JiraError && e.status === 429);
});

test('error bodies become JiraError with Jira message', async () => {
  const r = recorder([json({ errorMessages: ['Issue does not exist'], errors: { summary: 'too long' } }, 404)]);
  await assert.rejects(createJira({ ...cfg, fetch: r.fetch }).getIssue('A-1', ['status']),
    (e) => e instanceof JiraError && e.status === 404 && /Issue does not exist/.test(e.message) && /too long/.test(e.message));
});

test('network failure becomes JiraError 502', async () => {
  const j = createJira({ ...cfg, fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(j.myself(), (e) => e instanceof JiraError && e.status === 502);
});

test('comments flatten ADF to plain text', async () => {
  const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'pushed build number ' }, { type: 'text', text: '42' }] }] };
  const r = recorder([json({ comments: [{ author: { displayName: 'F' }, created: 'c', body: adf }] })]);
  const [c] = await createJira({ ...cfg, fetch: r.fetch }).comments('A-1');
  assert.deepEqual(c, { author: 'F', authorId: null, created: 'c', text: 'pushed build number 42' });
  assert.equal(r.calls[0].url, 'https://x.atlassian.net/rest/api/3/issue/A-1/comment?maxResults=100&orderBy=-created');
});

test('transition/assign/createIssue/link/issueTypes/versions hit the documented endpoints', async () => {
  const r = recorder([json({ transitions: [{ id: '41' }] }), json('', 204), json('', 204), json({ key: 'A-9' }, 201), json('', 201),
    json({ issueTypes: [{ name: 'Bug' }, { name: 'Story' }] }), json([{ name: 'Mobile 46' }])]);
  const j = createJira({ ...cfg, fetch: r.fetch });
  assert.deepEqual(await j.transitions('A-1'), [{ id: '41' }]);
  await j.transition('A-1', '41');
  await j.assign('A-1', 'acc');
  assert.deepEqual(await j.createIssue({ summary: 's' }), { key: 'A-9' });
  await j.link('Relates', 'A-9', 'A-1');
  assert.deepEqual(await j.issueTypes('TCPMOB'), ['Bug', 'Story']);
  assert.deepEqual(await j.versions('TCPMOB'), [{ name: 'Mobile 46' }]);
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.url.replace('https://x.atlassian.net', '')}`), [
    'GET /rest/api/3/issue/A-1/transitions',
    'POST /rest/api/3/issue/A-1/transitions',
    'PUT /rest/api/3/issue/A-1/assignee',
    'POST /rest/api/3/issue',
    'POST /rest/api/3/issueLink',
    'GET /rest/api/3/issue/createmeta/TCPMOB/issuetypes',
    'GET /rest/api/3/project/TCPMOB/versions',
  ]);
  assert.deepEqual(r.calls[1].body, { transition: { id: '41' } });
  assert.deepEqual(r.calls[2].body, { accountId: 'acc' });
  assert.deepEqual(r.calls[3].body, { fields: { summary: 's' } });
  assert.deepEqual(r.calls[4].body, { type: { name: 'Relates' }, inwardIssue: { key: 'A-9' }, outwardIssue: { key: 'A-1' } });
});

test('keys are URL-encoded in paths', async () => {
  const r = recorder([json({})]);
  await createJira({ ...cfg, fetch: r.fetch }).getIssue('A-1/../x', ['status']);
  assert.ok(r.calls[0].url.includes('/issue/A-1%2F..%2Fx?'));
});

test('401 with an empty body explains how to fix the token', async () => {
  const r = recorder([json('', 401)]);
  await assert.rejects(createJira({ ...cfg, fetch: r.fetch }).myself(),
    (e) => e instanceof JiraError && e.status === 401 && /Jira email and token in Settings/.test(e.message));
});

test('changelog pages until isLast', async () => {
  const r = recorder([json({ values: [{ id: 1 }, { id: 2 }], isLast: false }), json({ values: [{ id: 3 }], isLast: true })]);
  const h = await createJira({ ...cfg, fetch: r.fetch }).changelog('TCPMOB-1');
  assert.deepEqual(h.map((x) => x.id), [1, 2, 3]);
  assert.match(r.calls[0].url, /\/rest\/api\/3\/issue\/TCPMOB-1\/changelog\?startAt=0&maxResults=100$/);
  assert.match(r.calls[1].url, /startAt=2/);
});

test('comments carry the author account id', async () => {
  const r = recorder([json({ comments: [{ author: { displayName: 'F', accountId: 'acc1' }, created: 'c', body: 'hi' }] })]);
  const [c] = await createJira({ ...cfg, fetch: r.fetch }).comments('A-1');
  assert.equal(c.authorId, 'acc1');
});

test('userSearch queries by name', async () => {
  const r = recorder([json([{ accountId: 'a', displayName: 'Hamza Ashfaq', emailAddress: 'hashfaq@tcpsoftware.com' }])]);
  const users = await createJira({ ...cfg, fetch: r.fetch }).userSearch('Hamza Ashfaq');
  assert.equal(users[0].emailAddress, 'hashfaq@tcpsoftware.com');
  assert.equal(r.calls[0].url, 'https://x.atlassian.net/rest/api/3/user/search?query=Hamza%20Ashfaq&maxResults=10');
});
