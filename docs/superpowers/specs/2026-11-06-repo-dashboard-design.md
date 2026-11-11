# Mobile Clock Repo Dashboard Design

Date: 2026-11-06
Target repo: `tcp-software/mobile-clock`

## Intent

PR and Actions work for Mobile Clock is spread across many GitHub pages. Monitoring PRs, finding the right command, and triggering builds means jumping between tabs. This dashboard puts that work on one local page.

The first user is one developer. The team may use it later, so nothing should be tied to one person's machine beyond the `gh` login.

## Goals

- See open PRs, review state, checks, and staleness in one list
- Trigger any mix of the 4 standard builds for an approved PR in one action
- Watch Actions runs live and rerun or cancel them without opening GitHub
- See repo-wide health (nightly, `develop` tests, SAST) at a glance
- Get notified when builds finish, so the tab doesn't need watching

## Non-Goals (v1)

- Hosting, auth, or multi-user features
- Jira integration (branch-to-ticket view)
- Installing builds to simulators
- Release notes, review analytics, Detox launcher, saved command palette
- AI PR Review output panel
- `release prod` builds and QA/InfoSec release notifications (a future `release/*` branch build entry point)
- Mend SAST badge (latest runs are year-old failures; revisit when the workflow is fixed)
- Any change to the `mobile-clock` repo or its workflows

## Anti-Goals

- Triggering a build the user didn't explicitly confirm, or with inputs they didn't see
- Ever triggering a `release prod` build or sending `sendReleaseUpdates: true` from the dashboard
- Needing secrets or tokens beyond the user's existing `gh auth` session
- Heavy setup: it should start with one command

## Constraints

- Runs locally on macOS, served on `localhost`
- All GitHub access goes through the `gh` CLI (v2.103.3 installed), using the user's existing login
- Node 20 (installed); keep dependencies minimal
- Lives in its own repo: `~/Downloads/GitHub/mobile-clock-dashboard`

## Decided by the User

- Local-only for now, shareable with the team later
- Separate repo, not inside `mobile-clock`
- Each approved PR has a **Build** button that opens a **modal** (chosen over an inline panel from a mockup)
- The modal lists all 4 builds as checkboxes, all checked by default; any can be deselected:
  - Android MobileClock (`run-mc-android.yml`)
  - Android Mobile Kiosk (`run-mk-android.yml`)
  - iOS MobileClock (`run-mc-ios.yml`)
  - iOS MobileKiosk (`run-mk-ios.yml`)
- v1 scope: PR list with build modal, Actions monitor, status strip, desktop notifications, and behind-`develop` indicator
- Modal triggers dev builds only; no prod option and no QA/InfoSec notify
- Mend SAST badge left out of v1

## Features

### 1. PR List

- All open PRs: number, title, author, branch, draft flag, review decision, combined check state
- Filters: mine, review requested from me, all
- Stale flag: approved but unmerged for more than 7 days, or open more than 14 days (thresholds are constants)
- Behind-base indicator: commit count behind the PR's base branch, usually `develop` (via the compare API), with a **Merge base in** button that confirms first, then updates the branch (`gh api` PR update-branch endpoint, merge method)
- **Build** button shown only on approved PRs

### 2. Build Modal

- Header: PR number, title, full branch name
- 4 checkboxes as above, all checked
- **Dev builds only (user decision):** no build type dropdown and no notify checkbox. `release prod` signs and uploads to App Store Connect or Firebase prod and belongs on `release/*` branches, not PRs. The notify step only fires on prod and reads the version from a `release/x.y` branch name, so it would send a blank version from a PR branch.
- Primary button label shows the count ("Trigger 3 builds"); disabled when none are checked
- On confirm, runs `gh workflow run <file> --ref <branch> -f buildType='release dev' -f sendReleaseUpdates=false` once per selected build. These values are hardcoded on the server, not taken from the browser, so a crafted request can't trigger a prod build.
- After triggering, the PR row shows each build's status (queued, running, success, failure) with a link to its run

### 3. Actions Monitor

- Recent runs across all workflows: workflow name, branch, event, status, conclusion, age, duration
- Filters: workflow, branch, mine only
- Actions per run: open logs on GitHub, **Rerun failed jobs**, **Cancel** (confirm on cancel)
- Polls in the background; in-progress runs refresh more often than finished ones

### 4. Status Strip

A top bar with two green, red, or grey badges, each linking to its latest run:

- iOS MC nightly sanity build (`run-ios-mc-nightly.yml`)
- Unit tests on `develop` (`run-tests.yml`)

Grey means no run found or still running.

### 5. Desktop Notifications

- Browser Notification API (works on `localhost`); permission is requested once
- Notifies when a build triggered from the dashboard finishes, with success or failure, and when a status strip badge turns red
- Clicking a notification opens the run on GitHub

## Builder Calls

These were settled by Claude, not the user, and can be changed:

- **Stack:** a small Node server that shells out to `gh` and serves one static HTML page with plain JS. No framework or build step unless the plan finds a clear need.
- **Start command:** `npm start`, which opens `http://localhost:<port>`
- **Repo setting:** `tcp-software/mobile-clock` is one config value, so pointing at another repo is a one-line change
- **Polling:** about 15 seconds while runs are active and about 60 seconds when idle; respect `gh` rate limits
- **Server bind:** `127.0.0.1` only, because the server can trigger workflows
- **"Approved":** means `reviewDecision == APPROVED`; an empty review decision doesn't count
- **Behind indicator base:** compares against the PR's own base branch, not always `develop`, because some PRs target `epic/*` branches and the update-branch endpoint merges the PR base

## Left to the Builder

- Matching a triggered build to its run ID. `gh workflow run` may not return one, so match on workflow, branch, `workflow_dispatch` event, and created-after-trigger time.
- Page layout, styling, and empty, loading, and error states
- How dashboard-triggered builds are remembered across reloads (in memory or a small local JSON file is fine)
- Test approach for the server's `gh` wrapper

## Noticed During Research

`Mend-CLI-SAST.yml` filters on the branch `release/`, yet its recent runs come from `develop` and feature branches, and all of them since October 2025 have failed. This is out of scope here and is noted for whoever owns that workflow.
