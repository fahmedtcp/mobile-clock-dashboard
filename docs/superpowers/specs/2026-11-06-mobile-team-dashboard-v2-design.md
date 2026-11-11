# Mobile Team Dashboard v2 Design

Date: 2026-11-06
Builds on: `2026-11-06-repo-dashboard-design.md` (v1, implemented and working)
Target repo: `tcp-software/mobile-clock` · Jira: `timeclockplus.atlassian.net`, project `TCPMOB`

## Intent

v1 put PRs, builds, and Actions in one place. v2 turns it into the mobile team's daily home base by connecting the pieces the team still stitches together by hand: Jira tickets, branches, PRs, builds, releases, and code health. The goal is fewer tab switches, fewer copy-paste handoffs to QA, and problems surfaced before someone asks about them.

The user asked for every feature on the brainstormed list. Features are split into phases by what they need. **Phase 1 gets built now.** Phases 2 and 3 are recorded here so the design accounts for them, and are built later once credentials or setup exist.

## Goals

- Show each PR's Jira ticket state without opening Jira
- Make the dev-to-QA handoff one click
- Catch Jira/GitHub drift (done tickets with open PRs, merged PRs with stale tickets) automatically
- Answer "which build has my fix?" instantly
- Give the release train one view: what's in, what's missing, what needs cherry-picking, and the release notes
- Make code health visible: TypeScript error trend, test pass rates, flaky runs
- Make review load visible across the team
- Waste fewer retries on failures that retries can't fix

## Non-Goals (v2)

- Hosting, sign-in, or multi-user deployment (still local, single user)
- Replacing Jira or GitHub UIs for editing; the dashboard links out for anything beyond the actions listed here
- Prod builds of any kind

## Anti-Goals

- Any write to Jira, git, or GitHub that the user didn't click and confirm. Every write action shows what it will do and needs a confirmation.
- Duplicate Jira comments. The build workflows already post "pushed build number N … to testflight / firebase distribution" on the ticket; the dashboard never posts build comments.
- Secrets in the repo. Tokens live only in a local `.env` that's gitignored.
- A dashboard that breaks when Jira is unreachable or not configured. GitHub features keep working, and Jira areas show a clear setup or error message.
- Triggering `release prod` or setting `sendReleaseUpdates=true` (unchanged from v1)

## Constraints

- Everything in v1's constraints still holds: Node 20, zero npm dependencies unless a plan finds a clear need, `gh` for GitHub, `127.0.0.1` only, server-side hardcoded build inputs, Host and `X-Dashboard` checks on the API
- Jira access: Jira Cloud REST API v3 with basic auth (email + API token), read from `.env`: `JIRA_BASE_URL=https://timeclockplus.atlassian.net`, `JIRA_EMAIL`, `JIRA_TOKEN` (the user's chosen name). `.env` is gitignored and mode 600. Verified 2026-11-06: classic token with basic auth against the site URL returns HTTP 200 on `/rest/api/3/myself`.
- Some features need the local `mobile-clock` checkout (TypeScript budget). Its path is a config value, defaulting to `~/Downloads/GitHub/mobile-clock`.
- The user's own working tree in that checkout is never modified. Anything that needs a different branch uses a separate git worktree in a dashboard cache folder.

## Facts Gathered (Read-Only Recon)

- Ticket keys are in branch names: `TCPMOB-1482-sub-management-2-0-…`, `TCPMOB-897-accruals-ledger-date-is-undefined`. Branch names are the full summary in lowercase kebab-case after the key.
- TCPMOB statuses seen: To Do, Open, In Progress, Dev Review, QA Review, Release Candidate, Done. From Dev Review, a transition named "QA Review" (id 41) leads to QA Review. Transition ids differ by current status, so look them up per ticket by target status name.
- Fix versions are named "Mobile NN" (current: Mobile 46, release date 2026-11-30). Release branches are `release/1.NN.x` (latest: `release/1.45.x`). Mobile 46 maps to `release/1.46.x`, which isn't cut yet.
- Build workflows already comment on the ticket after each successful dev build, with these exact texts:
  - iOS MC: `<user> pushed build number <N> for MobileClock IOS to testflight`
  - iOS MK: `<user> pushed build number <N> for Mobile Kiosk IOS to testflight`
  - Android MC: `<user> pushed build number <N> for Mobile Clock Android to firebase distribution`
  - Android MK: `<user> pushed build number <N> for Mobile Kiosk Android to firebase distribution`
- **Release flow:** PRs merge into `develop`. A release branch is cut from `develop` at release time with a single "Bump version to Mobile NN" commit, then merged back. In the last 200 merged PRs only 3 targeted a release branch. "Release Candidate" in Jira means "merged to `develop`, waiting for the cut."
- The `.app` simulator artifact (`.app build artifacts for simulator`) is uploaded only when `buildType` is `build dev .app` or `build prod .app`.
- The PR Review workflow runs Claude, which posts inline comments plus one top-level summary comment as `claude[bot]`.
- Crash reporting is Firebase Crashlytics (`@react-native-firebase/crashlytics`). Crashlytics has no read API; crash data needs a BigQuery export.
- Listing self-hosted runners returns 404 for the user (needs repo admin).
- About 1,558 TypeScript errors already exist on `develop` (known baseline).

## Phase 1 Features (Build Now)

### Navigation

The single page grows into four views, with the v1 visual style:
- **Home:** my PRs, my triggered builds, alerts, and my sprint tickets
- **Release:** the release train
- **Quality:** TypeScript budget, test health, flaky runs
- **Team:** review queue and all open PRs

Desktop uses a sidebar; narrow screens use a segmented control or tab bar. The status strip stays in the header.

### 1. Jira on Every PR

- Extract the first `TCPMOB-\d+` (case-insensitive) from the branch name, falling back to the PR title
- Fetch all ticket keys in one JQL query (`key in (…)`) and cache for 60 seconds
- Show on each PR row: ticket key (linked), status chip, assignee, and fix version
- PRs with no key show a "No ticket" chip

### 2. Send to QA

- Shown on a PR row when its ticket is in Dev Review and the ticket has at least one Jira build comment (the four texts above). Only successful `release dev` builds post those comments; `gh run list` can't show a run's build type, so it isn't used for this check.
- One click opens a confirmation listing the ticket, current status → QA Review, and the latest build numbers found in the ticket's Jira comments
- On confirm, look up the ticket's transitions and apply the one whose target status is "QA Review"; if none exists, show the available transitions and do nothing
- No Jira comment is posted

### 3. Mismatch Alerts

An alerts list on Home, each with a link to fix it in Jira or GitHub:
- Ticket is Release Candidate or Done, but its PR is still open (non-draft)
- PR merged in the last 14 days, but its ticket is still To Do, Open, In Progress, or Dev Review
- Open non-draft PR with no ticket key
- My sprint ticket (open sprints, assigned to me) in Open, In Progress, or Dev Review with no remote branch containing its key

Alerts are computed on refresh and are scoped by default to my PRs and tickets, with a toggle for the whole team.

### 4. Start a Ticket

- Home lists my open-sprint tickets in To Do, Open, or In Progress (Start is offered on To Do and Open)
- **Start** opens a confirmation showing the branch name that will be created: `TCPMOB-<n>-<summary as lowercase kebab-case>` (non-alphanumerics become `-`, repeats collapsed, trimmed to 100 characters total)
- On confirm: create the branch on the remote from the current `develop` head (GitHub API, no local checkout change), and assign the ticket to me if it's unassigned
- No status transition (user decision: Start never changes ticket status)

### 5. Failed Build to Jira Bug

- On a triggered build that failed for good, a **Create Jira bug** button opens a form pre-filled with:
  - Summary: `CI build failure: <build label> on <branch>`
  - Description: the failed job and step, the reason lines, the run link, and the attempt count
  - Link: "relates to" the PR's ticket, if any
- Every field is editable. Nothing is created until the user confirms.
- The issue type is Bug in TCPMOB. If Bug isn't available, the form says so and offers the types that are.

### 6. Which Build Has My Fix?

- A search box (on Home and Release) takes a ticket key
- Results list every build found for that ticket:
  - From the ticket's Jira comments matching the four texts above: app, platform, build number, who, and when
  - From dashboard-tracked builds and successful `workflow_dispatch` runs on branches containing the key
- Also shows whether the ticket's PR is merged to `develop` ("in the next release"), and, once that release's branch exists, whether the merge commit is on it

### 7. Smarter Retry

v1 retries every `failure`, `timed_out`, and `startup_failure` up to 2 times. v2 classifies first:
- Fetch the failure reason (v1's failed job, step, and log lines) before deciding
- **Infra failure → retry** (counts against the 2 retries). Patterns include network errors (`-1009`, `Internet connection appears to be offline`, `ETIMEDOUT`, `ECONNRESET`, `Could not resolve host`, HTTP 5xx), runner loss (`lost communication with the server`, `runner has received a shutdown signal`), disk space (`No space left on device`), dependency download failures, and `startup_failure` / `timed_out` conclusions
- **Code failure → no retry**, and notify immediately. Patterns include `error TS\d+`, Jest failure summaries, compile errors (`error:` from Xcode compile steps, `Compilation failed`, `e: ` Kotlin errors), and lint failures
- **Unknown → retry** (v1 behavior)
- The build row shows the classification ("Network issue, retrying" / "Code error, not retried")
- The patterns live in one list that's easy to extend

### 8. Release Train

Work happens on `develop`; the release branch is cut late (see Facts). So the view centers on `develop`, and uses the release branch only once it exists.

- **Current release:** the earliest unreleased "Mobile NN" fix version, with its release date
- **Last cut:** the newest existing `release/1.MM.x` branch with MM < NN. Its merge base with `develop` marks where this release's work starts.
- **Lists:**
  - **In the version:** tickets in the fix version with status, assignee, and PR state (open, merged to `develop`, or none)
  - **Not merged yet:** tickets in the fix version whose PR isn't merged to `develop`. Highlight any that are already Release Candidate or Done, since that's a mismatch.
  - **Unplanned:** PRs merged into `develop` after the last cut whose ticket isn't in the fix version (or has no ticket)
  - **Cherry-pick candidates (only when `release/1.NN.x` exists):** PRs merged into `develop` after that branch's merge base whose ticket is in the fix version and whose merge commit isn't on the release branch
- **Branch status:** "Release branch not cut" until `release/1.NN.x` exists, then a link to it
- **Release notes:** generated from the fix version's tickets, grouped by issue type (Bugs → Fixes; Stories and Tasks → Improvements), one line each (`TCPMOB-123 Summary`), with a copy button. Text only; nothing is posted anywhere.

### 9. TypeScript Error Budget

- A runner in the dashboard server counts `error TS` lines from `tsc --noEmit` on `origin/develop`:
  - Uses a git worktree in the dashboard's cache folder, never the user's working tree
  - Reuses the local checkout's `node_modules` via a symlink (ceiling: wrong counts if a branch changes dependencies)
  - Runs at most once a day automatically, plus a **Run now** button. Shows progress, since a run takes minutes.
- History is stored in a local gitignored JSON file and shown as a trend (count over time, change since last run)
- **PR delta, on demand:** a button on a PR row runs the same count on the PR's head and shows "+N / −N vs develop". One run at a time; results cached by commit SHA.

### 10. Test Health

- **Unit tests:** pass rate of `run-tests.yml` on `develop` over the last 30 runs, plus the latest result
- **Detox:** pass rate and latest result for the Detox workflows that have runs
- **Flaky runs:** commits (same head SHA and workflow) that have both a failed and a successful run, listed with links; counted per workflow over the last 100 runs
- Run-level only. Per-test flakiness needs test-result artifacts, which the workflows don't upload; that's a later item.

### 11. Review Queue

- Team view of open non-draft PRs with pending review requests: for each reviewer, the number of PRs waiting on them and the oldest wait. For each PR, who it's waiting on and since when (review request time from the PR timeline when available, else PR creation).
- Highlights PRs waiting more than 2 days
- Nudging (a Teams message) is Phase 2

### 12. AI Review Summary

- On each PR row, a disclosure shows the latest top-level `claude[bot]` comment (Markdown shown as plain text, safely) and the count of its inline review comments
- Cached per PR by the latest comment's ID

### 13. Simulator Install

- The build modal gets a fifth option for iOS: **iOS MobileClock (Simulator .app)**, which triggers `run-mc-ios.yml` with `buildType='build dev .app'`. This is a dev build that uploads no store build. The value is hardcoded on the server, like `release dev`, and `sendReleaseUpdates` stays false.
- When such a run succeeds, its row shows **Install on Simulator**:
  1. Lists booted simulators (`xcrun simctl list devices booted`)
  2. Downloads the `.app build artifacts for simulator` artifact with `gh run download` into the cache folder
  3. Unzips it, runs `xcrun simctl install <udid>`, and launches the app
- If nothing is booted, say so; booting a simulator is left to the user

## Phase 2 (Later: Needs Credentials)

| Feature | Needs |
|---|---|
| Install links and QR codes for the latest Firebase (Android) and TestFlight (iOS) builds per PR | Firebase service account; App Store Connect API key |
| App Store review status and Play rollout percentage per version | App Store Connect API key; Play Console service account |
| Self-hosted runner health (online, busy, queue) | Repo admin access or an admin-issued token |
| Teams nudge from the review queue, and a morning standup digest | Teams incoming webhook URL |

The v2 design leaves room for these: config keys in `.env`, a Home card for installs, a Release section for store status, and a Team section for runners.

## Phase 3 (Later: Needs Setup)

- **Crashes by version:** top Crashlytics issues per app version, with a Create Jira ticket button. Needs Crashlytics → BigQuery export enabled by the Firebase owner, plus a service account with BigQuery read access.

## Decided by the User

- Build every brainstormed feature (phased by what each one needs)
- Jira is linked into the dashboard
- Same flow as v1: spec, reviewer check, approval, then `superpowers:writing-plans`; no commits until the user says so
- Start a Ticket does not move the ticket to In Progress
- Spec approved 2026-11-06

## Claude's Calls (Changeable)

- Phase split as above; Phase 1 is built now
- Send to QA moves the status only and never comments, because the workflows already comment
- "Release Candidate" and "Done" count as finished for mismatch alerts
- Mismatch alerts default to my PRs and tickets, with a team toggle
- Release Train is `develop`-centered because releases are cut late; "Unplanned" uses PRs merged since the last release branch's merge base
- "In Progress" counts as active work everywhere the spec lists active statuses
- The Mobile NN ↔ `release/1.NN.x` mapping comes from current naming
- Unknown failure types keep v1's retry behavior
- The simulator `.app` build is a fifth modal option, hardcoded server-side like the others (`build dev .app` is dev-only and isn't a store upload)
- TypeScript budget uses a cache worktree plus a symlinked `node_modules`, at most one automatic run a day
- Jira cache TTL 60 seconds; branch list cache 5 minutes

## Left to the Builder

- Module layout, and how views are split across files
- A one-time Jira auth check (`GET /rest/api/3/myself`) at startup that reports clearly if the token is rejected or scoped, so all Jira areas show a setup message instead of failing one by one
- Jira client error handling and rate limiting (Jira Cloud returns 429 with `Retry-After`)
- Exact regexes for retry classification, starting from the lists above
- Fetching merged PRs and branch lists efficiently through `gh`
- Merge-commit containment checks (compare API or `git branch --contains` in the cache worktree)
- How progress of long jobs (TypeScript runs, artifact downloads) reaches the page
