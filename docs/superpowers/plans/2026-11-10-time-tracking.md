# Time Tracking (Tempo Helper) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Time view that suggests believable hours per ticket per workday, summing to 7h minus leave, from Jira, git, and Claude evidence. The user confirms days, copies or exports them, and gets an 8:30 PM nudge.

**Architecture:**
- **Sources:** three read-only modules under `lib/time/` (Claude transcripts, git, Jira) turn evidence into per-day, per-ticket signals.
- **Logic:** a pure allocator turns signals into hours, and a JSON store keeps drafts, confirmations, leave, and the Claude daily snapshots.
- **Delivery:** routes follow the v2 `routes(ctx)` pattern, the page gets a `views/time.js`, and the server main schedules the snapshot job and the macOS reminder.

**Tech Stack:** Node 20 (`node:fs` streams, `readline`, `node:test`), `git`, Jira REST v3 (existing `lib/jira.js`), `osascript`, plain browser JS. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-time-tracking-design.md`. Read it with the v2 spec; all v1 and v2 constraints still apply.

## Global Constraints

- **No commits:** never run `git commit` or `git push`; each task ends with `git status`
- **Read-only:** no writes to Jira, GitHub, Tempo, or the `mobile-clock` working tree. Git commands against `MOBILE_CLOCK_PATH` are read-only.
- **Privacy:** no Claude message text is stored. Snapshots hold only session id, times, active minutes, weighted key counts, branch, and segments.
- **Day size:** a workday is Monday–Friday in local time, and its target is `7.0 − leaveHours`. Leave is set by hand in 0.5h steps, from 0 to 7. A day with 7h of leave is a leave day.
- **Rounding:** hours are in 0.5h steps; each shown ticket gets at least 0.5h; at most 5 tickets per day; the day total equals the target exactly
- **Signal weights:**
  - In Progress for any part of the day: 2
  - each non-merge commit: 1, capped at 5
  - Claude time: 1 per 30 active minutes, capped at 6
  - the user's own Jira comment or transition: 0.5 each, capped at 1
- **Active minutes:** gaps over 15 minutes between messages don't count
- **Mention weights:**
  - **Full (1):** user-typed text with `<system-reminder>…</system-reminder>` removed, assistant `text`, and assistant `tool_use` input (JSON-stringified)
  - **Light (0.1):** `tool_result` content
  - **Never counted:** `attachment`, `system`, `api-request*`, assistant `thinking`, and every other record type
- **Active window:** a ticket is in progress only while its status is `In Progress`; any move out ends the window
- **Excluded issue types:** `Epic` and `Initiative`. Merge commits are excluded. Sub-agent records (same `sessionId`, `isSidechain: true`) merge into their parent session.
- **Reminder:** `TIME_REMINDER` defaults to `'20:30'`, and `TIME_REMINDER=off` in `.env` disables it. It sends at most once per day, never for a confirmed day or a leave day, and catches up on server start.
- **Storage:** `data/time/confirmed.json` and `data/time/claude/YYYY-MM-DD.json`, under the gitignored `data/`
- **v1/v2 rules still hold:** `127.0.0.1` only, the Host and `X-Dashboard` checks, `execFile` with no shell, and `textContent` with no `innerHTML`

## Review Focus

1. **Local-day boundaries:** a commit at 11:30 PM local time is 05:30 UTC the next day. Expected: it counts on the local day. Tested in Task 2 with `process.env.TZ = 'America/Chicago'` set at the top of the test file.
2. **Leave squeezing tickets:** 6.5h leave with three active tickets. Expected: only the top ticket gets 0.5h; the total is still 7. Tested in Task 4.
3. **Malformed or huge transcript lines:** a truncated JSON line, or a 5 MB tool result. Expected: the line is skipped or streamed, and the scan finishes. Tested in Task 1.
4. **Bad writes from the page:** confirming a day whose hours don't match the target, a date in the future, a weekend, or an invalid key. Expected: 400 and nothing saved. Tested in Task 5.
5. **Missing sources:** Jira not configured, `MOBILE_CLOCK_PATH` missing, or no `~/.claude/projects`. Expected: the month still renders from whatever sources work, with a `sources` status the page shows once. Tested in Task 5.

---

## File Structure

```
lib/time/days.js        local-date helpers: dayKey(date), workdays(ym), isWorkday
lib/time/claude.js      transcript classify + session summary + daily snapshot store
lib/time/git.js         user's non-merge commits per local day with ticket key
lib/time/jira.js        tickets worked, In Progress windows, user's own activity per day
lib/time/allocate.js    signals → weights → hours (+ evidence text), rebalance with manual edits
lib/time/store.js       confirmed.json read/write, day validation
lib/time/routes.js      HTTP routes + month assembly (exports routes(ctx))
lib/time/reminder.js    shouldRemind() + scheduler (osascript)
lib/jira.js             (modify) changelog(key), comments() gains authorId
config.js               (modify) TIME_* constants
server.js               (modify) register routes, start snapshot job + reminder
public/views/time.js    Time view: day mode + month mode
public/views/home.js    (modify) "N days to confirm" tile
public/app.js           (modify) add Time view + badge
public/ui.js            (modify) new icons: calendar, leave
public/style.css        (modify) strip, stepper, month grid
test/time-*.test.js     one per lib/time module
```

---

### Task 1: Claude Transcript Summaries and Snapshots

**Files:**
- Create: `lib/time/days.js`, `lib/time/claude.js`
- Modify: `config.js` (add `CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')`, `TIME_DIR = path.join(DATA_DIR, 'time')`)
- Test: `test/time-days.test.js`, `test/time-claude.test.js`

**Interfaces:**
- Produces:
  - `days.js`:
    - `dayKey(date: Date|string) -> 'YYYY-MM-DD'` (local)
    - `isWorkday(dayKey) -> boolean`
    - `workdays(ym: 'YYYY-MM') -> string[]`
    - `monthRange(ym) -> { start: Date, end: Date }`
  - `claude.js`:
    - `mentionsIn(record) -> Array<{ key, weight }>`, using the Global Constraints weights and keys matching `/TCPMOB-\d+/gi` (uppercased)
    - `summarizeSessions(records) -> Map<dayKey, Session[]>`
      - `Session = { sessionId, start, end, activeMinutes, keyCounts: Record<key, number>, branch, segments: Array<{ key, start, end, activeMinutes }> }`
      - The key comes from `keyCounts`, falling back to the branch's key
    - `scanAll(dir) -> Promise<Map<dayKey, Session[]>>`: streams every `*.jsonl` under `dir` recursively with `readline`, skipping bad lines
    - `snapshot(dir, timeDir) -> Promise<{ days: number }>`: writes or updates `claude/<day>.json` and never deletes a file
    - `loadDay(timeDir, dayKey) -> Session[]`

- [ ] **Step 1: Write the failing tests**

```js
process.env.TZ = 'America/Chicago';
test('workdays lists Mon–Fri of November 2026', () => {
  const w = workdays('2026-11');
  assert.equal(w[0], '2026-11-02'); assert.equal(w.length, 21); assert.ok(!w.includes('2026-11-07'));
});
test('dayKey uses local time', () => { assert.equal(dayKey('2026-11-06T05:30:00Z'), '2026-11-05'); });

const u = (text, ts, extra = {}) => ({ type: 'user', sessionId: 's1', timestamp: ts, gitBranch: 'TCPMOB-1-old', message: { role: 'user', content: text }, ...extra });
test('mentionsIn weights by source and strips system reminders', () => {
  assert.deepEqual(mentionsIn(u('work on tcpmob-1480 <system-reminder>TCPMOB-9 TCPMOB-9</system-reminder>', 't')), [{ key: 'TCPMOB-1480', weight: 1 }]);
  assert.deepEqual(mentionsIn({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'git switch TCPMOB-1480-x' } }, { type: 'thinking', thinking: 'TCPMOB-2' }] } }), [{ key: 'TCPMOB-1480', weight: 1 }]);
  assert.deepEqual(mentionsIn({ type: 'user', message: { content: [{ type: 'tool_result', content: 'TCPMOB-3 TCPMOB-3' }] } }), [{ key: 'TCPMOB-3', weight: 0.1 }, { key: 'TCPMOB-3', weight: 0.1 }]);
  assert.deepEqual(mentionsIn({ type: 'attachment', attachment: { content: 'TCPMOB-4' } }), []);
});
test('session key is most-mentioned key, not branch; branch only as fallback', () => {
  const recs = [u('TCPMOB-1480', '2026-11-06T15:00:00Z'), u('TCPMOB-1480 again', '2026-11-06T15:10:00Z')];
  const [s] = summarizeSessions(recs).get('2026-11-06');
  assert.equal(s.segments[0].key, 'TCPMOB-1480');
  const [f] = summarizeSessions([u('no key here', '2026-11-06T15:00:00Z')]).get('2026-11-06');
  assert.equal(f.segments[0].key, 'TCPMOB-1');
});
test('active minutes ignore gaps over 15 minutes', () => {
  const [s] = summarizeSessions([u('TCPMOB-5', '2026-11-06T15:00:00Z'), u('x', '2026-11-06T15:10:00Z'), u('y', '2026-11-06T16:00:00Z')]).get('2026-11-06');
  assert.equal(s.activeMinutes, 10);
});
test('a session that switches tickets is split at the switch', () => {
  const recs = ['15:00', '15:05', '15:10'].map((t) => u('TCPMOB-10', `2026-11-06T${t}:00Z`))
    .concat(['15:20', '15:25', '15:30', '15:35'].map((t) => u('TCPMOB-11', `2026-11-06T${t}:00Z`)));
  const [s] = summarizeSessions(recs).get('2026-11-06');
  assert.deepEqual(s.segments.map((g) => g.key), ['TCPMOB-10', 'TCPMOB-11']);
});
test('sidechain records merge into their parent session', () => { /* two records, same sessionId, one isSidechain:true → one session */ });
test('scanAll skips malformed lines and streams large files', async () => {
  // write tmp dir/a.jsonl with: valid line, '{"type":"user", truncated', a 5 MB tool_result line, valid line → 1 session, no throw
});
test('snapshot writes per-day files, keeps days whose transcripts are gone, stores no message text', async () => {
  // snapshot once with a transcript; delete the transcript; snapshot again → file still there; JSON.stringify(file) does not include 'work on'
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL, the modules are missing.

- [ ] **Step 3: Implement.**
  - **Splitting:** walk records in time order and keep running per-key weight counts. A segment switch happens when a different key's running count, counted since the current segment began, overtakes the current segment's key.
  - **Days:** a session that spans midnight is split per local day.
  - **Snapshots:** writes merge, so new sessions are added and existing session ids are replaced.

- [ ] **Step 4: Run** `npm test`. Expected: all pass.

- [ ] **Step 5: Real-data check (read-only).** In a scratch script, run `scanAll(CLAUDE_PROJECTS_DIR)` and print, for each day, each session's top key and its active minutes, with no text. Expected: recent days show TCPMOB keys that match the user's tickets.

- [ ] **Step 6: Run** `git status`. Nothing committed.

---

### Task 2: Git Commits per Day

**Files:**
- Create: `lib/time/git.js`
- Test: `test/time-git.test.js`

**Interfaces:**
- Consumes: `dayKey`
- Produces:
  - `parseLog(stdout) -> Array<{ sha, at, day, key|null, subject }>`: input is `git log` output with the format `%H%x09%aI%x09%S%x09%s`. The key comes from the subject first, else from the `%S` source ref.
  - `commitsByDay(exec, repoPath, { since, until }) -> Promise<Map<day, Commit[]>>`
    - Runs `git -C repo config user.email`, then `git -C repo log --all --source --no-merges --author=<email> --since=<iso> --until=<iso> --format=...`
    - Deduplicates by sha
    - Returns an empty map, plus `error` set on the result, if the repo is missing

- [ ] **Step 1: Write the failing tests**

```js
process.env.TZ = 'America/Chicago';
test('subject key wins over branch key; late-night commit counts on the local day', () => {
  const out = 'aaa\t2026-11-05T23:30:00-06:00\trefs/heads/TCPMOB-1-old\tTCPMOB-2: start new ticket\n' +
              'bbb\t2026-11-06T10:00:00-06:00\trefs/remotes/origin/TCPMOB-3-x\tfix thing\n';
  const c = parseLog(out);
  assert.deepEqual(c.map((x) => [x.sha, x.day, x.key]), [['aaa', '2026-11-05', 'TCPMOB-2'], ['bbb', '2026-11-06', 'TCPMOB-3']]);
});
test('commitsByDay passes --no-merges and the author email, dedupes shas', async () => { /* fake exec; duplicate sha in output → one */ });
test('missing repo returns empty map with error', async () => {});
```

- [ ] **Steps 2–4:** run (FAIL), implement, run (PASS).

- [ ] **Step 5: Real-data check:** `commitsByDay` for November 2026 on `MOBILE_CLOCK_PATH` prints a count per day. Confirm the user's working tree and branch are unchanged.

- [ ] **Step 6:** `git status`.

---

### Task 3: Jira Windows and Own Activity

**Files:**
- Create: `lib/time/jira.js`
- Modify: `lib/jira.js`
  - add `changelog(key) -> Promise<History[]>`: `GET /rest/api/3/issue/K/changelog?startAt=&maxResults=100`, paged until `isLast`, returning `values`
  - `comments()` items gain `authorId`
- Test: `test/time-jira.test.js`, `test/jira.test.js` (add cases)

**Interfaces:**
- Produces:
  - `inProgressWindows(histories, nowIso) -> Array<{ start, end }>`: built from `items` where `field === 'status'`, with `toString === 'In Progress'` opening a window and any other `toString` closing it. An open window ends at `nowIso`.
  - `daysTouched(windows, workdays) -> Set<day>`
  - `ownActivityByDay(histories, comments, accountId) -> Map<day, number>`: counts the user's status changes and comments
  - `jiraByDay(jira, { ym, accountId, baseUrl }) -> Promise<{ tickets: Map<key, { key, summary, url, issueType }>, inProgressDays: Map<key, Set<day>>, activity: Map<key, Map<day, number>> }>`
    - JQL: `project = TCPMOB AND (assignee was currentUser() OR status changed BY currentUser()) AND updated >= "<month start>" AND issuetype not in (Epic, Initiative)`
    - Changelog and comments are fetched per ticket, at most 4 at a time

- [ ] **Step 1: Write the failing tests**

```js
process.env.TZ = 'America/Chicago';
const h = (created, from, to, id = 'me') => ({ created, author: { accountId: id }, items: [{ field: 'status', fromString: from, toString: to }] });
test('In Progress windows open and close on any move out, including back to To Do', () => {
  const w = inProgressWindows([h('2026-11-03T15:00:00Z', 'To Do', 'In Progress'), h('2026-11-04T18:00:00Z', 'In Progress', 'To Do'),
    h('2026-11-10T15:00:00Z', 'To Do', 'In Progress')], '2026-11-12T00:00:00Z');
  assert.deepEqual(w, [{ start: '2026-11-03T15:00:00Z', end: '2026-11-04T18:00:00Z' }, { start: '2026-11-10T15:00:00Z', end: '2026-11-12T00:00:00Z' }]);
});
test('daysTouched lists only workdays the window overlaps', () => {});
test('ownActivityByDay counts only my transitions and comments', () => {});
test('changelog pages until isLast', async () => {}); // in jira.test.js
```

- [ ] **Steps 2–4:** run (FAIL), implement, run (PASS).

- [ ] **Step 5: Real-data check (GET only):** run `jiraByDay` for 2026-11 and print the tickets with their In Progress days.

- [ ] **Step 6:** `git status`.

---

### Task 4: Allocation and Rebalancing

**Files:**
- Create: `lib/time/allocate.js`
- Modify: `config.js` (add `TIME_WEIGHTS = { inProgress: 2, commit: 1, commitCap: 5, claudePer30: 1, claudeCap: 6, activity: 0.5, activityCap: 1 }`, `TIME_DAY_HOURS = 7`, `TIME_MAX_TICKETS = 5`)
- Test: `test/time-allocate.test.js`

**Interfaces:**
- Produces:
  - `dayWeights({ inProgress: Set<key>, commits: Commit[], claude: Session[], activity: Map<key, number> }, excluded: Set<key>) -> Map<key, { weight, evidence: { commits, claudeMinutes, inProgress, activity } }>`
  - `allocate(weights: Map<key, number>, target: number) -> Array<{ key, hours }>`, sorted by hours descending
  - `rebalance(entries: Array<{ key, hours, manual }>, target) -> entries`: keeps manual hours and spreads the rest across the non-manual entries by their previous proportions. If the manual entries already exceed the target, it returns them unchanged and the page shows the mismatch.
  - `evidenceText(e) -> string`, for example `'4 commits · 1h 40m in Claude · In Progress · 1 Jira update'`

- [ ] **Step 1: Write the failing tests**

```js
test('allocate sums exactly to target in 0.5 steps, min 0.5, max 5 tickets', () => {
  const r = allocate(new Map([['A', 6], ['B', 1], ['C', 1], ['D', 1], ['E', 1], ['F', 1]]), 7);
  assert.equal(r.length, 5);
  assert.equal(r.reduce((a, x) => a + x.hours, 0), 7);
  assert.ok(r.every((x) => x.hours >= 0.5 && (x.hours * 2) % 1 === 0));
  assert.equal(r[0].key, 'A');
});
test('6.5h leave with three tickets keeps only the top one at 0.5h', () => {
  assert.deepEqual(allocate(new Map([['A', 3], ['B', 2], ['C', 1]]), 0.5), [{ key: 'A', hours: 0.5 }]);
});
test('zero target and empty weights return []', () => {
  assert.deepEqual(allocate(new Map([['A', 1]]), 0), []);
  assert.deepEqual(allocate(new Map(), 7), []);
});
test('dayWeights applies caps and excludes epics', () => {
  // 9 commits on A → commit weight 5; 400 Claude minutes → 6; inProgress → +2; excluded key E gets nothing
});
test('rebalance keeps manual hours and fills the rest to target', () => {
  assert.deepEqual(rebalance([{ key: 'A', hours: 3, manual: true }, { key: 'B', hours: 2, manual: false }, { key: 'C', hours: 2, manual: false }], 5),
    [{ key: 'A', hours: 3, manual: true }, { key: 'B', hours: 1, manual: false }, { key: 'C', hours: 1, manual: false }]);
});
test('evidenceText formats', () => {
  assert.equal(evidenceText({ commits: 4, claudeMinutes: 100, inProgress: true, activity: 1 }), '4 commits · 1h 40m in Claude · In Progress · 1 Jira update');
});
```

- [ ] **Step 3: Allocation algorithm** (the tests don't fully determine it):
  1. Sort by weight and keep the top `TIME_MAX_TICKETS`.
  2. While `kept.length * 0.5 > target`, drop the lowest.
  3. Give each kept ticket 0.5h.
  4. Split the remaining `target − kept*0.5` in 0.5h units by largest remainder over the weights.

- [ ] **Steps 2, 4:** run (FAIL), then implement, then run (PASS). **Step 5:** `git status`.

---

### Task 5: Store, Month Assembly, and Routes

**Files:**
- Create: `lib/time/store.js`, `lib/time/routes.js`
- Modify: `server.js` (add `time` to `FEATURE_MODULES`; `ctx.timeDir = options.timeDir ?? TIME_DIR`)
- Test: `test/time-store.test.js`, `test/time-routes.test.js`

**Interfaces:**
- Produces:
  - `store.js`:
    - `createStore(file) -> { get(day), all(), save(day, record) }`. Records look like `{ status: 'draft'|'confirmed', leaveHours, entries: [{ key, hours, manual }], confirmedAt|null }`. Writes are atomic: write to `.tmp`, then rename.
    - `validateDay(day, record, today) -> string|null`, returning an error message for each of these:
      - a weekend
      - a future day
      - `leaveHours` not a 0.5 step between 0 and 7
      - a key not matching `^TCPMOB-\d+$`
      - hours not a 0.5 step above 0
      - `status === 'confirmed'` with a sum not exactly `7 − leaveHours`
  - `routes.js`:
    - `buildMonth(ctx, ym) -> Promise<Month>`
      - `Month = { ym, days: Day[], sources: { claude, git, jira }: 'ok'|string }`
      - `Day = { date, state: 'confirmed'|'review'|'nodata'|'leave'|'future', target, leaveHours, entries: Array<{ key, summary, url, hours, manual, evidence }>, suggested: boolean }`
      - Each source is fetched separately, and a failure becomes a `sources` message instead of breaking the month
    - Routes:
      - `GET /api/time/month?ym=YYYY-MM`. A missing `ym` means the current month; a malformed one returns 400.
      - `GET /api/time/pending` → `{ count, days }`: past workdays this month and last month that aren't confirmed and aren't leave days
      - `POST /api/time/day/:date` with body `{ leaveHours, entries, confirm: boolean }`. It validates (400 on error) and saves. A save without confirm becomes a draft; editing a confirmed day without confirm makes it a draft again.
      - `GET /api/time/export?ym=&format=json|csv` → confirmed entries plus leave (`key: 'LEAVE'`), with `Content-Disposition: attachment; filename=tempo-<ym>.<ext>`
  - Month results are cached for 5 minutes per `ym`, and any POST clears the cache

- [ ] **Step 1: Write the failing tests**

```js
process.env.TZ = 'America/Chicago';
test('validateDay rejects weekend, future, bad leave, bad key, wrong confirmed total', () => {
  const today = '2026-11-10';
  assert.match(validateDay('2026-11-07', { status: 'draft', leaveHours: 0, entries: [] }, today), /weekend/i);
  assert.match(validateDay('2026-11-11', { status: 'draft', leaveHours: 0, entries: [] }, today), /future/i);
  assert.match(validateDay('2026-11-10', { status: 'draft', leaveHours: 0.3, entries: [] }, today), /leave/i);
  assert.match(validateDay('2026-11-10', { status: 'draft', leaveHours: 0, entries: [{ key: 'HR-1', hours: 1 }] }, today), /key/i);
  assert.match(validateDay('2026-11-10', { status: 'confirmed', leaveHours: 1, entries: [{ key: 'TCPMOB-1', hours: 5 }] }, today), /6/);
  assert.equal(validateDay('2026-11-10', { status: 'confirmed', leaveHours: 7, entries: [] }, today), null);
});
test('store writes atomically and round-trips', () => {});
// routes with fakes for claude/git/jira sources:
test('month: suggested day sums to 7, confirmed day returns saved entries, leave day state leave', async () => {});
test('month still renders when Jira is unconfigured and git repo is missing', async () => {
  // sources.jira and sources.git carry messages; days built from Claude only
});
test('POST day: invalid → 400 and nothing saved; confirm with right total → saved confirmed', async () => {});
test('pending counts past unconfirmed non-leave workdays only', async () => {});
test('export json and csv contain confirmed entries and LEAVE rows', async () => {});
```

- [ ] **Steps 2–4:** run (FAIL), implement, run (PASS).

- [ ] **Step 5: Smoke check (GET only):** `GET /api/time/month` against the real sources shows November days with suggestions, and every `review` day's entries sum to 7. Print the first 3 days as `key hours evidence`. Don't POST.

- [ ] **Step 6:** `git status`.

---

### Task 6: Snapshot Job and 8:30 PM Reminder

**Files:**
- Create: `lib/time/reminder.js`
- Modify: `server.js` main, `config.js` (`TIME_REMINDER = process.env.TIME_REMINDER ?? '20:30'`)
- Test: `test/time-reminder.test.js`

**Interfaces:**
- Produces:
  - `shouldRemind({ now: Date, reminderAt: 'HH:MM'|'off', lastSentDay: string|null, pending: string[], todayRecord }) -> { send: boolean, day: string|null }`
    - Sends for today when it's a workday at or after `reminderAt` and today isn't confirmed or a leave day
    - Catch-up: on any check, if the most recent past workday is unconfirmed and not already reminded, it sends for that day
    - Never sends twice for the same day, and never when the setting is `off`
  - `reminderText(day, suggested: { tickets, hours }) -> { title: 'Confirm today\'s hours', body: '3 tickets, 7h suggested' }`
  - `notify({ title, body }, exec)` → `execFile('osascript', ['-e', 'display notification "<escaped body>" with title "<escaped title>"'])`. Quotes and backslashes are escaped, and there's no shell.
  - Server main:
    - Runs `snapshot()` at start and hourly
    - Checks the reminder every 5 minutes
    - Keeps `lastSentDay` in `data/time/reminder.json`

- [ ] **Step 1: Write the failing tests**

```js
process.env.TZ = 'America/Chicago';
const at = (iso) => new Date(iso);
test('sends at 20:30 on an unconfirmed workday, once', () => {
  const base = { reminderAt: '20:30', pending: [], todayRecord: null };
  assert.deepEqual(shouldRemind({ ...base, now: at('2026-11-10T20:29:00-06:00'), lastSentDay: null }), { send: false, day: null });
  assert.deepEqual(shouldRemind({ ...base, now: at('2026-11-10T20:31:00-06:00'), lastSentDay: null }), { send: true, day: '2026-11-10' });
  assert.equal(shouldRemind({ ...base, now: at('2026-11-10T21:00:00-06:00'), lastSentDay: '2026-11-10' }).send, false);
});
test('never for confirmed or leave day, weekends, or off', () => {});
test('catch-up on next start for the most recent unconfirmed past workday', () => {
  // now Wed 09:00, pending ['2026-11-10'], lastSentDay '2026-11-09' → send for 2026-11-10
});
test('notify escapes quotes and uses execFile args, not a shell', async () => {
  // body 'he said "hi" \\ ok' → args[1] contains \"hi\" and \\\\
});
```

- [ ] **Steps 2–4:** run (FAIL), implement, run (PASS).

- [ ] **Step 5: Real check:** run `notify({ title: 'Mobile Clock Dashboard', body: 'Test reminder' })` once from a scratch script. Expected: a macOS notification appears. (This notification is harmless, local, and shown only to the user.)

- [ ] **Step 6:** `git status`.

---

### Task 7: Time View, Home Tile, and Nav

**Files:**
- Create: `public/views/time.js`
- Modify: `public/app.js` (add the view `time`, titled "Time", look `['calendar', 'green']`, key `5`), `public/views/home.js` (tile), `public/ui.js` (icons `calendar`, `leave`), `public/style.css`

**Interfaces:**
- Consumes: the Task 5 routes
- Produces: the view module `{ id: 'time', title: 'Time', mount, update }`; `ctx.setBadge('time', pending.count)`

- [ ] **Step 1: Day mode:**
  - **Header:** month title with ‹ and › buttons; progress `N of M workdays confirmed`; a segmented control Day | Month
  - **Strip:** one pill per workday, showing weekday, date, and state (Confirmed is green "7h", Review orange, No Data gray, Leave muted, Future disabled). Days with partial leave show a dot, and today is highlighted.
  - **Day card:**
    - **Ticket rows:** a ticket glyph, the key as a Jira link, the summary, the evidence line, and an hours stepper (− value +, 0.5 steps, minimum 0.5, and − at 0.5 removes the row after confirming)
    - **Leave row:** shown when leave is above 0, with its own stepper
    - **Footer:**
      - a total shown as `6.5 / 7.0h`, turning green at exactly the target
      - **Add Ticket:** a select of the month's tickets, plus a text input for any key
      - **Add Leave**
      - **Copy Day**
      - **Confirm Day:** disabled until the total equals the target
  - **Editing:** any change marks that entry `manual: true`. Leave changes call the same rebalance as the server; port `rebalance` into `public/shared.js` and use it in both places.
  - **Saving:** edits save as drafts with a 600 ms debounce. Confirm POSTs with `confirm: true` and shows a toast.
  - **Default day:** today if it's a workday, else the most recent workday needing review
- [ ] **Step 2: Month mode:** a grid with tickets as rows and workdays as columns. Cells show hours (italic for suggested, bold for confirmed) with the evidence in a tooltip. Row and column totals appear, and column headers show each day's state. Clicking a column opens that day in day mode. **Copy Month** and **Export** (JSON or CSV) download through an `<a download>` pointed at the export route.
- [ ] **Step 3: Sources banner:** when `month.sources` has a non-ok entry, show one info banner, for example "Git commits unavailable: <reason>".
- [ ] **Step 4: Home tile and badge:** when `/api/time/pending` count is above 0, Home shows a tile reading "N days to confirm" that switches to Time, and the Time nav item shows the badge.
- [ ] **Step 5: Verify:**
  - `node --check` passes on all public JS
  - `npm test` stays green
  - Headless screenshots of `#time` in light at 1280 px, in dark, and at 500 px
  - A CDP click test (the scratch `cdp.mjs` pattern from the Home bug) that clicks a strip day and a stepper, confirms no JS errors, and confirms the total updates. Don't click Confirm.
- [ ] **Step 6:** `git status`.

---

### Task 8: README and End-to-End Check

- [ ] **Step 1: Update `README.md`** with a Time section covering:
  - what evidence it uses
  - that chat text is never stored
  - leave
  - Copy and Export
  - the reminder, and `TIME_REMINDER=off`
- [ ] **Step 2: Run** `npm test`. Expected: all pass, with the count reported.
- [ ] **Step 3: Check** that every GET time route returns 200 against real data, and print a few suggested days for the user to eyeball. No POSTs.
- [ ] **Step 4: Run** `git status` and report it. Don't commit.
