// Fixes from the final review of Settings.
process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, reminderSetting } from '../server.js';
import { createSettings } from '../lib/settings.js';
import { createTsBudget } from '../lib/tsbudget.js';
import { defaultSources } from '../lib/time/routes.js';
import { request } from './helpers.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function boot(opts = {}) {
  const server = createServer({ gh: { json: async () => [], run: async () => 'me\n' }, tracker: { list: () => [] }, behind: {}, timeDir: mkdtempSync(path.join(tmpdir(), 'setrev-')), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (...a) => request(port)(...a);
  return { server, req };
}

test('no evening reminder until workday hours are set', () => {
  assert.equal(reminderSetting({ dayHours: null, reminderOn: true, reminderAt: '20:30' }), 'off');
  assert.equal(reminderSetting({ dayHours: 7, reminderOn: false, reminderAt: '20:30' }), 'off');
  assert.equal(reminderSetting({ dayHours: 7, reminderOn: true, reminderAt: '19:00' }), '19:00');
});

test('hand-edited values with wrong types fall back instead of breaking', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'setbad-'));
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ builds: { defaultChecked: null }, time: { dayHours: '8' }, teams: { always: 'alice' }, jira: 'x', theme: 'neon' }));
  const s = createSettings({ file, env: {} });
  const r = s.resolved();
  assert.deepEqual(r.builds.defaultChecked, ['mcAndroid', 'mkAndroid', 'mcIos', 'mkIos']);
  assert.equal(r.time.dayHours, null);
  assert.deepEqual(r.teams.always, []);
  assert.equal(r.theme, 'light');
  s.update({ jira: { email: 'me@tcpsoftware.com' } });
  assert.equal(s.resolved().jira.email, 'me@tcpsoftware.com');
  const { server, req } = await boot({ settings: s });
  assert.equal((await req('GET', '/api/builds-config')).status, 200);
  server.close();
});

test('a moved clone folder does not discard saved values on load', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'setmoved-'));
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ time: { mobileClockPath: '/gone/away' }, tempo: { token: 'tokentoken1234' } }));
  const r = createSettings({ file, env: {} }).resolved();
  assert.equal(r.time.mobileClockPath, '/gone/away');
  assert.equal(r.tempo.token, 'tokentoken1234');
});

test('a JSON array file is treated as corrupt and moved aside', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'setarr-'));
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, '[]');
  const s = createSettings({ file, env: {} });
  assert.ok(readdirSync(dir).some((f) => f.startsWith('settings.json.corrupt-')));
  s.update({ theme: 'dark' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).theme, 'dark');
});

test('short secrets never show in full, and tokens need 8+ characters', () => {
  const s = createSettings({ file: null, env: { TEMPO_TOKEN: 'abc' } });
  assert.equal(s.publicView().tempo.token.last4, null);
  assert.throws(() => s.update({ jira: { token: 'short7x' } }), { status: 400 });
});

test('prototype keys are rejected as unknown settings', () => {
  const s = createSettings({ file: null, env: {} });
  for (const body of ['{"constructor":1}', '{"__proto__":{"x":1}}', '{"jira":{"toString":1}}']) {
    assert.throws(() => s.update(JSON.parse(body)), (e) => e.status === 400 && /^Unknown setting/.test(e.message), body);
  }
});

test('tests never take keys from the shell environment', async () => {
  process.env.TEMPO_TOKEN = 'shelltoken1234';
  process.env.JIRA_TOKEN = 'shelltoken5678';
  try {
    const { server } = await boot();
    assert.equal(server.ctx.tempo.configured, false);
    assert.equal(server.ctx.settings.publicView().jira.token.set, false);
    server.close();
  } finally { delete process.env.TEMPO_TOKEN; delete process.env.JIRA_TOKEN; }
});

test('review-request emails follow Settings changes, including removing an override', async () => {
  const gh = {
    async json() { return { number: 5, title: 'TCPMOB-1 Thing', url: 'u', author: { login: 'me' }, headRefName: 'TCPMOB-1-x', isDraft: false, state: 'OPEN', reviewRequests: [{ login: 'pat' }] }; },
    async run(args) { return args.some((a) => a.startsWith('users/')) ? 'Pat Doe\n' : 'me\n'; },
  };
  const settings = createSettings({ file: null, env: {} });
  const { server, req } = await boot({ gh, settings });
  const email = async () => (await req('GET', '/api/prs/5/review-request')).json().people.find((p) => p.login === 'pat')?.email ?? null;
  await req('PUT', '/api/settings', { teams: { people: { pat: 'pat@tcpsoftware.com' } } });
  assert.equal(await email(), 'pat@tcpsoftware.com');
  await req('PUT', '/api/settings', { teams: { people: null } });
  assert.equal(await email(), null);
  server.close();
});

test('time Jira source asks for the account again after a Jira change', async () => {
  let calls = 0;
  const ctx = { jira: { configured: true, myself: async () => { calls++; return { accountId: `acc${calls}` }; }, search: async () => [], changelog: async () => [], comments: async () => [] } };
  const src = defaultSources(ctx);
  await src.jira('2026-11');
  ctx.tempoAccountId = null; // what applySettings does on save
  await src.jira('2026-11');
  assert.equal(calls, 2);
});

test('TS budget rebuilds its worktree when the clone folder changes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsmove-'));
  const repoA = path.join(dir, 'a'); const repoB = path.join(dir, 'b');
  for (const r of [repoA, repoB]) mkdirSync(path.join(r, 'node_modules'), { recursive: true });
  let repo = repoA;
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes('worktree') && args.includes('add')) mkdirSync(args.at(-2), { recursive: true });
    if (args.includes('rev-parse')) return { stdout: 'sha\n', stderr: '', code: 0 };
    if (file === 'node') return { stdout: '', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const ts = createTsBudget({ repoPath: () => repo, cacheDir: path.join(dir, 'cache'), historyFile: path.join(dir, 'h.json'), exec });
  ts.runDevelop(); await ts.whenIdle();
  repo = repoB;
  calls.length = 0;
  ts.runDevelop(); await ts.whenIdle();
  assert.ok(calls.some((c) => c.includes(repoB) && c.includes('worktree') && c.includes('add')), JSON.stringify(calls));
  assert.equal(readFileSync(path.join(dir, 'cache', 'ts-wt', '.dashboard-repo'), 'utf8').trim(), repoB);
});

test('no server or page copy tells people to edit .env or restart', () => {
  const files = [
    ...['lib', 'lib/time'].flatMap((d) => readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, d, f))),
    ...['public', 'public/views'].flatMap((d) => readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, d, f))),
  ].filter((f) => !f.endsWith('settings.js') && !f.endsWith('env.js'));
  const bad = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l]))
    .filter(([, , l]) => /(to|in) \.env|then restart/.test(l) && !/^\s*\/\//.test(l));
  assert.deepEqual(bad.map(([f, n]) => `${path.relative(ROOT, f)}:${n}`), []);
  assert.ok(existsSync(path.join(ROOT, 'lib', 'settings.js')));
});
