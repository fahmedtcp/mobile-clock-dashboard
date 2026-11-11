import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.js';
import { GhError } from '../lib/gh.js';
import { BuildRequestError } from '../lib/builds.js';

const fakeTracker = {
  triggerCalls: [],
  nextError: null,
  async trigger(n, keys) {
    if (this.nextError) { const e = this.nextError; this.nextError = null; throw e; }
    this.triggerCalls.push([n, keys]);
    return [{ id: 'x', prNumber: n, key: keys[0] }];
  },
  async refresh() { return []; },
  list: () => [],
};
const fakeGh = {
  nextError: null,
  async json(args) {
    if (this.nextError) { const e = this.nextError; this.nextError = null; throw e; }
    if (args[0] === 'pr' && args[1] === 'view') return { number: 1, state: 'OPEN', headRefName: 'h/x', baseRefName: 'develop', reviewDecision: 'APPROVED' };
    return [];
  },
  async run() { return '0\n'; },
};
const behindCalls = [];
const fakeBehind = { async get(base, head) { behindCalls.push([base, head]); return 2; }, clear() {} };

let server, port;
before(async () => {
  server = createServer({ gh: fakeGh, tracker: fakeTracker, behind: fakeBehind });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

// fetch() forbids overriding Host, so use http.request directly.
function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const api = { 'X-Dashboard': '1', 'Content-Type': 'application/json' };

test('rejects foreign Host header with 403', async () => {
  const res = await req('GET', '/api/prs', { headers: { ...api, Host: `evil.example:${port}` } });
  assert.equal(res.status, 403);
});

test('accepts localhost Host header', async () => {
  const res = await req('GET', '/api/prs', { headers: { ...api, Host: `localhost:${port}` } });
  assert.equal(res.status, 200);
});

test('rejects POST without X-Dashboard header with 403 and triggers nothing', async () => {
  fakeTracker.triggerCalls.length = 0;
  const res = await req('POST', '/api/prs/1042/builds', { headers: { 'Content-Type': 'application/json' }, body: { keys: ['mcAndroid'] } });
  assert.equal(res.status, 403);
  assert.equal(fakeTracker.triggerCalls.length, 0);
});

test('ignores branch/buildType in POST body; passes only number and keys', async () => {
  fakeTracker.triggerCalls.length = 0;
  const res = await req('POST', '/api/prs/1042/builds', { headers: api, body: { keys: ['mcIos'], branch: 'release/1.45.x', buildType: 'release prod' } });
  assert.equal(res.status, 200);
  assert.deepEqual(fakeTracker.triggerCalls, [[1042, ['mcIos']]]);
});

test('BuildRequestError status passes through', async () => {
  fakeTracker.nextError = new BuildRequestError('PR #1 is not approved.', 409);
  const res = await req('POST', '/api/prs/1/builds', { headers: api, body: { keys: ['mcIos'] } });
  assert.equal(res.status, 409);
  assert.match(res.json().error, /not approved/);
});

test('GhError becomes 502 with stderr in error', async () => {
  fakeGh.nextError = new GhError('To get started, run gh auth login', 'To get started, run gh auth login');
  const res = await req('GET', '/api/prs', { headers: api });
  assert.equal(res.status, 502);
  assert.match(res.json().error, /gh auth login/);
});

test('invalid JSON body is 400', async () => {
  const res = await req('POST', '/api/prs/1/builds', { headers: api, body: '{nope' });
  assert.equal(res.status, 400);
});

test('non-numeric :n or :id is 400', async () => {
  assert.equal((await req('GET', '/api/prs/abc/behind', { headers: api })).status, 400);
  assert.equal((await req('POST', '/api/runs/1e3/cancel', { headers: api })).status, 400);
});

test('behind route takes branches from getPr, not the query', async () => {
  behindCalls.length = 0;
  const res = await req('GET', '/api/prs/1/behind?base=main&head=evil', { headers: api });
  assert.deepEqual(res.json(), { behind: 2, base: 'develop' });
  assert.deepEqual(behindCalls, [['develop', 'h/x']]);
});

test('unknown api path is 404', async () => {
  assert.equal((await req('GET', '/api/nope', { headers: api })).status, 404);
});

test('static path traversal is 404', async () => {
  assert.equal((await req('GET', '/..%2Fpackage.json')).status, 404);
  assert.equal((await req('GET', '/../package.json')).status, 404);
});

test('builds-config lists the 4 release dev builds checked plus the simulator build unchecked', async () => {
  const res = await req('GET', '/api/builds-config', { headers: api });
  assert.deepEqual(res.json().map((b) => [b.key, b.defaultChecked]), [['mcAndroid', true], ['mkAndroid', true], ['mcIos', true], ['mkIos', true], ['mcIosSim', false]]);
});

test('partial build failure returns status and started keys', async () => {
  fakeTracker.nextError = Object.assign(new BuildRequestError('Android Mobile Kiosk failed to start', 502), { started: ['mcAndroid'] });
  const res = await req('POST', '/api/prs/1/builds', { headers: api, body: { keys: ['mcAndroid', 'mkAndroid'] } });
  assert.equal(res.status, 502);
  assert.deepEqual(res.json().started, ['mcAndroid']);
});

test('GitHub routes work with Jira unconfigured; /api/jira/status says so', async () => {
  const prs = await req('GET', '/api/prs', { headers: api });
  assert.equal(prs.status, 200);
  assert.ok(Array.isArray(prs.json().prs));
  const st = await req('GET', '/api/jira/status', { headers: api });
  assert.deepEqual(st.json(), { configured: false, ok: false, error: "Jira isn't connected. Add your Jira URL, email, and token in Settings." });
});

test('static files are always revalidated so a browser never mixes old and new modules', async () => {
  const res = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/app.js', headers: { Host: `127.0.0.1:${port}` } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
    r.on('error', reject); r.end();
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-cache');
});
