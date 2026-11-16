import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { createSettings } from '../lib/settings.js';
import { draftBody, labelFor, PLACEHOLDER } from '../lib/pr-request.js';
import { request } from './helpers.js';

const KEY = 'TCPMOB-1764';
const BRANCH = 'TCPMOB-1764-deep-link-invalid-namespace';
const adf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function fakes({ openPrs = [], branches = [BRANCH, 'develop'], status = 'In Progress', transitions = [{ id: '31', to: { name: 'Dev Review' } }] } = {}) {
  const calls = { create: null, transition: null };
  const gh = {
    async json(args) {
      const joined = args.join(' ');
      if (joined.includes('compare/develop...')) {
        return { commits: [
          { commit: { message: `${KEY} Route invalid namespaces back to the Namespace page\n\nlonger body` } },
          { commit: { message: 'Merge branch develop into TCPMOB-1764' } },
          { commit: { message: 'Show the company ID error once' } },
          { commit: { message: 'Show the company ID error once' } },
        ], files: [{ filename: 'packages/common/hooks/useLinkingActions.ts' }, { filename: 'packages/common/assets/strings/english.ts' }] };
      }
      if (args.includes('pr') && args.includes('list')) return openPrs;
      return [];
    },
    async run(args) {
      if (args.includes('user')) return 'fahmedtcp\n';
      if (args.join(' ').includes('branches')) return `${branches.join('\n')}\n`;
      if (args[0] === 'pr' && args[1] === 'create') { calls.create = args; return 'https://github.com/tcp-software/mobile-clock/pull/1110\n'; }
      return '';
    },
  };
  const jira = {
    configured: true,
    getIssue: async () => ({ key: KEY, fields: { summary: 'Deep link with an invalid namespace shows a blank screen', status: { name: status },
      issuetype: { name: 'Bug' }, description: adf('Opening a setup deep link with an invalid namespace showed a blank screen.') } }),
    transitions: async () => transitions,
    transition: async (key, id) => { calls.transition = [key, id]; },
    comments: async () => [],
    search: async () => [],
  };
  return { gh, jira, calls };
}

async function boot(options = {}) {
  const { gh, jira, calls } = fakes(options);
  const settings = createSettings({ file: null, env: { JIRA_BASE_URL: 'https://timeclockplus.atlassian.net' }, initial: {
    time: { dayHours: 7 },
    teams: { always: ['hashfaqtcp'] },
    team: { people: [
      { name: 'Hamza Ashfaq', github: 'hashfaqtcp', jiraEmail: 'h@x.co', qa: false },
      { name: 'Abdul Qadir', github: 'abdulqadir-tcp', jiraEmail: 'a@x.co', qa: false },
      { name: 'Sana Ali', github: 'sana-qa', jiraEmail: 's@x.co', qa: true },
      { name: 'Foad Ahmed', github: 'fahmedtcp', jiraEmail: 'f@x.co', qa: false },
    ] },
  } });
  const server = createServer({ gh, jira, settings, tracker: { list: () => [] }, behind: {}, timeDir: mkdtempSync(path.join(tmpdir(), 'prr-')) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, calls, req: request(server.address().port) };
}

test('labels follow the ticket type', () => {
  assert.equal(labelFor('Bug'), 'bug');
  assert.equal(labelFor('Story'), 'enhancement');
  assert.equal(labelFor('New Feature'), 'feature');
  assert.equal(labelFor('Task'), 'enhancement');
});

test('the draft body follows the team format, with placeholders where only you know the answer', () => {
  const body = draftBody({
    key: KEY, summary: 'Deep link blank screen', url: `https://timeclockplus.atlassian.net/browse/${KEY}`,
    description: 'It was blank.', commits: ['Route invalid namespaces', 'Show the error once'], files: ['a.ts', 'b.ts'],
  });
  assert.match(body, /^## TCPMOB-1764 - Deep link blank screen\n\n\[TCPMOB-1764\]\(https:\/\/timeclockplus\.atlassian\.net\/browse\/TCPMOB-1764\)/);
  assert.match(body, /### Problem\nIt was blank\./);
  assert.match(body, /### Root Cause\n\[fill in: root cause\]/);
  assert.match(body, /### Solution\n- Route invalid namespaces\n- Show the error once/);
  assert.match(body, /### Files Changed\n- `a\.ts`\n- `b\.ts`/);
  assert.ok(PLACEHOLDER.test(body));
  assert.match(draftBody({ key: KEY, summary: 's', url: 'u', description: '', commits: [], files: [] }), /### Problem\n\[fill in: problem\]/);
});

test('draft: title, base, head, label, reviewers, and a body built from Jira and the branch', async () => {
  const { server, req } = await boot();
  const draft = (await req('GET', `/api/tickets/${KEY}/pr-draft`)).json();
  assert.equal(draft.existing, null);
  assert.equal(draft.title, `${KEY} - Deep link with an invalid namespace shows a blank screen`);
  assert.equal(draft.base, 'develop');
  assert.equal(draft.head, BRANCH);
  assert.equal(draft.label, 'bug');
  assert.equal(draft.status, 'In Progress');
  assert.deepEqual(draft.reviewers.map((r) => [r.login, r.selected]), [['hashfaqtcp', true], ['abdulqadir-tcp', false]]);
  assert.match(draft.body, /### Solution\n- Route invalid namespaces back to the Namespace page\n- Show the company ID error once\n/);
  assert.match(draft.body, /`packages\/common\/hooks\/useLinkingActions\.ts`/);
  server.close();
});

test('draft reports an existing open PR instead', async () => {
  const pr = { number: 1094, title: `${KEY} x`, url: 'u1094', author: { login: 'fahmedtcp' }, headRefName: BRANCH, baseRefName: 'develop',
    isDraft: false, reviewDecision: '', statusCheckRollup: [], createdAt: '2026-11-01T00:00:00Z', reviewRequests: [], latestReviews: [] };
  const { server, req } = await boot({ openPrs: [pr] });
  const draft = (await req('GET', `/api/tickets/${KEY}/pr-draft`)).json();
  assert.deepEqual(draft.existing, { number: 1094, url: 'u1094' });
  server.close();
});

test('draft with no branch on GitHub says to push first', async () => {
  const { server, req } = await boot({ branches: ['develop'] });
  const res = await req('GET', `/api/tickets/${KEY}/pr-draft`);
  assert.equal(res.status, 409);
  assert.equal(res.json().error, `No branch for ${KEY} on GitHub yet. Push your branch, then try again.`);
  server.close();
});

test('create posts the PR with your choices, and refuses placeholders or unknown branches', async () => {
  const { server, req, calls } = await boot();
  const good = { title: `${KEY} - Fix`, body: '## Done', head: BRANCH, label: 'bug', reviewers: ['hashfaqtcp', 'abdulqadir-tcp'] };
  assert.equal((await req('POST', `/api/tickets/${KEY}/pr`, { ...good, body: 'x [fill in: root cause]' })).json().error,
    'Fill in or delete the [fill in: …] parts first.');
  assert.equal((await req('POST', `/api/tickets/${KEY}/pr`, { ...good, head: 'main' })).status, 400);
  assert.equal((await req('POST', `/api/tickets/${KEY}/pr`, { ...good, reviewers: ['bad login!'] })).status, 400);
  assert.equal((await req('POST', `/api/tickets/${KEY}/pr`, { ...good, label: 'nope' })).status, 400);
  assert.equal(calls.create, null, 'nothing posted while invalid');
  const created = (await req('POST', `/api/tickets/${KEY}/pr`, good)).json();
  assert.deepEqual(created, { number: 1110, url: 'https://github.com/tcp-software/mobile-clock/pull/1110' });
  const arg = (flag) => calls.create[calls.create.indexOf(flag) + 1];
  assert.equal(arg('--base'), 'develop');
  assert.equal(arg('--head'), BRANCH);
  assert.equal(arg('--title'), good.title);
  assert.equal(arg('--body'), good.body);
  assert.equal(arg('--label'), 'bug');
  assert.equal(arg('--assignee'), '@me');
  assert.equal(arg('--reviewer'), 'hashfaqtcp,abdulqadir-tcp');
  server.close();
});

test('dev review moves the ticket once, and says so when it is already there', async () => {
  const { server, req, calls } = await boot();
  assert.deepEqual((await req('POST', `/api/tickets/${KEY}/dev-review`)).json(), { ok: true, from: 'In Progress', to: 'Dev Review' });
  assert.deepEqual(calls.transition, [KEY, '31']);
  server.close();
  const already = await boot({ status: 'Dev Review' });
  assert.deepEqual((await already.req('POST', `/api/tickets/${KEY}/dev-review`)).json(), { ok: true, already: true });
  already.server.close();
  const none = await boot({ transitions: [{ id: '9', to: { name: 'Done' } }] });
  assert.equal((await none.req('POST', `/api/tickets/${KEY}/dev-review`)).status, 409);
  none.server.close();
});
