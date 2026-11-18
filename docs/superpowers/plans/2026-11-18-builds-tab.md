# Builds Tab, Build Conflict Checks, and Editable Teams Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn before starting a build that collides with a running one, queue iOS builds until their slot frees up, give builds their own tab, and make the review and QA Teams messages editable.

**Architecture:**
- A new pure module, `lib/build-slots.js`, reads active runs per build workflow and decides conflicts.
- The tracker (`lib/builds.js`) uses it when starting builds and before automatic iOS retries.
- A small saved queue, `lib/build-queue.js`, rides the existing 30-second background loop.
- `lib/build-overview.js` feeds a new `public/views/builds.js` tab, which replaces Home's Actions list.
- Teams cards take an optional free-text body.

**Tech Stack:** Node 20, no npm dependencies, `node:test`, vanilla ES modules in `public/`, headless Chrome CDP for page checks.

**Spec:** `docs/superpowers/specs/2026-11-18-builds-tab-design.md`

## Global Constraints

- Zero npm dependencies. Follow the existing patterns:
  - route tables `[method, regex, handler]`
  - `ctx` injection
  - `el()` builds DOM with `textContent` only
  - `HttpError` and `BuildRequestError` for HTTP errors
- No calls to real GitHub, Jira, or Teams in tests or development. Use fakes (`gh.run` and `gh.json` stubs, fake servers).
- Tests run with `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off npm test`
- Build workflows: `run-mc-ios.yml`, `run-mk-ios.yml`, `run-mc-android.yml`, `run-mk-android.yml`
- iOS slots: `mcIos` uses `run-mc-ios.yml`, and `mkIos` uses `run-mk-ios.yml`. `mcIosSim` never trips the iOS slot rule when starting.
- Active statuses: `queued`, `in_progress`, `waiting`, `pending`, `requested`
- History is the last 14 days. Queue entries expire after 8 hours. A retry wait never expires.
- Teams text is at most 2,000 characters and can't be empty. The character count shows above 1,800.
- UI copy follows the org style: AP Style, contractions, title-case headings, no first person
- CSS only for motion: row insert and remove fade at 200 ms ease-out. Everything is instant under `prefers-reduced-motion: reduce`.
- Commit after each task. Don't push.

## Review Focus

- A conflict check that sees a 15-second-old cached run list misses a build started seconds ago. Checks must read fresh. (Task 1 test: `fresh` bypasses the cache.)
- A tracker build that's been dispatched but isn't on GitHub's list yet must hold its iOS slot. (Task 1 test: `requested` tracker build counts as busy.)
- A queued build whose PR lost approval or closed must be dropped, never started. (Task 3 test.)
- A server restart with queue entries on disk must neither lose them nor start them twice. (Task 3 test: reload from file; started entry removed before save.)
- A TestFlight duplicate-upload failure must stay retryable, never classified as `code`. (Task 2 test.)

---

### Task 1: Active Runs and Conflict Rules

**Files:**
- Modify: `lib/gh.js` (the `json`/`run` facade accepts an options argument)
- Create: `lib/build-slots.js`
- Test: `test/build-slots.test.js`, `test/gh.test.js`

**Interfaces:**
- Produces:
  - `gh.json(args, { fresh = false } = {})`: with `fresh`, skips a cache hit but still stores the new result
  - `BUILD_FILES = ['run-mc-ios.yml', 'run-mk-ios.yml', 'run-mc-android.yml', 'run-mk-android.yml']`
  - `IOS_SLOTS = { 'run-mc-ios.yml': 'iOS MobileClock', 'run-mk-ios.yml': 'iOS MobileKiosk' }`
  - `async recentRuns(gh, file, { fresh = false, actor = null, since = null, perPage = 30 } = {}) -> Run[]`
    - `Run` is `{ runId, file, url, branch, actor, status, conclusion, createdAt, startedAt, updatedAt, attempt }`
  - `isActive(run) -> boolean`
  - `findConflicts({ keys, branch, active, tracked }) -> { [key]: Conflict[] }`
    - `active` is `{ [file]: Run[] }` (active runs only)
    - `tracked` is the tracker's `list()`
    - `Conflict` is `{ rule: 'ios-slot' | 'same-branch', runId, url, branch, actor, startedAt, ticketKey }`
  - `slotBusy({ file, active, tracked, excludeBuildId = null }) -> Conflict | null`
  - `ticketKeyOf(branch) -> string | null`

- [ ] **Step 1: Write the failing tests** in `test/build-slots.test.js`:
  - `recentRuns maps REST runs`: a fake `gh.json` returns `{ workflow_runs: [{ id: 9, html_url: 'u', head_branch: 'TCPMOB-1764-x', actor: { login: 'hamza' }, status: 'in_progress', conclusion: null, created_at: 'c', run_started_at: 's', updated_at: 'd', run_attempt: 1 }] }`
    - The call args are `['api', 'repos/tcp-software/mobile-clock/actions/workflows/run-mc-ios.yml/runs', '-X', 'GET', '-f', 'per_page=30']`
    - With `actor: 'me', since: '2026-11-04'`, the call adds `-f actor=me -f created=>=2026-11-04`
    - The mapped run equals `{ runId: 9, file: 'run-mc-ios.yml', url: 'u', branch: 'TCPMOB-1764-x', actor: 'hamza', status: 'in_progress', conclusion: null, createdAt: 'c', startedAt: 's', updatedAt: 'd', attempt: 1 }`
    - A response that's an array or lacks `workflow_runs` gives `[]`
  - `ios slot conflicts across branches, not across apps`: an active `run-mc-ios.yml` run on another branch gives an `mcIos` conflict with `rule: 'ios-slot'` and `ticketKey: 'TCPMOB-1764'`. `mkIos` gets none.
  - `sim start never trips the ios slot rule`: same input gives `mcIosSim` no conflicts. With the same branch, it gets `same-branch`.
  - `same-branch applies to android`: an active `run-mc-android.yml` run on `branch` gives `mcAndroid` a `same-branch` conflict. One on another branch gives none.
  - `requested tracker build holds its slot`: no active runs, but `tracked` has `{ key: 'mkIos', status: 'requested', runId: null, branch: 'b2', triggeredAt }`. `mkIos` then gets an `ios-slot` conflict with `runId: null`.
  - `tracked sim run frees the ios slot`: an active `run-mc-ios.yml` run whose `runId` matches a tracked `mcIosSim` build means `mcIos` has no `ios-slot` conflict
  - `waiting-slot tracker build doesn't hold the slot`
  - `slotBusy ignores excludeBuildId`
- [ ] **Step 2: Add the gh test.** In `test/gh.test.js`, add `fresh skips a cache hit`: two `json` calls with the same args within 15 s make one exec call. A third call with `{ fresh: true }` makes a second exec call.
- [ ] **Step 3: Run the tests and confirm they fail.** Run: `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off node --test test/build-slots.test.js test/gh.test.js`. Expected: FAIL (module missing, extra exec call count).
- [ ] **Step 4: Implement.**
  - `gh.js`: `load(args, { fresh })` skips the `hit` check when `fresh`
  - `build-slots.js`: pure functions, except `recentRuns`. `recentRuns` uses `gh api` so both the direct path and the CLI fallback return `actor`, which `gh run list --json` lacks.
  - Tracked builds that hold a slot: `status === 'requested'`, or `status === 'queued' && waitAttempt > attempt`
  - Dedupe conflicts by `runId` when it isn't null
- [ ] **Step 5: Run the tests and confirm they pass.** Same command. Then run the full `npm test` and confirm all pass.
- [ ] **Step 6: Commit.** `git commit -m "feat: active build runs and conflict rules"`

### Task 2: Conflict-Checked Starts and Slot-Aware Retries

**Files:**
- Modify: `lib/builds.js`, `server.js` (route and error body)
- Test: `test/builds.test.js`, `test/retryclass.test.js`, `test/server.test.js`

**Interfaces:**
- Consumes: Task 1 (`recentRuns`, `isActive`, `findConflicts`, `slotBusy`, `BUILD_FILES`)
- Produces:
  - `tracker.check(prNumber) -> { branch, conflicts: { [key]: Conflict[] } }`. Reads every `BUILD_FILES` workflow with `fresh: true`, in parallel.
  - `tracker.trigger(prNumber, keys, { force = [] } = {})`:
    - Before dispatching, it refuses with `BuildRequestError(409)` when any key not in `force` has conflicts
    - The error's `conflicts` field holds those conflicts. Nothing is dispatched.
  - `tracker.activeSnapshot() -> Promise<{ [file]: Run[] }>`, a fresh read used by the queue
  - New build status `'waiting-slot'`, with fields `waitingSince` (ms) and `pendingRun` (the run id to rerun)
  - `tracker.waitingRetries() -> Build[]`
  - `tracker.resumeRetry(build) -> Promise<void>`: reruns and sets the build `queued` as `retry()` does today
  - `tracker.cancelWait(id)`: marks the build `completed`, keeping its `conclusion`, with `reason.step = 'Retry cancelled'`
  - `GET /api/prs/:n/build-check` returns `tracker.check(n)`
  - `POST /api/prs/:n/builds` takes the body `{ keys, force }`
  - Error JSON now includes `conflicts: err.conflicts`

- [ ] **Step 1: Write the failing tests** in `test/builds.test.js`. Extend `fakeGh` so `json(['api', …])` returns `{ workflow_runs: runsByFile[file] ?? [] }`.
  - `trigger refuses a conflicting key unless forced`: an active `run-mc-ios.yml` run on another branch
    - `trigger(1, ['mcIos'])` rejects with status 409, `conflicts.mcIos[0].rule === 'ios-slot'`, and `runCalls` empty
    - `trigger(1, ['mcIos'], { force: ['mcIos'] })` dispatches
  - `trigger with one clean and one conflicting key dispatches nothing`
  - `check returns conflicts per key and the PR branch`
  - `failed iOS build waits for a busy slot before retrying`: the tracked `mcIos` build's run completes with `failure` and an infra log, while another active `run-mc-ios.yml` run exists
    - After `refresh()`: `status === 'waiting-slot'`, no `rerun` call
    - After the other run completes and `queue.tick` calls `resumeRetry(build)`: one `['run', 'rerun', …]` call, and `status === 'queued'`
  - `failed Android build retries right away` (current behavior)
- [ ] **Step 2: Add the classification test** in `test/retryclass.test.js`: `TestFlight duplicate upload stays retryable`:

  ```js
  assert.notEqual(classifyFailure('failure', { lines: ['ERROR ITMS-90189: "Redundant Binary Upload. You\'ve already uploaded a build with build number \'512\'"'] }).kind, 'code');
  ```

- [ ] **Step 3: Add the server test** in `test/server.test.js`: `build-check route returns conflicts`, and `409 body carries conflicts`, using the existing fake-ctx server setup.
- [ ] **Step 4: Run the tests and confirm they fail.** Run: `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off node --test test/builds.test.js test/retryclass.test.js test/server.test.js`. Expected: FAIL.
- [ ] **Step 5: Implement.**
  - In `settle()`, when a failure is retryable and `build.key` is `mcIos` or `mkIos`, call `slotBusy({ file, active, tracked: builds, excludeBuildId: build.id })` on a fresh read
  - If the slot is busy, set `status: 'waiting-slot'`, `waitingSince: now()`, and `pendingRun: run.databaseId`, then save
  - `refreshOnce` skips `waiting-slot` builds; the queue resumes them
  - `load()` keeps `waiting-slot` builds (they aren't `completed`)
- [ ] **Step 6: Run the tests and confirm they pass.** Then run the full `npm test`.
- [ ] **Step 7: Commit.** `git commit -m "feat: conflict-checked build starts and slot-aware iOS retries"`

### Task 3: Start When Free Queue

**Files:**
- Create: `lib/build-queue.js`
- Modify: `server.js` (create it, add routes, and extend the background loop condition to include `queue.list().length || tracker.waitingRetries().length`; call `queue.tick()` after `tracker.refresh()`)
- Test: `test/build-queue.test.js`

**Interfaces:**
- Consumes:
  - Task 2: `tracker.trigger`, `tracker.activeSnapshot`, `tracker.waitingRetries`, `tracker.resumeRetry`, `tracker.list`
  - Task 1: `slotBusy`, `IOS_SLOTS`
  - `notify({ title, body })` from `lib/time/reminder.js`
- Produces:
  - `createQueue({ tracker, file = null, now = Date.now, notify }) -> { add, cancel, list, tick }`
    - `add({ prNumber, key, branch }) -> Entry`. Only `mcIos` and `mkIos` are accepted (`BuildRequestError(400)` otherwise).
    - `Entry` is `{ id, prNumber, key, branch, queuedAt }`
    - `cancel(id) -> boolean`
    - `list() -> Entry[]`
    - `tick() -> Promise<void>`
  - Routes:
    - `GET /api/build-queue` returns `{ entries, retries }`
    - `POST /api/build-queue` takes `{ prNumber, key }` and returns an entry. The server fills `branch` from `getPr`.
    - `DELETE /api/build-queue/:id` cancels a queue entry, or calls `tracker.cancelWait(id)` for a retry wait

**Behavior of `tick()`, per slot file:**
- Merge `waitingRetries()` (ordered by `waitingSince`) and entries (ordered by `queuedAt`) into one first-in, first-out line
- Expire entries older than 8 h with the notification "iOS MobileKiosk build for TCPMOB-1780 expired"
- If the slot is busy on a fresh snapshot, stop for that slot
- Otherwise, take the head only:
  - A retry calls `resumeRetry`
  - An entry is removed and saved first, then `trigger(prNumber, [key])` runs
- On success, notify: title "Build Started", body "iOS MobileKiosk build started for TCPMOB-1780"
- On `BuildRequestError` (not open, not approved, fork, or a same-branch conflict), notify "Build Dropped" with the error message
- Any other error logs with `console.error`. The entry is already removed, so it can never start twice.
- Saving reuses the `builds.js` atomic write (export `save` and `load` helpers, or duplicate the five lines). The file is `DATA_DIR/build-queue.json`.

- [ ] **Step 1: Write the failing tests** in `test/build-queue.test.js` with a fake tracker:
  - `starts head entry when slot free and notifies`
  - `leaves entries while slot busy`
  - `only one start per slot per tick`: two `mcIos` entries mean one `trigger` call
  - `mc and mk slots start independently`
  - `retry wait queued earlier goes before a newer entry`
  - `drops entry when trigger throws BuildRequestError 409 and notifies with its message`
  - `expires after 8 hours`
  - `reload from file keeps entries`
  - `entry removed from file before trigger runs`: the file is read inside the fake `trigger`
  - `add refuses Android keys`
- [ ] **Step 2: Run the tests and confirm they fail.** Run: `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off node --test test/build-queue.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `lib/build-queue.js`, then wire it in `server.js` as `ctx.queue`
- [ ] **Step 4: Run the tests and confirm they pass.** Then run the full `npm test`.
- [ ] **Step 5: Commit.** `git commit -m "feat: Start When Free queue for iOS builds"`

### Task 4: Builds Overview Endpoint

**Files:**
- Create: `lib/build-overview.js`
- Modify: `server.js` (route)
- Test: `test/build-overview.test.js`

**Interfaces:**
- Consumes: Task 1 (`recentRuns`, `isActive`, `ticketKeyOf`, `BUILD_FILES`, `IOS_SLOTS`), `getLogin(gh)`, `tracker.list()`, `queue.list()`
- Produces:
  - `async buildOverview({ gh, tracker, queue, now = Date.now }) -> Overview`, behind `GET /api/builds/overview`
  - `Overview` fields:
    - `slots: [{ file, label, busy: Conflict | null, medianMs: number | null, waiting: number }]`
    - `waiting: [{ id, kind: 'queue' | 'retry', key, label, prNumber, branch, ticketKey, since }]`
    - `running: [{ ...Run, label, ticketKey, mine: boolean }]`
    - `history: [{ ...Run, label, ticketKey, durationMs, build: TrackerBuild | null }]`, newest first
    - `week: { count, passed, retriesSaved, iosMedianMs }`
  - `median(numbers) -> number | null`

**Values:**
- One `recentRuns(file, { perPage: 30 })` call per workflow feeds `running`, `slots.busy`, and the median. The median is taken over the last 20 `success` runs: `updatedAt − startedAt`.
- One `recentRuns(file, { actor: login, since: <today − 14 days as YYYY-MM-DD>, perPage: 100 })` call per workflow feeds `history`. Only completed runs are kept.
- `history[].build` is the tracker build with the same `runId`
- `label` comes from file to label: iOS MobileClock, iOS MobileKiosk, Android MobileClock, Android MobileKiosk
- `week` covers runs since Monday 00:00 local
  - `retriesSaved` counts tracker builds with `conclusion === 'success' && retries > 0` in that window
  - `iosMedianMs` is the median of both iOS workflows' success durations
- Uses the normal 15-second cache (no `fresh`)

- [ ] **Step 1: Write the failing tests**, using a fake gh keyed by file and actor:
  - `slots show busy run and median of last 20 successes`
  - `running includes everyone and marks mine`
  - `history keeps only my completed runs within 14 days, newest first, joined to tracker builds`
  - `week counts since Monday with retriesSaved`
  - `waiting lists queue entries and retry waits`
  - `median([]) is null; median([3,1,2]) is 2`
- [ ] **Step 2: Run the tests and confirm they fail.** Run: `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off node --test test/build-overview.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `Promise.all` across workflows.
- [ ] **Step 4: Run the tests and confirm they pass.** Then run the full `npm test`.
- [ ] **Step 5: Commit.** `git commit -m "feat: builds overview endpoint"`

### Task 5: Build Sheet Conflict Warnings and Start When Free

**Files:**
- Modify: `public/views/home.js` (`buildCheckboxes`, `syncBuildButton`, `openBuildSheet`; export `openBuildSheet`, `createBug`, and `installOnSim`), `public/notify.js` (`submitState`), `public/style.css`
- Test: `test/notify.test.js`

**Interfaces:**
- Consumes: Task 2 routes (`build-check`, `builds` with `force`, 409 `conflicts`) and Task 3 `POST /api/build-queue`
- Produces:
  - `submitState({ start, queue }, inFlight) -> { disabled, label }`
  - Exports from `home.js`, for Task 6: `openBuildSheet(pr, preselect)`, `createBug(build)`, `installOnSim(build)`

**Copy and states:**
- While checking, a footnote reads "Checking for running builds…", in a fixed-height row so the sheet doesn't jump
- When the check fails: "Couldn't check for running builds. You can still start them."
- The warning sits under its box, in amber (`.build-warn`):
  - iOS slot: "{label} is already building {ticketKey ?? branch} for {actor} ({N} min). A second iOS build fails on TestFlight."
  - Same branch: "{label} is already building this branch ({N} min)."
- Conflicting boxes start unchecked. Re-checking one adds it to `force`.
- For an iOS slot conflict, the note has a **Start When Free** toggle button (`aria-pressed`). Pressing it checks the box and marks it queued.
- Button labels:
  - "Start 2 Builds"
  - "Start 1 Build, Queue 1"
  - "Queue 1 Build"
  - "Starting…" while sending
- Confirm sends `POST /api/prs/:n/builds { keys: startKeys, force }` and then one `POST /api/build-queue` per queued key
- A 409 with `conflicts` (a race since the sheet opened) repaints the warnings from `err.data.conflicts` and unchecks those boxes
- Toast copy:
  - "Started 1 build, queued 1"
  - "Queued 1 build. You'll get a notification when it starts."

- [ ] **Step 1: Write the failing test** in `test/notify.test.js`: `submitState labels`
  - `{ start: 2, queue: 0 }` → "Start 2 Builds"
  - `{ start: 1, queue: 1 }` → "Start 1 Build, Queue 1"
  - `{ start: 0, queue: 1 }` → "Queue 1 Build"
  - `{ start: 0, queue: 0 }` → disabled
  - In flight → "Starting…", disabled
  - Update any existing `submitState` tests to the new signature
- [ ] **Step 2: Run the test and confirm it fails.** Run: `node --test test/notify.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the sheet and CSS (`.build-warn`, and `.build-check` with a fixed `min-height`)
- [ ] **Step 4: Run the tests and confirm they pass.** Then run the full `npm test`.
- [ ] **Step 5: Check the page with CDP** against a fake server (scratchpad `fake-demo.mjs` pattern) where `run-mc-ios.yml` has an active run:
  - Open the build sheet. Confirm the iOS MobileClock box is unchecked, the warning text shows, and no runtime exceptions occur.
  - Press Start When Free. Confirm the button label reads "Start N Builds, Queue 1".
- [ ] **Step 6: Commit.** `git commit -m "feat: build sheet conflict warnings and Start When Free"`

### Task 6: Builds Tab

**Files:**
- Create: `public/views/builds.js`
- Modify:
  - `public/app.js`:
    - add `builds` to `VIEWS` after `home`
    - replace the `/api/runs` poll with `/api/builds/overview` into `shared.overview`
    - `pollDelay(shared.builds, shared.overview?.running ?? [])`
    - remove `runsQuery` and `setRunsQuery`
    - nav badge `builds` = running mine + waiting
  - `public/views/home.js`: `triggeredBuildRow` shows "Waiting for iOS slot to retry" for `status === 'waiting-slot'` (no progress line); remove the Actions section (`runsQuery`, `runAction`, `addWorkflowOptions`, `runRow`, `renderRuns`, `runFilters`, the `runs` freshness entry, and the `section('runs', …)`)
  - `public/style.css`
- Test: CDP script in the scratchpad (no unit test; the view only renders `Overview`)

**Interfaces:**
- Consumes:
  - Task 4 `Overview`
  - Task 3 `DELETE /api/build-queue/:id`
  - existing `POST /api/runs/:id/rerun|cancel`
  - Task 5 exports (`openBuildSheet`, `createBug`, `installOnSim`)
  - `shared.prs` for Build Again
- Produces: view `{ id: 'builds', title: 'Builds', mount, update, refresh }`

**Layout (top to bottom)** follows the spec sketch:
- **iOS Slots card:**
  - Title-weight name
  - Dot plus "Busy"/"Free" plus tint
  - Ticket chip, actor, and a live elapsed time (1-second client timer, `tabular-nums`; the timer stops when the view is hidden)
  - A progress track `elapsed / medianMs`, capped at 100%. Past the median, the label reads "Running long"; otherwise "~N min left". With no median, there's no track.
  - "{n} waiting (yours)" when `waiting > 0`
- **Waiting to Start:** Cancel goes through the existing `confirmSheet`. Retry waits read "Waiting for iOS slot to retry."
- **Running Now:** Open on GitHub, and Cancel only when `mine`
- **Your History:**
  - Segmented control All, iOS, Android, Failed, remembered in `localStorage` key `builds.filter` with try/catch
  - Day groups: "Today," "Yesterday," then weekday and date
  - Each row shows the label, ticket chip (opens the ticket panel, as Home does), branch in mono, duration, result chip, and the classification chip and reason when `build` is present
  - Actions:
    - Open
    - Rerun Failed (failed runs)
    - Create Bug (failed with `build`)
    - Install on Simulator (`build.key === 'mcIosSim'` and success)
    - Build Again (an open PR in `shared.prs` with `headRefName === branch`; preselects the `BUILDS` key mapped from file, with `run-mc-ios.yml` mapping to `mcIos` unless `build?.key` says otherwise)
- **Footer line:** "This Week: {count} builds · {passed} passed · {retriesSaved} retries saved · iOS median {m}m"
- **Empty states:**
  - "No builds running." (Running Now)
  - "No builds in the last 14 days." (Your History)
- **Toast** "iOS MobileKiosk is free" when a slot goes from busy to free between two updates while the tab is shown

- [ ] **Step 1: Remove** Home's Actions section and the `/api/runs` poll. Run the full `npm test`. Expected: PASS. Server tests may reference `/api/runs`; the route stays, so they still pass.
- [ ] **Step 2: Implement** `builds.js`, the `app.js` changes, and the CSS:
  - `.slot-card`, `.slot-track`
  - row fade with `@starting-style` for inserts, 200 ms
  - a `prefers-reduced-motion` override
- [ ] **Step 3: Check the page with CDP** against a fake server with a busy MobileClock slot, one waiting entry, two running runs (one mine), and history across two days with one failure:
  - Confirm the sections render in order, the elapsed time ticks, the Failed filter shows only the failure, and the filter survives a reload
  - Confirm Build Again opens the build sheet with the right box checked
  - Confirm Home has no Actions section and the console has no errors
  - Repeat in the dark theme
- [ ] **Step 4: Commit.** `git commit -m "feat: Builds tab replaces Home Actions list"`

### Task 7: Editable Teams Messages

**Files:**
- Modify: `lib/teams.js`, `public/views/home.js` (review and QA sheets)
- Test: `test/teams.test.js`, `test/teams-qa.test.js`, `test/teams-routes.test.js`

**Interfaces:**
- Produces:
  - `defaultReviewText({ key, ticketUrl, prNumber, prUrl }) -> string`, which is exactly:
    `'Hey Team!\n\nTicket: [KEY](ticketUrl)\n\nPR: [PR#N](prUrl)\n\nis ready for Dev-Review, Kindly take a peak at your convenience.\n\nThanks'`
  - `defaultQaText({ ticketUrl }) -> string`, which is exactly:
    `'[url](url) is ready for PRE-QA. Builds are mentioned in the ticket.'`
  - `buildCard({ …, text })`: the body is the title block, then one `textBlock(text)` (unescaped), then the footer mentions. The `note` parameter is removed.
  - `buildQaCard({ summary, tag, text })`: the title block, `textBlock(text)`, then the tag
  - `validText(raw, fallback) -> string`:
    - `undefined` gives the fallback
    - Otherwise, the trimmed text must be 1 to 2,000 characters, or it's an `HttpError(400, 'Message text can't be empty.')` or `HttpError(400, 'Keep the message under 2,000 characters.')`
  - Preview responses add `defaultText`. Send bodies take `text` and no longer take `note`.
  - Send bodies also take `force: true`, which skips `cooldown.assertReady`. `deliver` still calls `mark`, so the timer restarts.

**Resend override (spec section 5):**
- While cooling down, both sheets show the cooldown note plus an unchecked **Send Anyway** checkbox
- Checking it enables Send, renames it "Send Again," and sends `force: true`
- Test sends are unchanged

- [ ] **Step 1: Write the failing tests:**
  - `buildCard uses given text unescaped and keeps mentions after it`: `text: '**Hi** [x](https://e.x)'` gives `body[1].text === '**Hi** [x](https://e.x)'`, the last block is the mention footer, and the entities are unchanged
  - `buildCard default text matches the old card`: compare the joined text against the current fixed lines
  - `title stays escaped`: summary `'a*b'` gives `'a\\*b'`
  - `qa card uses text then tag`
  - Routes:
    - `second send within cooldown is 429; with force: true it sends and restarts the timer` (for both review and QA)
    - `send with empty text is 400`, `send with 2001 chars is 400`, `preview returns defaultText`, `send without text uses default`
- [ ] **Step 2: Run the tests and confirm they fail.** Run: `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off node --test test/teams*.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the server side.**
- [ ] **Step 4: Implement the sheets.**
  - Textarea (`maxlength=2000`) pre-filled with `defaultText`
  - The preview renders the text with `public/markdown.js` on every `input` event, with no debounce
  - Character count `n/2,000` appears above 1,800
  - Send is disabled when the trimmed text is empty
  - **Reset to Default** link: `ta.select(); document.execCommand('insertText', false, defaultText)` so Cmd+Z undoes it
  - The text box and preview sit side by side above 720px and stacked below
  - The old Note field is removed
- [ ] **Step 5: Run the tests and confirm they pass.** Run the full `npm test`. Then check with CDP:
  - Edit the text and confirm the preview updates
  - Press Reset and confirm the default returns
  - Send to the fake Teams server and confirm the posted card's `body[1].text` equals the edited text
- [ ] **Step 6: Commit.** `git commit -m "feat: editable Teams review and QA messages"`

### Task 8: Final Verification

- [ ] **Step 1:** Run the full suite. Run: `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off npm test`. Expected: all pass, with a count of 464 plus the new tests.
- [ ] **Step 2:** Restart the service and load the Builds tab against real GitHub (reads only).
  - Restart: `launchctl kickstart -k gui/$(id -u)/com.tcpsoftware.mobile-clock-dashboard`
  - Load: `curl -s -H 'X-Dashboard: 1' http://127.0.0.1:4317/api/builds/overview | head -c 600`
  - Expected: JSON with `slots`, `running`, and `history`. Don't trigger, queue, or send anything.
