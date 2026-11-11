# Tempo Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Time view loads the user's Tempo worklogs as the source of truth, and sends confirmed days that are empty in Tempo, one day or a whole month at a time, with a preview and no possible double log.

**Architecture:** `lib/time/tempo.js` is a small Tempo v4 client plus pure helpers. `buildMonth` overlays Tempo days onto the month, and a new `lib/time/sync.js` adds preview, send, and Tempo-edit routes that share the time routes' month cache. The browser sends only dates. The server builds every worklog from its own stored confirmed day and re-checks Tempo right before posting.

**Tech Stack:** Node 20, `fetch`, `node:test`, no npm dependencies. Vanilla ES modules in `public/`.

**Spec:** `docs/superpowers/specs/2026-11-11-tempo-sync-design.md`

## Global Constraints

- Node 20, zero npm dependencies, server on `127.0.0.1` only, `textContent` only (never `innerHTML`)
- Every non-GET route needs `X-Dashboard: 1`. The Host check stays.
- `TEMPO_TOKEN` stays on the server. It never goes into a response, a log line, or an error message.
- Tests never touch real Tempo, Jira, or `.env`. `config.js` already skips `.env` under `NODE_TEST_CONTEXT`. Inject fakes through `createServer` options (`tempo`, `jira`, `timeSources`).
- Never update or delete Tempo worklogs. The only write is `POST /worklogs`.
- Worklog fields: `startTime: '09:00:00'`, `description` is the ticket's status at the end of that day, `timeSpentSeconds = Math.round(hours * 3600)`, and `authorAccountId` is Jira `myself().accountId`
- Leave is never sent
- User-facing copy follows the org style: AP Style, no first person, contractions, title-case buttons
- Don't run `git commit`. The user commits.

## Review Focus

1. **Stale page after logging in another tab:** the day is confirmed locally, but Tempo got worklogs after the page loaded. Send must skip it and report "Already in Tempo," never post. Pinned in Task 3 by `send skips a day that gained Tempo worklogs after preview`.
2. **Double click or two tabs sending the same day at once:** only one send runs, and the second gets 409. Pinned in Task 3 by `concurrent sends of one day post once`.
3. **Forged browser payload:** a send body with `entries` or extra fields is ignored, so worklogs come only from the stored day. Pinned in Task 3 by `send ignores entries in the request body`.
4. **Reminder or pending badge on a day logged in Tempo by hand:** a day in Tempo counts as done. Pinned in Task 2 by `pending skips days found in Tempo`.
5. **Tempo error or no token:** the month still loads with suggestions and shows the reason. Sends return 503 and post nothing. Pinned in Task 2 by `month loads when Tempo fails` and in Task 3 by `send without a token returns 503`.

---

### Task 1: Tempo Client and Pure Helpers

**Files:**
- Create: `lib/time/tempo.js`
- Modify: `config.js` (add `TEMPO`)
- Test: `test/time-tempo.test.js`

**Interfaces:**
- Produces:
  - `config.js`: `export const TEMPO = { token: process.env.TEMPO_TOKEN ?? '', baseUrl: 'https://api.tempo.io/4', startTime: '09:00:00' }`
  - `createTempo({ token, baseUrl, fetch = globalThis.fetch }) → { configured: boolean, worklogs(accountId, from, to): Promise<Worklog[]>, create(payload): Promise<void> }`
    - `Worklog = { tempoId: number, issueId: string, date: 'YYYY-MM-DD', hours: number }`, where `hours = seconds / 3600`, rounded to 2 decimals
    - `worklogs` calls `GET {baseUrl}/worklogs/user/{accountId}?from=&to=&limit=1000`, then follows `metadata.next` until it's absent
    - Non-2xx responses throw `Error('Tempo returned <status>.')`. Never include the token, the response body, or the request headers. On 401 or 403, throw `Error('Tempo rejected the token. Check TEMPO_TOKEN in .env.')`.
  - `tempoByDay(worklogs, keyById: Map<string,string>) → Map<date, Array<{ key, hours }>>`, merging same-key worklogs on a day by summing hours. A key missing from the map shows as `#<issueId>`.
  - `statusAtEndOfDay(histories, currentStatus, day) → string`. It uses the last status change at or before local 23:59:59 of `day`. If none, it uses the first change's `fromString`. With no changes at all, it uses `currentStatus`.
  - `toPayload({ issueId, hours, date, description, accountId }) → { issueId: Number(issueId), timeSpentSeconds, startDate: date, startTime: TEMPO.startTime, authorAccountId: accountId, description }`

- [ ] **Step 1: Write failing tests** in `test/time-tempo.test.js`, using a fake `fetch` that records calls:
  - `worklogs follows metadata.next and maps fields`: two pages, the first with `metadata.next` set. The result has 3 items, for example `{ tempoId: 1, issueId: '363920', date: '2026-08-12', hours: 3.13 }` from `timeSpentSeconds: 11250`. Assert that the `Authorization` header equals `Bearer t0k`.
  - `401 throws a token message without the token`: `assert.rejects(..., (e) => /TEMPO_TOKEN/.test(e.message) && !e.message.includes('t0k'))`
  - `unconfigured client reports configured false`: `createTempo({ token: '' }).configured === false`
  - `create posts JSON to /worklogs`: method `POST`, URL ends with `/worklogs`, and the body deep-equals the `toPayload` output
  - `tempoByDay merges same key per day and labels unknown ids`
  - `statusAtEndOfDay picks last change by end of day, falls back to fromString, then current`: changes `In Progress` at 2026-08-12T10:00 and `Dev Review` at 2026-08-13T09:00. Day 08-12 gives `'In Progress'`, day 08-13 gives `'Dev Review'`, and day 08-11 gives the first change's `fromString`, `'To Do'`.
  - `toPayload converts hours to seconds`: 3.5h gives 12600, and 2.33h gives 8388
- [ ] **Step 2:** Run `node --test test/time-tempo.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `lib/time/tempo.js` and `TEMPO` in `config.js` to the interfaces above.
- [ ] **Step 4:** Run `node --test test/time-tempo.test.js`. Expected: PASS.

### Task 2: Tempo Days in the Month

**Files:**
- Modify: `lib/time/routes.js` (`buildMonth`, `pending`, `routes`)
- Modify: `server.js` (pass `tempo` from options. Default `createTempo(TEMPO)`.)
- Test: `test/time-tempo-month.test.js`

**Interfaces:**
- Consumes: `createTempo`, `tempoByDay` (Task 1). `ctx.jira.myself()` and `ctx.jira.search(jql, fields, max)`. `search` already returns issues with `id` and `key`.
- Produces:
  - `ctx.tempo`: the client (injectable)
  - `ctx.tempoEdits`: `createStore(path.join(ctx.timeDir, 'tempo-edits.json'))`, holding records shaped `{ entries: [{ key, hours }] }` or `null`
  - `ctx.tempoLogged: Map<ym, Set<date>>`, filled by each successful Tempo month read and used by `pending`
  - Month response additions:
    - `tempo: { configured, status: 'ok' | 'off' | <error message> }`
    - A day in Tempo gets `state: 'tempo'`, `entries` (the edits if present, else Tempo's), `tempoEntries` (Tempo's), `flags: [{ key, tempoHours, yourHours }]`, `leaveHours: Math.max(0, 7 - tempoTotal)`, and `readOnlyKeys` (keys not matching `/^TCPMOB-\d+$/`). It keeps `pool` and `evidence` as now.
    - `flags`: one item per key whose hours differ between edits and Tempo. A key only in the edits has `tempoHours: 0`, and a key only in Tempo has `yourHours: 0`. When edits exist and `flags` is empty, `buildMonth` calls `ctx.tempoEdits.save(date, null)`.
  - `buildMonth` reads Tempo through `settle()` like the other sources, with `from`/`to` set to the month's first and last day. Map IDs to keys with `jira.search('id in (…)', ['summary'], 300)`, which also fills ticket info for summaries. Cache the account ID the way `defaultSources` does.

- [ ] **Step 1: Write failing tests** with a fake `tempo` (`{ configured: true, worklogs: async () => [...] }`), a fake `jira` whose `search` returns `[{ id: '363920', key: 'TCPMOB-1600', fields: { summary: 'S' } }]` and whose `myself` returns `{ accountId: 'acc' }`, the existing fake `timeSources`, and `timeToday: () => '2026-11-10'`:
  - `day with Tempo worklogs shows tempo state and Tempo hours`: 3.13h + 3.13h gives `state === 'tempo'`, `entries` keys `['TCPMOB-1600','TCPMOB-1609']`, and `leaveHours === 0.74`, rounded to 2 decimals
  - `old confirmed record on a Tempo day is ignored`: save a confirmed local record with different hours. The day still shows Tempo hours and `flags.length === 0`.
  - `tempo edits produce flags and clear when Tempo matches`: edits `[{ key: 'TCPMOB-1600', hours: 5 }]` against Tempo 3.5h give `flags` deep-equal to `[{ key: 'TCPMOB-1600', tempoHours: 3.5, yourHours: 5 }]`. After the fake Tempo returns 5h, `flags` is empty and `ctx.tempoEdits.get(date) === null`.
  - `non-TCPMOB worklog is read-only`: a key `OPS-12` appears in `readOnlyKeys`
  - `month loads when Tempo fails`: `worklogs` throws `Error('Tempo returned 500.')`. The response has `tempo.status === 'Tempo returned 500.'`, and days keep their suggestion states.
  - `no token means tempo off`: `tempo.configured === false`, `tempo.status === 'off'`, and `worklogs` is never called
  - `pending skips days found in Tempo`: a past unconfirmed workday that has Tempo worklogs isn't in `GET /api/time/pending` after the month loads
- [ ] **Step 2:** Run `node --test test/time-tempo-month.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes in `lib/time/routes.js` and `server.js`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass, with the existing `time-routes` tests unchanged. They get an unconfigured Tempo by default.

### Task 3: Preview, Send, and Tempo-Edit Routes

**Files:**
- Create: `lib/time/sync.js`
- Modify: `lib/time/routes.js` (spread `syncRoutes(ctx, { month, clearCache })` into its route list)
- Test: `test/time-tempo-sync.test.js`

**Interfaces:**
- Consumes: Tasks 1 and 2, `validateDay`'s date rules (`validDay`, `isWorkday`, not future), `ctx.timeStore`, `ctx.jira.search`, and `ctx.jira.changelog`
- Produces:
  - `GET /api/time/tempo/preview?dates=2026-11-03,2026-11-04` returns `{ days: [{ date, ok: boolean, reason?: string, worklogs: [{ key, hours, description }] }], totalHours }`
  - `POST /api/time/tempo/send` with body `{ dates: string[] }` (1 to 23 dates) returns `{ results: [{ date, status: 'sent' | 'skipped' | 'failed' | 'partial', sent: number, reason?: string, errors?: string[] }] }`
  - `POST /api/time/tempo/edits/:date` with body `{ entries: [{ key, hours }] }` returns `{ ok: true }`. Keys must match `/^[A-Z][A-Z0-9]+-\d+$/`, and hours must be a number with `0 < hours <= 24`. A date not in Tempo returns 400.
  - Skip reasons (exact copy):
    - `'Already in Tempo'`
    - `'Not confirmed'`
    - `'Full day of leave'`
    - `'Future day'`
    - `'Not a workday'`
- **Send algorithm, one date at a time, in order:**
  1. If the date is already in `locks: Set<date>`, return 409 for the whole request, with `'Already sending <date>.'`.
  2. Validate the date and require a stored record with `status === 'confirmed'` and at least one entry. Otherwise, skip it with the reason.
  3. Run `ctx.tempo.worklogs(accountId, date, date)` with no cache. If the result is non-empty, skip with `'Already in Tempo'`.
  4. Resolve IDs and statuses through `jira.search('key in (…)', ['status'])` and `jira.changelog(key)`, then `statusAtEndOfDay`.
  5. `create` each entry in sequence. All sent gives `'sent'`. Zero sent gives `'failed'`, with the errors. Some sent gives `'partial'`, and the errors name each unsent key and its hours. On a partial send, also call `ctx.tempoEdits.save(date, { entries: <all stored entries> })`, so the day (now In Tempo) flags exactly what is missing.
  6. Release the lock in `finally`. After the loop, call `clearCache()`.
- Without `ctx.tempo.configured`, preview and send return 503 with `'Tempo isn't set up. Add TEMPO_TOKEN to .env, then restart.'`.

- [ ] **Step 1: Write failing tests** in `test/time-tempo-sync.test.js`, with a fake `tempo` that records `create` calls and a fake `jira`:
  - `preview lists worklogs with status descriptions and skips with reasons`
  - `send posts each entry with payload fields`: `startTime` is `'09:00:00'`, `description` is the status at the end of the day, and `authorAccountId` is `'acc'`
  - `send skips a day that gained Tempo worklogs after preview`: `worklogs` returns `[]` for the preview, then 1 item for the send. Zero `create` calls, with `reason === 'Already in Tempo'`.
  - `concurrent sends of one day post once`: two sends fire together while `create` waits on a promise. One gets 409, and `create` count equals the day's entry count.
  - `send ignores entries in the request body`: the body is `{ dates: [d], entries: [{ key: 'TCPMOB-1', hours: 7 }] }`. The posted keys equal the stored record's keys.
  - `partial failure reports unsent keys`: the second `create` throws, giving `status === 'partial'`, `sent === 1`, and `errors[0]` including the second key. After the fake Tempo returns the first worklog, the month day has `flags` equal to `[{ key: <second key>, tempoHours: 0, yourHours: <its hours> }]`.
  - `unconfirmed, future, weekend, and full-leave days are skipped with exact reasons`
  - `send without a token returns 503`, with zero `create` calls
  - `send requires X-Dashboard`: without the header, the response is 403
  - `edits route rejects bad keys and hours and non-Tempo days`
- [ ] **Step 2:** Run `node --test test/time-tempo-sync.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `lib/time/sync.js` and wire it in.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.

### Task 4: Time View UI

**Files:**
- Modify: `public/views/time.js`, `public/style.css`, and `README.md` (a Tempo section with `TEMPO_TOKEN` setup)

**Interfaces:**
- Consumes: the month response from Task 2 and the routes from Task 3. `confirmSheet({ title, body, confirmLabel, onConfirm })` and `toast` from `ui.js`.
- **Behavior:**
  - **Strip:** `STATE.tempo = ['In Tempo', 'green']`. A day with flags shows the orange dot.
  - **Day card, `tempo` state:**
    - A green "In Tempo" note
    - Steppers on TCPMOB rows. Edits post to `/api/time/tempo/edits/:date`, through the existing debounced draft path, branched by state.
    - `readOnlyKeys` rows without steppers
    - A flag banner, with one line per flag in the exact copy: `Tempo has TCPMOB-1521 3.5h. You changed it to 5h. Update it in Tempo by hand.`
    - No Confirm and no Send
    - When `yourHours` is 0, use `You removed it.` instead of `You changed it to Nh.`. When `tempoHours` is 0, use `Tempo doesn't have TCPMOB-1521. You added 2h.`
  - **Day card, `confirmed` state, `tempo.configured`:** a **Send to Tempo** button. It opens the preview sheet, then sends `{ dates: [date] }`.
  - **Month mode:** a **Send Month** button, enabled when any `confirmed` day exists. It collects every `confirmed` date up to today, then runs the same preview, send, and summary flow. The summary sheet lists Sent, Skipped (with reason), Failed or Partial (with errors), and **Fix in Tempo** (dates whose `flags` are non-empty).
  - **Preview sheet:** one line per worklog, formatted `date · key · hours · description`, followed by the skipped days with reasons. The confirm label is `Send N Worklogs`. It's disabled when N is 0.
  - **When `tempo.configured` is false:** no send buttons, and a muted note: `Add TEMPO_TOKEN to .env to load and send Tempo hours.` When `tempo.status` is an error, use the existing `sourcesBanner` style with the message.
  - After a send, call `load()` again.

- [ ] **Step 1:** Implement it. Then run `node --check public/views/time.js` and `npm test`. Expected: all pass.
- [ ] **Step 2: Browser check.** Start the server with `DASHBOARD_DATA_DIR=<tmp> TIME_REMINDER=off` and a fake Tempo. Add a test-only `TEMPO_FAKE=1` env in `server.js` that injects an in-memory Tempo with 2 seeded days and logs `create` calls to the console. This branch must never be reachable when `TEMPO_TOKEN` is set. Use CDP to:
  - open a seeded Tempo day and see the In Tempo note
  - change an hour and see the flag line
  - open a confirmed day, press Send to Tempo, and see the preview with `Send 2 Worklogs`
  - confirm, then watch the day turn In Tempo after the reload
  - take screenshots of the day and the month

  Expected: no console errors, and fake `create` was called twice.
