# Builds Tab, Build Conflict Checks, and Editable Teams Messages

## Intent

iOS builds on `tcp-software/mobile-clock` upload to TestFlight. When two builds of the same iOS app run at once, on any branch and by anyone, the second one fails on TestFlight. One iOS MobileClock build and one iOS MobileKiosk build can run together. Today the dashboard starts builds without checking, so the failure only shows up 30+ minutes later. Starting a second build of the same type on a branch that already has one running is also wasted work.

The user also wants one place for builds: a Builds tab showing running builds and their own history, limited to build workflows instead of every GitHub Action.

Separately, the Request Review and Send to QA Teams messages use fixed wording. The user wants to edit the message before it's sent.

## Goals

- Warn before starting a build that would collide with a running one, and default to not starting it
- Let the user queue a build to start automatically once the iOS slot frees up ("Start When Free")
- Give builds their own tab: iOS slot status, running builds, personal history, and build-only actions
- Make the review and QA Teams messages editable before sending

## Non-Goals

- Changing the `mobile-clock` workflow files (for example, adding a `concurrency:` group). This lives entirely in the dashboard.
- Queueing for anything other than iOS slot conflicts
- Showing non-build workflows (tests, PR review, Detox, Namely apps) in the Builds tab
- Saving edited Teams wording as a new default

## Anti-Goals

- A queued build that starts when its PR is no longer open and approved
- A queued build that starts twice, or a queue that silently loses an entry on restart
- Mentions that stop notifying people because they were edited into plain text
- A hard block that stops the user from starting a build they've decided to start

## Constraints

- Node 20, zero npm dependencies, existing patterns: route tables in `FEATURE_MODULES`, `ctx` injection, `el()` with `textContent` only, `node:test`
- GitHub reads go through `ctx.gh` (direct REST with a 15-second cache and CLI fallback). Conflict checks must bypass or tolerate the cache so they don't miss a build that started seconds ago.
- No writes to real GitHub or Teams during development or tests. Tests use fakes.
- The org writing style applies to all UI copy: AP Style, contractions, title-case headings, no first person
- Builds still require an open, approved, same-repo PR (`checkBuildable` in `lib/builds.js`)

## Approaches Considered

**Conflict handling (user picked A)**

- A. Warn and pre-uncheck. A note names the running build, its branch, who started it, and its elapsed time. The conflicting box starts unchecked; the user can re-check it to start anyway. Picked: stops accidents and still allows an override.
- B. Hard block. Rejected: false alarms (see the Simulator note) would leave no way out.
- C. Warn only. Rejected: easy to miss.

**Builds tab data (builder's pick, user didn't object)**

- GitHub's run list for the four build workflows, merged with the tracker's own records (retries, failure reasons, ticket). Picked: also catches builds started on GitHub directly.
- Tracker records only. Rejected: misses builds started elsewhere, and keeps only 7 days.

**Start When Free (user said yes; where it runs is the builder's pick)**

- On the server, saved to disk, driven by the existing 30-second background loop. Picked: works with no tab open and survives a restart, like the existing build tracker.
- In the page. Rejected: stops when the Safari tab closes.

## Design

### 1. Conflict Check

**Rules**

- iOS slot rule: a build of `run-mc-ios.yml` conflicts with any `run-mc-ios.yml` run that's `queued`, `in_progress`, `waiting`, or `pending`, on any branch, by anyone. Same for `run-mk-ios.yml`. MobileClock and MobileKiosk never conflict with each other.
- Same-branch rule: any build type (Android too) conflicts with a running run of the same workflow file on the same branch.
- The Simulator `.app` build (`mcIosSim`) uses `run-mc-ios.yml` but doesn't upload to TestFlight. Starting one never triggers the iOS slot rule. A *running* run can't be told apart by build type from the run list, though, so a running Simulator build started outside the dashboard still counts as busy. If the run came from this dashboard's tracker with key `mcIosSim`, it doesn't count for the iOS slot rule. The same-branch rule still applies to it.

**Server**

- New `GET /api/prs/:n/build-check` returns `{ conflicts: { [buildKey]: [{ rule: 'ios-slot' | 'same-branch', runId, url, branch, actor, startedAt, ticketKey }] } }` for every build key.
- One run-list call per build workflow (status filter for active runs), not per key. Bypasses the 15-second cache.
- `POST /api/prs/:n/builds` repeats the check and refuses a conflicting key unless the body says `force: [keys]`. This catches a build that started between opening the sheet and pressing Start.

**Build sheet**

- Fetches the check when it opens. Shows a "Checking for running builds…" line until it returns. If the check fails, it says so and lets the user build anyway.
- Each conflicting box gets a warning line under it, for example "iOS MobileClock is already building TCPMOB-1764 for hamza (14 min). A second iOS build fails on TestFlight." The box starts unchecked.
- Re-checking a conflicting box sends it as `force`.
- For an iOS slot conflict only, the sheet offers **Start When Free** for that box (see section 3).

### 2. Builds Tab

New view `public/views/builds.js`, added to `VIEWS` after Home (keyboard shortcuts shift by one). The nav badge counts the user's running and queued builds.

```
Builds                                              ↻ 12s ago
┌ iOS Slots ──────────────────────────────────────────────┐
│ iOS MobileClock  ● busy · TCPMOB-1764 · hamza · 14m      │
│                  ~24m left (usually 38m)                 │
│ iOS MobileKiosk  ○ free · 1 waiting (yours)              │
└──────────────────────────────────────────────────────────┘
Waiting to Start (yours)
  ⏳ iOS MK  TCPMOB-1780  queued 3m ago            Cancel
Running Now (everyone, build workflows only)
  ● iOS MC   TCPMOB-1764  hamza    14m   Open
  ● Android  TCPMOB-1790  you      6m    Open · Cancel
Your History                 [All] [iOS] [Android] [Failed]
  Today
  ✓ iOS MK   TCPMOB-1780  31m  1 auto-retry   Open · Build Again
  ✗ Android  TCPMOB-1780  Compile error       Open · Rerun Failed · Create Bug
  Yesterday …
This Week: 9 builds · 7 passed · 2 retries saved · iOS median 38m
```

**Sections**

- **iOS Slots:** MobileClock and MobileKiosk, busy or free. A busy slot shows the ticket, actor, and elapsed time. Time left is the median duration of the last 20 successful runs of that workflow minus elapsed time, shown as "~N min left," or "running long" if past the median. It also shows the count of the user's queued builds for that slot.
- **Waiting to Start:** the user's Start When Free entries, each with Cancel
- **Running Now:** active runs of the four build workflows (`run-mc-ios`, `run-mk-ios`, `run-mc-android`, `run-mk-android`), by anyone. Cancel shows only on the user's own runs.
- **Your History:** completed runs of those workflows by the user, last 14 days, grouped by day, newest first
  - Filters: All, iOS, Android, Failed. The filter is remembered in `localStorage`, wrapped in try/catch.
  - Each row shows the build label, ticket key (linked to Jira, parsed from the branch name), branch, duration, and result
  - Rows from the tracker add the auto-retry count, failure classification chip, and reason
  - Actions are the existing ones where they apply: Open on GitHub, Rerun Failed, Create Bug, and Install on Simulator (Simulator builds)
  - **Build Again** opens the build sheet for the PR whose head branch matches, with that build type preselected. It's hidden when no open PR matches.
- **This Week:** the user's build count, passed count, retries saved (tracker builds that passed after an automatic retry), and the iOS median duration

**Home**

- The Actions run list in Home's More section is removed. Builds replaces it.
- Triggered-build rows on Home stay as they are.

### 3. Start When Free

- Only offered for an iOS slot conflict. Same-branch conflicts don't queue.
- Choosing it adds a queue entry `{ id, prNumber, key, branch, queuedAt, notifiedAt }` saved to `DATA_DIR/build-queue.json` with the same atomic write as `builds.json`
- Every 30 seconds, while the queue has entries, the background loop checks each entry's slot. When the slot is free, it:
  - re-runs `checkBuildable` (PR open, approved, not a fork) and the same-branch rule
  - starts the build through the tracker, so it gets auto-retry
  - removes the entry
  - sends a macOS notification ("iOS MobileKiosk build started for TCPMOB-1780") with the existing `osascript` helper from `lib/time/reminder.js`
- If the PR is no longer buildable, the entry is dropped with a notification saying why
- One entry per slot starts per pass, so two queued MobileClock builds never start together. Order is first in, first out.
- Entries expire after 8 hours with a notification
- The user can cancel an entry from the Builds tab or the build sheet

**Automatic Retries Obey the Slot (builder's call)**

- Today the tracker reruns a failed build right away (`retry()` in `lib/builds.js`). For an iOS TestFlight build, it now waits until that iOS slot is free, then reruns. While waiting, the build shows "Waiting for iOS slot to retry" on Home and in Waiting to Start.
- A retry wait has no 8-hour expiry, because the build itself is already tracked. Cancel marks the build failed with no further retries.
- Holding the slot: a tracker build of `mcIos` or `mkIos` that's `requested` (dispatched but not in the run list yet) or between attempts counts as busy for the slot rule. This closes the gap where a just-started build isn't visible on GitHub yet.
- Queue entries and retry waits share one first-in, first-out line per slot

**Several Dashboards (user's call)**

- Teammates run their own copies, each with its own queue. Two copies can see a slot free on the same pass and both start a build. The user accepts this: one fails on TestFlight, and its automatic retry waits for the slot, then succeeds. No cross-copy race guard is added.
- This depends on a TestFlight collision not being classified as a code failure, so it stays retryable. A test covers that.

### 4. Editable Teams Messages

- The Request Review and Send to QA sheets get an editable message text box, pre-filled with the current wording, links included
- Mentions stay outside the text box. Picked reviewers, "+ Add Person," and the QA tag are chosen as they are now and added to the card after the text, so they keep notifying people.
- The card title (ticket key and Jira summary) stays fixed and escaped
- The user's text is sent as-is, so `[text](url)` and `**bold**` work. Max 2,000 characters. Empty text blocks Send.
- The preview repaints on every keystroke. A **Reset to Default** link restores the default wording.
- **Server:** `buildCard` and `buildQaCard` accept an optional `text`. When it's given, it replaces the fixed body lines ("Hey Team!" through "Thanks" for review; the "ready for PRE-QA" line for QA). The default text comes from the existing preview endpoints as `defaultText`. The existing "note" field is folded into this text box and removed.

### 5. Override the Teams Resend Timer

- Today a real send blocks another send for the same PR or ticket until the cooldown ends (`createCooldown` in `lib/teams.js`, 429 "Already sent…").
- While the timer is running, both sheets show the existing cooldown note plus a **Send Anyway** checkbox. Checking it enables Send and changes its label to "Send Again."
- The send body takes `force: true`, which skips `assertReady`. The send still restarts the timer, so a double click can't post twice.
- The checkbox starts unchecked every time, so the guard still protects against an accidental resend

## Visual Design (Apple Design Guidance)

The dashboard already follows Apple patterns: system fonts, translucent sticky chrome (`backdrop-filter`), `:active` press scale, sheets with `@starting-style`, and `tabular-nums`. The new UI reuses those tokens and adds the following. CSS only, with no new libraries.

**Hierarchy and Simplicity**

- The most important question on the tab is "can I start an iOS build right now?" The iOS Slots card answers it first, in the largest type on the page. Everything else is secondary.
- Slot state is shown in three ways at once, so it never relies on color alone: a filled or hollow dot, the word "Busy" or "Free," and a tint (amber for busy, green for free).
- History shows the common case first: All, last 14 days. Filters sit in a segmented control above the list, not in a menu.
- Labels are specific: "iOS Slots," "Waiting to Start," "Running Now," and "Your History," not "Status" or "Activity."

**Live Status Feedback**

- A busy slot shows a thin progress track: elapsed time against the median duration. It fills continuously, without stepping. Once past the median, the track stops at 100% and the label switches to "Running long." It never shows a fake percentage.
- Elapsed times tick every second on the client between polls, using `tabular-nums` so digits don't shift.
- When a slot goes from busy to free while the tab is open, the dot cross-fades and a status toast appears ("iOS MobileKiosk is free"). If a queued build starts, the row moves from Waiting to Start into Running Now. No sound, and no haptics.
- There are four kinds of feedback, each with one treatment:
  - Status: muted text and dots
  - Completion: green check plus a toast
  - Warning: an amber inline note under the affected checkbox, never a modal
  - Error: a red banner in the sheet with the server message

**Build Sheet Warning**

- The conflict note sits directly under the checkbox it affects (grouping and mapping), not at the top of the sheet
- The "Checking for running builds…" line holds the same space as the result, so the sheet doesn't jump when the check returns
- Start When Free is a secondary button inside the warning note, next to the box it applies to
- The primary button's label always says exactly what will happen: "Start 2 Builds," "Start 1 Build, Queue 1," or "Queue 1 Build"

**Motion**

- Sheets keep their existing enter and exit motion. New rows insert with a short opacity and height fade (200 ms ease-out). Removed rows fade out the same way, so things leave the way they came.
- Nothing here is gesture-driven, so CSS transitions are fine. There are no springs and no bounce.
- Press feedback reuses the existing `:active` scale on every new button and row action
- Under `prefers-reduced-motion: reduce`, row inserts, the progress track, and the dot cross-fade become instant. The elapsed-time counter still updates.

**Materials and Type**

- The iOS Slots card is an opaque grouped-list card, like Home cards. It doesn't stick or float, so it never stacks a translucent layer on the translucent nav.
- Section headers reuse the existing `sectionHead` styles
- Slot names use title weight; ticket keys use the mono pill; durations use `tabular-nums`
- Under `prefers-reduced-transparency` and `prefers-contrast: more`, the existing overrides apply. New surfaces add no new blur.

**Teams Message Editor**

- The text box and the live Teams preview sit side by side on wide screens and stacked on narrow ones. The preview updates on every keystroke with no debounce.
- Reset to Default is a quiet text link under the box. It's always reversible: one undo (Cmd+Z) restores the edited text, because the reset selects all and uses `document.execCommand('insertText')`, which keeps the browser's undo history (`value =` and `setRangeText` don't).
- The character count appears only near the limit (over 1,800 characters)

## Left to the Builder

- Exact markup and CSS for the new tab, matching existing views
- How the run-list calls are shared between the Builds tab poll and the build-check endpoint
- The poll interval for the Builds tab (reuse `pollDelay`)
- Test layout: unit tests for the conflict rules, queue logic, and card text; a CDP check of the sheet and tab against fake servers
