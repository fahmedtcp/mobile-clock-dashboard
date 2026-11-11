# Time Tracking (Tempo Helper) Design

Date: 2026-11-10
Builds on: dashboard v2 (`2026-11-06-mobile-team-dashboard-v2-design.md`), implemented and working

## Intent

The user logs Tempo hours per ticket per day, 7 hours per workday. They put it off until month-end, then rebuild the month by hand from Jira status changes, git commits, and Claude chat history: when a ticket moved To Do → In Progress → Dev Review, and when the next one started. That takes a long time and memory fills the gaps badly.

The dashboard should rebuild that timeline for them, suggest believable hours with the evidence behind each number, nudge them to confirm each evening so nothing piles up, and make the confirmed hours easy to type into Tempo.

## Goals

- Suggest hours per ticket per workday, summing to 7.0h, from evidence the user already leaves behind
- Show the evidence next to every suggestion so confirming takes a glance
- Let the user adjust, confirm, and copy a day in under a minute
- Show the whole month at once when they want it
- Remind them at the end of each workday so they confirm the same day
- Keep enough history that a month-end catch-up still works after Claude's log cleanup

## Non-Goals

- Writing worklogs to Tempo (the user will script that later; the export must make it easy)
- Minute-level accuracy
- Tracking anyone but the current user
- Meetings, calendars, or non-ticket time

## Anti-Goals

- Hours that look precise but aren't believable (for example, 0.25h slivers across eight tickets)
- Storing Claude conversation content. Only ticket-key counts and timestamps are kept.
- Any write to Jira, GitHub, or Tempo
- A reminder that nags after the day is already confirmed

## Decided by the User

Spec approved: 2026-11-10

- **Granularity:** hours per ticket per day, 7 hours per workday total
- **Accuracy:** "not to the minute but something believable and quick to confirm"
- **Claude sessions:** count toward the ticket key referenced most in the session, not the git branch it ran on. The user sometimes forgets to switch branches before starting the next ticket.
- **Output:** show hours only. No Tempo writing for now; the user will write a Tempo script later.
- **Layout:** day by day, plus a toggle that shows the whole month's breakdown at once (picked from a mockup over a weekly timesheet)
- **Mentions:** full weight for the user's messages and Claude's own actions, light weight for tool output, never for injected memory or system text (accepted Claude's recommendation)
- **Leave:** added by hand per day, as leave hours; remaining ticket hours rebalance to fill the 7h day
- **History:** the dashboard keeps its own summary of Claude sessions, so Claude's 30-day log cleanup doesn't matter
- **Reminder:** end of each workday, around 8:30 PM

## Evidence Sources

All are local or already connected. No new credentials are needed.

| Source | What it gives | Ticket attribution |
|---|---|---|
| Jira changelog | Status transitions with timestamps for tickets the user worked on | The ticket itself |
| Jira activity | The user's own comments and transitions on a day | The ticket itself |
| Git commits | The user's commits across all branches in the local `mobile-clock` clone (`MOBILE_CLOCK_PATH`), with author dates | Key in the commit message first, else the key in the branch the commit came from |
| Claude Code sessions | `~/.claude/projects/**/*.jsonl` transcripts: message timestamps, text, and `gitBranch` | The `TCPMOB-\d+` key mentioned most in the session, weighted by where the mention appears (see **Which Mentions Count**). The branch is a fallback only when no key is mentioned. A session where two keys dominate different stretches of time is split at the switch point. |

### Which Mentions Count (Decided by the User)

Real data from the reviewer: the user typed a key in only 15 of 93 sessions. There were 1,197 key mentions in tool results and 470 in injected context; the memory index alone lists about 8 old TCPMOB keys in every session.

- **Full weight (1 per mention):** the user's own typed messages, and Claude's own actions: tool call inputs such as `git switch TCPMOB-1480-…`, edited or created file paths, Jira or `gh` calls naming a key, and Claude's reply text
- **Light weight (0.1 per mention):** keys that only appear in tool output, such as search results, `git log` listings, and file contents read
- **Never counted:** injected context: system reminders, the auto-memory index (`MEMORY.md` and memory files), CLAUDE.md contents, skill text, and hook output

The user's identities: Jira `currentUser()` (already authenticated), and git author email from `git -C MOBILE_CLOCK_PATH config user.email` (fallback: GitHub login email from `gh api user`).

## How a Day's Hours Are Suggested

**Workdays:** Monday–Friday in the machine's local time zone. Each day totals 7.0h.

**Leave (decided by the user):** the user adds leave to a day by hand, as hours in 0.5h steps, up to 7h. Leave is its own line in the day ("Leave 3.5h"). The remaining hours (7 − leave) are balanced across that day's tickets. A full 7h of leave makes it a leave day: no ticket hours, and no reminder or badge. The dashboard never guesses leave.

**Active window per ticket** (Claude's call, refined from the user's description and real data): a ticket is active only while its status is **In Progress**. Any move out of In Progress ends the window, including to To Do, On Hold, PO Review, Rejected, or any review/done status. Real data: the user moved tickets from In Progress back to To Do 4 times in 60 days, and those must not keep earning hours. Moving back into In Progress opens a new window.

**Signals per ticket per day, with weights** (Claude's call, tunable in config):
- In its In Progress window for any part of the day: 2
- Each non-merge commit attributed to it that day: 1, capped at 5 per day (merge commits are about a third of the user's commits and say nothing about the work)
- Claude session time attributed to it that day: 1 per 30 active minutes, capped at 6. Active minutes come from message timestamps, with gaps over 15 minutes not counted.
- The user's own Jira comment or transition on it that day: 0.5 each, capped at 1

**Excluded keys:** Epic and Initiative issue types never receive hours.

**Claude sub-agents:** sub-agent transcripts share their parent's session ID and are merged into the parent session, never counted twice.

**Allocation:**
- Hours are proportional to each ticket's weight, rounded to 0.5h. The day's total is exactly 7.0 (largest-remainder rounding).
- The target is 7.0 minus any leave on that day.
- Every ticket shown gets at least 0.5h.
- Tickets that would get under 0.5h are dropped and their share is redistributed.
- At most 5 tickets per day; the rest fold into the top ones.

**No evidence:** if a workday has no evidence at all, it's marked "No data". The user picks tickets from their recent tickets (or types a key) and sets the hours.

**Evidence lines** (one line per ticket in the day view), for example: `4 commits · 1h 40m in Claude · moved to Dev Review 3:12 PM`.

## The Time View

A fifth view, **Time**, in the sidebar and tab bar, using the existing dashboard style.

### Day Mode (Default)
- **Month header:** month name, previous and next month buttons, and a progress summary (for example "12 of 15 workdays confirmed")
- **Strip of the month's workdays:** each shows the weekday and date with a state: Confirmed (green, "7h"), Needs Review (orange), No Data (gray), Leave (muted, for a full day of leave), or Future (disabled). Days with partial leave show a small leave marker. Today is highlighted, and the day that's open is outlined.
- **The open day:**
  - **Ticket rows:** key (links to Jira), summary, evidence line, and an hours stepper (− / +, 0.5h steps)
  - **Total:** a running total. Confirm is enabled only at exactly 7.0h.
  - **Add ticket:** from recent tickets, or by typing a key
  - **Copy Day:** text ready to paste into Tempo, one line per ticket plus a leave line when present: `TCPMOB-1480  4.5h  Clock Ops | Workflow Handling During Network Interruptions` and `Leave  2.5h`
  - **Confirm Day:** saves the day. Confirmed days stay editable, and a day edited after confirming needs Confirm again.
  - **Add Leave:** a leave line with its own stepper (0.5h steps). Changing it rebalances the ticket hours right away, unless the user has already adjusted a ticket by hand; then only the untouched tickets rebalance.
- **Default open day:** today if it's a workday, else the most recent unconfirmed workday

### Month Mode (Toggle)
- **Grid:** rows are tickets, columns are workdays. Each cell shows hours (suggested or confirmed, styled differently), and pointing at a cell shows its evidence.
- **Totals and status:** row totals (hours per ticket for the month), column totals (each day, which must be 7), and a confirmation state per column
- **Copy Month:** text grouped by day
- **Export:** a JSON file with every confirmed entry, `[{ date: 'YYYY-MM-DD', key, hours, summary, evidence }]`, the format a future Tempo script reads. Leave is exported as `key: 'LEAVE'`. Also offered as CSV with the same fields.
- **Navigation:** clicking a column opens that day in day mode

### Home Integration
- When yesterday or earlier is unconfirmed, a Home tile shows "N days to confirm" and links to Time
- Unconfirmed past workdays add to the Time nav badge

## Reminder

- **When:** at 8:30 PM local time on workdays, if today isn't confirmed and isn't a full leave day
- **How:** the dashboard server shows a macOS notification. Server-side, because the browser tab may be closed (Claude's call: `osascript -e 'display notification …'` via `execFile`, no shell).
- **Content:** "Confirm today's hours: 3 tickets, 7h suggested"
- **Clicking it:** opens the dashboard on Time if the OS allows; otherwise the notification is informational
- **Frequency:** one reminder per day, never sent if the day is already confirmed. If the server wasn't running at 8:30 PM, the reminder fires when it next starts, for the most recent unconfirmed workday, at most once per day.
- **Settings:** the time is a config value (`TIME_REMINDER = '20:30'`); `TIME_REMINDER=off` in `.env` disables it

## Storage (Local, Gitignored `data/`)

- `data/time/confirmed.json`: confirmed and edited days, `{ 'YYYY-MM-DD': { status: 'confirmed'|'draft', leaveHours: 0, entries: [{ key, hours, manual: boolean }], confirmedAt } }`. A day with `leaveHours: 7` is a leave day.
- `data/time/claude/YYYY-MM-DD.json`: the dashboard's own Claude summary per day, `{ sessions: [{ sessionId, start, end, activeMinutes, keyCounts: { 'TCPMOB-1480': 12 }, branch, segments: [{ key, start, end, activeMinutes }] }] }`. **No message text is stored.**
- **Snapshots:** taken at server start and hourly, for every day that still has transcript files. Already-snapshotted days are only updated, never deleted, so history outlives Claude's cleanup.
- **Backfill:** the first run snapshots everything currently on disk (Claude keeps about the last 30 days)

## Constraints

- All v1 and v2 constraints hold: Node 20, no npm dependencies, `127.0.0.1` only, `execFile` with no shell, `textContent` with no `innerHTML`, the Host plus `X-Dashboard` checks, and confirmation for any write
- Reading `~/.claude/projects` is local file access. Scanning must stream line by line, because transcripts can be large, and must skip malformed lines.
- Git: read-only commands against `MOBILE_CLOCK_PATH`, never changing its working tree or branch
- Jira: read-only for this feature
- No change to Tempo

## Left to the Builder

- Module layout (for example `lib/time/` for sources, allocation, storage, reminder) and routes
- The JQL for "tickets the user worked on this month" (for example `project = TCPMOB AND (assignee was currentUser() OR status changed BY currentUser()) AND updated >= <month start>`), and changelog paging
- How commits map to branches (for example `git log --all --source`)
- Splitting a Claude session between two keys (for example, the first message where the second key's running count overtakes the first)
- Caching per month, and when to recompute suggestions
- The exact styling of the strip, steppers, and month grid, within the existing design system
