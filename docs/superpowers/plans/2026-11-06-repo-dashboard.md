# Mobile Clock Repo Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web dashboard for `tcp-software/mobile-clock` that lists PRs, triggers dev builds from approved PRs through a modal, monitors Actions runs, shows a status strip, and sends desktop notifications.

**Architecture:** A zero-dependency Node HTTP server shells out to the `gh` CLI (via `execFile`, never a shell) and exposes a small JSON API on `127.0.0.1`. One static page (plain HTML, CSS, and ES-module JS) polls that API. Pure logic (staleness, run matching, badge color, notification diffing) lives in small modules tested with `node:test` and a fake `gh` runner.

**Tech Stack:** Node 20 (`node:http`, `node:child_process`, `node:test`), `gh` 2.103.3, plain browser JS. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-repo-dashboard-design.md`

## Global Constraints

- **No commits:** do not run `git commit` or `git push` in any task; the user commits when they decide to. Each task ends with `git status` instead.
- Repo: `tcp-software/mobile-clock`, defined once in `config.js`
- Server binds `127.0.0.1` only; start with `npm start`
- All GitHub access through `gh` using the existing login; no tokens or secrets in the repo
- Builds: dev only. The server hardcodes `buildType='release dev'` and `sendReleaseUpdates=false`; the browser never sends either value
- The 4 build workflows: `run-mc-android.yml`, `run-mk-android.yml`, `run-mc-ios.yml`, `run-mk-ios.yml`
- Status strip: `run-ios-mc-nightly.yml` (latest run, any branch) and `run-tests.yml` on `develop`; no Mend badge
- "Approved" means `reviewDecision === 'APPROVED'`
- Stale: approved and unmerged more than 7 days after the latest approval, or open more than 14 days
- Behind indicator compares against the PR's own `baseRefName`
- Polling: about 15 seconds while any tracked run is queued or in progress, about 60 seconds otherwise
- Node 20, zero runtime dependencies

## Review Focus

1. **Cross-site requests:** a malicious web page POSTs to `http://127.0.0.1:<port>/api/prs/1042/builds`, or reaches the server through DNS rebinding. Expected: rejected (403) unless the `Host` header is `127.0.0.1:<port>` or `localhost:<port>` and the request carries `X-Dashboard: 1`. Tested in Task 5.
2. **Branch names with slashes:** `epic/TCPMOB-1423-technical-debt` and `release/1.45.x` as base or head. Expected: the compare URL encodes each side, and `--ref` receives the raw name as a single argv item. Tested in Tasks 2 and 3.
3. **`gh` failures:** not logged in, network down, or a 404. Expected: the API returns 502 with `gh` stderr in `{ error }`, and the page shows the message in place of a blank list. Tested in Tasks 1 and 5.
4. **Double-clicked trigger, or two builds of one workflow close together:** Expected: the modal button disables while a request is in flight, and run matching never assigns one run to two tracked builds. Tested in Task 3.
5. **Building a PR that isn't approved, is closed, or with unknown build keys:** Expected: 409 for not-open or not-approved, 400 for an empty or unknown key list; the branch is always taken from GitHub, never from the request body. Tested in Task 3.

---

## File Structure

```
mobile-clock-dashboard/
  package.json        scripts: start, test
  .gitignore          node_modules, .DS_Store
  README.md           setup + usage
  config.js           all constants
  lib/gh.js           gh runner (execFile wrapper, injectable)
  lib/prs.js          PR list, staleness, behind cache, update-branch
  lib/builds.js       trigger, run matching, tracker
  lib/runs.js         run list, rerun, cancel, status strip
  server.js           HTTP routes, security checks, static files
  public/index.html   layout: status strip, PR list, runs, modal
  public/style.css
  public/app.js       rendering, polling, modal
  public/notify.js    pure notification diff (shared with tests)
  test/*.test.js      one per lib module, plus server and notify
```

---

### Task 1: Scaffold, Config, and gh Runner

**Files:**
- Create: `package.json`, `.gitignore`, `config.js`, `lib/gh.js`
- Test: `test/gh.test.js`

**Interfaces:**
- Produces:
  - `config.js` exports `REPO = 'tcp-software/mobile-clock'`, `PORT = 4317`, `HOST = '127.0.0.1'`, `BUILDS = { mcAndroid: { file: 'run-mc-android.yml', label: 'Android MobileClock' }, mkAndroid: { file: 'run-mk-android.yml', label: 'Android Mobile Kiosk' }, mcIos: { file: 'run-mc-ios.yml', label: 'iOS MobileClock' }, mkIos: { file: 'run-mk-ios.yml', label: 'iOS MobileKiosk' } }`, `STATUS = [{ key: 'nightly', label: 'iOS MC nightly', file: 'run-ios-mc-nightly.yml', branch: null }, { key: 'devTests', label: 'develop unit tests', file: 'run-tests.yml', branch: 'develop' }]`, `STALE_APPROVED_DAYS = 7`, `STALE_OPEN_DAYS = 14`, `BEHIND_TTL_MS = 300000`
  - `lib/gh.js` exports `class GhError extends Error { stderr: string }` and `createGh(exec = defaultExec) -> { run(args: string[]): Promise<string>, json(args: string[]): Promise<any> }`. `exec(file, args)` resolves `{ stdout }` or rejects with `{ stderr }`; `defaultExec` is `promisify(execFile)` with `maxBuffer: 10 MB`. Every call prepends nothing; callers pass `-R REPO` or `repos/REPO/...` themselves

- [ ] **Step 1: Create `package.json`** with `"type": "module"`, `"private": true`, `"engines": { "node": ">=20" }`, scripts `"start": "node server.js"`, `"test": "node --test test/"`, and no dependencies. Create `.gitignore` with `node_modules/` and `.DS_Store`.

- [ ] **Step 2: Write the failing tests** in `test/gh.test.js`

```js
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
```

- [ ] **Step 3: Run** `npm test`. Expected: FAIL, cannot find `lib/gh.js`.

- [ ] **Step 4: Implement `config.js` and `lib/gh.js`** per the Interfaces block. `GhError.message` is the trimmed stderr, or the original message if stderr is empty.

- [ ] **Step 5: Run** `npm test`. Expected: 3 passing.

- [ ] **Step 6: Run** `git status`. Expected: new files untracked; nothing committed.

---

### Task 2: PRs Module

**Files:**
- Create: `lib/prs.js`
- Test: `test/prs.test.js`

**Interfaces:**
- Consumes: `createGh` (Task 1), `REPO`, `STALE_*`, `BEHIND_TTL_MS` from `config.js`
- Produces:
  - `listPrs(gh) -> Promise<Pr[]>` where `Pr = { number, title, url, author, headRefName, baseRefName, isDraft, approved: boolean, reviewDecision, checks: 'success'|'failure'|'pending'|'none', reviewRequestedLogins: string[], createdAt, approvedAt: string|null, stale: boolean }`
  - `isStale(pr: { approved, approvedAt, createdAt }, now: Date) -> boolean`
  - `checkState(rollup: Array<{ conclusion?: string, status?: string, state?: string }>) -> 'success'|'failure'|'pending'|'none'`
  - `getPr(gh, number: number) -> Promise<{ number, state, headRefName, baseRefName, reviewDecision }>`
  - `createBehindCache(gh, now = () => Date.now()) -> { get(base: string, head: string): Promise<number>, clear(): void }`
  - `updateBranch(gh, number: number) -> Promise<void>`

- [ ] **Step 1: Write the failing tests** in `test/prs.test.js`

```js
const now = new Date('2026-11-06T12:00:00Z');
const daysAgo = (d) => new Date(now - d * 864e5).toISOString();
test('approved more than 7 days ago is stale', () => {
  assert.equal(isStale({ approved: true, approvedAt: daysAgo(8), createdAt: daysAgo(9) }, now), true);
});
test('approved 6 days ago and open 10 days is not stale', () => {
  assert.equal(isStale({ approved: true, approvedAt: daysAgo(6), createdAt: daysAgo(10) }, now), false);
});
test('unapproved but open 15 days is stale', () => {
  assert.equal(isStale({ approved: false, approvedAt: null, createdAt: daysAgo(15) }, now), true);
});
test('checkState: any failure wins, then pending, empty is none', () => {
  assert.equal(checkState([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'failure');
  assert.equal(checkState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(checkState([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' }]), 'success');
  assert.equal(checkState([]), 'none');
});
test('listPrs maps approved and approvedAt from latest APPROVED review', async () => {
  const gh = { json: async () => [{ number: 1042, title: 't', url: 'u', author: { login: 'fahmedtcp' }, headRefName: 'h', baseRefName: 'develop', isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [], createdAt: daysAgo(3), reviewRequests: [], latestReviews: [{ state: 'APPROVED', submittedAt: daysAgo(2) }, { state: 'COMMENTED', submittedAt: daysAgo(1) }] }] };
  const [pr] = await listPrs(gh);
  assert.equal(pr.approved, true);
  assert.equal(pr.approvedAt, daysAgo(2));
  assert.equal(pr.author, 'fahmedtcp');
});
test('empty reviewDecision is not approved', async () => {
  const gh = { json: async () => [{ number: 875, author: { login: 'x' }, reviewDecision: '', statusCheckRollup: [], reviewRequests: [], latestReviews: [], createdAt: daysAgo(1) }] };
  assert.equal((await listPrs(gh))[0].approved, false);
});
test('behind cache encodes slashed branch names and caches for TTL', async () => {
  const args = []; let t = 0;
  const gh = { run: async (a) => { args.push(a); return '3\n'; } };
  const cache = createBehindCache(gh, () => t);
  assert.equal(await cache.get('epic/TCPMOB-1423-technical-debt', 'TCPMOB-1/x'), 3);
  await cache.get('epic/TCPMOB-1423-technical-debt', 'TCPMOB-1/x');
  assert.equal(args.length, 1);
  assert.ok(args[0].includes('repos/tcp-software/mobile-clock/compare/epic%2FTCPMOB-1423-technical-debt...TCPMOB-1%2Fx'));
  t = 300001; await cache.get('epic/TCPMOB-1423-technical-debt', 'TCPMOB-1/x');
  assert.equal(args.length, 2);
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL, cannot find `lib/prs.js`.

- [ ] **Step 3: Implement `lib/prs.js`**
  - `listPrs`: `gh pr list -R REPO --state open -L 100 --json number,title,url,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,createdAt,reviewRequests,latestReviews`. `approvedAt` is the latest `submittedAt` among `latestReviews` with `state === 'APPROVED'`. `reviewRequestedLogins` keeps entries with a `login` (ignore team requests). `stale = isStale(pr, new Date())`
  - `checkState`: failure if any conclusion or state is `FAILURE`, `ERROR`, `CANCELLED`, or `TIMED_OUT`; pending if any item lacks a conclusion and has status other than `COMPLETED` (or state `PENDING`); `SKIPPED` and `NEUTRAL` count as success
  - `getPr`: `gh pr view <n> -R REPO --json number,state,headRefName,baseRefName,reviewDecision`
  - Behind cache: `gh api repos/REPO/compare/<enc(base)>...<enc(head)> --jq .behind_by` with `encodeURIComponent` on each side; key `base\0head`
  - `updateBranch`: `gh api -X PUT repos/REPO/pulls/<n>/update-branch`

- [ ] **Step 4: Run** `npm test`. Expected: all passing.

- [ ] **Step 5: Run** `git status`. Nothing committed.

---

### Task 3: Builds Module (Trigger, Match, Track)

**Files:**
- Create: `lib/builds.js`
- Test: `test/builds.test.js`

**Interfaces:**
- Consumes: `getPr` (Task 2), `BUILDS`, `REPO`
- Produces:
  - `class BuildRequestError extends Error { status: 400|409 }`
  - `createTracker(gh, now = () => Date.now()) -> { trigger(prNumber: number, keys: string[]): Promise<TrackedBuild[]>, refresh(): Promise<TrackedBuild[]>, list(): TrackedBuild[] }`
  - `TrackedBuild = { id: string, prNumber, key, label, file, branch, triggeredAt: number, runId: number|null, url: string|null, status: 'requested'|'queued'|'in_progress'|'completed', conclusion: string|null }`
  - `matchRun(runs: Run[], build: TrackedBuild, claimed: Set<number>) -> Run|null` where `Run = { databaseId, createdAt, status, conclusion, url }`

- [ ] **Step 1: Write the failing tests** in `test/builds.test.js`. The fake `gh` records `run` calls and serves `getPr` and `run list` JSON.

```js
test('trigger hardcodes dev values and uses the branch from GitHub', async () => {
  // fake getPr -> { state: 'OPEN', reviewDecision: 'APPROVED', headRefName: 'TCPMOB-1482-x' }
  await tracker.trigger(1042, ['mcAndroid', 'mkIos']);
  assert.deepEqual(runCalls, [
    ['workflow', 'run', 'run-mc-android.yml', '-R', 'tcp-software/mobile-clock', '--ref', 'TCPMOB-1482-x', '-f', 'buildType=release dev', '-f', 'sendReleaseUpdates=false'],
    ['workflow', 'run', 'run-mk-ios.yml', '-R', 'tcp-software/mobile-clock', '--ref', 'TCPMOB-1482-x', '-f', 'buildType=release dev', '-f', 'sendReleaseUpdates=false'],
  ]);
  assert.equal(tracker.list().length, 2);
});
test('rejects not-approved PR with 409', async () => { /* reviewDecision: 'REVIEW_REQUIRED' */
  await assert.rejects(tracker.trigger(1084, ['mcAndroid']), (e) => e.status === 409);
});
test('rejects closed PR with 409', async () => { /* state: 'MERGED' */ });
test('rejects empty or unknown keys with 400 and triggers nothing', async () => {
  await assert.rejects(tracker.trigger(1042, []), (e) => e.status === 400);
  await assert.rejects(tracker.trigger(1042, ['mcAndroid', 'releaseProd']), (e) => e.status === 400);
  assert.equal(runCalls.length, 0);
});
test('matchRun picks earliest unclaimed run created no earlier than 10s before trigger', () => {
  const b = { triggeredAt: Date.parse('2026-11-06T12:00:00Z') };
  const runs = [
    { databaseId: 3, createdAt: '2026-11-06T12:00:09Z' },
    { databaseId: 2, createdAt: '2026-11-06T12:00:04Z' },
    { databaseId: 1, createdAt: '2026-11-06T11:58:00Z' },
  ];
  assert.equal(matchRun(runs, b, new Set()).databaseId, 2);
  assert.equal(matchRun(runs, b, new Set([2])).databaseId, 3);
  assert.equal(matchRun(runs, b, new Set([2, 3])), null);
});
test('refresh fills runId/status for two builds of one workflow without sharing a run', async () => { /* two trigger() calls on same PR+key, fake run list returns 2 runs */ });
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL, cannot find `lib/builds.js`.

- [ ] **Step 3: Implement `lib/builds.js`**
  - `trigger`: validate keys (non-empty, all in `BUILDS`) before any `gh` call, then `getPr`; 409 unless `state === 'OPEN'` and `reviewDecision === 'APPROVED'`. Trigger sequentially; record each with `status: 'requested'`. If one `gh workflow run` fails, keep the ones already sent and rethrow with which keys succeeded in the message
  - `refresh`: for each build not `completed`, `gh run list -R REPO -w <file> -b <branch> -e workflow_dispatch -L 10 --json databaseId,createdAt,status,conclusion,url`; unmatched builds call `matchRun` with a set of all run IDs already claimed; matched builds copy `status`, `conclusion`, `url`
  - `matchRun`: 10-second clock-skew allowance, earliest `createdAt` first
  - Tracker state is in memory (spec leaves this to the builder; lost on server restart)

- [ ] **Step 4: Run** `npm test`. Expected: all passing.

- [ ] **Step 5: Run** `git status`. Nothing committed.

---

### Task 4: Runs and Status Strip

**Files:**
- Create: `lib/runs.js`
- Test: `test/runs.test.js`

**Interfaces:**
- Consumes: `REPO`, `STATUS`
- Produces:
  - `listRuns(gh, { workflow?: string, branch?: string, user?: string }) -> Promise<Run[]>` with `Run = { databaseId, workflowName, headBranch, event, status, conclusion, createdAt, updatedAt, url, displayTitle }`
  - `rerunFailed(gh, id: number) -> Promise<void>`; `cancelRun(gh, id: number) -> Promise<void>`
  - `badgeColor(run: Run|null) -> 'green'|'red'|'grey'`
  - `statusStrip(gh) -> Promise<Array<{ key, label, color, url: string|null, conclusion: string|null }>>`
  - `getLogin(gh) -> Promise<string>` (cached after the first call)

- [ ] **Step 1: Write the failing tests**

```js
test('badgeColor', () => {
  assert.equal(badgeColor({ status: 'completed', conclusion: 'success' }), 'green');
  for (const c of ['failure', 'cancelled', 'timed_out', 'startup_failure']) assert.equal(badgeColor({ status: 'completed', conclusion: c }), 'red');
  assert.equal(badgeColor({ status: 'in_progress', conclusion: '' }), 'grey');
  assert.equal(badgeColor(null), 'grey');
});
test('listRuns passes filters as flags', async () => {
  await listRuns(gh, { workflow: 'run-tests.yml', branch: 'develop', user: 'fahmedtcp' });
  assert.deepEqual(lastArgs.slice(0, 10), ['run', 'list', '-R', 'tcp-software/mobile-clock', '-L', '50', '-w', 'run-tests.yml', '-b', 'develop']);
  assert.ok(lastArgs.includes('-u') && lastArgs.includes('fahmedtcp'));
});
test('statusStrip queries develop only for devTests and returns grey when no runs', async () => { /* fake returns [] */ });
test('rerunFailed and cancelRun', async () => {
  // expect ['run','rerun','123','--failed','-R',REPO] and ['run','cancel','123','-R',REPO]
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement `lib/runs.js`** per the Interfaces block. `statusStrip` runs `gh run list -R REPO -w <file> [-b <branch>] -L 1 --json ...` for each `STATUS` entry in parallel. `getLogin` uses `gh api user --jq .login`.

- [ ] **Step 4: Run** `npm test`. Expected: all passing.

- [ ] **Step 5: Run** `git status`. Nothing committed.

---

### Task 5: HTTP Server

**Files:**
- Create: `server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: Tasks 1–4
- Produces: `createServer({ gh, tracker, behind, port }) -> http.Server` (exported for tests; `server.js` listens on `HOST:PORT` and opens the browser with `open http://localhost:PORT` when run directly). JSON API:

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/me` | | `{ login }` |
| GET | `/api/prs` | | `Pr[]` |
| GET | `/api/prs/:n/behind` | | `{ behind: number }` |
| POST | `/api/prs/:n/update-branch` | | `{ ok: true }` |
| POST | `/api/prs/:n/builds` | `{ keys: string[] }` | `TrackedBuild[]` (new ones) |
| GET | `/api/builds` | | `TrackedBuild[]` after `tracker.refresh()` |
| GET | `/api/runs?workflow=&branch=&mine=1` | | `Run[]` |
| POST | `/api/runs/:id/rerun` | | `{ ok: true }` |
| POST | `/api/runs/:id/cancel` | | `{ ok: true }` |
| GET | `/api/status` | | badges |
| GET | `/api/builds-config` | | `BUILDS` as `[{ key, label }]` |

Anything else under `/api` is 404; other paths serve `public/` (`index.html` for `/`), refusing paths that resolve outside `public/`.

- [ ] **Step 1: Write the failing tests** using `createServer` on port 0 with fakes

```js
test('rejects foreign Host header with 403', async () => {
  const res = await fetch(`${base}/api/prs`, { headers: { Host: 'evil.example:4317', 'X-Dashboard': '1' } });
  assert.equal(res.status, 403);
});
test('rejects POST without X-Dashboard header with 403 and triggers nothing', async () => {
  const res = await fetch(`${base}/api/prs/1042/builds`, { method: 'POST', body: '{"keys":["mcAndroid"]}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 403);
  assert.equal(fakeTracker.triggerCalls.length, 0);
});
test('ignores branch/buildType in POST body; passes only number and keys', async () => {
  await post('/api/prs/1042/builds', { keys: ['mcIos'], branch: 'release/1.45.x', buildType: 'release prod' });
  assert.deepEqual(fakeTracker.triggerCalls, [[1042, ['mcIos']]]);
});
test('BuildRequestError status passes through', async () => { /* tracker throws 409 -> response 409 { error } */ });
test('GhError becomes 502 with stderr in error', async () => { /* gh throws GhError('gh auth login') -> 502 */ });
test('non-numeric :n or :id is 400', async () => { /* /api/prs/abc/behind */ });
test('static path traversal is 404', async () => { /* GET /..%2Fpackage.json */ });
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement `server.js`** with `node:http`. Allowed hosts: `127.0.0.1:<port>` and `localhost:<port>` (use the actual bound port). Every `/api` request needs an allowed `Host`; every POST also needs `X-Dashboard: 1`. Request body limit 10 KB. The `behind` route reads `baseRefName` and `headRefName` with `getPr`, never from the query. Successful `update-branch` clears the behind cache.

- [ ] **Step 4: Run** `npm test`. Expected: all passing.

- [ ] **Step 5: Smoke check** with the real `gh`: `npm start`, then `curl -s -H 'X-Dashboard: 1' http://127.0.0.1:4317/api/prs | head -c 300` and `curl -s http://127.0.0.1:4317/api/status`. Expected: JSON with real PR numbers, and two badges. Stop the server. Do not call any POST route against the real repo.

- [ ] **Step 6: Run** `git status`. Nothing committed.

---

### Task 6: Page, PR List, and Build Modal

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/app.js`

**Interfaces:**
- Consumes: the Task 5 API. Every `fetch` sends `X-Dashboard: 1`; POSTs also send `Content-Type: application/json`
- Produces: `app.js` exports nothing; `index.html` has regions `#status-strip`, `#prs`, `#runs`, `<dialog id="build-modal">`

- [ ] **Step 1: Build the PR list** in `#prs`
  - Filter tabs: Mine (`author === login`), Review requested (`reviewRequestedLogins` includes login), All. Default: Mine
  - Row: `#number` linking to `url`, title, author, branch, draft tag, review state, check dot, stale tag, behind count (fetched lazily per visible row from `/api/prs/:n/behind`; shows "↓N from <base>" and a **Merge base in** button when N > 0, which uses `confirm()` before POSTing)
  - **Build** button only when `approved`

- [ ] **Step 2: Build the modal** with native `<dialog>` (spec choice B)
  - Header: `Build #<n>`, title, full branch name
  - 4 checkboxes from `/api/builds-config`, all checked on open
  - Primary button text `Trigger N builds` (singular "build" when N is 1), disabled at N = 0 and while the request is in flight; Cancel closes
  - No build-type dropdown and no notify checkbox
  - On success, close and show the new builds in the PR row; on error, keep the modal open and show the `error` text inside it

- [ ] **Step 3: Show tracked builds** under each PR row from `/api/builds`: label, status, conclusion, link when `url` is set

- [ ] **Step 4: Show load errors:** when any API call returns non-2xx, show its `error` text in a banner at the top of the region instead of an empty list

- [ ] **Step 5: Manual check:** `npm start`. Verify the Mine tab shows your PRs (for example, #1042), the Build button appears only on approved rows, the modal opens with 4 checked boxes, unchecking one changes the label to "Trigger 3 builds", and Cancel closes it without a network POST (check DevTools Network). Do not click Trigger yet.

- [ ] **Step 6: Run** `git status`. Nothing committed.

---

### Task 7: Actions Monitor, Status Strip, Notifications, and Polling

**Files:**
- Create: `public/notify.js`
- Modify: `public/app.js`, `public/index.html`, `public/style.css`
- Test: `test/notify.test.js`

**Interfaces:**
- Produces: `public/notify.js` exports `diffNotifications(prev: { builds: TrackedBuild[], badges: Badge[] } | null, next: same) -> Array<{ title: string, body: string, url: string|null }>` and `pollDelay(builds: TrackedBuild[], runs: Run[]) -> 15000|60000`

- [ ] **Step 1: Write the failing tests** in `test/notify.test.js` (import from `../public/notify.js`)

```js
test('first load never notifies', () => {
  assert.deepEqual(diffNotifications(null, { builds: [done('success')], badges: [badge('red')] }), []);
});
test('build moving to completed notifies once with conclusion', () => {
  const n = diffNotifications({ builds: [b('in_progress')], badges: [] }, { builds: [done('failure')], badges: [] });
  assert.equal(n.length, 1);
  assert.match(n[0].title, /Android MobileClock/);
  assert.match(n[0].body, /failure/);
});
test('badge turning red notifies; red staying red does not', () => {
  assert.equal(diffNotifications({ builds: [], badges: [badge('green')] }, { builds: [], badges: [badge('red')] }).length, 1);
  assert.equal(diffNotifications({ builds: [], badges: [badge('red')] }, { builds: [], badges: [badge('red')] }).length, 0);
});
test('pollDelay is 15s with active work, else 60s', () => {
  assert.equal(pollDelay([b('requested')], []), 15000);
  assert.equal(pollDelay([], [{ status: 'queued' }]), 15000);
  assert.equal(pollDelay([done('success')], [{ status: 'completed' }]), 60000);
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement `public/notify.js`** (no DOM or browser APIs, so it runs in Node). Builds match by `id`; badges match by `key`.

- [ ] **Step 4: Run** `npm test`. Expected: all passing.

- [ ] **Step 5: Wire up `app.js`**
  - Status strip: two badges from `/api/status`, each linking to its run
  - Actions monitor in `#runs`: table of `/api/runs`, with filters for workflow (select of distinct `workflowName`s), branch (text), and Mine (checkbox mapping to `mine=1`). Per row: open link, **Rerun failed** (only when `conclusion === 'failure'`), **Cancel** (only when queued or in progress; needs `confirm()`)
  - Polling: one loop refreshes PRs, builds, runs, and status, then schedules itself with `pollDelay`. Skip a tick while the previous one is still in flight
  - Notifications: request permission once on the first user click (browsers block unprompted requests); on each tick, `new Notification(title, { body })` for each `diffNotifications` result, with `onclick` opening `url`

- [ ] **Step 6: Manual check:** `npm start`. Verify the status strip shows two badges, the runs table filters by workflow and Mine, and the Rerun and Cancel buttons appear only on matching rows. Do not click them against real runs unless the user OKs it.

- [ ] **Step 7: Run** `git status`. Nothing committed.

---

### Task 8: README and End-to-End Check

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`:** prerequisites (Node 20+, `gh auth login` with access to `tcp-software`), `npm start`, `npm test`, what the Build button sends (dev only, no QA/InfoSec notify), and that the server listens only on `127.0.0.1`

- [ ] **Step 2: Run** `npm test`. Expected: all suites pass, 0 failures.

- [ ] **Step 3: Live trigger check, only with the user's explicit OK:** ask the user to pick one approved PR of theirs and one build, trigger it from the modal, and confirm the PR row shows `requested`, then `queued` or `in_progress` with a working log link, and that a desktop notification arrives when it completes. This costs a real CI build, so never run it without asking.

- [ ] **Step 4: Run** `git status` and report the untracked file list to the user. Do not commit.
