# Shift-Aware Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Home's long list of sections with the approved shift-aware layout: a calm hero (headline, on-shift team, 1–10 PM shift line with meetings), My Work blocker rows, a change feed, and start / mid / wrap-up cards.

**Architecture:** The server computes everything Home shows in one `GET /api/home` from pure modules in `lib/home/` (shift clock, work rows, feed, headline, wrap-up, standup, team), fed by data it already fetches (Jira, `gh`, build tracker, local git) plus a new macOS Calendar reader (`lib/calendar.js` running a small EventKit Swift helper). The client keeps Home's existing sheets (builds, review request, QA request, Send to QA) and swaps its section renderers for card builders in `public/views/home-cards.js`.

**Tech Stack:** Node 20 ES modules, `node:test`, `execFile` (no shell), Swift/EventKit via `swiftc`, vanilla DOM via `el()`.

**Spec:** `docs/superpowers/specs/2026-11-13-shift-home-design.md` (mockup: `.superpowers/brainstorm/99544-1794571659/content/home-calm-v8.html`)

## Global Constraints

- Zero npm dependencies; Node 20; existing patterns: route tables `[method, regex, handler]` in `FEATURE_MODULES`, `HttpError`, `el()` with `textContent` only, `X-Dashboard` header
- Tests use `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off`, never touch real Jira/GitHub/Teams/Tempo or the real calendar; inject fakes (`exec`, `jira`, `gh`, `now`)
- Never write to the mobile-clock clone: git is read-only (`for-each-ref`, `log`); pushing is a **Copy push command** button
- Calendar data never reaches Time, Tempo, evidence, disk, logs, Jira, or Teams; meeting titles live only in memory and the `/api/home` response
- Nothing posts or transitions on its own: Standup, Note for Tomorrow, and wrap-up items are drafts or buttons; existing confirm sheets still apply
- Copy: AP Style, contractions, no first person, title-case headings; exact strings below are fixed
- Softened palette (take 6) on Home only, light and dark; reduced motion, reduced transparency, increased contrast, phone width (one column under 960px)
- No commits during execution: the user commits when asked. Each task ends with a ledger line instead.

## Review Focus

1. **No team list, no Jira, or no calendar set up:** Home still renders the hero, shift line, and My Work from whatever sources work; missing parts hide, never error (Task 5 test `home works with only GitHub`)
2. **Calendar helper fails** (permission denied, `swiftc` missing, timeout, garbage output): no meetings, `calendar: 'denied' | 'error'`, no crash, retried after 10 minutes (Task 2 tests)
3. **Shift boundaries:** 12:59, 13:00, 13:59, 14:00, 21:19, 21:20, 21:59, 22:00, 00:30, Saturday 15:00 each land in the right moment (Task 1 table test)
4. **Jira comment text with markup or many lines** shows as plain clipped text in feed bubbles and blockers (Task 4 test `quotes are plain and clipped`, plus CDP check in Task 6)
5. **A ticket that matches several blockers** shows exactly one, by the fixed priority (Task 3 test `one blocker per ticket by priority`)

---

### Task 1: Shift Clock and Settings

**Files:**
- Modify: `public/shared.js` (add `shiftState`), `lib/settings.js` (fields + checks), `public/views/settings.js` (Shift and Team rows)
- Test: `test/shift.test.js` (new), `test/settings.test.js`

**Interfaces:**
- Produces: `shiftState(now: Date, cfg: { start: 'HH:MM', end: 'HH:MM', wrapMinutes: number }) → { moment: 'start'|'mid'|'wrap', phase: 'before'|'during'|'after'|'weekend', progress: number /*0..1*/, minutesLeft: number, startsInMinutes: number|null, shiftStart: Date, shiftEnd: Date, prevShiftEnd: Date }`
- Produces settings (resolved shape): `shift: { start: '13:00', end: '22:00', wrapMinutes: 40 }`, `calendar: { on: false }`, `team: { people: Person[] }` where `Person = { name: string, github: string, jiraEmail: string, qa: boolean }`

- [ ] **Step 1: Write the failing tests**

`test/shift.test.js`, with `process.env.TZ = 'Asia/Karachi'` at the top and `cfg = { start: '13:00', end: '22:00', wrapMinutes: 40 }`:

```js
test('moments across the shift', () => {
  const at = (iso) => shiftState(new Date(iso), cfg);
  const rows = [
    ['2026-11-13T12:59:00+05:00', 'start', 'before'],
    ['2026-11-13T13:00:00+05:00', 'start', 'during'],
    ['2026-11-13T13:59:00+05:00', 'start', 'during'],
    ['2026-11-13T14:00:00+05:00', 'mid', 'during'],
    ['2026-11-13T21:19:00+05:00', 'mid', 'during'],
    ['2026-11-13T21:20:00+05:00', 'wrap', 'during'],
    ['2026-11-13T22:00:00+05:00', 'wrap', 'after'],
    ['2026-11-14T00:30:00+05:00', 'mid', 'weekend'],   // Saturday
    ['2026-11-16T00:30:00+05:00', 'start', 'before'],  // Monday after midnight
    ['2026-11-14T15:00:00+05:00', 'mid', 'weekend'],
  ];
  for (const [iso, moment, phase] of rows) assert.deepEqual([at(iso).moment, at(iso).phase], [moment, phase], iso);
});

test('progress, minutes left, and starts-in', () => {
  const mid = shiftState(new Date('2026-11-13T17:30:00+05:00'), cfg);
  assert.equal(mid.progress, 0.5);
  assert.equal(mid.minutesLeft, 270);
  const early = shiftState(new Date('2026-11-13T11:00:00+05:00'), cfg);
  assert.equal(early.startsInMinutes, 120);
  assert.equal(early.progress, 0);
});

test('prevShiftEnd is the last shift end before now, skipping weekends', () => {
  const monday = shiftState(new Date('2026-11-16T13:05:00+05:00'), cfg);
  assert.equal(monday.prevShiftEnd.toISOString(), new Date('2026-11-13T22:00:00+05:00').toISOString());
});
```

In `test/settings.test.js`:

```js
test('shift and team settings validate', () => {
  assert.equal(validateSettingsPatch({ shift: { start: '22:00', end: '13:00' } }).shift, 'Shift must end after it starts, on the same day.');
  assert.equal(validateSettingsPatch({ shift: { wrapMinutes: 5 } })['shift.wrapMinutes'], 'Wrap-up must be 15–120 minutes.');
  assert.equal(validateSettingsPatch({ team: { people: [{ name: 'Sana', github: 'bad login!', jiraEmail: 's@x.co', qa: true }] } })['team.people'],
    'Each teammate needs a name, a GitHub login, and a Jira email.');
  assert.deepEqual(validateSettingsPatch({ team: { people: [{ name: 'Sana', github: 'sana-q', jiraEmail: 's@x.co', qa: true }] } }), {});
});
```

(Use the existing error-map shape `validateSettingsPatch` returns; the cross-field shift check reports under the key `shift`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off node --test test/shift.test.js test/settings.test.js`
Expected: FAIL, `shiftState` is not exported; unknown setting paths

- [ ] **Step 3: Implement**

- `shiftState` in `public/shared.js` (shared with the client so the shift line ticks without a refetch). Weekend = Saturday or Sunday in local time. `start` moment = phase `before`, or the first 60 minutes of `during`. `wrap` = the last `wrapMinutes` of `during`, or phase `after` (until local midnight). Progress is clamped 0..1 and rounded to 3 decimals.
- Settings fields: `shift.start` and `shift.end` (def `'13:00'`, `'22:00'`, `TIME_OF_DAY` check), `shift.wrapMinutes` (def 40, integer 15–120), `calendar.on` (def `false`, `bool`), `team.people` (def `[]`; each needs a non-empty `name` ≤ 60 chars, `LOGIN` github, `EMAIL` jiraEmail, boolean `qa`; at most 20). Cross-field: end must be later than start.
- Settings UI: a **Shift** group (start, end, wrap-up minutes, calendar switch with an info tip: "Reads meetings from the Calendar app on this Mac. Titles stay on this Mac and aren't used for Time. macOS asks for permission once.") and a **Team** group (rows of name, GitHub login, Jira email, QA checkbox; Add and Remove; info tip: "Used for On Shift Now and to recognize QA on your tickets.").

- [ ] **Step 4: Run tests to verify they pass**

Run: `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off npm test`
Expected: all pass

- [ ] **Step 5: Ledger** (no commit)

---

### Task 2: Calendar Reader

**Files:**
- Create: `tools/calendar.swift`, `lib/calendar.js`
- Test: `test/calendar.test.js`

**Interfaces:**
- Produces: `createCalendar({ exec, cacheDir, now = () => Date.now(), enabled: () => boolean }) → { meetings(fromIso: string, toIso: string): Promise<Meeting[]>, status(): 'off'|'ok'|'denied'|'error' }` where `Meeting = { title: string, start: string /*ISO*/, end: string }`
- `exec(file: string, args: string[], { timeout }) → Promise<{ stdout: string }>` (rejects with `{ code }` on non-zero exit), same shape as `lib/time/git.js` `defaultExec`

- [ ] **Step 1: Write the failing tests** (`test/calendar.test.js`, fake `exec` records calls)

```js
test('compiles once, then runs the binary and keeps timed meetings only', async () => {
  const out = JSON.stringify([
    { title: 'Standup', start: '2026-11-13T14:30:00Z', end: '2026-11-13T14:45:00Z', allDay: false, canceled: false, declined: false },
    { title: 'Holiday', start: '2026-11-13T00:00:00Z', end: '2026-11-14T00:00:00Z', allDay: true, canceled: false, declined: false },
    { title: 'Old sync', start: '2026-11-13T16:30:00Z', end: '2026-11-13T17:00:00Z', allDay: false, canceled: true, declined: false },
    { title: 'Declined', start: '2026-11-13T15:00:00Z', end: '2026-11-13T15:30:00Z', allDay: false, canceled: false, declined: true },
  ]);
  const { exec, calls } = fakeExec({ swiftc: '', calendar: out });
  const cal = createCalendar({ exec, cacheDir, enabled: () => true });
  assert.deepEqual(await cal.meetings(FROM, TO), [{ title: 'Standup', start: '2026-11-13T14:30:00Z', end: '2026-11-13T14:45:00Z' }]);
  await cal.meetings(FROM, TO);
  assert.equal(calls.filter((c) => c.file === 'swiftc').length, 1);
  assert.equal(calls.filter((c) => c.file.endsWith('calendar-helper')).length, 1, 'cached for 5 minutes');
  assert.equal(cal.status(), 'ok');
});

test('denied permission is "denied", with no meetings and no throw', ...)   // helper exits code 2
test('swiftc missing, a timeout, or bad JSON is "error", with no meetings', ...)
test('after an error it retries only once 10 minutes have passed', ...)      // fake now
test('off means no exec at all', ...)                                         // enabled: () => false → status 'off'
test('titles are clipped to 80 characters', ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/calendar.test.js`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

- `tools/calendar.swift`: args `<fromISO> <toISO>`; `requestFullAccessToEvents`; denied → print `NO_ACCESS` to stderr, exit 2; else print one JSON array of `{ title, start, end, allDay, canceled: status == .canceled, declined: (attendees where isCurrentUser).participantStatus == .declined }` using `ISO8601DateFormatter`, all calendars, `predicateForEvents` (expands repeats).
- `lib/calendar.js`: compile with `swiftc -O tools/calendar.swift -o <cacheDir>/calendar-helper` when the binary is missing or older than the source (timeout 120 s); run it with timeout 15 s; cache results per `from|to` for 5 minutes; on error keep `[]` and back off 10 minutes. Never log titles.
- Wire in `server.js`: `ctx.calendar ??= createCalendar({ exec: defaultExec, cacheDir: CACHE_DIR, enabled: () => ctx.settings.resolved().calendar.on })`.

- [ ] **Step 4: Run tests, then the full suite**

Run: `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off npm test`
Expected: all pass

- [ ] **Step 5: Ledger** (no commit)

---

### Task 3: My Work Rows

**Files:**
- Create: `lib/home/work.js` (pure), `lib/home/sources.js` (loads inputs, cached 60 s)
- Modify: `lib/jira.js` (add `userByEmail(email)`), `lib/prs.js` (keep failing check names and the latest CHANGES_REQUESTED review body on each PR)
- Test: `test/home-work.test.js`

**Interfaces:**
- Consumes: `parseBuildComments` (`lib/tickets.js`), `listPrs` / `listMergedPrs`, tracker `list()`, behind cache `get(pr)`, `jira.search`, `jira.changelog`, `jira.comments`
- Produces: `workRows(input: WorkInput) → WorkRow[]` and `loadHomeSources(ctx) → Promise<{ input: WorkInput, errors: { jira?: string, github?: string } }>`
- `WorkInput = { me: { accountId, login }, people: ResolvedPerson[], tickets: Ticket[] /*{key, summary, status, url, assigneeId}*/, prs: Pr[] /*open, mine*/, merged: MergedPr[] /*mine, last 14 days*/, builds: TrackerBuild[], buildComments: Map<key, Build[]>, changelogs: Map<key, History[]>, comments: Map<key, Comment[]>, behind: Map<prNumber, number>, now: Date }`
- `ResolvedPerson = Person & { accountId: string|null }`
- `WorkRow = { key, summary, url, stageIndex: 0..4, stageLabel: string, tone: 'ok'|'now'|'wait'|'bad', blocker: { kind: BlockerKind, text: string, quote: string|null }, action: Action|null, pr: number|null }`
- `Action = { kind: 'build'|'request-qa'|'open-url'|'update-branch'|'start'|'open-ticket', label: string, pr?: number, keys?: string[], url?: string, key?: string }`
- Stages (index, label): 0 To Do, 1 In Progress, 2 In Review, 3 Building, 4 In QA. QA status = any status name matching `/QA/i` (e.g. `QA Review`).

Blocker priority (first match wins) and fixed copy (`{who}` is the person's first name, or "QA" / "Someone" when unknown):

| Kind | Condition | Text | Action |
|---|---|---|---|
| `qa-bounce` | status moved from a QA status to In Progress / To Do by someone else in the last 3 days | `{who} sent it back:` + quote of their newest comment after that change | `open-url` "Open PR" (or "Open ticket" with no PR) |
| `checks-failed` | my open PR has `checks === 'failure'` | `Checks failed · {names joined by ", "}` (+ ` · {n} behind develop` when behind > 0) | `update-branch` "Update branch" when behind > 0, else `open-url` "Open checks" |
| `changes-requested` | `reviewDecision === 'CHANGES_REQUESTED'` | `{who} asked for changes` + quote of review body | `open-url` "Open review" |
| `merged-not-built` | in a QA status, merged PR, no build comment after `mergedAt` | `Merged {n} days ago, no build since.` + `QA's latest build doesn't have the fix.` | `open-ticket` "Open ticket" |
| `qa-missing-platform` | in a QA status and the ticket's app (from build comments) has a build for one platform only | `{who} is testing build {n} ({Platform}). No {Other} build yet.` | `build` "Build {Other}" (pr, keys) |
| `qa-testing` | in a QA status | `{who} is testing build {n}.` (`With QA.` when no build) | `open-ticket` "Open ticket" |
| `behind` | open PR, checks not failed, behind > 0 | `{n} behind develop` | `update-branch` "Update branch" |
| `ready-for-qa` | Dev Review, PR approved, has a build | `Approved with build {n}. Ready for QA.` | `request-qa` "Request QA" |
| `needs-build` | PR approved, no build | `Approved. No build yet.` | `build` "Build" |
| `waiting-review` | PR open with reviewers requested | `Waiting on {who}'s review` | `open-url` "Open PR" |
| `needs-review` | PR open, no reviewers, not draft | `No reviewer yet.` | `open-url` "Open PR" |
| `no-pr` | In Progress, no PR | `No PR yet.` | `open-ticket` "Open ticket" |
| `todo` | To Do / Open | `Not started.` | `start` "Start" |

Row order: `bad` tones first (bounce, checks, changes), then `wait`, then `now`, then `ok`; ties by ticket key descending.

- [ ] **Step 1: Write the failing tests** (`test/home-work.test.js`, builders for tickets, PRs, histories)

```js
test('one blocker per ticket by priority', () => {
  // ticket bounced by QA AND its PR has failed checks AND is behind
  const [row] = workRows(input({ bounced: true, checks: 'failure', behind: 9 }));
  assert.equal(row.blocker.kind, 'qa-bounce');
  assert.equal(row.blocker.text, 'Sana sent it back:');
  assert.equal(row.blocker.quote, 'still shows on empty filter');
  assert.equal(row.tone, 'bad');
});
test('QA testing with one platform built names the missing one', () => {
  const [row] = workRows(input({ status: 'QA Review', builds: [android(412)] , qaAssignee: 'Sana' }));
  assert.equal(row.blocker.text, 'Sana is testing build 412 (Android). No iOS build yet.');
  assert.deepEqual(row.action, { kind: 'build', label: 'Build iOS', pr: 1101, keys: ['mcIos'] });
});
test('merged with no build since offers Open ticket', ...)   // mergedAt 5 days ago → 'Merged 5 days ago, no build since.'
test('failed checks name the checks and offer Update branch when behind', ...) // 'Checks failed · eslint, unit · 9 behind develop'
test('stage index and label follow status and PR', ...)       // To Do 0, In Progress no PR 1, PR open 2, approved+building 3, QA 4
test('rows sort bad, wait, now, ok', ...)
test('my own status change back to In Progress is not a bounce', ...)
```

- [ ] **Step 2: Run to verify they fail** — `node --test test/home-work.test.js` → FAIL, module not found

- [ ] **Step 3: Implement**

- `workRows` per the table. Quotes: first non-empty line, plain text, clipped to 140 chars with `…`.
- `loadHomeSources(ctx)`: tickets from one JQL, `project = TCPMOB AND ((assignee = currentUser() AND status in ("To Do","Open","In Progress","Dev Review")) OR (assignee was currentUser() AND status in ("QA Review") AND updated >= -14d))`, plus the keys of my open PRs and PRs merged in the last 14 days (fetched by key). Changelog and comments per key with concurrency 4, cached 60 s per key. People resolved with `jira.userByEmail` (`GET /rest/api/3/user/search?query=<email>`, first `accountId`), cached for the process. GitHub and Jira failures go to `errors` and leave their inputs empty.
- `lib/prs.js`: add `failedChecks: string[]` (rollup names whose result is in `FAILED`) and `changesBody: string|null` (newest `CHANGES_REQUESTED` review body) and `reviewers: string[]` (logins who reviewed). `latestReviews` already includes `body` and `author`.

- [ ] **Step 4: Run the full suite** — expected: all pass

- [ ] **Step 5: Ledger** (no commit)

---

### Task 4: Feed, Headline, Wrap-Up, Standup, Team

**Files:**
- Create: `lib/home/feed.js`, `lib/home/headline.js`, `lib/home/wrap.js`, `lib/home/standup.js`, `lib/home/team.js` (all pure except the git read in `wrap.js`)
- Test: `test/home-parts.test.js`

**Interfaces:**
- Consumes: `WorkInput`, `WorkRow[]`, `shiftState`, `Meeting[]`
- Produces:
  - `feedItems(input: WorkInput, { sinceMs: number }) → FeedItem[]` newest first, max 20; `FeedItem = { at, who, kind: 'status'|'comment'|'review'|'approved', key: string|null, pr: number|null, text: string, quote: string|null }`; only other people's actions
  - `pickHeadline({ rows, builds, meetings, waiting, wrap, shift, now }) → { text, sub, action: Action|null, secondary: Action|null }`
  - `unpushedBranches(exec, repoPath) → Promise<{ branch, key, ahead }[]>` (runs `git for-each-ref refs/heads --format=%(refname:short)%09%(upstream:short)%09%(upstream:track)`; TCPMOB branches with `[ahead N]`, or no upstream and commits not on `origin/develop`)
  - `wrapChecklist({ unpushed, hoursPending: boolean, rows }) → CheckItem[]`; `CheckItem = { id, done: boolean, title, sub, action: Action|{ kind: 'copy', label: 'Copy push command', text: string } }`
  - `standupDraft({ input, rows, sinceMs }) → { yesterday: string, today: string, blocked: string }`
  - `teamOnShift({ people, me, tickets: TeamTicket[], prs, shift }) → { name, you: boolean, qa: boolean, doing: string }[]`

Headline order (first match wins), with fixed copy:

1. one of my builds failed after retries → `{label} failed after {n} retries.` / sub = reason line / `Details` (scroll) + `Rerun`
2. a row with `qa-bounce` or `changes-requested` newer than last seen → `{who} sent {key} back.` or `{who} asked for changes on #{pr}.` / sub = quote / row action
3. a row with `qa-missing-platform` → `{who} is testing your {key} right now.` / `Build {n} is with them. Start the {Other} build so they can test both platforms this shift.` / row action + `Open ticket`
4. a meeting starts within 15 minutes → `{title} in {m} min.` / no action
5. a review is waiting on me → `{author} is waiting on your review of #{pr}.` / `Open`
6. moment `wrap` with open checklist items → `{n} things before you log off.` / `Start checklist` (scroll)
7. otherwise → `Nothing's stuck.` / sub = top row's blocker text / top row's action

Team "doing" text: QA person with a QA-status ticket assigned → `Testing {key}` (+ ` on build {n}` when known); In Progress ticket → `{key} · In Progress`; review requests waiting on them → `Reviewing · {n} in queue`; otherwise `No ticket in progress`. The user is first, as `You`. Everyone is on the same shift (Task 1 settings); outside the shift nobody shows a green dot (`onShift: false`).

Standup: `yesterday` lists keys with my commits, status changes, PRs, or builds since `sinceMs` (the previous standup meeting's start, else `prevShiftEnd − 9h`), one clause each; `today` = top 3 rows' action labels with keys; `blocked` = rows in `waiting-review` older than 1 day, else `Nothing.`. Built only from Jira changes, commits, PRs, builds; never Claude chat text.

- [ ] **Step 1: Write the failing tests** (`test/home-parts.test.js`)

```js
test('feed shows only other people, newest first, since the given time', ...)
test('quotes are plain and clipped', () => {
  const [item] = feedItems(inputWithComment(`<img src=x onerror=alert(1)>\n${'a'.repeat(300)}`), { sinceMs: 0 });
  assert.equal(item.quote, '<img src=x onerror=alert(1)>');           // first line, verbatim text
  const [long] = feedItems(inputWithComment('a'.repeat(300)), { sinceMs: 0 });
  assert.equal(long.quote.length, 140);
  assert.ok(long.quote.endsWith('…'));
});
test('headline order: failed build beats bounce beats QA testing beats meeting', ...)
test('headline falls back to "Nothing\'s stuck."', ...)
test('unpushed branches parse ahead counts and skip non-ticket branches', ...)   // fake exec output with tabs
test('wrap checklist marks pushed branches and confirmed hours done', ...)
test('push item copies "git push -u origin <branch>"', ...)
test('standup lists yesterday by ticket and says "Nothing." when unblocked', ...)
test('team puts you first and says "Testing TCPMOB-1768 on build 412" for QA', ...)
test('nobody is on shift on Saturday', ...)
```

- [ ] **Step 2: Run to verify they fail** — `node --test test/home-parts.test.js` → FAIL, modules not found

- [ ] **Step 3: Implement** the five modules per the interfaces and copy above. `unpushedBranches` uses `execFile('git', ['-C', repoPath, ...])` with a 10 s timeout and returns `[]` on any error.

- [ ] **Step 4: Run the full suite** — expected: all pass

- [ ] **Step 5: Ledger** (no commit)

---

### Task 5: Home API and Store

**Files:**
- Create: `lib/home/routes.js` (register as `home` in `FEATURE_MODULES`), `lib/home/store.js`
- Test: `test/home-routes.test.js`

**Interfaces:**
- Consumes: Tasks 1–4
- Produces:
  - `GET /api/home` → `{ now, shift: ShiftConfig & ShiftState, meetings: Meeting[], calendar: 'off'|'ok'|'denied'|'error', team: TeamRow[], work: WorkRow[], feed: (FeedItem & { unread: boolean })[], headline, wrap: CheckItem[], standup: Standup|null, note: { text, savedAt }|null, plan: Action[] /*top 3 rows' actions*/, waiting: { reviews: { pr, author, title, url, since }[], hoursPending: number }, errors: { jira?, github?, calendar? } }`
  - `POST /api/home/seen` → `{ lastSeen }` (sets now); `PUT /api/home/note` body `{ text }` (≤ 1000 chars, plain) → `{ note }`
  - `ctx.homeNow ??= () => new Date()` (injectable for tests and the CDP fake server)
  - Store file `DATA_DIR/home.json` via `createStore`: `{ lastSeen: ms, note: { text, savedAt } }`

Response rules: `standup` only when today has a meeting whose title matches `/stand-?up/i` and it hasn't ended; feed covers the last 48 h with `unread = at > lastSeen`; `note` shows during moment `start` only; wrap checklist only in moment `wrap`; meetings only when `calendar.on`. The whole response is cached 30 s except `shift` (always fresh).

- [ ] **Step 1: Write the failing tests** (`test/home-routes.test.js`, fake jira/gh/exec/calendar, `homeNow` fixed)

```js
test('home returns shift, work, and feed in one call', ...)
test('home works with only GitHub', async () => {
  // no jira, no team, calendar off
  const body = (await req('GET', '/api/home')).json();
  assert.equal(body.calendar, 'off');
  assert.deepEqual(body.team, []);
  assert.ok(Array.isArray(body.work));
  assert.ok(body.errors.jira);
});
test('seen marks the feed read', ...)
test('note is saved, trimmed, limited to 1000 characters, and shown at shift start only', ...)
test('standup appears only before a standup meeting today', ...)
test('meeting titles never reach the time store or logs', ...)   // spy console + read timeDir files after /api/home
```

- [ ] **Step 2: Run** — `node --test test/home-routes.test.js` → FAIL
- [ ] **Step 3: Implement** the routes and store
- [ ] **Step 4: Run the full suite** — all pass
- [ ] **Step 5: Ledger** (no commit)

---

### Task 6: Home Page

**Files:**
- Create: `public/views/home-cards.js` (card builders)
- Modify: `public/views/home.js` (load `/api/home`, render cards, keep sheets), `public/style.css` (hero, shift line, work rows, feed, checklist, softened palette scoped to `.home`), `public/palette.js` (Copy push command not needed; keep ⌘K Lookup), `README.md`
- Verify: CDP script against a fake server (scratchpad), no unit tests (no DOM harness)

**Interfaces:**
- Consumes: `/api/home`, `shiftState`, existing `openBuildSheet`, `requestQa`, `sendToQa`, `requestReview`, `openTicketPanel`, `ticketLink`, `buildChip`, `confirmSheet`, `toast`
- Produces (in `home-cards.js`, each returns a DOM node or null): `heroCard(home, handlers)`, `shiftLine(shift, meetings)`, `workCard(rows, handlers)`, `feedCard(items, { title, onMarkRead })`, `buildsCard(builds, handlers)`, `waitingCard(waiting, handlers)`, `todayCard(meetings, shift)`, `planCard(plan, handlers)`, `standupCard(standup)`, `wrapCard(items, handlers)`, `noteCard(note, onSave)`, `moreSection(prs, runs)`

Layout by moment (My Work always): start → Since Last Shift (`feed` items after `prevShiftEnd`), Today's Shift, Plan for This Shift, Note for Tomorrow (when saved); mid → Since You Last Looked, Builds, Standup at {time} (when present), Waiting on You; wrap → Before You Log Off, Note for Tomorrow (editable). A collapsed **More** disclosure at the bottom keeps the full PR list (Mine / Review Requested) and Actions, so no current feature is lost. Needs Attention and Build Lookup sections are removed from Home (Lookup stays in ⌘K).

Behavior: clicking a work row (outside its button) opens the ticket panel; the shift line re-renders every 30 s from `shiftState` on the client; Since You Last Looked posts `/api/home/seen` after it has been visible 5 s or on **Mark read**; **Copy push command** uses `navigator.clipboard.writeText` with a toast "Copied. Run it in your terminal."; Note for Tomorrow saves on blur; Standup **Copy** copies plain text. Freshness label on the hero ("Updated N min ago") from the response time.

- [ ] **Step 1: Build the fake server** in the scratchpad: `createServer` with fake gh/jira/tracker, a fake calendar (Standup 19:30, Release sync 21:30), a team of Sana (QA), Hamza, Raja, and `ctx.homeNow` read from `process.env.FAKE_NOW`
- [ ] **Step 2: Implement** `home-cards.js`, rewire `home.js`, add styles
- [ ] **Step 3: Verify with CDP** at `FAKE_NOW` 13:05, 17:30, 21:20, 23:00, Saturday 15:00, light and dark, 1280 and 390 wide. Expected:
  - the right cards per moment; hero headline matches the Task 4 order
  - work row click opens the panel; its button does not
  - the comment `<img src=x onerror=alert(1)>` shows as text (0 `img` in feed, no dialog)
  - with calendar off: no meeting blocks, no errors
  - no console errors; screenshots saved for the user
- [ ] **Step 4: README** — a "Home" section: shift settings, Team setting, calendar permission, what each moment shows, and that calendar data never reaches Time
- [ ] **Step 5: Run the full suite** — `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off npm test` → all pass
- [ ] **Step 6: Ledger** (no commit)
