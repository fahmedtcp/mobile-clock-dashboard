import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGh, GhError } from '../lib/gh.js';

test('run passes args as argv to gh and returns stdout', async () => {
  const calls = [];
  const gh = createGh(async (file, args) => { calls.push([file, args]); return { stdout: 'ok\n' }; });
  assert.equal(await gh.run(['pr', 'list', '--ref', 'epic/TCPMOB-1423 x']), 'ok\n');
  assert.deepEqual(calls, [['gh', ['pr', 'list', '--ref', 'epic/TCPMOB-1423 x']]]);
});

test('json parses stdout', async () => {
  const gh = createGh(async () => ({ stdout: '[{"a":1}]' }));
  assert.deepEqual(await gh.json([]), [{ a: 1 }]);
});

test('failure becomes GhError carrying stderr', async () => {
  const gh = createGh(async () => { throw Object.assign(new Error('x'), { stderr: 'gh: To get started, run gh auth login' }); });
  await assert.rejects(gh.run([]), (e) => e instanceof GhError && e.stderr.includes('gh auth login'));
});

// ---------- direct reads ----------
const R = 'tcp-software/mobile-clock';
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

function setup({ env = {}, fetchImpl } = {}) {
  const execCalls = [];
  const exec = async (file, args) => {
    execCalls.push(args.join(' '));
    if (args[0] === 'auth' && args[1] === 'token') return { stdout: 'ghp_tok\n' };
    return { stdout: 'cli-output\n' };
  };
  const fetchCalls = [];
  const fetch = async (url, opts) => { fetchCalls.push(String(url)); return fetchImpl ? fetchImpl(url, opts) : ok({ login: 'fahmedtcp' }); };
  let t = 1000;
  const gh = createGh(exec, { fetch, env, now: () => t });
  return { gh, execCalls, fetchCalls, tick: (ms) => { t += ms; } };
}
const cliCalls = (calls) => calls.filter((c) => c !== 'auth token');

test('a mapped read goes direct; the CLI only supplies the token', async () => {
  const { gh, execCalls, fetchCalls } = setup();
  assert.equal(await gh.run(['api', 'user', '--jq', '.login']), 'fahmedtcp\n');
  assert.deepEqual(cliCalls(execCalls), []);
  assert.equal(fetchCalls.length, 1);
});

test('identical reads share one fetch, reuse it for 15 seconds, then fetch again', async () => {
  const { gh, fetchCalls, tick } = setup();
  const args = ['api', 'user', '--jq', '.login'];
  await Promise.all([gh.run(args), gh.run(args)]);
  assert.equal(fetchCalls.length, 1);
  tick(14000);
  await gh.run(args);
  assert.equal(fetchCalls.length, 1);
  tick(2000);
  await gh.run(args);
  assert.equal(fetchCalls.length, 2);
});

test('json results are copies, so a caller changing them cannot change the cache', async () => {
  const { gh, fetchCalls } = setup({ fetchImpl: () => ok({ workflow_runs: [{ id: 9, conclusion: 'success', html_url: 'h' }] }) });
  const args = ['run', 'list', '-R', R, '-L', '1', '--json', 'databaseId,url'];
  (await gh.json(args))[0].url = 'changed';
  assert.equal((await gh.json(args))[0].url, 'h');
  assert.equal(fetchCalls.length, 1);
});

test('a write runs the CLI and clears the cache; clearCache does too', async () => {
  const { gh, execCalls, fetchCalls } = setup();
  const args = ['api', 'user', '--jq', '.login'];
  await gh.run(args);
  await gh.run(['run', 'rerun', '5', '--failed', '-R', R]);
  assert.deepEqual(cliCalls(execCalls), ['run rerun 5 --failed -R tcp-software/mobile-clock']);
  await gh.run(args);
  assert.equal(fetchCalls.length, 2);
  gh.clearCache();
  await gh.run(args);
  assert.equal(fetchCalls.length, 3);
});

test('an unmapped read uses the CLI and keeps the cache', async () => {
  const { gh, execCalls, fetchCalls } = setup();
  await gh.run(['api', 'user', '--jq', '.login']);
  assert.equal(await gh.run(['api', '--paginate', '--slurp', 'repos/x/issues/1/comments']), 'cli-output\n');
  await gh.run(['api', 'user', '--jq', '.login']);
  assert.equal(fetchCalls.length, 1);
  assert.equal(cliCalls(execCalls).length, 1);
});

test('a proxy turns direct reads off', async () => {
  const { gh, fetchCalls } = setup({ env: { HTTPS_PROXY: 'http://proxy:8080' } });
  assert.equal(await gh.run(['api', 'user', '--jq', '.login']), 'cli-output\n');
  assert.equal(fetchCalls.length, 0);
});

test('a connection failure falls back to the CLI, which stays in use for a minute', async () => {
  const { gh, execCalls, fetchCalls, tick } = setup({ fetchImpl: () => { throw new TypeError('fetch failed'); } });
  assert.equal(await gh.run(['api', 'user', '--jq', '.login']), 'cli-output\n');
  assert.equal(await gh.run(['api', 'repos/x/compare/a...b', '--jq', '.status']), 'cli-output\n');
  assert.equal(fetchCalls.length, 1, 'no second direct try within a minute');
  tick(61000);
  await gh.run(['api', 'repos/x/compare/c...d', '--jq', '.status']);
  assert.equal(fetchCalls.length, 2);
  assert.equal(cliCalls(execCalls).length, 3);
});

test('a fake exec without an explicit fetch never reaches the network', async () => {
  const exec = async () => ({ stdout: '{"login":"cli"}' });
  const gh = createGh(exec);
  assert.deepEqual(await gh.json(['api', 'user']), { login: 'cli' });
});

// ---------- review fixes ----------

test('signed out: a token read failure falls back to the CLI and its sign-in error', async () => {
  const exec = async (file, args) => {
    throw Object.assign(new Error('Command failed'), { stderr: 'To get started with GitHub CLI, please run:  gh auth login' });
  };
  const gh = createGh(exec, { fetch: async () => { throw new Error('should not fetch'); }, env: {} });
  await assert.rejects(gh.run(['api', 'user', '--jq', '.login']), (e) => e instanceof GhError && e.message.includes('gh auth login'));
});

test('a read that starts during a write is not reused after the write finishes', async () => {
  let releaseWrite;
  const execCalls = [];
  const exec = async (file, args) => {
    execCalls.push(args.join(' '));
    if (args[0] === 'auth') return { stdout: 'ghp_tok\n' };
    if (args[1] === 'rerun') await new Promise((resolve) => { releaseWrite = resolve; });
    return { stdout: '' };
  };
  let fetches = 0;
  const gh = createGh(exec, { fetch: async () => { fetches++; return ok({ login: `v${fetches}` }); }, env: {} });
  const args = ['api', 'user', '--jq', '.login'];
  const write = gh.run(['run', 'rerun', '5', '--failed', '-R', R]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await gh.run(args), 'v1\n');
  releaseWrite();
  await write;
  assert.equal(await gh.run(args), 'v2\n', 'refetched after the write');
});
