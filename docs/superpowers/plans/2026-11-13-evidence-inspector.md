# Evidence Timeline, Ticket Panel, Last Build, and Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain each Time suggestion with a dated evidence timeline and point math, add a ticket side panel, show each ticket's last build, and show data freshness on every section.

**Architecture:**
- **Evidence (server):** the time sources keep the raw events they already read (Jira status changes, commits, GitHub runs and reviews, Claude sessions). A lazy `GET /api/time/evidence` builds one ticket-day timeline from the month's cached sources.
- **Tickets (server):** `lib/tickets.js` gains a cached batch "latest build" endpoint and a ticket panel endpoint.
- **Page:** one new browser module, `public/tickets-ui.js`, owns ticket links, the panel, and build chips. A `freshness()` helper in `ui.js` labels sections.

**Tech Stack:** Node 20, `node:test`, no dependencies. Vanilla ES modules and CSS.

**Spec:** `docs/superpowers/specs/2026-11-13-evidence-inspector-design.md` (approved mockup: `.superpowers/brainstorm/81087-1794564662/content/evidence-panel.html`)

## Global Constraints

- Node 20, zero npm dependencies, `127.0.0.1` only, `textContent` only (Jira description, comments, and commit subjects are untrusted), X-Dashboard and Host checks stay
- Ticket keys are validated with `/^TCPMOB-\d+$/` before any Jira or GitHub call
- Claude chat text is never read for this feature or stored. Only session ID, times, minutes, and counts.
- Copy: AP Style, contractions, no first person. Exact strings below are the copy.
- **Design (`/apple-design`):**
  - **Motion:** critically damped spring (`var(--spring)`) for the panel slide and the timeline expand
  - **Reduced Motion:** cross-fade instead
  - **Reduced Transparency:** a solid panel
  - **Increased Contrast:** a 1px border
  - **Numbers:** tabular numerals for times and build numbers
- **Source dot colors** (light and dark): Jira `#0052cc`, Claude `#d97757`, git `#f05032`, GitHub `var(--label)`
- Functions under about 20 lines; lines of 120 characters or fewer (team conventions)
- Don't run `git commit`. The user commits.

## Review Focus

1. **A ticket key Jira doesn't know (deleted, typo, no access):** the panel shows `Couldn't load TCPMOB-123: <reason>` inline, and the page keeps working. Pinned in Task 3 by `panel returns 404 with a reason for an unknown key`.
2. **HTML or markup in Jira description and comments:** shown as plain text, never as markup. Pinned in Task 3 by `panel text is plain, with markup left as literal characters`, and in Task 4 by the browser check (a fixture comment `<img src=x onerror=alert(1)>` renders as text).
3. **Days saved before `mentionCounts` existed:** the session line has no count and never shows "undefined" or "NaN". Pinned in Task 2 by `old snapshots without mentionCounts show no count`.
4. **Large or hostile input to the build batch:** more than 50 keys or any invalid key returns 400 and makes no Jira call. Pinned in Task 3 by `latest builds rejects bad and oversized key lists`.
5. **A source that keeps failing:** the label turns red with Retry, and the last good data stays on screen. Pinned in Task 4 by the browser check (a fake source that fails after the first load).

---

### Task 1: Keep Raw Evidence in the Time Sources

**Files:**
- Modify: `lib/time/allocate.js`, `lib/time/jira.js`, `lib/time/git.js`, `lib/time/github.js`, `lib/time/claude.js`, `lib/tickets.js` (`parseBuildComments` only)
- Test: `test/time-evidence-sources.test.js` (new). Existing tests stay green.

**Interfaces:**
- Produces:
  - **`allocate.js`:** `weightParts(evidence) → Array<{ label: string, points: number }>`, the per-signal points that `dayWeights` already sums. `dayWeights` must now total `weightParts` so the two can't drift.
    - Labels: `In Progress`, `N commit(s)`, `Claude Xh Ym` (via the existing minutes formatter), `N Jira update(s)`, `N build(s)`, `N PR review(s)`
    - Signals that are zero are omitted.
  - **`jira.js`:** `jiraByDay` also returns `events: Map<key, Array<JiraEvent>>`, where `JiraEvent = { at: ISO, kind: 'status', from, to, by: displayName, mine: boolean } | { at: ISO, kind: 'comment', mine: true }`. Status changes come from all authors; comments only from the user. Comment text is never kept.
  - **`git.js`:** each commit item gains `branch` (the `%S` source, minus `refs/heads/` and `refs/remotes/origin/`)
  - **`github.js`:** items become `{ key, kind: 'build', at, runId, workflow }`, with the jq adding `.name`, or `{ key, kind: 'review', at, pr }`
  - **`claude.js`:** each session gains `mentionCounts: { [key]: integer }`, the raw mention count of every kind, next to the weighted `keyCounts`
  - **`tickets.js`:** each `parseBuildComments` item gains `destination: 'TestFlight' | 'Firebase'`
- Consumes: nothing new.

- [ ] **Step 1: Write failing tests** in `test/time-evidence-sources.test.js`:
  - `weightParts sums to the dayWeights weight`: for the evidence `{ inProgress: true, commits: 7, claudeMinutes: 150, activity: 1, builds: 3, reviews: 0 }`, the labels are `['In Progress', '7 commits', 'Claude 2h 30m', '1 Jira update', '3 builds']`, the points are `[2, 5, 5, 0.5, 1]`, and their sum equals `dayWeights(...)` for that key
  - `jira events keep status changes with author names and only my comment times`: a fake changelog with two status items (by me, by "Pat") and two comments (mine, Pat's) gives 2 status events (`by: 'Foad Ahmed'`, `by: 'Pat'`, `mine` set right) and 1 comment event with no `text` property
  - `commits carry their branch`: `parseLog` of a `%S` of `refs/remotes/origin/TCPMOB-1-x` gives `branch: 'TCPMOB-1-x'`
  - `github items keep run id, workflow, and PR number`: fake `gh` output gives `{ kind: 'build', runId: '101', workflow: 'Run MC Android' }` and `{ kind: 'review', pr: 7 }`
  - `claude sessions keep raw mention counts`: a session where TCPMOB-1 is typed twice and appears in tool output 3 times has `mentionCounts['TCPMOB-1'] === 5` and keeps its existing weighted `keyCounts`
  - `build comments keep the destination`: "pushed build number 412 for Mobile Clock Android to firebase distribution" gives `destination: 'Firebase'`, and "… to testflight" gives `'TestFlight'`
- [ ] **Step 2:** Run `node --test test/time-evidence-sources.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the changes listed in Interfaces. `dayWeights` calls `weightParts` (DRY). Status `by` comes from `history.author.displayName`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass. Existing tests asserting exact `{ key, kind }` GitHub items get the new fields added. That's the intended shape change; ledger it.

### Task 2: Evidence Endpoint and Month Build Time

**Files:**
- Modify: `lib/time/routes.js`
- Test: `test/time-evidence.test.js` (new)

**Interfaces:**
- Consumes: Task 1 shapes, the existing `buildMonth`, `monthCache`, `daySignals`, `dayWeights`, `allocate`, `weightParts`
- Produces:
  - **Month response:** gains `generatedAt: ISO` (when it was built). The month cache stores `{ data, sources }`, where `sources` is the `loadSources` result, kept so evidence needs no refetch.
  - **`GET /api/time/evidence?date=YYYY-MM-DD&key=TCPMOB-n`** returns `Evidence`:
    ```
    { date, key, events: Array<EvidenceEvent>, parts: Array<{label, points}>, total: number,
      outcome: { mode: 'suggested', dayPoints, hours, dayHours }
             | { mode: 'saved', suggestedHours, hours }      // saved, confirmed, or Tempo day
             | { mode: 'maybe' } }
    EvidenceEvent = { at, source: 'jira'|'claude'|'git'|'github', text: string, detail?: string, url?: string }
    ```
  - **Events:** sorted by `at` ascending, limited to that local day and that key. `text` and `detail` are plain strings built server-side:
    - **Jira status:** text `To Do → In Progress`, detail `by you` or `by Pat`
    - **Jira comment:** text `Commented`, detail `by you`
    - **Claude:** one per session that has a segment for the key, or a weighted mention of it. Text `Claude session 3f2a9c…c91e`. Detail `10:05 AM–12:35 PM · 2h 30m active · 41 mentions`; the ` · N mentions` part is left out when the session has no `mentionCounts`.
    - **Git:** text `Commit a1b2c3d "subject"`, detail `on <branch>`
    - **GitHub build:** text `Build <workflow> dispatched`, detail `run #<runId>`, url `https://github.com/<REPO>/actions/runs/<runId>`
    - **GitHub review:** text `Reviewed PR #<pr>`, url to the PR
  - **Outcome:**
    - `suggested`: the day's `dayPoints` is the total weight of the tickets allocated that day, and `hours` is the row's hours
    - `saved`: `suggestedHours` is `allocate(...)` from today's evidence for this key (0 if not allocated), and `hours` is the row's hours
    - `maybe`: a key that isn't in the day's entries
  - **Errors:**
    - 400 `Expected date like 2026-11-10 and key like TCPMOB-123.` on bad input
    - 409 `Set your workday hours in Settings first.` when `dayHours` is unset
    - A month that isn't cached is built on demand (same as `GET /api/time/month`)

- [ ] **Step 1: Write failing tests** with fake sources that include Task 1 events for one day:
  - `evidence lists the day's events for one ticket in time order with plain text`: `text` values are exact, including `To Do → In Progress`, `Claude session 3f2a9c…c91e`, and `Commit a1b2c3d "Guard CSSO permission check"`, and other tickets' events are absent
  - `suggested day shows its points and hours`: `outcome` deep-equals `{ mode: 'suggested', dayPoints: <sum>, hours: 6, dayHours: 7 }`, and `total` equals the sum of `parts`
  - `saved day shows what today's evidence would suggest`: after saving the day with 4h for the key, `outcome.mode === 'saved'`, `hours === 4`, and `suggestedHours` is the allocated value
  - `maybe ticket returns events and mode maybe`
  - `old snapshots without mentionCounts show no count`: the Claude detail has no `mentions` and no `undefined` or `NaN`
  - `bad date or key is 400; evidence never contains comment text`
  - `month has generatedAt`
- [ ] **Step 2:** Run `node --test test/time-evidence.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `handleEvidence` plus small helpers (`dayEvents`, `claudeEvent`, `evidenceOutcome`). Reuse `daySignals`, `dayWeights`, `allocate`, and `weightParts`, with no second copy of the weighting. Format times with `toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })` on the server's local clock (the dashboard runs on the user's Mac).
- [ ] **Step 4:** Run `npm test`. Expected: all pass.

### Task 3: Latest Builds Batch and Ticket Panel Endpoints

**Files:**
- Modify: `lib/tickets.js` and `lib/jira.js` (export `adfText`)
- Test: `test/tickets-panel.test.js` (new)

**Interfaces:**
- Consumes: Task 1 `parseBuildComments` destination, `requireJira`, `loadTicket`, `ctx.timeMonth`, `ctx.tempo`
- Produces:
  - **`GET /api/builds/latest?keys=K1,K2,…`** returns `{ [key]: LatestBuild }` for keys with a build, where `LatestBuild = { number, app, platform, destination, created }` is the newest by `created`
    - At most 50 keys, all valid and deduplicated. Otherwise 400 `Send 1–50 ticket keys like TCPMOB-123.`
    - Per-key cache for 10 minutes (`BUILD_TTL_MS = 600000`). Up to 4 Jira comment requests at once. A Jira error for one key leaves that key out.
  - **`GET /api/tickets/:key/panel`** returns `TicketPanel`:
    ```
    { ticket: { key, type, summary, status, assignee: name|null, fixVersions: string[], url },
      description: string,            // plain text, first 300 chars, '…' if cut
      comments: Array<{ author, created, text }>,   // latest 3, text = first 2 non-empty lines, ≤ 200 chars
      builds: Array<LatestBuild>,     // newest per app+platform, newest first
      prs: Array<{ number, title, url, state, reviewDecision }>,  // key's PRs, newest first, ≤ 3
      hours: { ym, hours } | null,    // this month's hours for the key (Tempo-backed days included)
      canSendToQa: boolean }          // status is 'Dev Review' and a build exists
    ```
    - An unknown key gives 404 `Couldn't find TCPMOB-123 in Jira.`; other Jira errors keep the existing mapping.
    - `hours` comes from `ctx.timeMonth(currentYm)`, summing the key's entries. It's null when time tracking is off or the month fails, and never throws.

- [ ] **Step 1: Write failing tests** with a fake `jira` (`getIssue` with ADF description, `comments`), fake `gh` (`pr list`), and fake `timeMonth`:
  - `latest builds returns the newest build per key, cached`: two calls give one `comments` call per key, and the result deep-equals `{ 'TCPMOB-1': { number: '412', app: 'MobileClock', platform: 'Android', destination: 'Firebase', created } }`
  - `latest builds rejects bad and oversized key lists`: 51 keys gives 400, `OPS-1` gives 400, and zero Jira calls are made
  - `panel returns ticket, plain description, 3 latest comments, builds, prs, hours`
  - `panel text is plain, with markup left as literal characters`: a description and comment containing `<img src=x onerror=alert(1)>` come back as the same literal string, with no HTML parsing
  - `panel returns 404 with a reason for an unknown key`: Jira 404 gives `{ error: "Couldn't find TCPMOB-999 in Jira." }`
  - `panel canSendToQa only in Dev Review with a build`
- [ ] **Step 2:** Run `node --test test/tickets-panel.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `handleLatestBuilds`, `handlePanel`, `latestBuildsFor(ctx, keys)`, `panelComments`, and `panelHours`. Reuse the existing `mapLimit` pattern or a small local equivalent. `pathKey` validates the key.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.

### Task 4: Ticket Panel, Build Chips, Evidence Timeline, and Freshness in the Page

**Files:**
- Create: `public/tickets-ui.js`
- Modify:
  - `public/ui.js` (`freshness`, `startFreshnessTicker`)
  - `public/app.js` (start the ticker; ⌘K "Open ticket")
  - `public/palette.js`
  - `public/views/home.js`, `public/views/time.js`, `public/views/release.js`, `public/views/quality.js`, `public/views/team.js`
  - `public/style.css`
  - `README.md`

**Interfaces:**
- Consumes: Task 2 and Task 3 endpoints
- Produces (`public/tickets-ui.js`):
  - `ticketLink(key, label = key) → HTMLElement`: a button styled as a link (`class="ticket-link"`). Click opens the panel.
  - `openTicketPanel(key) → void` and `closeTicketPanel() → void`
    - One `<aside class="ticket-panel" role="complementary" aria-label="Ticket details">` appended to `main`.
    - Calling it again swaps the contents in place. Esc or ✕ closes it, and focus returns to the trigger.
    - Loading shows a skeleton. An error shows the endpoint's message inline.
  - `loadLatestBuilds(keys: string[]) → Promise<void>`: batches every 50, fills a module cache, then calls the registered repaint callbacks
  - `buildChip(key) → HTMLElement | null`: `▲ Build 412 · Android MC · 2h ago`. Platform short names: `Android MC`, `Android MK`, `iOS MC`, `iOS MK`. Click opens the panel.
  - `registerTicketActions({ requestQa(key), sendToQa(key) })`: Home calls this at mount. The panel's buttons call it, so the panel doesn't import `home.js`.
- Produces (`ui.js`):
  - `freshness({ at, intervalMs, error = null, onRefresh }) → HTMLElement`, a `.fresh` span with `data-at` and `data-interval`. Copy:
    - **Green:** `Updated just now` under 60 seconds, then `Updated N min ago`, then `Updated N hr ago`
    - **Stale:** once `age > 2 × intervalMs`, orange `Updated N min ago · Refresh`
    - **Error:** with `error` set, red `Couldn't update · Retry`, plus `title=<error>`
  - `startFreshnessTicker()`: one 30-second interval that rewrites every `.fresh[data-at]` text and state in place
- **Behavior by view:**
  - **Home:**
    - Freshness on Needs Attention (interval 120000), Triggered Builds (30000), My Tickets (120000), My Pull Requests (30000), and Actions (30000), using the page's own load times.
    - Ticket keys in My Tickets, PR rows, and Up Next use `ticketLink`.
    - `buildChip` appears after the key in My Tickets and PR rows.
    - `requestQa` and `sendToQa` take a key. Their current `pr` callers pass `pr.ticket.key` and the helpers look up what they need, with the same requests as today.
  - **Time:**
    - The header freshness uses `month.generatedAt` (interval 300000), with Refresh running the existing pull-to-refresh path.
    - Ticket rows use `ticketLink` and `buildChip`.
    - **"Why Nh?" pill:** each entry row gets `Why ${hours}h?`, and Maybe rows get `Why?`. It toggles an inline `.evidence` region (`aria-expanded`) that loads `/api/time/evidence` once per date and key, then caches it.
    - **Timeline layout:** a `<ul class="timeline">` of time, dot, and text plus detail lines, then `.weights` chips.
    - **Final line:** `= {total} of {dayPoints} points → {hours}h of {dayHours}h`, or `Today's evidence suggests {s}h; you have {h}h`, or `Not enough to suggest hours`.
  - **Release, Quality, Team:** a header freshness label (interval 300000). Release ticket keys use `ticketLink`.
  - **Palette:** when the query is a ticket key, add `Open ticket TCPMOB-n` above `Which build has…`. It calls `openTicketPanel`.
- **CSS (design):**
  - **`.ticket-panel`:**
    - **Layout:** fixed on the right, `width: min(380px, 100vw)`, full height below the window top, `z-index` above content and below sheets.
    - **Material:** `background: color-mix(in srgb, var(--card) 86%, transparent)` with `backdrop-filter: saturate(180%) blur(30px)`, an inset left hairline, and a soft left shadow. No scrim.
    - **Motion:** enters `transform: translateX(100%) → 0` on `var(--spring)` 380ms, using `@starting-style` and the `[open]` pattern from `dialog.palette`.
    - **Under 900px:** a bottom sheet (`inset: auto 0 0 0; max-height: 85dvh; border-radius: 16px 16px 0 0`).
  - **`.timeline`:** a vertical rule at the dot column, 9px dots with a 3px ring in the row background, and tabular-numeral times.
  - **`.build-chip`:** a blue tint (`--tint-blue`), 11.5px semibold.
  - **`.fresh`:** 12px label-2 with a 6px dot. `.stale` is orange and `.error` is red. The button inside is an accent link.
  - **Accessibility:** reduced-motion, reduced-transparency, and contrast variants as in Global Constraints.

- [ ] **Step 1:** Implement it. Run `node --check` on every changed file, then `npm test`. Expected: all pass.
- [ ] **Step 2: Browser check.** Use a scratchpad launcher with fake `gh`, `jira`, sources, and tracker (no real services). The fake Jira includes a comment `<img src=x onerror=alert(1)>` and a description with markup. Use CDP to check:
  - **Ticket link:** clicking `TCPMOB-1768` in My Tickets opens the panel. Its text includes the last build, PR, description, and comments. The fixture markup shows as literal text and no `<img>` element exists in the panel. Esc closes it.
  - **Build chip:** `▲ Build 412` appears in My Tickets and PR rows after load, and clicking it opens the panel.
  - **Evidence:** on Time, `Why 6h?` expands a timeline whose first line is the 9:12 AM Jira change and whose last line is the points sentence. Clicking again collapses it.
  - **Freshness:** labels show `Updated just now`. Advancing time with `Date` overridden by +20 minutes in the page turns a 30s-interval section orange with Refresh. A fake source that fails after the first load shows red `Couldn't update · Retry` while the earlier rows stay.
  - **Palette:** with the query `tcpmob-1768`, the first item is `Open ticket TCPMOB-1768`.
  - **Themes:** screenshots in light and dark, the panel at desktop and phone width, and no console errors.
