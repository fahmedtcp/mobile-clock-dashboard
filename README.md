# Mobile Clock Dashboard

A local dashboard for the mobile team. It connects `tcp-software/mobile-clock` on GitHub with TCPMOB tickets in Jira, so PRs, builds, tickets, releases, and code health live in one place.

## Requirements

- Node 20 or later
- GitHub CLI (`gh`), logged in with access to `tcp-software` (`gh auth login`)
- Optional, for Jira features: a Jira API token
- Optional, for the TypeScript budget: a local clone of `mobile-clock` with `node_modules` installed
- Optional, for simulator installs: Xcode with a booted iOS simulator

## Setup

1. Clone this repo, then sign in to GitHub: `gh auth login`
2. Run `npm start`. The dashboard opens at http://localhost:4317.
3. Open **Settings** (the gear at the bottom of the sidebar, or press `,`) and add your own connections:
   - **Jira:** URL, email, and an API token from https://id.atlassian.com/manage-profile/security/api-tokens
   - **Tempo:** a token from Tempo's Settings, then API Integration
   - **Teams:** the review channel webhook and, if you like, a test chat webhook
4. Set your **workday hours** under Time Tracking. Time stays off until you do.

Settings are saved in `data/settings.json` on your Mac only. Git ignores the file, and only your Mac account can read it. After a key is saved, the page shows only its last 4 characters. **Test Connection** checks what you typed without saving or writing anything.

Without Jira, the GitHub features still work, and a banner links to Settings.

### Optional: `.env`

A `.env` file in this folder still works as a fallback. Anything set in Settings takes priority. Supported names: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`, `TEMPO_TOKEN`, `TEAMS_WEBHOOK_URL`, `TEAMS_TEST_WEBHOOK_URL`, `TEAMS_ALWAYS`, `TEAMS_NEVER`, `TEAMS_PEOPLE`, `MOBILE_CLOCK_PATH`, and `TIME_REMINDER`.

## Settings

- **Connections:** GitHub (from `gh`), Jira, Tempo, and Teams, each with Test Connection
- **Appearance:** Light (default), Dark, or System
- **Time Tracking:**
  - **Workday hours:** 4–10h. Each saved day keeps the hours it was saved with, so changing this never rewrites past days.
  - **Evening reminder:** on or off, at a time you pick
  - **mobile-clock folder:** where your clone lives
- **Review Requests:** who's always tagged, who's never tagged, and email overrides for people whose Jira email is hidden
- **Builds and Notifications:** which builds are checked by default, and desktop notifications on or off

Changes apply right away, with no restart.

## Usage

```bash
npm start   # starts the server and opens http://localhost:4317
npm test    # runs the test suite
```

Set `NO_OPEN=1` to start without opening a browser tab. Link straight to a view with `#home`, `#release`, `#quality`, or `#team`.

## Views

**Home**
- **Needs Attention:** finished tickets with open PRs, merged PRs whose ticket is still active, PRs with no ticket, and your active tickets with no branch
- **Triggered Builds:** builds you started here, with live status, retry attempts, failure reason, and failure type
- **My Tickets:** your active TCPMOB tickets, with Start on To Do and Open tickets
- **My Pull Requests:** ticket status, checks, review state, staleness, commits behind base, the AI review summary, and an on-demand TypeScript check
- **Which Build Has My Fix?:** enter a ticket key to see every build posted to it, its PR, and whether it's merged
- **Actions:** recent workflow runs with filters, Rerun, and Cancel

**Release**
- The current "Mobile NN" fix version, days left, and whether its release branch is cut
- Tickets with open PRs, tickets with no PR found, unplanned merges, and cherry-pick candidates once the branch exists
- Release notes grouped into Fixes and Improvements, with a Copy button

**Quality**
- TypeScript error count on `develop`, with trend and a Run Now button
- Pass rates for unit tests and Detox, with how long ago each last ran
- Flaky runs: the same commit both failed and passed

**Team**
- Review load per person and PRs waiting on review
- All open pull requests

**Time** (press `t`)
- Suggested hours per ticket for each workday, always adding up to 7h, rebuilt from:
  - Jira: days your ticket was **In Progress** while assigned to you, plus your own status changes and comments
  - Git: your non-merge commits in the local `mobile-clock` clone (a ticket key in the commit message beats the branch name)
  - GitHub: builds you started (0.5 each, up to 1 per ticket per day; re-runs don't count again) and your reviews of other people's PRs (1 each, up to 2), matched to the ticket by branch name. GitHub keeps run history for about 90 days.
  - Claude Code sessions: the ticket each session mentions most, weighted toward what you typed and what Claude did, never injected memory or system text
- Each suggestion shows its evidence, for example `4 commits · 1h 40m in Claude · In Progress`
- Adjust with − and +; the other tickets rebalance to keep the day at 7h. Add leave as a half day, a full day, or any 0.5h step, and ticket hours fill the rest.
- **Confirm Day** saves the day locally. **Copy Day** gives text ready to paste into Tempo.
- **Month** mode shows every day and ticket at once, with **Copy Month** and **Export** (JSON or CSV, confirmed days only) for a future Tempo script
- A macOS reminder at 8:30 PM on workdays you haven't confirmed. Set `TIME_REMINDER=off` in `.env` to turn it off, or `TIME_REMINDER=19:00` to change the time.
- Claude chat text is never stored: the dashboard keeps only per-day ticket counts and times in `data/time/`, so history survives Claude's 30-day log cleanup.

## Tempo

Tempo is the source of truth. Each month loads your Tempo worklogs first, and only days with nothing in Tempo show suggestions.

- **In Tempo days:** show Tempo's hours, and any hours Tempo doesn't cover show as leave. You can edit them, but the dashboard never changes Tempo. If your edits differ, the day lists exactly what to change in Tempo by hand.
- **Send to Tempo:** on a confirmed day, or **Send Month** in Month mode. A preview shows every worklog first. Each worklog starts at 9:00 AM, and its description is the ticket's status at the end of that day. Leave isn't sent.
- **No double logs:** right before posting, each day is checked against Tempo again, and any day with a Tempo worklog is skipped. A day can't be sent twice at once.

Setup: in Tempo, open **Settings**, then **API Integration**, and create a token. Add `TEMPO_TOKEN="…"` to `.env`, then restart. Your Tempo account ID comes from Jira.

## Teams Review Requests

**Request Review** on your open, non-draft PRs posts your review message to a Teams channel. It shows a preview first and sends nothing until you press **Send to Teams**. The message uses the ticket key and Jira title, links to the ticket and PR, includes your optional note, and @mentions you and the requested reviewers.

Setup:
1. In the Teams channel, open **•••**, then **Workflows**, then **"Post to a channel when a webhook request is received"**, and copy the URL.
2. Add `TEAMS_WEBHOOK_URL="…"` to `.env`. Only Microsoft webhook addresses are accepted.
3. Optional: when a reviewer's Jira profile hides their email, they show as a plain name. To @mention them, add `TEAMS_PEOPLE="githublogin=email@tcpsoftware.com,other=…"`.

Messages appear from Workflows, not your own account. Each PR can be sent at most once every 30 minutes.

## Actions That Change Things

Each one asks for confirmation first and is checked again on the server.

| Action | What it changes |
|---|---|
| Build | Starts dev builds (`release dev`, or `build dev .app` for the simulator option). QA and InfoSec are never notified, and prod builds can't be started. |
| Send to QA | Moves the ticket from Dev Review to QA Review. Only offered after a dev build was posted to the ticket. Posts no comment. |
| Start | Creates `TCPMOB-123-summary` from the latest `develop` on GitHub and assigns the ticket to you if it's unassigned. Doesn't change status. |
| Create Jira Bug | Creates a TCPMOB Bug from a failed build, linked to the PR's ticket |
| Update (behind base) | Merges the base branch into the PR branch |
| Rerun / Cancel | Reruns failed jobs or cancels a workflow run |
| Request Review | Posts a review request to your Teams channel |
| Request QA Review | On Dev Review tickets with a dev build: posts "ready for PRE-QA" to the QA channel and tags the QA group. Doesn't change the ticket. |
| Send to Tempo / Send Month | Creates Tempo worklogs for confirmed days that have nothing in Tempo. Never updates or deletes worklogs. |
| Install on Simulator | Downloads the `.app` artifact and installs it on a booted simulator |

## Automatic Behavior

- **Build retries:** builds triggered here are watched by the server, even with no tab open. Network, runner, disk, and timeout failures rerun their failed jobs up to 2 times. Code failures (TypeScript, tests, compile, lint) aren't retried and notify you right away. Cancelled builds are never retried.
- **TypeScript budget:** counts errors on `develop` once a day. It uses its own git worktree under `cache/` and links your clone's `node_modules`, so your working tree and branch are never touched.
- **Notifications:** a desktop alert when a triggered build succeeds or fails for good, or when a status badge turns red. Click the page once to allow them.

## Safety

- The server listens on `127.0.0.1` only and rejects requests from other sites.
- Build inputs and branches come from the server and GitHub, never from the browser.
- Ticket keys are validated before any Jira query.
- Triggered builds are tracked in memory, so restarting the server clears that list.

## Later (Needs Credentials or Setup)

- Install links and QR codes for Firebase and TestFlight builds (Firebase service account, App Store Connect API key)
- App Store review status and Play rollout percentage (store API keys)
- Self-hosted runner health (repo admin access)
- Teams nudges and a morning standup digest (Teams webhook)
- Crashes by app version (Crashlytics export to BigQuery)

## Configuration

`config.js` holds the repo, port, workflows, status badges, Jira project, statuses, cache times, and retry limit.
