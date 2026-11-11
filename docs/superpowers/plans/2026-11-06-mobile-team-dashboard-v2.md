# Mobile Team Dashboard v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Phase 1 of v2 to the working v1 dashboard: Jira linking, Send to QA, mismatch alerts, Start a Ticket, failed build to Jira bug, build lookup, smarter retry, release train, TypeScript budget, test health, review queue, AI review summary, and simulator install. All of it ships across four views.

**Architecture:** Each feature is a small `lib/` module made of pure functions (unit-tested) plus thin fetchers over `gh`, Jira REST, `git`, or `xcrun`. Each module also exports a `routes(ctx)` list that `server.js` merges into its route table, so `server.js` stays a router. The page splits into a shared `ui.js` plus one ES module per view.

**Tech Stack:** Node 20 (`fetch`, `node:test`, `node:child_process`), `gh` 2.103.3, Jira Cloud REST v3, `git`, `xcrun simctl`, plain browser JS. Still zero npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-mobile-team-dashboard-v2-design.md` (Phase 1 only). v1 spec and plan live alongside it.

## Global Constraints

- **No commits:** never run `git commit` or `git push` in this repo; each task ends with `git status`. The user commits.
- **No unconfirmed writes:** write actions only run from a user click followed by a confirmation in the UI. Writes are Jira transition, assign, issue create, and issue link; GitHub branch create; simulator install. No background job writes to Jira or GitHub, except v1's auto-rerun of dashboard-triggered builds.
- **No Jira build comments:** the dashboard never posts comments to Jira.
- **Build inputs:** never `release prod`, never `sendReleaseUpdates=true`. The only build types are `release dev` (the 4 v1 builds) and `build dev .app` (the new simulator build), both hardcoded server-side.
- **Jira auth:** `.env` holds `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_TOKEN` (values may be double-quoted). `.env` is gitignored. If Jira is missing or rejected, GitHub features keep working and Jira areas show a setup or error message.
- **Ticket keys:** must match `/^TCPMOB-\d+$/` after uppercasing before they reach JQL or a URL
- **Statuses:**
  - Active: `To Do`, `Open`, `In Progress`, `Dev Review`
  - Finished: `Release Candidate`, `Done`
  - Send to QA: from `Dev Review` to the transition whose `to.name === 'QA Review'`
  - Start: never changes status
- **Caches:** Jira 60 s; branch list 5 min
- **v1 rules still hold:** `127.0.0.1` only, Host + `X-Dashboard` checks, `execFile` with no shell, `textContent` with no `innerHTML`
- **Local checkout:** `MOBILE_CLOCK_PATH` defaults to `~/Downloads/GitHub/mobile-clock`. Its working tree is never modified; worktrees live under `cache/` in this repo (gitignored).
- **Visual style:** v1's Apple-style CSS tokens and components. New UI reuses `.group`, `.row`, `.chip`, `.btn`, `.segmented`, `dialog.sheet`.

## Review Focus

1. **Jira not configured or the token is rejected.** Expected: `/api/prs`, `/api/runs`, and `/api/builds` still return 200. Jira routes return 503 `{ error: 'Jira is not configured…' }` or 502 with the Jira message, and the page shows one setup banner. Tested in Task 1 (client) and Task 2 (server).
2. **Untrusted ticket keys and branch names reaching JQL.** A branch like `tcpmob-12" OR project = HR` must never inject JQL. Expected: only validated keys are joined into `key in (…)`. Tested in Task 2.
3. **Hostile or odd ticket summaries becoming branch names.** Covers quotes, emoji, `..`, trailing dots, and 300-character summaries. Expected: a valid git ref of 100 characters or fewer that matches `^TCPMOB-\d+(-[a-z0-9]+)*$`. Tested in Task 2.
4. **Jira 429 rate limiting.** Expected: one retry after `Retry-After` (capped at 10 s), then a 502 with the message. Tested in Task 1.
5. **Overlapping long jobs.** Covers a second "Run now" while `tsc` runs, and two simulator installs at once. Expected: no second process. The second request returns the current job status (TS) or 409 (simulator). Tested in Tasks 8 and 9.

---

## File Structure

```
.env                      (exists, gitignored) JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN
.gitignore                + cache/, data/
config.js                 + JIRA env read, MOBILE_CLOCK_PATH, new build key, status sets
lib/env.js                parse + load .env
lib/jira.js               Jira REST client (fetch, basic auth, 429 retry, JiraError)
lib/tickets.js            ticket keys, PR↔ticket join, build-comment parser, branch slug, Jira routes
lib/retryclass.js         classifyFailure()
lib/builds.js             (modify) classification before retry, buildType per key
lib/alerts.js             mismatch rules + routes
lib/release.js            release train + notes + routes
lib/testhealth.js         pass rate + flaky runs + routes
lib/reviews.js            review queue + AI summary + routes
lib/tsbudget.js           TypeScript budget job + routes
lib/simulator.js          booted sims + artifact install + routes
lib/ghdata.js             shared gh fetchers: merged PRs, branch list (cached)
server.js                 (modify) createServer(ctx) merges feature routes; startup wiring
public/ui.js              el, api, chips, sheet helpers (moved out of app.js)
public/app.js             (modify) shell: nav, polling loop, status strip, notifications
public/views/home.js      PRs (+ticket), triggered builds, alerts, my tickets, lookup, sheets
public/views/release.js   release train + notes
public/views/quality.js   TS budget + test health
public/views/team.js      review queue + all PRs
public/index.html         (modify) nav + view containers
public/style.css          (modify) sidebar/tab bar, cards, sparkline
test/*.test.js            one per lib module, plus server routes
```

## Shared Route Contract

Every feature module exports `routes(ctx) -> Array<[method, RegExp, handler(match, req, url) => Promise<any>]>`. `ctx` = `{ gh, tracker, behind, jira, ts, sim, readJson, id }`, where `readJson` and `id` are the existing helpers in `server.js`, now passed down.

- `createServer(ctx)` (Task 2) concatenates the core routes with `routes(ctx)` from each module listed in `FEATURE_MODULES`.
- Error mapping gains `JiraError` → its `status` if it's 409 or 503, else 502.
- A route that needs Jira calls `requireJira(ctx)` (Task 2), which throws `JiraError(503, 'Jira is not configured. Add JIRA_BASE_URL, JIRA_EMAIL, and JIRA_TOKEN to .env.')` when `!ctx.jira?.configured`.

---

### Task 1: Env Loader and Jira Client

**Files:**
- Create: `lib/env.js`, `lib/jira.js`
- Modify: `config.js`, `.gitignore` (add `cache/` and `data/`)
- Test: `test/env.test.js`, `test/jira.test.js`

**Interfaces:**
- Produces:
  - `parseEnv(text: string) -> Record<string,string>`
  - `loadEnv(path: string) -> void` (sets `process.env` keys that aren't already set; a missing file is a no-op)
  - `class JiraError extends Error { status: number }`
  - `createJira({ baseUrl, email, token, fetch = globalThis.fetch, sleep = (ms) => setTimeout promise }) -> Jira`
  - `Jira = { configured: boolean, myself(), search(jql: string, fields: string[], max = 100): Promise<Issue[]>, getIssue(key, fields), comments(key): Promise<Comment[]>, transitions(key): Promise<Transition[]>, transition(key, id), assign(key, accountId), createIssue(fields): Promise<{ key }>, link(type, inwardKey, outwardKey), issueTypes(projectKey): Promise<string[]> }`
  - `config.js` adds:
    - `JIRA = { baseUrl, email, token }` from `process.env` after `loadEnv('.env')` (resolved next to `config.js`)
    - `MOBILE_CLOCK_PATH`
    - `ACTIVE_STATUSES = ['To Do', 'Open', 'In Progress', 'Dev Review']`
    - `FINISHED_STATUSES = ['Release Candidate', 'Done']`
    - `JIRA_TTL_MS = 60000`
    - `BRANCH_TTL_MS = 300000`

- [ ] **Step 1: Write the failing tests**

```js
test('parseEnv handles quotes, comments, blank lines, = in values', () => {
  assert.deepEqual(parseEnv('# c\nJIRA_TOKEN="ab=c"\n\nJIRA_EMAIL=me@x.com\nX=\'q\'\n'), { JIRA_TOKEN: 'ab=c', JIRA_EMAIL: 'me@x.com', X: 'q' });
});
test('unconfigured client reports configured=false and every call throws 503', async () => {
  const j = createJira({ baseUrl: '', email: '', token: '' });
  assert.equal(j.configured, false);
  await assert.rejects(j.myself(), (e) => e instanceof JiraError && e.status === 503);
});
test('sends basic auth and JSON to the site URL', async () => {
  const calls = []; const j = createJira({ baseUrl: 'https://x.atlassian.net', email: 'a@b.c', token: 't', fetch: async (url, opt) => { calls.push([url, opt]); return new Response('{"displayName":"F"}', { status: 200 }); } });
  await j.myself();
  assert.equal(calls[0][0], 'https://x.atlassian.net/rest/api/3/myself');
  assert.equal(calls[0][1].headers.Authorization, 'Basic ' + Buffer.from('a@b.c:t').toString('base64'));
});
test('search posts to /rest/api/3/search/jql and follows nextPageToken', async () => { /* two pages → 3 issues total */ });
test('429 retries once after Retry-After (capped 10s) then succeeds', async () => {
  const waits = []; let n = 0;
  const j = createJira({ ...cfg, sleep: async (ms) => waits.push(ms), fetch: async () => (++n === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '30' } }) : new Response('{}', { status: 200 })) });
  await j.myself();
  assert.deepEqual(waits, [10000]);
});
test('second 429 and other errors become JiraError with Jira message', async () => {
  // body {"errorMessages":["Issue does not exist"]} status 404 → JiraError status 404, message includes 'Issue does not exist'
});
test('transition/assign/createIssue/link hit the documented endpoints', async () => {
  // POST /rest/api/3/issue/K/transitions {transition:{id}}; PUT /issue/K/assignee {accountId};
  // POST /rest/api/3/issue {fields}; POST /rest/api/3/issueLink {type:{name},inwardIssue:{key},outwardIssue:{key}}
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL, missing `lib/env.js` / `lib/jira.js`.

- [ ] **Step 3: Implement.** `search` uses `POST /rest/api/3/search/jql` with `{ jql, fields, maxResults: min(max,100), nextPageToken }` and loops while `nextPageToken` exists and `issues.length < max`. `comments` uses `GET /issue/K/comment?maxResults=100&orderBy=-created`. Comment bodies are ADF, so flatten to plain text by joining every `text` node. `issueTypes` uses `GET /issue/createmeta/TCPMOB/issuetypes` and returns `values[].name` (or `issueTypes[].name`). Error message: `errorMessages.join('; ')` plus `Object.values(errors)`.

- [ ] **Step 4: Run** `npm test`. Expected: all pass, including v1's 60 tests.

- [ ] **Step 5: Run** `git status`. Nothing committed.

---

### Task 2: Tickets Module, Server Route Merging, Jira on Every PR

**Files:**
- Create: `lib/tickets.js`, `lib/ghdata.js`
- Modify: `server.js`
- Test: `test/tickets.test.js`, `test/server.test.js` (add cases)

**Interfaces:**
- Consumes: `createJira`, `JiraError` (Task 1); v1 `listPrs`
- Produces:
  - `ticketKey(...texts: string[]) -> string|null`: first `/TCPMOB-\d+/i` across texts, uppercased
  - `keysJql(keys: string[]) -> string|null`: validated keys only, `key in (TCPMOB-1, TCPMOB-2)`, or null if none
  - `toTicket(issue) -> Ticket` where `Ticket = { key, url, summary, status, statusCategory, assignee: { accountId, name }|null, fixVersions: string[], issueType }`
  - `createTicketCache(jira, now) -> { get(keys: string[]): Promise<Map<key, Ticket>>, clear() }`: 60 s TTL per key, one search for all misses
  - `parseBuildComments(comments: Array<{ author, created, text }>) -> Array<{ app: 'MobileClock'|'Mobile Kiosk', platform: 'iOS'|'Android', number: string, user, created }>`
  - `branchName(key: string, summary: string) -> string`
  - `requireJira(ctx)` (exported for other modules)
  - `routes(ctx)`: `GET /api/jira/status` → `{ configured, ok, name|error }`, and `GET /api/prs` is replaced by `GET /api/prs` enriched with `pr.ticket: Ticket|null`, `pr.ticketKey`
  - `lib/ghdata.js`:
    - `listMergedPrs(gh, { base = 'develop', sinceIso }) -> Promise<Array<{ number, title, url, headRefName, mergedAt, mergeCommit: { oid }, author }>>`, using `gh pr list --state merged --base <base> --search "merged:>=<date>" -L 500 --json …`
    - `createBranchList(gh, now) -> { get(): Promise<string[]> }`, using `gh api --paginate repos/REPO/branches?per_page=100 --jq '.[].name'` with a 5 min TTL
  - `server.js`: `createServer(ctx)`. A missing `ctx.jira` is treated as `{ configured: false }`. `FEATURE_MODULES = [tickets, alerts, release, testhealth, reviews, tsbudget, simulator]` (modules that aren't built yet are added in their own tasks).

- [ ] **Step 1: Write the failing tests**

```js
test('ticketKey reads branch first, then title, uppercased', () => {
  assert.equal(ticketKey('tcpmob-1482-sub-management', 'x'), 'TCPMOB-1482');
  assert.equal(ticketKey('fix/thing', 'TCPMOB-33: notes'), 'TCPMOB-33');
  assert.equal(ticketKey('detox-poc', 'Detox POC'), null);
});
test('keysJql drops anything that is not a plain key (no JQL injection)', () => {
  assert.equal(keysJql(['TCPMOB-1', 'TCPMOB-2" OR project = HR', 'tcpmob-3']), 'key in (TCPMOB-1, TCPMOB-3)');
  assert.equal(keysJql(['nope']), null);
});
test('parseBuildComments reads all four workflow comment texts', () => {
  const c = (text) => ({ author: 'Foad Ahmed', created: '2026-11-06T12:00:00Z', text });
  assert.deepEqual(parseBuildComments([
    c('fahmedtcp pushed build number 4521 for MobileClock IOS to testflight '),
    c('fahmedtcp pushed build number 4522 for Mobile Kiosk IOS to testflight'),
    c('fahmedtcp pushed build number 30117 for Mobile Clock Android to firebase distribution '),
    c('fahmedtcp pushed build number 30118 for Mobile Kiosk Android to firebase distribution '),
    c('looks good'),
  ]).map((b) => [b.app, b.platform, b.number]), [
    ['MobileClock', 'iOS', '4521'], ['Mobile Kiosk', 'iOS', '4522'], ['MobileClock', 'Android', '30117'], ['Mobile Kiosk', 'Android', '30118'],
  ]);
});
test('branchName: kebab, ascii, ≤100 chars, valid ref', () => {
  assert.equal(branchName('TCPMOB-1482', 'Sub Management 2.0 | Day View: "Load more" button…'), 'TCPMOB-1482-sub-management-2-0-day-view-load-more-button');
  const long = branchName('TCPMOB-1', 'é😀 '.repeat(20) + 'a'.repeat(300) + '..');
  assert.ok(long.length <= 100 && /^TCPMOB-\d+(-[a-z0-9]+)*$/.test(long));
  assert.equal(branchName('TCPMOB-9', '!!!'), 'TCPMOB-9');
});
test('ticket cache: one search for misses, reuse within 60s', async () => { /* 2 calls to get() → 1 jira.search */ });
// server.test.js additions:
test('GitHub routes work with Jira unconfigured; /api/jira/status says so', async () => {
  // createServer without jira → GET /api/prs 200 with ticket:null; GET /api/jira/status → { configured:false }
});
test('a Jira-only route returns 503 setup message when unconfigured', async () => { /* GET /api/tickets/mine → 503, error matches /JIRA_TOKEN/ */ });
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement.** `branchName`: NFKD-normalize, strip non-ASCII, lowercase, replace each run of `[^a-z0-9]` with `-`, trim `-`, join to the key with `-`, then cut at 100 characters and trim a trailing `-`. `/api/prs` calls `listPrs`, then `ticketCache.get(keys)` only when Jira is configured. A Jira failure there leaves `ticket: null` and sets `ticketError` on the response, without failing the request: the response becomes `{ prs, ticketError }`. **Ruling for the executor:** this changes the v1 `/api/prs` shape from an array to an object, so update v1's server tests and `app.js` in the same task. `server.js` main wiring builds `jira = createJira(JIRA)`.

- [ ] **Step 4: Run** `npm test`. Expected: all pass.

- [ ] **Step 5: Smoke check (read-only):** `NO_OPEN=1 npm start`, then `curl -s -H 'X-Dashboard: 1' 127.0.0.1:4317/api/jira/status` returns `{"configured":true,"ok":true,"name":"Foad Ahmed"}`. `curl -s 127.0.0.1:4317/api/prs | head -c 400` shows `"ticket":{"key":"TCPMOB-…","status":…`. Stop the server.

- [ ] **Step 6: Run** `git status`. Nothing committed.

---

### Task 3: Smarter Retry and Simulator Build Option

**Files:**
- Create: `lib/retryclass.js`
- Modify: `lib/builds.js`, `config.js`
- Test: `test/retryclass.test.js`, `test/retry.test.js` (add cases), `test/builds.test.js` (add case)

**Interfaces:**
- Produces:
  - `classifyFailure(conclusion: string, reason: { step, lines: string[] }|null) -> { kind: 'infra'|'code'|'unknown', label: string }`
  - `INFRA_PATTERNS` and `CODE_PATTERNS` exported arrays of `{ re: RegExp, label: string }`
  - `BUILDS.mcIosSim = { file: 'run-mc-ios.yml', label: 'iOS MobileClock (Simulator .app)', buildType: 'build dev .app', defaultChecked: false }`. The other 4 get `buildType: 'release dev', defaultChecked: true`.
  - `TrackedBuild` gains `classification: { kind, label }|null`. `/api/builds-config` items gain `defaultChecked`.

- [ ] **Step 1: Write the failing tests**

```js
test('timed_out and startup_failure are infra', () => {
  assert.equal(classifyFailure('timed_out', null).kind, 'infra');
  assert.equal(classifyFailure('startup_failure', null).kind, 'infra');
});
test('network lines are infra', () => {
  for (const line of ['The Internet connection appears to be offline. (-1009)', 'connect ETIMEDOUT 10.0.0.1:443', 'read ECONNRESET', 'Could not resolve host: github.com', 'The runner has received a shutdown signal.', 'lost communication with the server', 'No space left on device', 'Response status code does not indicate success: 503'])
    assert.equal(classifyFailure('failure', { step: 's', lines: [line] }).kind, 'infra', line);
});
test('code lines are code, and code wins over infra in the same reason', () => {
  for (const line of ["src/a.ts(3,5): error TS2322: Type 'x'", 'Tests: 2 failed, 40 passed, 42 total', "e: file.kt:12:3 Unresolved reference: foo", '/Users/runner/x/App.swift:10:5: error: cannot find', '✖ 3 problems (3 errors, 0 warnings)'])
    assert.equal(classifyFailure('failure', { step: 's', lines: [line] }).kind, 'code', line);
  assert.equal(classifyFailure('failure', { step: 's', lines: ['ECONNRESET', 'error TS2322: x'] }).kind, 'code');
});
test('anything else is unknown', () => {
  assert.equal(classifyFailure('failure', { step: 's', lines: ['fastlane finished with errors'] }).kind, 'unknown');
});
// retry.test.js additions (reuse setup()):
test('code failure is not retried; reason and classification set on first failure', async () => {
  // log-failed returns "error TS2322: bad" → reruns().length === 0, status completed, classification.kind 'code'
});
test('infra failure still retries and records classification', async () => { /* default offline log → 1 rerun, classification.kind 'infra' */ });
// builds.test.js addition:
test('simulator build sends build dev .app and never release prod', async () => {
  // trigger(1042, ['mcIosSim']) → args include '-f','buildType=build dev .app','-f','sendReleaseUpdates=false', file run-mc-ios.yml
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `settle`, for a retryable conclusion, call `failureReason` first, then `classifyFailure`. If `kind === 'code'`, finalize. Otherwise retry while `retries < MAX_RETRIES`. Store `classification` and the latest `reason` on every failure. Code patterns are checked before infra patterns. `trigger` uses `BUILDS[key].buildType`. Labels: `Network issue`, `Runner lost`, `Disk full`, `Timed out`, `Failed to start`, `Server error`, `TypeScript error`, `Test failures`, `Compile error`, `Lint errors`, and `Unknown failure`.

- [ ] **Step 4: Run** `npm test`. Expected: all pass.

- [ ] **Step 5: Run** `git status`. Nothing committed.

---

### Task 4: Home Data — My Tickets, Alerts, Build Lookup, and Jira Write Actions

**Files:**
- Create: `lib/alerts.js`
- Modify: `lib/tickets.js` (routes)
- Test: `test/alerts.test.js`, `test/tickets.test.js`, `test/server.test.js`

**Interfaces:**
- Consumes: Tasks 1–3, `lib/ghdata.js`
- Produces:
  - `computeAlerts({ openPrs, mergedPrs, tickets: Map, sprintTickets: Ticket[], branches: string[], login, accountId, scope: 'mine'|'team' }) -> Alert[]` where `Alert = { kind: 'finished-but-open'|'merged-but-active'|'pr-no-ticket'|'ticket-no-branch', key|null, pr|null, text: string, url: string }`
  - Routes (all Jira routes call `requireJira`):
    - `GET /api/tickets/mine`: `Ticket[]` from JQL `project = TCPMOB AND assignee = currentUser() AND sprint in openSprints() AND status in ("To Do","Open","In Progress","Dev Review") ORDER BY status`
    - `GET /api/alerts?scope=mine|team`: `Alert[]`, using merged PRs since 14 days ago
    - `GET /api/lookup/:key`: `{ ticket, jiraBuilds, trackedBuilds, runs, pr: { number, url, state }|null, mergedToDevelop: boolean, onReleaseBranch: boolean|null }`
    - `POST /api/tickets/:key/qa`: re-checks server-side that the status is `Dev Review` and `parseBuildComments(comments).length > 0` (else 409 with reason), finds the transition with `to.name === 'QA Review'` (else 409 listing available `to.name`s), applies it, and returns `{ ok: true, from, to }`
    - `POST /api/tickets/:key/start`: requires status `To Do`|`Open` (else 409). Gets the `develop` SHA via `gh api repos/REPO/git/ref/heads/develop --jq .object.sha`, then `gh api -X POST repos/REPO/git/refs -f ref=refs/heads/<branchName> -f sha=<sha>` (a GhError containing `Reference already exists` → 409 "Branch already exists"). Assigns to `myself().accountId` if unassigned. Never transitions. Returns `{ ok: true, branch, assigned: boolean }`.
    - `POST /api/builds/:id/bug` with body `{ summary, description }`: the build must exist and be `completed` and failed (else 409). Checks `issueTypes('TCPMOB')` includes `Bug` (else 409 listing types). Creates the issue with the description as ADF paragraphs (each line is a paragraph, and the reason lines go in a `codeBlock`). Links `Relates` to the build's PR ticket when present. Returns `{ key, url }`. Summary is trimmed, required, and at most 255 characters (else 400).
  - `:key` params go through `ticketKey()` and must be non-null (else 400). `:id` for builds is the tracker's string id, validated with `/^\d+-\d+$/`.

- [ ] **Step 1: Write the failing tests**

```js
test('finished ticket with open non-draft PR alerts; draft does not', () => { /* RC + open PR → 1 alert kind finished-but-open; draft → 0 */ });
test('merged PR whose ticket is still In Progress alerts', () => { /* kind merged-but-active */ });
test('open non-draft PR without key alerts; scope mine filters to my PRs', () => {});
test('my sprint ticket in Dev Review with no matching branch alerts; branch match is case-insensitive', () => {
  // branches ['tcpmob-1725-ios-date'] covers TCPMOB-1725
});
// server routes with fake jira + fake gh:
test('qa refuses when not Dev Review (409) and when no build comment (409), transitions otherwise', async () => {
  // asserts jira.transition called with id of the transition whose to.name is 'QA Review', and no comment API call
});
test('start creates branch from develop sha, assigns if unassigned, never transitions', async () => {
  // gh calls: git/ref/heads/develop then POST git/refs with ref=refs/heads/TCPMOB-5-fix-thing; jira.transition never called
});
test('start on existing branch → 409 Branch already exists', async () => {});
test('bug requires failed completed build, Bug type, ≤255 summary; links Relates to PR ticket', async () => {});
test('bad key in path → 400 and no Jira call', async () => { /* /api/tickets/HR-1/qa → 400 */ });
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. Lookup details:
  - `runs` are successful `workflow_dispatch` runs from `gh run list -R REPO -e workflow_dispatch -s success -L 100 --json …`, filtered by `headBranch` containing the key (case-insensitive)
  - `mergedToDevelop` comes from the ticket's PR (search `gh pr list --state all --search "<key> in:title,head"`; take the newest) being merged with base `develop`
  - `onReleaseBranch` is `null` until the release branch exists (Task 5 exports `currentRelease`; until then, return `null`)

- [ ] **Step 4: Run** `npm test`. Expected: all pass.

- [ ] **Step 5: Smoke check (GET only):** `/api/tickets/mine`, `/api/alerts`, and `/api/lookup/TCPMOB-1482` return JSON. **Do not call any POST route against real Jira or GitHub.**

- [ ] **Step 6: Run** `git status`. Nothing committed.

---

### Task 5: Release Train

**Files:**
- Create: `lib/release.js`
- Modify: `lib/tickets.js` (lookup uses `onReleaseBranch`)
- Test: `test/release.test.js`

**Interfaces:**
- Produces:
  - `parseVersion(name: string) -> number|null`: `"Mobile 46"` → 46
  - `currentRelease(versions: Array<{ name, released, archived, releaseDate }>, branches: string[]) -> { name, nn, releaseDate, branch: 'release/1.NN.x', branchExists: boolean, lastCut: 'release/1.MM.x'|null }|null`: the lowest unreleased, unarchived `Mobile NN`. `lastCut` is the highest existing `release/1.MM.x` with MM < NN.
  - `releaseLists({ tickets: Ticket[], prsByKey: Map<key, PR>, mergedSinceCut: PR[], onBranch: Set<sha>|null, fixKeys: Set<key> }) -> { inVersion, notMerged, unplanned, cherryPicks }`
  - `releaseNotes(tickets: Ticket[], versionName) -> string`, in this format:
    ```
    Mobile 46

    Fixes
    - TCPMOB-123 Summary

    Improvements
    - TCPMOB-456 Summary
    ```
    Bug goes to Fixes. Story, Task, and Internal Development Story go to Improvements. Other types go to `Other`. Empty sections are omitted, and keys are sorted numerically.
  - Route `GET /api/release` → `{ release, lists, notes }`. The cut date is `merge_base_commit.commit.committer.date` from `gh api repos/REPO/compare/<lastCut>...develop`. Fix-version tickets come from JQL `project = TCPMOB AND fixVersion = "<name>"`. Versions come from `GET /rest/api/3/project/TCPMOB/versions` (add `jira.versions(projectKey)` to the Task 1 client with a test). Cherry-pick containment: for each candidate merge SHA, `gh api repos/REPO/compare/<branch>...<sha> --jq .status`. `behind` or `identical` means it's on the branch. Only computed when `branchExists`. Cache the whole response for 60 s.

- [ ] **Step 1: Write the failing tests**

```js
test('currentRelease picks lowest unreleased Mobile NN and maps branches', () => {
  const r = currentRelease([{ name: 'Mobile 45', released: true }, { name: 'Mobile 47', released: false }, { name: 'Mobile 46', released: false, releaseDate: '2026-11-30' }], ['release/1.43.x', 'release/1.45.x', 'develop']);
  assert.deepEqual(r, { name: 'Mobile 46', nn: 46, releaseDate: '2026-11-30', branch: 'release/1.46.x', branchExists: false, lastCut: 'release/1.45.x' });
});
test('releaseLists: notMerged flags RC/Done mismatch, unplanned excludes fix-version keys, cherryPicks only when onBranch given', () => {});
test('releaseNotes groups and sorts', () => {
  assert.equal(releaseNotes([t('TCPMOB-10', 'Story', 'B'), t('TCPMOB-9', 'Bug', 'A'), t('TCPMOB-2', 'Bug', 'C')], 'Mobile 46'),
    'Mobile 46\n\nFixes\n- TCPMOB-2 C\n- TCPMOB-9 A\n\nImprovements\n- TCPMOB-10 B\n');
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. Wire `onReleaseBranch` into lookup.

- [ ] **Step 4: Run** `npm test`. Expected: all pass. **Smoke check:** `GET /api/release` shows `Mobile 46`, `branchExists: false`, `lastCut: release/1.45.x`, and non-empty `inVersion`.

- [ ] **Step 5: Run** `git status`. Nothing committed.

---

### Task 6: Test Health

**Files:**
- Create: `lib/testhealth.js`
- Test: `test/testhealth.test.js`

**Interfaces:**
- Produces:
  - `passRate(runs: Run[]) -> { rate: number|null, passed, total, latest: Run|null, latestAgeDays: number|null }`, counting only `completed` runs whose conclusion isn't `cancelled` or `skipped`
  - `flakyRuns(runs: Array<Run & { headSha, workflowName }>) -> Array<{ workflowName, headSha, branch, failedUrl, passedUrl }>`: same workflow and SHA with both a `failure` and a `success`
  - `TEST_WORKFLOWS = [{ key: 'unit', label: 'Unit tests (develop)', file: 'run-tests.yml', branch: 'develop' }, { key: 'detoxIos', label: 'Detox iOS', file: 'run-detox-ios.yml', branch: null }, { key: 'detoxIosSelf', label: 'Detox iOS (self-hosted)', file: 'run-detox-ios-selfhosted.yml', branch: null }, { key: 'detoxAndroidSelf', label: 'Detox Android (self-hosted)', file: 'run-detox-android-selfhosted.yml', branch: null }]`
  - Route `GET /api/tests` → `{ suites: Array<{ key, label, ...passRate }>, flaky: [...] }`. Suites use `-L 30`. Flaky uses `gh run list -R REPO -L 100 --json databaseId,workflowName,headSha,headBranch,conclusion,status,url`. Cache for 5 min.

- [ ] **Step 1: Write the failing tests**

```js
test('passRate ignores cancelled/skipped/in-progress and reports latest age', () => {});
test('passRate of no runs is null rate', () => { assert.equal(passRate([]).rate, null); });
test('flakyRuns pairs failure+success on same workflow+sha only', () => {});
```

- [ ] **Steps 2–4:** run (FAIL), implement, run (PASS). **Step 5:** `git status`.

---

### Task 7: Review Queue and AI Review Summary

**Files:**
- Create: `lib/reviews.js`
- Test: `test/reviews.test.js`

**Interfaces:**
- Produces:
  - `reviewQueue(prs: Array<{ number, title, url, author, isDraft, requests: Array<{ login, requestedAt }> }>, now: Date) -> { byReviewer: Array<{ login, count, oldestDays }>, prs: Array<{ number, title, url, author, waitingOn: string[], waitingDays: number, overdue: boolean }> }`. `overdue` means `waitingDays > 2`. Drafts are excluded. Reviewers are sorted by count descending.
  - `latestBotSummary(comments: Array<{ id, user: { login }, body, created_at }>) -> { id, body, createdAt }|null`: the newest from `claude[bot]`
  - Routes:
    - `GET /api/reviews`: one GraphQL call via `gh api graphql -f query=…` for open PRs (first 100) with `reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }` and `timelineItems(itemTypes: REVIEW_REQUESTED_EVENT, last: 20) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } } }`. `requestedAt` is the latest matching event per login, falling back to PR `createdAt`.
    - `GET /api/prs/:n/ai-review`: returns `{ summary, inlineCount }`. `summary` comes from `latestBotSummary` over `gh api --paginate repos/REPO/issues/<n>/comments`. `inlineCount` counts `claude[bot]` items in `repos/REPO/pulls/<n>/comments`. Cached per PR for 5 min.

- [ ] **Step 1: Write the failing tests**

```js
test('reviewQueue counts per reviewer, oldest wait, overdue > 2 days, skips drafts', () => {});
test('latestBotSummary picks newest claude[bot] comment only', () => {});
```

- [ ] **Steps 2–4:** run (FAIL), implement, run (PASS). **Smoke check:** `GET /api/reviews` returns real reviewers. **Step 5:** `git status`.

---

### Task 8: TypeScript Error Budget

**Files:**
- Create: `lib/tsbudget.js`
- Test: `test/tsbudget.test.js`

**Interfaces:**
- Produces:
  - `countTsErrors(output: string) -> number`: lines matching `/error TS\d+:/`
  - `createTsBudget({ repoPath, cacheDir, historyFile, exec, now }) -> { status(): Status, runDevelop(): Status, runPr(prNumber: number): Status, history(): Entry[] }`
    - `Status = { running: null|{ target: 'develop'|`pr-${n}`, phase: 'fetch'|'worktree'|'tsc', startedAt }, last: Entry|null, prResults: Record<n, { sha, count, delta, at }>, error: string|null }`
    - `Entry = { at, sha, count }`
    - `exec(file, args, opts) -> Promise<{ stdout, stderr, code }>`. It never throws on a non-zero exit, because `tsc` exits 2 when it finds errors.
  - Behavior:
    - One job at a time. Calling `run*` while running returns the current status and starts nothing.
    - `runDevelop`:
      1. `git -C repoPath fetch origin develop`
      2. `git -C repoPath rev-parse origin/develop`
      3. Create the worktree at `cacheDir/ts-wt` (`git -C repoPath worktree add --detach <wt> <sha>` the first time, else `git -C <wt> checkout --detach <sha>`)
      4. Symlink `<wt>/node_modules` to `repoPath/node_modules` if missing
      5. `node <wt>/node_modules/typescript/bin/tsc --noEmit -p <wt>/tsconfig.json` with cwd `<wt>`
      6. Count errors and append to the history JSON
    - `runPr(n)`: the same, but fetches `pull/<n>/head`. `delta = count − last develop count`. Results are cached by SHA (no re-run for a SHA that's already counted).
    - Auto-run: the server main starts `runDevelop()` at startup if the last entry is older than 24 h, then checks hourly
  - Routes: `GET /api/ts` → `{ status, history }`; `POST /api/ts/run` → status; `POST /api/prs/:n/ts` → status
  - Config: `TS_CACHE_DIR = <repo>/cache`, `TS_HISTORY = <repo>/data/ts-history.json`

- [ ] **Step 1: Write the failing tests**

```js
test('countTsErrors counts only error TS lines', () => {
  assert.equal(countTsErrors("a.ts(1,1): error TS2322: x\nb.ts(2,2): error TS7006: y\nFound 2 errors.\nwarning foo"), 2);
});
test('runDevelop runs fetch → worktree → tsc and appends history', async () => { /* fake exec records commands; tsc stdout with 3 errors → history [ {count:3} ] */ });
test('second run while running returns status and does not spawn', async () => { /* exec for tsc awaits a deferred; call runDevelop twice; tsc spawned once */ });
test('runPr computes delta vs last develop and caches by sha', async () => {});
test('never runs git checkout/reset in repoPath itself', async () => {
  // assert no exec call has args containing ['-C', repoPath, 'checkout'] or 'reset'
});
```

- [ ] **Steps 2–4:** run (FAIL), implement, run (PASS). **Step 5 (local, read-only for GitHub):** `POST /api/ts/run` from a curl with `X-Dashboard: 1`. This only touches the cache worktree, never the user's working tree. Wait for completion, and expect a count in roughly the 1,500 range. Report the real number. **Step 6:** `git status` in both repos. The mobile-clock working tree must be unchanged, apart from the new `.git/worktrees` entry.

---

### Task 9: Simulator Install

**Files:**
- Create: `lib/simulator.js`
- Test: `test/simulator.test.js`

**Interfaces:**
- Produces:
  - `parseBooted(json: string) -> Array<{ udid, name, runtime }>` (from `xcrun simctl list devices booted -j`)
  - `createSimulator({ gh, exec, cacheDir }) -> { booted(): Promise<Device[]>, install(runId: number, udid: string): Promise<{ ok: true, bundleId }> }`
  - `install` steps:
    1. Rejects with 409 if an install is already running
    2. Verifies the `udid` is in `booted()` (else 400)
    3. `gh run download <runId> -R REPO -n ".app build artifacts for simulator" -D <cacheDir>/sim/<runId>` (a GhError containing `no artifact` → 404 "This run has no simulator build")
    4. `ditto -x -k <zip> <dir>`, then finds the first `*.app` dir
    5. `/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" <app>/Info.plist`
    6. `xcrun simctl install <udid> <app>`, then `xcrun simctl launch <udid> <bundleId>`
  - Routes: `GET /api/simulators` → devices; `POST /api/runs/:id/install` with body `{ udid }` → result

- [ ] **Step 1: Write the failing tests**

```js
test('parseBooted reads simctl json', () => {});
test('install runs download → unzip → plist → install → launch in order', async () => {});
test('second concurrent install → 409; unknown udid → 400 before any download', async () => {});
test('missing artifact → 404 with clear message', async () => {});
```

- [ ] **Steps 2–4:** run (FAIL), implement, run (PASS). **Step 5:** `GET /api/simulators` returns the booted list (an empty list is fine). Don't run a real install. **Step 6:** `git status`.

---

### Task 10: Page Shell, Shared UI, and Home View

**Files:**
- Create: `public/ui.js`, `public/views/home.js`
- Modify: `public/app.js`, `public/index.html`, `public/style.css`

**Interfaces:**
- Consumes: all routes above
- Produces:
  - `ui.js` exports `el, ext, api, showError, ago, statusOf, statusChip, ticketChip(ticket), placeholder, confirmSheet({ title, body: Node[], confirmLabel, danger }) -> Promise<boolean>`. `confirmSheet` is a promise-based `dialog.sheet`, and all write actions use it in place of `confirm()`.
  - Each view module exports `{ id, title, mount(container), refresh(data) }`
  - `app.js` owns nav state (persisted in `localStorage` with try/catch), the single polling loop (v1 `pollDelay`), and the status strip. It adds a Jira banner from `/api/jira/status` when Jira is unconfigured or erroring.

- [ ] **Step 1: Navigation:** a sidebar at ≥900 px (Home, Release, Quality, Team) and a bottom tab bar below that, both with `aria-current`. The view switches without reload.

- [ ] **Step 2: Home view sections, in order:**
  1. **Alerts:** shown only when there are alerts, with a Mine/Team switch
  2. **Triggered Builds:** v1 content plus the classification chip and, on final failure, a **Create Jira Bug** button that opens a form sheet with summary and description prefilled and editable
  3. **My Tickets:** key, summary, and status. **Start** on To Do/Open opens a confirm sheet showing the exact branch name (from `branchName`, mirrored client-side) and "assigns to you if unassigned"
  4. **My Pull Requests:** v1 rows plus a ticket chip. **Send to QA** appears when the ticket is Dev Review; its confirm sheet shows "TCPMOB-x: Dev Review → QA Review" and the latest build numbers from lookup. Also an **AI review** disclosure (lazy-loaded on open) and a **TS check** button (shows the delta when present)
  5. **Which build has my fix?:** a search input for a ticket key that renders the lookup result
- Build modal: render choices from `builds-config`, using `defaultChecked`
- Simulator builds that succeeded get **Install on Simulator**, which opens a sheet that lists booted simulators (or shows "No simulator is booted")

- [ ] **Step 3: Verify:**
  - `node --check` on every public JS file
  - `npm test` stays green
  - Headless Chrome screenshots of Home in light and dark mode at 1280 px and 500 px (v1 command), each read and inspected
  - Fix any overflow or broken layout before moving on

- [ ] **Step 4: Run** `git status`. Nothing committed.

---

### Task 11: Release, Quality, and Team Views

**Files:**
- Create: `public/views/release.js`, `public/views/quality.js`, `public/views/team.js`
- Modify: `public/style.css`

- [ ] **Step 1: Release:**
  - Header: version name, release date, and days left; a branch status chip ("Not cut" or a link)
  - Four grouped lists (In the Version, Not Merged Yet, Unplanned, Cherry-Pick Candidates). The last is hidden when the branch isn't cut.
  - A release notes card in a `<pre>` with a **Copy** button (`navigator.clipboard.writeText` with a select-text fallback)
- [ ] **Step 2: Quality:**
  - TS budget card: latest count, change since the previous run, and an inline SVG sparkline of history (no library). Shows the running phase with a spinner and has a **Run Now** button.
  - Test health list: one row per suite with pass rate, latest result chip, and "last run N days ago" (orange when older than 14 days)
  - Flaky runs list with links
- [ ] **Step 3: Team:**
  - Review queue: reviewers with counts and oldest wait, then PRs waiting (overdue rows show an orange "Waiting N days" chip)
  - All Open PRs list (v1's All tab, moved here)
- [ ] **Step 4: Verify:** the same verification as Task 10, Step 3, for all three views
- [ ] **Step 5: Run** `git status`. Nothing committed.

---

### Task 12: README and End-to-End Read-Only Check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update `README.md`:**
  - Jira setup (`.env` keys, token creation link `https://id.atlassian.com/manage-profile/security/api-tokens`, never commit `.env`)
  - The four views
  - The write actions and what each one changes
  - The TypeScript budget's use of a cache worktree
  - Phase 2 and 3 features listed as "later, needs credentials"
- [ ] **Step 2: Run** `npm test`. Expected: everything passes, with the count reported.
- [ ] **Step 3: Read-only smoke check against real services:** start the server and GET every route. Report each status code. No POSTs.
- [ ] **Step 4: Run** `git status` and list the untracked and modified files for the user. Don't commit.
