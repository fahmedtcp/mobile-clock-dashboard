import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { JiraError } from '../lib/jira.js';
import { request } from './helpers.js';

const MARKUP = '<img src=x onerror=alert(1)>';
const adf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const buildComment = (number, app, dest, created) =>
  ({ author: 'bot', created, text: `pushed build number ${number} for ${app} to ${dest}` });

function fakeJira() {
  const calls = { comments: 0 };
  const issues = {
    'TCPMOB-1': { key: 'TCPMOB-1', fields: {
      summary: 'CSSO guards', status: { name: 'Dev Review' }, assignee: { displayName: 'Foad Ahmed' },
      fixVersions: [{ name: 'Mobile 42' }], issuetype: { name: 'Bug' }, description: adf(`Check roles ${MARKUP} too`) } },
    'TCPMOB-2': { key: 'TCPMOB-2', fields: { summary: 'No build', status: { name: 'Dev Review' }, issuetype: { name: 'Story' } } },
  };
  const comments = {
    'TCPMOB-1': [
      buildComment(405, 'Mobile Kiosk Android', 'firebase distribution', '2026-11-06T10:00:00Z'),
      { author: 'Hamza Ashfaq', created: '2026-11-10T09:00:00Z', text: `Can you check kiosk?\n${MARKUP}\nthird line` },
      buildComment(409, 'MobileClock IOS', 'testflight', '2026-11-09T10:00:00Z'),
      buildComment(412, 'Mobile Clock Android', 'firebase distribution', '2026-11-10T10:00:00Z'),
      { author: 'Pat', created: '2026-11-10T11:00:00Z', text: 'Looks good' },
    ],
    'TCPMOB-2': [],
  };
  return {
    calls,
    configured: true,
    async getIssue(key) {
      if (!issues[key]) throw new JiraError(404, 'Issue does not exist or you do not have permission to see it.');
      return issues[key];
    },
    async comments(key) { calls.comments++; return comments[key] ?? []; },
  };
}

async function boot() {
  const jira = fakeJira();
  const prs = [
    { number: 1101, title: 'TCPMOB-1 CSSO guards', url: 'u1101', state: 'OPEN', reviewDecision: 'APPROVED', headRefName: 'TCPMOB-1-x' },
    { number: 900, title: 'TCPMOB-10 other', url: 'u900', state: 'OPEN', reviewDecision: '', headRefName: 'TCPMOB-10-x' },
  ];
  const cachedMonth = { dayHours: 7, days: [
    { state: 'confirmed', entries: [{ key: 'TCPMOB-1', hours: 6 }, { key: 'TCPMOB-2', hours: 1 }] },
    { state: 'confirmed', entries: [{ key: 'TCPMOB-1', hours: 3.5 }] },
  ] };
  const server = createServer({
    gh: { json: async (args) => (args.includes('pr') ? prs : []), run: async () => '' }, tracker: { list: () => [] },
    behind: {}, timeDir: mkdtempSync(path.join(tmpdir(), 'panel-')), jira,
  });
  server.ctx.timeMonthPeek = () => cachedMonth;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, jira, req: request(server.address().port) };
}

test('latest builds returns the newest build per key, cached', async () => {
  const { server, jira, req } = await boot();

  const first = (await req('GET', '/api/builds/latest?keys=TCPMOB-1,TCPMOB-2')).json();
  await req('GET', '/api/builds/latest?keys=TCPMOB-1,TCPMOB-2');

  assert.deepEqual(first, { 'TCPMOB-1': {
    number: '412', app: 'MobileClock', platform: 'Android', destination: 'Firebase', created: '2026-11-10T10:00:00Z' } });
  assert.equal(jira.calls.comments, 2, 'one comments call per key, then cached');
  server.close();
});

test('latest builds rejects bad and oversized key lists', async () => {
  const { server, jira, req } = await boot();
  const many = Array.from({ length: 51 }, (_, i) => `TCPMOB-${i + 1}`).join(',');

  const oversized = await req('GET', `/api/builds/latest?keys=${many}`);
  const invalid = await req('GET', '/api/builds/latest?keys=TCPMOB-1,OPS-1');

  assert.equal(oversized.status, 400);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json().error, 'Send 1–50 ticket keys like TCPMOB-123.');
  assert.equal(jira.calls.comments, 0);
  server.close();
});

test('panel returns ticket, plain description, latest comments, builds, prs, hours', async () => {
  const { server, req } = await boot();

  const panel = (await req('GET', '/api/tickets/TCPMOB-1/panel')).json();

  assert.deepEqual(panel.ticket, { key: 'TCPMOB-1', type: 'Bug', summary: 'CSSO guards', status: 'Dev Review',
    assignee: 'Foad Ahmed', fixVersions: ['Mobile 42'], url: panel.ticket.url });
  assert.equal(panel.comments.length, 3);
  assert.equal(panel.comments[0].author, 'Pat', 'newest first');
  assert.deepEqual(panel.builds.map((b) => b.number), ['412', '409', '405'], 'newest per app and platform, newest first');
  assert.deepEqual(panel.prs.map((p) => p.number), [1101]);
  assert.deepEqual(panel.hours.hours, 9.5);
  assert.equal(panel.canSendToQa, true);
  server.close();
});

test('panel text is plain, with markup left as literal characters', async () => {
  const { server, req } = await boot();

  const panel = (await req('GET', '/api/tickets/TCPMOB-1/panel')).json();

  assert.equal(panel.description, `Check roles ${MARKUP} too`);
  const hamza = panel.comments.find((c) => c.author === 'Hamza Ashfaq');
  assert.equal(hamza.text, `Can you check kiosk?\n${MARKUP}`, 'first two non-empty lines, verbatim');
  server.close();
});

test('panel returns 404 with a reason for an unknown key', async () => {
  const { server, req } = await boot();

  const missing = await req('GET', '/api/tickets/TCPMOB-999/panel');

  assert.equal(missing.status, 404);
  assert.equal(missing.json().error, "Couldn't find TCPMOB-999 in Jira.");
  server.close();
});

test('panel canSendToQa only in Dev Review with a build', async () => {
  const { server, req } = await boot();

  const noBuild = (await req('GET', '/api/tickets/TCPMOB-2/panel')).json();

  assert.equal(noBuild.canSendToQa, false);
  assert.deepEqual(noBuild.builds, []);
  server.close();
});

// ---------- review fixes ----------

async function bootWith({ gh, peek }) {
  const server = createServer({
    gh, tracker: { list: () => [] }, behind: {}, timeDir: mkdtempSync(path.join(tmpdir(), 'panel2-')), jira: fakeJira(),
  });
  let built = 0;
  server.ctx.timeMonth = async () => { built++; return null; };
  server.ctx.timeMonthPeek = peek;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, req: request(server.address().port), builtCount: () => built };
}

test('panel still loads when GitHub fails, with no PRs', async () => {
  const gh = { json: async () => { throw new Error('gh: not logged in'); }, run: async () => '' };
  const { server, req } = await bootWith({ gh, peek: () => null });

  const res = await req('GET', '/api/tickets/TCPMOB-1/panel');

  assert.equal(res.status, 200);
  assert.deepEqual(res.json().prs, []);
  server.close();
});

test('panel hours count only Tempo and confirmed days, and never build a month', async () => {
  const month = { dayHours: 7, days: [
    { state: 'tempo', entries: [{ key: 'TCPMOB-1', hours: 9 }], tempoEntries: [{ key: 'TCPMOB-1', hours: 2 }] },
    { state: 'confirmed', entries: [{ key: 'TCPMOB-1', hours: 3.5 }] },
    { state: 'review', suggested: true, entries: [{ key: 'TCPMOB-1', hours: 6 }] },
  ] };
  const gh = { json: async () => [], run: async () => '' };
  const { server, req, builtCount } = await bootWith({ gh, peek: () => month });

  const panel = (await req('GET', '/api/tickets/TCPMOB-1/panel')).json();

  assert.equal(panel.hours.hours, 5.5, 'Tempo 2h (not the 9h edit note) + confirmed 3.5h; suggestions excluded');
  assert.equal(builtCount(), 0);
  server.close();
});

test('panel hours are null when the month is not cached yet', async () => {
  const gh = { json: async () => [], run: async () => '' };
  const { server, req, builtCount } = await bootWith({ gh, peek: () => null });

  const panel = (await req('GET', '/api/tickets/TCPMOB-1/panel')).json();

  assert.equal(panel.hours, null);
  assert.equal(builtCount(), 0);
  server.close();
});

test('a malformed key escape is a 400, not a 500', async () => {
  const gh = { json: async () => [], run: async () => '' };
  const { server, req } = await bootWith({ gh, peek: () => null });

  const res = await req('GET', '/api/tickets/%E0%A4%A/panel');

  assert.equal(res.status, 400);
  server.close();
});
