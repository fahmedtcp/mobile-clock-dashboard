import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRead, jqSelect } from '../lib/github-direct.js';

const R = 'tcp-software/mobile-clock';
const PR_FIELDS = 'number,title,url,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,createdAt,reviewRequests,latestReviews';
const RUN_FIELDS = 'databaseId,workflowName,headBranch,event,status,conclusion,createdAt,updatedAt,url,displayTitle';

test('pr list and view commands from the call sites', () => {
  assert.deepEqual(parseRead(['pr', 'list', '-R', R, '--state', 'open', '-L', '100', '--json', PR_FIELDS]),
    { kind: 'prList', state: 'open', base: null, search: null, limit: 100, fields: PR_FIELDS.split(',') });
  assert.deepEqual(parseRead(['pr', 'list', '-R', R, '--state', 'merged', '--base', 'develop', '--search', 'merged:>=2026-11-02', '-L', '500',
    '--json', 'number,title,url,headRefName,baseRefName,mergedAt,mergeCommit,author']),
  { kind: 'prList', state: 'merged', base: 'develop', search: 'merged:>=2026-11-02', limit: 500,
    fields: ['number', 'title', 'url', 'headRefName', 'baseRefName', 'mergedAt', 'mergeCommit', 'author'] });
  assert.equal(parseRead(['pr', 'list', '-R', R, '--state', 'all', '--search', 'TCPMOB-1', '-L', '20', '--json', 'number,url,state']).state, 'all');
  assert.deepEqual(parseRead(['pr', 'view', '1094', '-R', R, '--json', 'number,state,headRefName,baseRefName,reviewDecision,isCrossRepository']),
    { kind: 'prView', number: 1094, fields: ['number', 'state', 'headRefName', 'baseRefName', 'reviewDecision', 'isCrossRepository'] });
});

test('run list and view commands, with flags in any order', () => {
  assert.deepEqual(parseRead(['run', 'list', '-R', R, '-L', '50', '-w', 'run-tests.yml', '-b', 'develop', '--json', RUN_FIELDS]),
    { kind: 'runList', workflow: 'run-tests.yml', branch: 'develop', event: null, status: null, user: null, limit: 50, fields: RUN_FIELDS.split(',') });
  const health = parseRead(['run', 'list', '-R', R, '-w', 'x.yml', '-L', '30', '--json', 'databaseId,conclusion', '-b', 'develop']);
  assert.equal(health.branch, 'develop');
  assert.deepEqual(parseRead(['run', 'list', '-R', R, '-e', 'workflow_dispatch', '-s', 'success', '-L', '100', '--json', 'databaseId,url']),
    { kind: 'runList', workflow: null, branch: null, event: 'workflow_dispatch', status: 'success', user: null, limit: 100, fields: ['databaseId', 'url'] });
  assert.deepEqual(parseRead(['run', 'view', '42', '-R', R, '--json', 'jobs']), { kind: 'runView', id: 42, fields: ['jobs'] });
});

test('api reads: REST with simple jq, pagination, GET params, and GraphQL', () => {
  assert.deepEqual(parseRead(['api', 'user', '--jq', '.login']), { kind: 'rest', path: 'user', query: {}, paginate: false, jq: '.login' });
  assert.deepEqual(parseRead(['api', '--paginate', `repos/${R}/branches?per_page=100`, '--jq', '.[].name']),
    { kind: 'rest', path: `repos/${R}/branches?per_page=100`, query: {}, paginate: true, jq: '.[].name' });
  assert.deepEqual(parseRead(['api', `repos/${R}/compare/develop...x`]), { kind: 'rest', path: `repos/${R}/compare/develop...x`, query: {}, paginate: false, jq: null });
  assert.deepEqual(parseRead(['api', '-X', 'GET', 'search/issues', '-f', 'q=is:pr']).query, { q: 'is:pr' });
  assert.deepEqual(parseRead(['api', 'graphql', '-f', 'query=query($n:Int){x}', '-F', 'owner=tcp', '-F', 'n=5']),
    { kind: 'graphql', query: 'query($n:Int){x}', variables: { owner: 'tcp', n: 5 } });
});

test('writes and anything unusual go to the CLI (null)', () => {
  for (const args of [
    ['pr', 'create', '-R', R, '--title', 't'],
    ['workflow', 'run', 'x.yml', '-R', R],
    ['run', 'rerun', '1', '--failed', '-R', R],
    ['run', 'view', '-R', R, '--job', '7', '--log-failed'],
    ['run', 'download', '1', '-R', R, '-n', 'a', '-D', '/tmp/x'],
    ['api', '-X', 'PUT', `repos/${R}/pulls/1/update-branch`],
    ['api', '-X', 'POST', `repos/${R}/git/refs`, '-f', 'ref=x'],
    ['api', '--paginate', '--slurp', `repos/${R}/issues/1/comments`],
    ['api', `repos/${R}/pulls/1`, '--jq', '[.head.ref, .title] | @tsv'],
    ['pr', 'list', '-R', R, '--json', 'number,labels'],
    ['pr', 'list', '--ref', 'x'],
    [],
  ]) assert.equal(parseRead(args), null, args.join(' '));
});

test('unknown json fields fall back', () => {
  assert.equal(parseRead(['run', 'list', '-R', R, '--json', 'databaseId,jobs']), null);
});

test('jqSelect prints like gh --jq', () => {
  assert.equal(jqSelect({ login: 'x' }, '.login'), 'x');
  assert.equal(jqSelect([{ name: 'a' }, { name: 'b' }], '.[].name'), 'a\nb');
  assert.equal(jqSelect({ name: null }, '.name // ""'), '');
  assert.equal(jqSelect({ name: 'Hamza' }, '.name // ""'), 'Hamza');
  assert.equal(jqSelect({ behind_by: 3 }, '.behind_by'), '3');
  assert.equal(jqSelect({ object: { sha: 'abc' } }, '.object.sha'), 'abc');
  assert.equal(jqSelect({ merge_base_commit: { commit: { committer: { date: 'd' } } } }, '.merge_base_commit.commit.committer.date'), 'd');
});

// ---------- Task 2: mapping ----------
import { prQuery, prNodes, mapPr, runRequest, mapRun, mapJobs } from '../lib/github-direct.js';

const node = {
  number: 1094, title: 'TCPMOB-1764 x', url: 'u', isDraft: false, headRefName: 'h', baseRefName: 'develop', createdAt: 'c',
  state: 'OPEN', mergedAt: null, isCrossRepository: false, reviewDecision: null, author: { login: 'fahmedtcp' }, mergeCommit: null,
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'hashfaqtcp' } }, { requestedReviewer: { __typename: 'Team', name: 'Mobile', slug: 'mobile' } }] },
  latestReviews: { nodes: [{ author: { login: 'hashfaqtcp' }, state: 'APPROVED', submittedAt: 's', body: 'ok' }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: 'CheckRun', name: 'eslint', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'unit', status: 'IN_PROGRESS', conclusion: null },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
  ] } } } }] },
};

test('a PR node maps to exactly the requested gh fields', () => {
  const read = { kind: 'prList', fields: PR_FIELDS.split(',').concat(['state', 'mergedAt', 'mergeCommit', 'isCrossRepository']) };
  assert.deepEqual(mapPr(read, node), {
    number: 1094, title: 'TCPMOB-1764 x', url: 'u', author: { login: 'fahmedtcp' }, headRefName: 'h', baseRefName: 'develop',
    isDraft: false, reviewDecision: '', createdAt: 'c', state: 'OPEN', mergedAt: null, mergeCommit: null, isCrossRepository: false,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'eslint', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'unit', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
    ],
    reviewRequests: [{ __typename: 'User', login: 'hashfaqtcp' }, { __typename: 'Team', name: 'Mobile', slug: 'mobile' }],
    latestReviews: [{ author: { login: 'hashfaqtcp' }, state: 'APPROVED', submittedAt: 's', body: 'ok' }],
  });
  assert.deepEqual(Object.keys(mapPr({ fields: ['number', 'url'] }, node)), ['number', 'url']);
  assert.deepEqual(mapPr({ fields: ['statusCheckRollup', 'mergeCommit'] }, { ...node, commits: { nodes: [] }, mergeCommit: { oid: 'abc' } }),
    { statusCheckRollup: [], mergeCommit: { oid: 'abc' } });
});

test('PR queries: open list, search, and single view', () => {
  const open = prQuery({ kind: 'prList', state: 'open', base: null, search: null, limit: 100, fields: ['number', 'author'] }, null);
  assert.match(open.query, /pullRequests\(states: OPEN, first: \$first, after: \$after, orderBy: \{field: CREATED_AT, direction: DESC\}\)/);
  assert.match(open.query, /author \{ login \}/);
  assert.equal(open.variables.first, 100);
  const merged = prQuery({ kind: 'prList', state: 'merged', base: 'develop', search: 'merged:>=2026-11-02', limit: 500, fields: ['number'] }, 'CUR');
  assert.equal(merged.variables.q, 'repo:tcp-software/mobile-clock is:pr is:merged base:develop merged:>=2026-11-02 sort:created-desc');
  assert.equal(merged.variables.first, 100);
  assert.equal(merged.variables.after, 'CUR');
  const all = prQuery({ kind: 'prList', state: 'all', base: null, search: 'TCPMOB-1764', limit: 20, fields: ['number'] }, null);
  assert.equal(all.variables.q, 'repo:tcp-software/mobile-clock is:pr TCPMOB-1764 sort:created-desc');
  const view = prQuery({ kind: 'prView', number: 7, fields: ['number'] }, null);
  assert.match(view.query, /pullRequest\(number: \$number\)/);
  assert.equal(view.variables.number, 7);
  assert.deepEqual(prNodes({ kind: 'prList', state: 'all' }, { search: { nodes: [{ number: 1 }, {}], pageInfo: { hasNextPage: false } } }),
    { nodes: [{ number: 1 }], pageInfo: { hasNextPage: false } }, 'non-PR search hits are dropped');
});

test('runs and jobs map to gh fields, nulls as empty strings', () => {
  const read = { kind: 'runList', workflow: 'run-tests.yml', branch: 'develop', event: 'workflow_dispatch', status: 'success', limit: 30,
    fields: ['databaseId', 'workflowName', 'headBranch', 'headSha', 'event', 'status', 'conclusion', 'createdAt', 'updatedAt', 'url', 'displayTitle', 'attempt'] };
  assert.deepEqual(runRequest(read), { path: 'repos/tcp-software/mobile-clock/actions/workflows/run-tests.yml/runs',
    query: { per_page: '30', branch: 'develop', event: 'workflow_dispatch', status: 'success' } });
  assert.deepEqual(runRequest({ ...read, workflow: null, branch: null, event: null, status: null, limit: 150 }),
    { path: 'repos/tcp-software/mobile-clock/actions/runs', query: { per_page: '100' } });
  const run = { id: 9, name: 'Run Tests', head_branch: 'develop', head_sha: 'abc', event: 'push', status: 'in_progress', conclusion: null,
    created_at: 'c', updated_at: 'u', html_url: 'h', display_title: 'd', run_attempt: 2 };
  assert.deepEqual(mapRun(read, run), { databaseId: 9, workflowName: 'Run Tests', headBranch: 'develop', headSha: 'abc', event: 'push',
    status: 'in_progress', conclusion: '', createdAt: 'c', updatedAt: 'u', url: 'h', displayTitle: 'd', attempt: 2 });
  assert.deepEqual(mapJobs({ jobs: [{ id: 5, name: 'build', status: 'completed', conclusion: 'failure', steps: [{ name: 'gradle', status: 'completed', conclusion: null, number: 3 }] }] }),
    { jobs: [{ databaseId: 5, name: 'build', status: 'completed', conclusion: 'failure', steps: [{ name: 'gradle', status: 'completed', conclusion: '', number: 3 }] }] });
});

// ---------- Task 3: direct client ----------
import { createDirect, NetworkError } from '../lib/github-direct.js';
import { GhError } from '../lib/gh.js';

const TOKEN = 'ghp_secret123';
const respond = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function fakeGitHub(handler) {
  const calls = [];
  const fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return handler(String(url), opts, calls.length); };
  return { fetch, calls };
}

test('requests go to api.github.com with the token and gh-like output', async () => {
  const { fetch, calls } = fakeGitHub(() => respond(200, { login: 'fahmedtcp' }));
  const direct = createDirect({ fetch, readToken: async () => TOKEN });
  const out = await direct.read(parseRead(['api', 'user', '--jq', '.login']));
  assert.equal(out.text, 'fahmedtcp\n');
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].opts.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].opts.headers['User-Agent'], 'mobile-clock-dashboard');
});

test('paginate follows Link next and joins the pages', async () => {
  const { fetch } = fakeGitHub((url) => (url.includes('page=2')
    ? respond(200, [{ name: 'c' }])
    : respond(200, [{ name: 'a' }, { name: 'b' }], { link: '<https://api.github.com/repos/x/branches?per_page=100&page=2>; rel="next"' })));
  const direct = createDirect({ fetch, readToken: async () => TOKEN });
  assert.equal((await direct.read(parseRead(['api', '--paginate', 'repos/x/branches?per_page=100', '--jq', '.[].name']))).text, 'a\nb\nc\n');
});

test('pr list pages until the limit, runs and jobs map', async () => {
  const pr = (n) => ({ number: n, author: { login: 'me' } });
  const { fetch } = fakeGitHub((url, opts) => {
    if (url.endsWith('/graphql')) {
      const { variables } = JSON.parse(opts.body);
      return respond(200, { data: { search: { nodes: variables.after ? [pr(3)] : [pr(1), pr(2)], pageInfo: { hasNextPage: !variables.after, endCursor: 'C' } } } });
    }
    if (url.includes('/jobs')) return respond(200, { jobs: [{ id: 1, name: 'b', status: 'completed', conclusion: null, steps: [] }] });
    return respond(200, { workflow_runs: [{ id: 9, conclusion: null, html_url: 'h' }] });
  });
  const direct = createDirect({ fetch, readToken: async () => TOKEN });
  const prs = await direct.read(parseRead(['pr', 'list', '-R', R, '--state', 'all', '--search', 'K', '-L', '3', '--json', 'number,author']));
  assert.deepEqual(prs.json.map((p) => p.number), [1, 2, 3]);
  const runs = await direct.read(parseRead(['run', 'list', '-R', R, '-L', '1', '--json', 'databaseId,conclusion,url']));
  assert.deepEqual(runs.json, [{ databaseId: 9, conclusion: '', url: 'h' }]);
  const jobs = await direct.read(parseRead(['run', 'view', '5', '-R', R, '--json', 'jobs']));
  assert.equal(jobs.json.jobs[0].conclusion, '');
});

test('a 401 re-reads the token once, then says to sign in, never showing the token', async () => {
  let reads = 0;
  const { fetch, calls } = fakeGitHub(() => respond(401, { message: `Bad credentials ${TOKEN}` }));
  const direct = createDirect({ fetch, readToken: async () => { reads++; return TOKEN; } });
  await assert.rejects(direct.read(parseRead(['api', 'user'])), (e) => e instanceof GhError
    && e.message === "gh isn't signed in. Run gh auth login." && !e.message.includes(TOKEN));
  assert.equal(reads, 2);
  assert.equal(calls.length, 2);
});

test('HTTP errors throw GhError; connection failures and timeouts throw NetworkError', async () => {
  const notFound = createDirect({ fetch: async () => respond(404, { message: 'Not Found' }), readToken: async () => TOKEN });
  await assert.rejects(notFound.read(parseRead(['api', 'repos/x/compare/a...b'])), (e) => e instanceof GhError && e.message === 'HTTP 404: Not Found (repos/x/compare/a...b)');
  const down = createDirect({ fetch: async () => { throw new TypeError('fetch failed'); }, readToken: async () => TOKEN });
  await assert.rejects(down.read(parseRead(['api', 'user'])), (e) => e instanceof NetworkError && !e.message.includes(TOKEN));
  const slow = createDirect({ fetch: (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))), readToken: async () => TOKEN, timeoutMs: 20 });
  await assert.rejects(slow.read(parseRead(['api', 'user'])), (e) => e instanceof NetworkError);
  const gqlErr = createDirect({ fetch: async () => respond(200, { errors: [{ message: 'Could not resolve to a PullRequest' }] }), readToken: async () => TOKEN });
  await assert.rejects(gqlErr.read(parseRead(['pr', 'view', '1', '-R', R, '--json', 'number'])), (e) => e instanceof GhError && /Could not resolve/.test(e.message));
});

test('workflowName comes from the workflow, not the run name, looked up once', async () => {
  let workflowCalls = 0;
  const { fetch } = fakeGitHub((url) => {
    if (url.includes('/actions/workflows?')) { workflowCalls++; return respond(200, { workflows: [{ id: 77, name: 'Run Tests' }] }); }
    return respond(200, { workflow_runs: [{ id: 1, name: 'Custom run-name for #1094', workflow_id: 77, conclusion: 'success' }] });
  });
  const direct = createDirect({ fetch, readToken: async () => TOKEN });
  const read = parseRead(['run', 'list', '-R', R, '-L', '1', '--json', 'databaseId,workflowName']);
  assert.deepEqual((await direct.read(read)).json, [{ databaseId: 1, workflowName: 'Run Tests' }]);
  await direct.read(read);
  assert.equal(workflowCalls, 1);
  const noName = parseRead(['run', 'list', '-R', R, '-L', '1', '--json', 'databaseId,url']);
  await direct.read(noName);
  assert.equal(workflowCalls, 1, 'not fetched when workflowName is not asked for');
});

test('run list -u <user> maps to the actor filter', () => {
  const read = parseRead(['run', 'list', '-R', R, '-L', '50', '-u', 'fahmedtcp', '--json', 'databaseId,url']);
  assert.equal(read.user, 'fahmedtcp');
  assert.deepEqual(runRequest(read).query, { per_page: '50', actor: 'fahmedtcp' });
});

// ---------- review fixes ----------

test('a broken or stalled body on a 200 is a connection failure, not empty data', async () => {
  const broken = createDirect({ fetch: async () => new Response('{"workflow_runs": [', { status: 200 }), readToken: async () => TOKEN });
  await assert.rejects(broken.read(parseRead(['run', 'list', '-R', R, '-L', '1', '--json', 'databaseId'])), (e) => e instanceof NetworkError);
  const stalled = createDirect({
    fetch: async (url, opts) => new Response(new ReadableStream({ start(c) { opts.signal.addEventListener('abort', () => c.error(opts.signal.reason)); } }), { status: 200 }),
    readToken: async () => TOKEN, timeoutMs: 30,
  });
  await assert.rejects(stalled.read(parseRead(['api', 'user'])), (e) => e instanceof NetworkError);
});

test('the token is only ever sent to api.github.com', async () => {
  const { fetch, calls } = fakeGitHub(() => respond(200, [{ name: 'a' }], { link: '<https://evil.example/steal?page=2>; rel="next"' }));
  const direct = createDirect({ fetch, readToken: async () => TOKEN });
  await assert.rejects(direct.read(parseRead(['api', '--paginate', 'repos/x/branches', '--jq', '.[].name'])), (e) => e instanceof GhError);
  assert.equal(calls.length, 1, 'the off-host link was never requested');
});
