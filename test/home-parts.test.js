import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedItems } from '../lib/home/feed.js';
import { pickHeadline } from '../lib/home/headline.js';
import { unpushedBranches, wrapChecklist } from '../lib/home/wrap.js';
import { standupDraft } from '../lib/home/standup.js';
import { teamOnShift } from '../lib/home/team.js';

const NOW = new Date('2026-11-13T12:30:00Z');
const ago = (h) => new Date(NOW - h * 36e5).toISOString();
const KEY = 'TCPMOB-1482';
const people = [
  { name: 'Sana Ali', github: 'sana-q', qa: true, accountId: 'sana' },
  { name: 'Hamza Ashfaq', github: 'hamza', qa: false, accountId: 'hamza' },
];
const me = { accountId: 'me', login: 'fahmed' };
const history = (by, name, at, from, to) => ({ created: at, author: { accountId: by, displayName: name }, items: [{ field: 'status', fromString: from, toString: to }] });
const comment = (by, name, at, text) => ({ author: name, authorId: by, created: at, text });
const baseInput = (o = {}) => ({
  me, people, tickets: [], prs: [], allPrs: [], merged: [], teamTickets: [],
  changelogs: new Map(), comments: new Map(), buildComments: new Map(), behind: new Map(), now: NOW, ...o,
});
const row = (o) => ({ key: KEY, summary: 's', stageIndex: 1, stageLabel: 'In Progress', tone: 'now', pr: null,
  blocker: { kind: 'no-pr', text: 'No PR yet.', quote: null, detail: null }, action: { kind: 'open-ticket', label: 'Open ticket', key: KEY }, ...o });

// ---------- feed ----------

test('feed shows only other people, newest first, since the given time', () => {
  const input = baseInput({
    changelogs: new Map([[KEY, [history('sana', 'Sana Ali', ago(2), 'QA Review', 'In Progress'), history('me', 'Foad', ago(1), 'In Progress', 'Dev Review')]]]),
    comments: new Map([[KEY, [comment('sana', 'Sana Ali', ago(3), 'still shows'), comment('me', 'Foad', ago(1), 'fixed'), comment('hamza', 'Hamza Ashfaq', ago(30), 'old')]]]),
    prs: [{ number: 1101, title: 'x', url: 'u', reviews: [{ by: 'hamza', state: 'APPROVED', at: ago(4), body: '' }, { by: 'fahmed', state: 'COMMENTED', at: ago(1), body: 'x' }] }],
  });
  const items = feedItems(input, { sinceMs: NOW - 24 * 36e5 });
  assert.deepEqual(items.map((i) => [i.who, i.kind, i.text]), [
    ['Sana', 'status', `moved ${KEY} to In Progress`],
    ['Sana', 'comment', `commented on ${KEY}`],
    ['Hamza', 'approved', 'approved #1101'],
  ]);
  assert.equal(items[1].quote, 'still shows');
});

test('quotes are plain and clipped', () => {
  const at = ago(1);
  const one = (text) => feedItems(baseInput({ comments: new Map([[KEY, [comment('sana', 'Sana Ali', at, text)]]]) }), { sinceMs: 0 })[0];
  assert.equal(one(`<img src=x onerror=alert(1)>\n${'a'.repeat(300)}`).quote, '<img src=x onerror=alert(1)>');
  const long = one('a'.repeat(300)).quote;
  assert.equal(long.length, 140);
  assert.ok(long.endsWith('…'));
});

test('changes requested on my PR shows the review body', () => {
  const input = baseInput({ prs: [{ number: 1099, title: 'x', url: 'u', reviews: [{ by: 'hamza', state: 'CHANGES_REQUESTED', at: ago(2), body: 'use the token' }] }] });
  const [item] = feedItems(input, { sinceMs: 0 });
  assert.deepEqual([item.who, item.kind, item.text, item.quote, item.pr], ['Hamza', 'review', 'asked for changes on #1099', 'use the token', 1099]);
});

// ---------- headline ----------

const shiftMid = { moment: 'mid', phase: 'during' };
const headline = (o = {}) => pickHeadline({ rows: [], builds: [], meetings: [], reviews: [], wrap: [], shift: shiftMid, now: NOW, ...o });
const failedBuild = { label: 'Android Mobile Kiosk', status: 'completed', conclusion: 'failure', retries: 2, maxRetries: 2,
  classification: { kind: 'infra' }, triggeredAt: NOW - 36e5, runId: 77, reason: { lines: ['Gradle: daemon disappeared'] } };
const bounceRow = row({ tone: 'bad', blocker: { kind: 'qa-bounce', who: 'Sana', text: 'Sana sent it back:', quote: 'still shows', detail: null } });
const qaRow = row({ key: 'TCPMOB-1768', blocker: { kind: 'qa-missing-platform', who: 'Sana', build: '412', missing: 'iOS', text: 't', quote: null, detail: null },
  action: { kind: 'build', label: 'Build iOS', pr: 1101, keys: ['mcIos'] } });
const soon = { title: 'Standup', start: new Date(+NOW + 10 * 60000).toISOString(), end: new Date(+NOW + 25 * 60000).toISOString() };

test('headline order: failed build beats bounce beats QA testing beats meeting', () => {
  assert.equal(headline({ builds: [failedBuild], rows: [bounceRow, qaRow], meetings: [soon] }).text, 'Android Mobile Kiosk failed after 2 retries.');
  assert.equal(headline({ rows: [qaRow, bounceRow], meetings: [soon] }).text, `Sana sent ${KEY} back.`);
  const qa = headline({ rows: [qaRow], meetings: [soon] });
  assert.equal(qa.text, 'Sana is testing your TCPMOB-1768 right now.');
  assert.equal(qa.sub, 'Build 412 is with them. Start the iOS build so they can test both platforms this shift.');
  assert.deepEqual(qa.action, qaRow.action);
  assert.equal(headline({ meetings: [soon] }).text, 'Standup in 10 min.');
});

test('a review waiting on me, then wrap-up count', () => {
  const reviews = [{ pr: 1105, author: 'Raja', title: 't', url: 'u' }];
  assert.equal(headline({ reviews }).text, 'Raja is waiting on your review of #1105.');
  const wrap = [{ id: 'a', done: false }, { id: 'b', done: false }, { id: 'c', done: true }];
  assert.equal(headline({ wrap, shift: { moment: 'wrap', phase: 'during' } }).text, '2 things before you log off.');
});

test('headline falls back to "Nothing\'s stuck."', () => {
  const quiet = headline({ rows: [row()] });
  assert.equal(quiet.text, "Nothing's stuck.");
  assert.equal(quiet.sub, `${KEY}: No PR yet.`);
  assert.deepEqual(quiet.action, row().action);
  assert.equal(headline().sub, 'No tickets assigned to you right now.');
});

// ---------- wrap-up ----------

const refs = (stdout) => async (file, args) => {
  if (args.includes('for-each-ref')) return { stdout, stderr: '', code: 0 };
  if (args.includes('rev-list')) return { stdout: '3\n', stderr: '', code: 0 };
  return { stdout: '', stderr: '', code: 1 };
};

test('unpushed branches parse ahead counts and skip non-ticket, gone, and stale branches', async () => {
  const fresh = Math.floor(NOW / 1000) - 3600;
  const stale = Math.floor(NOW / 1000) - 15 * 86400;
  const out = [
    `TCPMOB-1482-load-more\torigin/TCPMOB-1482-load-more\t[ahead 2]\t${fresh}`,
    `TCPMOB-1768-csso\torigin/TCPMOB-1768-csso\t\t${fresh}`,
    `TCPMOB-1500-old\torigin/TCPMOB-1500-old\t[gone]\t${fresh}`,
    `TCPMOB-961-ancient\torigin/TCPMOB-961-ancient\t[ahead 1]\t${stale}`,
    `develop\torigin/develop\t[ahead 1]\t${fresh}`,
    `TCPMOB-1772-new\t\t\t${fresh}`,
  ].join('\n');
  assert.deepEqual(await unpushedBranches(refs(out), '/repo', NOW), [
    { branch: 'TCPMOB-1482-load-more', key: 'TCPMOB-1482', ahead: 2 },
    { branch: 'TCPMOB-1772-new', key: 'TCPMOB-1772', ahead: 3 },
  ]);
  assert.deepEqual(await unpushedBranches(async () => ({ stdout: '', stderr: 'boom', code: 128 }), '/repo', NOW), []);
});

test('wrap checklist: push items copy the command, hours done when confirmed, ready-for-QA asks', () => {
  const unpushed = [{ branch: 'TCPMOB-1482-load-more', key: KEY, ahead: 2 }];
  const ready = row({ key: 'TCPMOB-1768', blocker: { kind: 'ready-for-qa', text: 't' }, action: { kind: 'request-qa', label: 'Request QA', key: 'TCPMOB-1768' } });
  const items = wrapChecklist({ unpushed, hoursPending: true, rows: [ready, row()] });
  assert.deepEqual(items.map((i) => [i.title, i.done]), [
    [`Push ${KEY} and open the PR`, false],
    ['Ask QA to test TCPMOB-1768', false],
    ["Confirm today's hours", false],
  ]);
  assert.deepEqual(items[0].action, { kind: 'copy', label: 'Copy push command', text: 'git push -u origin TCPMOB-1482-load-more' });
  assert.equal(items[0].sub, '2 commits only on this Mac. Push so your reviewer has it next shift.');
  assert.equal(wrapChecklist({ unpushed: [], hoursPending: false, rows: [] })[0].done, true);
});

// ---------- standup ----------

test('standup lists yesterday by ticket and says "Nothing." when unblocked', () => {
  const input = baseInput({
    changelogs: new Map([[KEY, [history('me', 'Foad', ago(20), 'In Progress', 'Dev Review')]]]),
    prs: [{ number: 1101, title: `${KEY} x`, headRefName: `${KEY}-x`, createdAt: ago(10), reviews: [] }],
    buildComments: new Map([[KEY, [{ number: '412', platform: 'Android', app: 'MobileClock', created: ago(5) }]]]),
  });
  const commits = [{ key: KEY, at: ago(22) }, { key: KEY, at: ago(21) }, { key: 'TCPMOB-9', at: ago(40) }];
  const draft = standupDraft({ input, rows: [row(), row({ key: 'TCPMOB-2', stageLabel: 'To Do', blocker: { kind: 'todo' } })], commits, sinceMs: NOW - 24 * 36e5 });
  assert.equal(draft.yesterday, `${KEY}: 2 commits, moved to Dev Review, opened PR #1101, build 412.`);
  assert.equal(draft.today, `${KEY} (In Progress), TCPMOB-2 (To Do).`);
  assert.equal(draft.blocked, 'Nothing.');
  const waiting = standupDraft({ input: baseInput(), rows: [row({ blocker: { kind: 'waiting-review', text: "Waiting on Hamza's review" } })], commits: [], sinceMs: 0 });
  assert.equal(waiting.yesterday, 'Nothing logged.');
  assert.equal(waiting.blocked, `${KEY}: Waiting on Hamza's review.`);
});

// ---------- team ----------

test('team puts you first and says "Testing TCPMOB-1768" for QA', () => {
  const teamTickets = [
    { key: 'TCPMOB-1768', status: 'QA Review', assignee: { accountId: 'sana' } },
    { key: 'TCPMOB-1735', status: 'In Progress', assignee: { accountId: 'hamza' } },
  ];
  const team = teamOnShift({ people, me, rows: [row()], teamTickets, allPrs: [], shift: shiftMid });
  assert.deepEqual(team.map((t) => [t.name, t.you, t.qa, t.doing, t.onShift]), [
    ['You', true, false, `${KEY} · In Progress`, true],
    ['Sana Ali', false, true, 'Testing TCPMOB-1768', true],
    ['Hamza Ashfaq', false, false, 'TCPMOB-1735 · In Progress', true],
  ]);
  const reviewing = teamOnShift({ people: [people[1]], me, rows: [], teamTickets: [], shift: shiftMid,
    allPrs: [{ reviewRequestedLogins: ['hamza'] }, { reviewRequestedLogins: ['hamza', 'x'] }] });
  assert.equal(reviewing[1].doing, 'Reviewing · 2 in queue');
  assert.equal(reviewing[0].doing, 'No ticket in progress');
});

test('nobody is on shift on Saturday, and no team means an empty list', () => {
  const team = teamOnShift({ people, me, rows: [], teamTickets: [], allPrs: [], shift: { moment: 'mid', phase: 'weekend' } });
  assert.ok(team.every((t) => t.onShift === false));
  assert.deepEqual(teamOnShift({ people: [], me, rows: [], teamTickets: [], allPrs: [], shift: shiftMid }), []);
});
