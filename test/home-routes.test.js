process.env.TZ = 'Asia/Karachi';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { createSettings } from '../lib/settings.js';
import { request } from './helpers.js';

const NOW = new Date('2026-11-13T17:30:00+05:00'); // Friday, mid-shift
const iso = (hhmm) => new Date(`2026-11-13T${hhmm}:00+05:00`).toISOString();
const KEY = 'TCPMOB-1768';
const SECRET_TITLE = 'Standup about secret project';

function fakeJira() {
  const issue = (key, status, assignee) => ({ key, fields: { summary: `${key} summary`, status: { name: status }, assignee } });
  return {
    configured: true,
    myself: async () => ({ accountId: 'me', displayName: 'Foad' }),
    userByEmail: async (email) => (email.startsWith('sana') ? 'sana' : null),
    search: async (jql) => (jql.includes('assignee in')
      ? [issue('TCPMOB-1700', 'QA Review', { accountId: 'sana', displayName: 'Sana Ali' })]
      : [issue(KEY, 'QA Review', { accountId: 'sana', displayName: 'Sana Ali' })]),
    comments: async () => [
      { author: 'bot', authorId: 'bot', created: iso('10:00'), text: 'pushed build number 412 for Mobile Clock Android to firebase distribution' },
      { author: 'Sana Ali', authorId: 'sana', created: iso('16:00'), text: 'testing now' },
    ],
    changelog: async () => [],
  };
}

const pr = { number: 1101, title: `${KEY} CSSO`, url: 'https://github.com/x/pull/1101', author: { login: 'fahmed' }, headRefName: `${KEY}-csso`,
  baseRefName: 'develop', isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [], createdAt: iso('09:00'), reviewRequests: [],
  latestReviews: [{ state: 'APPROVED', submittedAt: iso('15:00'), author: { login: 'hamza' }, body: '' }] };
const gh = (prs = [pr]) => ({
  json: async (args) => (args.includes('merged') ? [] : args.includes('pr') ? prs : []),
  run: async (args) => (args.includes('user') ? 'fahmed\n' : ''),
});

async function boot({ jira = fakeJira(), team = true, calendarOn = true, prs, ghOverride } = {}) {
  const settings = createSettings({ file: null, env: {}, initial: {
    time: { dayHours: 7, mobileClockPath: '/nope' },
    calendar: { on: calendarOn },
    team: { people: team ? [{ name: 'Sana Ali', github: 'sana-q', jiraEmail: 'sana@x.co', qa: true }] : [] },
  } });
  const timeDir = mkdtempSync(path.join(tmpdir(), 'home-'));
  const logs = [];
  const calendar = {
    meetings: async () => [{ title: SECRET_TITLE, start: iso('19:30'), end: iso('19:45') }],
    status: () => (calendarOn ? 'ok' : 'off'),
  };
  const server = createServer({
    gh: ghOverride ?? gh(prs), tracker: { list: () => [], refresh: async () => [] }, behind: { get: async () => 0, clear() {} },
    settings, jira, calendar, timeDir, cacheDir: timeDir, timeToday: () => '2026-11-13',
  });
  server.ctx.homeNow = () => NOW;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, req: request(server.address().port), timeDir, logs };
}

test('home returns shift, work, feed, team, and headline in one call', async () => {
  const { server, req } = await boot();
  const body = (await req('GET', '/api/home')).json();
  assert.equal(body.shift.moment, 'mid');
  assert.equal(body.shift.start, '13:00');
  assert.equal(body.shift.progress, 0.5);
  assert.equal(body.calendar, 'ok');
  assert.deepEqual(body.meetings.map((m) => m.title), [SECRET_TITLE]);
  assert.equal(body.work[0].key, KEY);
  assert.equal(body.work[0].blocker.kind, 'qa-missing-platform');
  assert.equal(body.headline.text, `Sana is testing your ${KEY} right now.`);
  assert.deepEqual(body.team.map((t) => t.doing), [`${KEY} · In QA`, 'Testing TCPMOB-1700']);
  assert.ok(body.feed.some((f) => f.text === 'approved #1101' && f.unread === true));
  assert.equal(body.standup.today.startsWith(KEY), true, 'standup meeting later today');
  assert.deepEqual(body.errors, {});
  server.close();
});

test('home works with only GitHub', async () => {
  const { server, req } = await boot({ jira: { configured: false }, team: false, calendarOn: false });
  const res = await req('GET', '/api/home');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.calendar, 'off');
  assert.deepEqual(body.meetings, []);
  assert.deepEqual(body.team, []);
  assert.deepEqual(body.work, []);
  assert.ok(body.errors.jira);
  assert.equal(body.standup, null);
  server.close();
});

test('a GitHub failure still returns Jira work', async () => {
  const { server, req } = await boot({ ghOverride: { json: async () => { throw new Error('gh: not logged in'); }, run: async () => 'fahmed\n' } });
  const body = (await req('GET', '/api/home')).json();
  assert.ok(body.errors.github);
  assert.equal(body.work[0].key, KEY);
  server.close();
});

test('seen marks the feed read', async () => {
  const { server, req } = await boot();
  const seen = (await req('POST', '/api/home/seen')).json();
  assert.equal(seen.lastSeen, NOW.getTime());
  const body = (await req('GET', '/api/home?fresh=1')).json();
  assert.ok(body.feed.every((f) => f.unread === false));
  server.close();
});

test('note is saved trimmed, limited to 1000 characters, and comes back', async () => {
  const { server, req } = await boot();
  assert.equal((await req('PUT', '/api/home/note', { text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await req('PUT', '/api/home/note', { text: 42 })).status, 400);
  const saved = (await req('PUT', '/api/home/note', { text: '  Start with TCPMOB-1772  ' })).json();
  assert.equal(saved.note.text, 'Start with TCPMOB-1772');
  assert.equal((await req('GET', '/api/home')).json().note.text, 'Start with TCPMOB-1772');
  server.close();
});

test('meeting titles never reach the data directory or logs', async () => {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(original)) console[k] = (...a) => lines.push(a.join(' '));
  const { server, req, timeDir } = await boot();
  try {
    await req('GET', '/api/home');
    await req('POST', '/api/home/seen');
    await req('PUT', '/api/home/note', { text: 'n' });
  } finally {
    Object.assign(console, original);
    server.close();
  }
  const files = readdirSync(timeDir, { recursive: true }).map((f) => path.join(timeDir, String(f)));
  const written = files.filter((f) => !f.endsWith('/')).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  assert.ok(!written.includes(SECRET_TITLE));
  assert.ok(!lines.join('\n').includes(SECRET_TITLE));
});

test('a merged PR with no build since shows as merged, not built', async () => {
  const merged = { number: 1071, title: `${KEY} fix`, url: 'm', headRefName: `${KEY}-fix`, baseRefName: 'develop',
    mergedAt: iso('12:00'), author: { login: 'fahmed' } }; // after build 412 (10:00)
  const ghMerged = { json: async (args) => (args.includes('merged') ? [merged] : []), run: async (args) => (args.includes('user') ? 'fahmed\n' : '') };
  const { server, req } = await boot({ ghOverride: ghMerged });
  const [row] = (await req('GET', '/api/home')).json().work;
  assert.equal(row.blocker.kind, 'merged-not-built');
  server.close();
});

// ---------- review fixes ----------

test('the calendar gets dates without milliseconds, which the Swift helper can parse', async () => {
  const { server, req } = await boot();
  const calls = [];
  server.ctx.calendar = { meetings: async (from, to) => { calls.push([from, to]); return []; }, status: () => 'ok' };
  await req('GET', '/api/home?fresh=1');
  assert.equal(calls.length, 1);
  for (const value of calls[0]) assert.match(value, /T\d\d:\d\d:\d\dZ$/);
  server.close();
});

test('tickets of merged PRs that are finished stay out of My Work', async () => {
  const merged = { number: 1080, title: 'TCPMOB-1600 shipped', url: 'm', headRefName: 'TCPMOB-1600-x', baseRefName: 'develop',
    mergedAt: iso('09:00'), author: { login: 'fahmed' } };
  const ghMerged = { json: async (args) => (args.includes('merged') ? [merged] : []), run: async (args) => (args.includes('user') ? 'fahmed\n' : '') };
  const { server, req } = await boot({ ghOverride: ghMerged });
  server.ctx.tickets = { get: async () => new Map([['TCPMOB-1600', { key: 'TCPMOB-1600', summary: 's', status: 'Done', url: 'u', assignee: null }]]) };
  const keys = (await req('GET', '/api/home')).json().work.map((r) => r.key);
  assert.ok(!keys.includes('TCPMOB-1600'), keys.join(','));
  server.close();
});

test("Monday's feed reaches back to Friday's shift end", async () => {
  const jira = fakeJira();
  jira.comments = async () => [{ author: 'Sana Ali', authorId: 'sana', created: '2026-11-13T23:30:00+05:00', text: 'Friday night note' }];
  const { server, req } = await boot({ jira });
  server.ctx.homeNow = () => new Date('2026-11-16T13:05:00+05:00');
  const feed = (await req('GET', '/api/home?fresh=1')).json().feed;
  assert.ok(feed.some((f) => f.quote === 'Friday night note'));
  server.close();
});

test('a teammate lookup that failed is tried again', async () => {
  const jira = fakeJira();
  let calls = 0;
  jira.userByEmail = async () => { calls++; if (calls === 1) throw new Error('timeout'); return 'sana'; };
  const { server, req } = await boot({ jira });
  await req('GET', '/api/home?fresh=1');
  const team = (await req('GET', '/api/home?fresh=1')).json().team;
  assert.equal(team[1].doing, 'Testing TCPMOB-1700');
  server.close();
});
