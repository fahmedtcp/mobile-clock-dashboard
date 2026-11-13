# Shift-Aware Home Design

Date: 2026-11-13
Builds on: `main` plus `feature/evidence-inspector` (ticket panel, last build chips, freshness labels, evidence timeline)
Design reference: the approved mockup `.superpowers/brainstorm/99544-1794571659/content/home-calm-v8.html` (take 8), following the `/apple-design` guidance

## Intent

Home today is one long column of lists: a row of counts, Up Next, Needs Attention, Triggered Builds, My Tickets, My Pull Requests, Build Lookup, and Actions. It doesn't read like a dashboard, and the user rejected adding charts and team stats ("useless information"). What they approved is a Home where **every card either tells them something new or shows what's stuck and gives the one button that unsticks it**.

The user, their teammates, and QA (Sana, in Pakistan) all work the same **1–10 PM** shift. Home uses that: it knows how far into the shift it is, who's on shift and what they're doing, which meetings are coming up (from the Mac's Calendar app), and it changes what it shows at the start, middle, and end of the shift.

## Goals

1. **A calm hero card** with a one-sentence headline about the most important thing right now and its button, an "On shift now" list of teammates and what each is working on, and a thin 1–10 PM shift line with today's meetings on it.
2. **My Work:** one row per ticket (replacing My Tickets and My Pull Requests as separate lists) with its stage, what's blocking it in plain words, and one fix button. Clicking a row opens the ticket panel.
3. **Since You Last Looked:** comments, reviews, and status changes on the user's tickets and PRs made by someone else, with the actual comment text.
4. **Shift moments:** a start-of-shift view (Since Last Shift, Today's Shift, Plan for This Shift), a mid-shift view (Since You Last Looked, Builds, Standup draft, Waiting on You), and a wrap-up view (Before You Log Off, Note for Tomorrow).
5. **Calendar:** read meetings from the macOS Calendar app, locally, with titles, to place them on the shift line, name the next meeting, and time the Standup draft.

## Non-Goals

- **Calendar data in Time.** The user said Time is good as it is. Meetings never change hour suggestions, Tempo sync, or evidence.
- Charts, trend lines, team statistics, or connection-status pills on Home (they stay on Quality, Team, and Settings)
- Microsoft Graph sign-in or a published ICS link (macOS Calendar app only for now)
- A drag-to-rearrange widget editor

## Anti-Goals

- **Bright, decorative visuals.** The user rejected the sky gradient and sun arc and asked for less bright color. The hero is a plain card; colors are the softened palette from take 6 onward.
- **Numbers without an action.** If a card can't say what to do next, it doesn't belong on Home.
- **Sending anything on its own.** The Standup draft, Handoff and Note for Tomorrow are drafts. Nothing posts to Teams or changes Jira without a button press, and existing confirm sheets still apply.
- **Calendar data leaving the Mac.** Meeting titles are read locally and never written to disk, logs, Jira, Tempo, or Teams.

## Constraints

- Zero npm dependencies, Node 20, existing patterns (route tables, `el()`, `textContent` only, `HttpError`, `X-Dashboard` header)
- Teammates run their own copy with their own settings; nothing here may assume the user's name, team, or calendar
- Tests never touch real services or the real calendar (same `NODE_TEST_CONTEXT` rules as today)
- Org writing style for all copy: AP Style, contractions, no first person, title-case headings
- Reduced motion, reduced transparency, increased contrast, light and dark, and phone width all work (as the current Home does)

## What the User Decided

### Layout (take 8)

- **Hero card**, left: small line with date, time, and the next meeting ("Friday, November 13 · 5:30 PM · Standup in 2h"); a headline; a sentence of context; one filled button and one plain button.
- **Hero card**, right: "On shift now": each teammate's avatar with a green dot, name, and what they're doing ("Testing TCPMOB-1768 on build 412", "Reviewing #1105 · 2 in queue", "TCPMOB-1735 · In Progress"). The user appears first as "You".
- **Shift line** across the bottom of the hero: "1 PM", a thin rail with the elapsed part filled and a ring marking now, meeting blocks with their title and start time above them, a "Wrap-up" mark, and "10 PM · 4h 30m left". **No QA cutoff** (the user removed it).
- **My Work** card (full width): per ticket, the key and summary; a five-dot stage line (green done, blue current, orange waiting, red failing) with a stage name under it; the blocker in plain words; one button. Examples the user approved:
  - "Sana is testing build 412 (Android). No iOS build yet." → **Build iOS**
  - "Sana sent it back: 'still shows on empty filter.'" → **Open PR**
  - "Hamza left 3 threads · 'use the theme spacing token'" → **Open threads**
  - "Lint failed · 2 errors in useLinkingActions.ts · 9 behind develop" → **Update branch**
  - "Merged 5 days ago, no build since. QA's latest build doesn't have the fix." → **Open ticket** (no develop builds from Home; the user said it isn't needed)
- **Since You Last Looked**: unread dot, avatar, who did what on which ticket or PR, the comment text in a bubble, and the time. "Mark read".
- **Builds**: only failed and running builds, with the error line in monospace, whether it's a runner problem or the code (from the existing classification), and **Rerun**.
- **Waiting on You**: reviews requested from the user, and unconfirmed hours (existing Time pending count).
- **Softened palette** (take 6 values) everywhere on Home, light and dark.

### Shift moments

The shift is split by time; the hero headline, the shift line, and which cards show all follow it. My Work shows in every moment.

| Moment | When | Cards besides My Work |
|---|---|---|
| Start | first hour of the shift | **Since Last Shift** (everything from 10 PM to 1 PM), **Today's Shift** (focus gaps and meetings from the calendar), **Plan for This Shift** (ordered next steps sized to the focus time before the first meeting) |
| Mid | after the first hour, until wrap-up | **Since You Last Looked**, **Builds**, **Standup at <time>** draft (when a standup meeting is coming up today), **Waiting on You** |
| Wrap-up | last 40 minutes | **Before You Log Off** checklist, **Note for Tomorrow** |

- **Before You Log Off** items, each with a button and checked off when done: unpushed local commits on a ticket branch (push and open the PR so the reviewer has it at 1 PM); today's hours not confirmed; completed items stay visible, struck through.
- **Note for Tomorrow**: an editable draft (start with, waiting on, left off) that shows at the top of Home at the next shift start.
- **Standup draft**: Yesterday, Today, Blocked, built from the same evidence the Time view uses (Jira changes, commits, PRs, builds; never Claude chat text), covering the period since the previous standup. **Copy** only.

### Calendar

- Source: the macOS Calendar app on the user's Mac, read through Apple's EventKit (a small Swift helper the dashboard runs). AppleScript was tried and doesn't expand repeating meetings, so it's out.
- Titles are read (the user approved). Meetings show on the shift line, as "<title> in <time>" in the hero's small line, in Today's Shift, and decide when the Standup card appears.
- **Not used by Time** in any way.
- One-time macOS permission prompt. If permission is denied, the calendar isn't set up, or the helper fails, Home works without meetings and the shift line shows no blocks.

## Claude's Calls (Before the Builder Check)

- **Shift settings:** shift start and end (default 13:00 and 22:00), wrap-up length (default 40 minutes), and a calendar on/off switch, in Settings with info tips. Defaults are the user's shift; teammates can change them.
- **Teammates:** a new **Team** setting, a list of people, each with name, GitHub login, Jira email, and a QA checkbox. `teams.people` (GitHub login to email, for Teams @mentions) stays as is. "On shift now", QA blockers ("Sana is testing…"), and Since Last Shift all use this list. With no list, those parts hide and the rest of Home works. Everyone shares the user's shift hours; per-person hours aren't needed.
- **"Since you last looked"** is stored as one timestamp per user in the dashboard's data dir, updated by **Mark read** and when the card has been on screen for a few seconds.
- **Build Lookup** moves to ⌘K only (it already has "Which build has KEY?"). **Actions** and the full PR list move into a collapsed **More** section at the bottom of Home, so no current feature is lost. **Needs Attention** items fold into My Work blockers or Since You Last Looked.
- **Pushing:** the dashboard never writes to the mobile-clock clone (a standing rule). "Unpushed commits" items show the branch and a **Copy push command** button plus **Open PR** (GitHub compare page); the user pushes in their terminal.
- **Hero headline order** (first match wins): one of the user's builds failed after retries; a ticket was sent back by QA or got changes requested since the user last looked; QA is testing one of the user's tickets and a build is missing for a platform; a meeting starts within 15 minutes; a review is waiting on the user; in wrap-up, the Before You Log Off count; otherwise "Nothing's stuck." with the top My Work row as the button.
- **Outside the shift:** before the shift starts, Home shows the Start view with "Shift starts in Xh" and the shift line empty; after it ends, the Wrap-up view until midnight, then Start. Saturdays and Sundays show the Mid view with no shift line. Shifts crossing midnight aren't supported (Settings rejects end before start).
- **Calendar scope:** all calendars in the Calendar app, skipping all-day, declined, and canceled events.
- **Standup detection:** a meeting whose title contains "standup" or "stand-up" (any case). Without one, no Standup card shows.

## Left to the Builder

- How to detect each blocker from data the dashboard already fetches (PR checks, review state and threads, behind counts, build tracker, Jira status and changelog, build comments), and their priority when a ticket has several
- How "what a teammate is doing" is derived (Jira In Progress ticket, QA ticket in testing, GitHub review activity) and its caching
- Exact Swift helper shape (compiled once vs. run with `swift`), its output format, timeout, and caching
- Card order within a moment, empty states, and loading skeletons
- How "unpushed commits" is read from the local clone (the clone path setting already exists)
