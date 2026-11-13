# Evidence Timeline, Ticket Panel, Last Build, and Freshness Design

Date: 2026-11-13
Builds on: the current dashboard (`main` plus the `refactor/clean-code` branch: Mac-style shell, Time with Tempo sync and Maybe, ⌘K)
Design reference: the approved mockup (`.superpowers/brainstorm/81087-1794564662/content/evidence-panel.html`), following the `/apple-design` guidance

## Intent

Today the Time view shows an evidence summary like "2h 30m in Claude · 1 commit · In Progress", but not *what actually happened*. To trust or fix a suggestion, the user goes back to Jira, git, and Claude history, which is exactly what the Time feature exists to avoid. They also jump to Jira for ticket context, and can't see at a glance which build a ticket is on or how fresh a section's data is.

## Goals

1. **Evidence timeline:** every suggested ticket row (including Maybe rows) can show *why* it got its hours: a dated timeline of the events behind it, plus the point math.
2. **Ticket panel:** clicking any ticket key opens a side panel with the ticket's context, so the user doesn't need to open Jira.
3. **Last build:** tickets with a "pushed build number" comment show their latest build wherever the ticket appears.
4. **Freshness labels:** each section shows how old its data is, and offers Refresh or Retry.

## Non-Goals

- Editing Jira from the panel, beyond the actions that already exist (Send to QA, Request QA Review)
- Showing Claude conversation text anywhere
- New data sources or credentials

## Anti-Goals

- **Storing Claude chat text.** The timeline uses only what the dashboard already keeps: session ID, start and end times, active minutes, and mention counts.
- **A panel that blocks the page.** It sits alongside, like a macOS inspector. No scrim, and the page keeps working.
- **Labels that alarm when nothing is wrong.** Green is the normal state; only real staleness or failure gets color.
- **Slowing down the Time view.** Evidence for a day loads only when the row is opened.

## Decided by the User (Approved Mockup)

### 1. Evidence Timeline (Time View)
- **Trigger:** each ticket row (suggested, saved, Tempo, and Maybe) gets a small **"Why Nh?"** pill (for Maybe rows: **"Why?"**). Pressing it expands a timeline under the row; pressing again collapses it.
- **Timeline:** one line per event on that day, in local time order. Each line has a time, a colored source dot, and a description:
  - **Jira status change:** `To Do → In Progress`, plus *by you* or the person's name
  - **Jira comment by the user:** time only, never the comment text
  - **Claude session:** shortened session ID (first 6 and last 4 characters), start–end time, active minutes, and how many times this ticket was mentioned in that session
  - **Commit:** short hash, subject line, branch
  - **GitHub build dispatched:** workflow name and run ID, linked to the run
  - **GitHub PR review:** PR number, linked
- **Point math under the timeline:** each signal's points as chips, then the total. Example: `In Progress 2 · Claude 2h 30m 5 · 1 commit 1 · Build 0.5 = 8.5 of 10 points → 6h of 7h`
- **Tempo days and days you added by hand:** the timeline still shows that day's evidence for the ticket, or "No activity found for this ticket on this day."

### 2. Ticket Panel
- **Opens from:** clicking a ticket key anywhere (Home: My Tickets, PR rows, Up Next; Time rows; Release lists; and a ⌘K "Open ticket TCPMOB-…" command).
- **Shape:** a right-side translucent panel, about 380px wide, that doesn't block the page.
  - **Opening:** it slides in from the right on a critically damped spring and leaves the same way.
  - **Closing:** Esc or ✕. Clicking another ticket key swaps its contents in place.
  - **Small screens:** it becomes a full-width sheet from the bottom.
- **Contents, top to bottom:**
  1. **Header:** key, type, summary, and close button
  2. **Chips:** status, assignee, release (fix version), and hours logged this month (Tempo hours if available, else confirmed hours)
  3. **Last build card:** the newest build number in large type, then app, platform, and destination (Firebase or TestFlight) with relative time. Below it, the latest build for each other app and platform.
  4. **Pull request(s)** using this key, with review state
  5. **Description excerpt:** about the first 300 characters of plain text
  6. **Latest 3 comments:** author, relative time, first 2 lines
  7. **Actions:** Open in Jira, Request QA Review and Send to QA (only when those are allowed today: Dev Review with a build posted)

### 3. Last Build Chip
- **Where:** any ticket with a parsed "pushed build number" comment shows a small blue chip, `▲ Build 412 · Android MC · 2h ago`, on Home My Tickets, Home PR rows (next to the ticket chip), and Time rows.
- **Which build:** the most recent comment's build. Clicking the chip opens the ticket panel.

### 4. Freshness Labels
- **Where:** each section header on Home (Needs Attention, Triggered Builds, My Tickets, My Pull Requests, Actions), the Time view header, and the Release, Quality, and Team views.
- **States:**
  - **Green dot:** "Updated just now" or "Updated 3 min ago"
  - **Orange:** "Updated 18 min ago · **Refresh**", once older than twice that section's normal refresh interval
  - **Red:** "Couldn't update · **Retry**", when the last load failed while older data still shows
- **Ticking:** labels update about every 30 seconds without re-rendering the section.
- **Accuracy:** the age is the age of the *data*, not of the page. When the server serves cached data, the label shows when the server fetched it.

## Claude's Calls (After the Builder Check)

- **Point math by row type:** the point chips always show; the last line depends on the row.
  - **Suggested day:** the full sum, `= 8.5 of 10 points → 6h of 7h`. "Of N points" is the total across the tickets suggested that day.
  - **Saved, confirmed, or Tempo day:** `Today's evidence suggests 5h; you have 6h`. The suggestion is recomputed from today's evidence, so a difference is visible instead of hidden.
  - **Maybe row:** `Not enough to suggest hours`. A Claude-only Maybe shows its tool-output mentions.
- **Last build traffic:** one batched endpoint, for example `GET /api/builds/latest?keys=…`.
  - **Limits:** at most 50 keys, each validated.
  - **Caching:** per-key results are cached for 10 minutes, reusing comments already fetched when possible.
  - **Loading:** chips appear just after the rows render, so first paint isn't slowed. A missing chip simply isn't shown.
- **Mention counts:** the Claude day summary gains a raw `mentionCounts` per key alongside the existing weighted `keyCounts`. Days saved before this have no counts, so their session line shows without "N mentions."
- **Panel actions:** both Request QA Review (`/api/tickets/:key/qa-request`, with its preview and test-chat-first flow) and Send to QA are per ticket, so no PR choice is needed. Request Review (per PR) is not in the panel.
- **Freshness on Time:** one label on the Time header, using the month's build time. Per-source failures keep using the existing sources banner, and Refresh there is the existing `fresh=1` rebuild.
- **Small data additions the builder check found:**
  - GitHub evidence keeps the run ID, workflow name, and PR number.
  - `parseBuildComments` keeps the destination (Firebase or TestFlight).
  - Jira status-change evidence keeps the author's display name.

## Data Notes (What Already Exists)

- **Claude:** day snapshots already store `sessionId`, `start`, `end`, `activeMinutes`, `keyCounts`, and per-segment `{ key, start, end, activeMinutes }`. That's enough for the session line. No transcript text is read for this feature.
- **Git:** the month read already gets `sha`, author time, branch (`%S`), and subject per commit.
- **GitHub:** build runs have their ID, branch, and created time; reviews have the PR number and submitted time.
- **Jira:** the time source already reads each ticket's changelog and comments. Status transitions (time, from, to, author) and the user's comment times need to be kept per ticket per day, instead of being reduced to sets and counts.
- **Builds:** `parseBuildComments` already gives app, platform, number, user, and created time from comments.

## Constraints

- All existing constraints hold: Node 20, zero npm dependencies, `127.0.0.1` only, `textContent` only (Jira descriptions and comments are untrusted text), the X-Dashboard and Host checks, and no commits unless the user says so
- Ticket keys are validated (`TCPMOB-\d+`) before any Jira query
- **Tests:** server pieces get node tests. View pieces get `node --check` plus a headless browser check, as in recent work.
- **Design:** follows `/apple-design`
  - **Motion:** critically damped springs for the panel and the timeline expand
  - **Reduced Motion:** cross-fades instead
  - **Reduced Transparency:** a solid panel
  - **Increased Contrast:** borders
  - **Type:** tabular numerals for times and build numbers
  - **Colors:** source dots use their brand-ish colors (Jira blue, Claude coral, git orange, GitHub graphite) and work in light and dark mode
- **Copy:** AP Style, contractions, and no first person

## Left to the Builder

- Endpoint shapes: for example, a per-day evidence endpoint `GET /api/time/evidence?date=&key=` loaded when a row opens, and `GET /api/tickets/:key/panel`
- How freshness timestamps travel: response field or header, and per-section intervals
- Where shared UI pieces live (for example `public/inspector.js` and a `freshness` helper in `ui.js`)
- Caching for the panel endpoint (it can reuse the existing ticket and lookup caches)
