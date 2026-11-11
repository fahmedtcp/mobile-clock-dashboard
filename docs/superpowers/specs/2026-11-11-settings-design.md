# Settings and Theme Design

Date: 2026-11-11
Builds on: the dashboard as it stands today (v2, time tracking, Tempo sync, Teams review requests)

## Intent

The user wants to share the dashboard with the mobile team. Today every key and preference lives in the user's own `.env`, which teammates can't, and shouldn't, copy. Each teammate will clone the repo and run it on their own Mac, so each needs a way to enter their own keys and preferences from inside the dashboard.

The user also wants light mode as the default for the whole dashboard, with a toggle.

## Goals

- A **Settings** view where each person enters their own connections and preferences, with no `.env` editing
- Keys stay on that person's Mac and are never shown again after saving
- Light mode as the default across the whole dashboard (every view, sheet, toast, and banner), with Dark and System options
- A teammate can go from `git clone` and `npm start` to a working dashboard using only the Settings page
- The user's current `.env` setup keeps working with no changes

## Non-Goals

- A shared or hosted instance, user accounts, or sign-in (each person runs their own copy, decided by the user)
- Syncing settings between machines
- Managing GitHub credentials: GitHub stays on each person's `gh` CLI login

## Anti-Goals

- A saved key showing up in the browser, a response, a log line, an error, or anything under git
- A Settings change that silently needs a restart to work
- A teammate's dashboard tagging people or using defaults that only make sense for the user
- A flash of the wrong theme on page load

## Decided by the User

- **Sharing model:** each teammate clones the repo and runs it locally, "for now"
- **Layout:** option A, one scrolling page grouped like iPhone Settings (picked from a mockup over a side-navigation layout)
- **Theme:** Light is the default, and the toggle lives in Settings. It applies to the whole dashboard, not only the Settings screen.
- **Settings to include:** Claude's proposal, accepted as played back:
  - **Connections:**
    - GitHub: read-only status from `gh`
    - Jira: base URL, email, and token
    - Tempo: token
    - Teams: review channel webhook and test chat webhook
  - **Appearance:** Theme (Light, Dark, System)
  - **Time Tracking:** workday hours, evening reminder on or off plus its time, and the `mobile-clock` folder path
  - **Review Requests:** Always tag and Never tag (GitHub logins), plus email overrides for people whose Jira email is hidden (today's `TEAMS_PEOPLE`)
  - **Builds and Notifications:** which of the 4 store builds are checked by default in the Build sheet (the simulator build stays off by default and isn't listed), and browser build notifications on or off. The evening reminder has its own toggle under Time Tracking.
- **Behavior:** as played back and approved:
  - **Masking:** keys are shown only as their last 4 characters, with Replace and Remove buttons
  - **`.env` fallback:** `.env` keeps working, and Settings values take priority
  - **No restart:** changes apply right away
  - **Test Connection:** each connection has a button, and none of them write anything
  - **First run:** a Home banner links to Settings when Jira isn't set up
  - **Shortcut:** `,` opens Settings, and the Settings entry sits at the bottom of the sidebar
  - **Teammate defaults:** Always tag and Never tag start empty. The other defaults match today's values.

## Claude's Calls (After the Builder Check)

- **Workday hours (decided by the user after the builder check):** a setting with **no default**.
  - **Until it's set:** the Time view shows "Set your workday hours to start" with a link to Settings. No suggestions, Time badge, reminder, or Tempo send runs.
  - **Allowed values:** 4–10 in 0.5h steps
  - **Each day keeps its own target.** A saved day record stores `dayHours`, the workday length in effect when it was first saved, and every reader uses the day's own value. Readers include confirm validation, month build, Tempo leave math, pending, the reminder, sends, and the page's rebalancing. Changing the setting affects only days without a saved record from then on.
  - **Days saved before this change** have no `dayHours` and count as 7. Tempo days with no local record use the current setting.
  - **Existing user migration:** if `dayHours` is unset and `data/time/confirmed.json` already has records, it's set to 7 on first start, so the user's setup doesn't change. Teammates start unset.
- **Test Connection tests what's typed in the row.** Typed fields are merged with saved ones, for example a new token with the saved email and base URL. Testing a new token never replaces a working one. The test route takes candidate values, applies the same validation as a save, never stores them, and never echoes them back.
- **Tempo test without Jira:** it shows "Connect Jira first. Tempo uses your Jira account to find your worklogs." Saving a Jira change also clears the cached Jira account ID.
- **Rebuild on save also covers:** the TypeScript budget job (it uses the clone path) and the cached Jira account ID

## Storage

- `data/settings.json`, which is already gitignored because `data/` is, written atomically (tmp file plus rename) with file mode `0600`
- One file holds secrets and preferences. Secret fields are `jira.token`, `tempo.token`, `teams.webhookUrl`, and `teams.testWebhookUrl`. Teams webhook URLs count as secrets because the URL itself grants posting rights.
- **Precedence per field:** Settings value, then `.env` value, then the built-in default. "Remove" clears the Settings value, so `.env` or the default applies again, and the page says which one is in effect, for example "From .env".

## Secrets Handling

- `GET` of settings returns secret fields only as `{ set: true, last4: '7Q2a', source: 'settings' | 'env' }`, never the value. Webhook URLs show their host and the last 4 characters.
- A secret is written only by an explicit Replace (`PUT` with the new value) and cleared only by Remove
- **Validation on save:**
  - **Jira base URL:** must be `https://*.atlassian.net`
  - **Teams webhooks:** use the existing host allowlist (`validWebhookUrl`)
  - **Tokens:** non-empty, at most 500 characters, and no whitespace inside
- Errors and logs never include secret values
- All settings routes use the existing protections: `127.0.0.1` only, Host check, and `X-Dashboard` on writes

## Applying Changes Without Restart

Every place that reads `.env`-backed config today reads it once at startup:
- `JIRA` and `TEMPO` in `config.js`
- `MOBILE_CLOCK_PATH`
- `TIME_REMINDER`
- `process.env.TEAMS_*` in `lib/teams.js`

Those reads become reads of a settings object, and the clients built from them are rebuilt on save:
- `ctx.jira`
- `ctx.tempo`
- `ctx.teams`
- `ctx.teamsTest`
- `ctx.teamsPrefs`
- the reminder schedule
- the ticket cache

Month caches that depend on Jira, Tempo, or the clone path are cleared on save.

## Test Connection (Read-Only)

| Connection | Check | Shows |
|---|---|---|
| GitHub | `gh auth status` and `gh api user` | "Signed in as <login>", or how to run `gh auth login` |
| Jira | `GET /rest/api/3/myself` | "Connected as <name>" or Jira's error |
| Tempo | Read the current user's worklogs for today | "Connected" or the error |
| Teams | Validates the address format and host only. Never posts. | "Looks right." For a real check, use test mode in Request Review. |

## Theme

- **Values:** `light` (default), `dark`, and `system`
- **Where it's kept:** in Settings on the server, and mirrored to `localStorage`. A tiny inline script in `index.html` reads `localStorage` and sets `data-theme` on `<html>` before any CSS paints, so there's no flash. If the saved value is missing, it uses `light`.
- **CSS:** light tokens on `:root`. Dark tokens move from the `prefers-color-scheme: dark` block to `[data-theme="dark"]`, plus `[data-theme="system"]` inside the `prefers-color-scheme: dark` media query. The reduced-transparency and increased-contrast rules keep working in both themes.
- **Everywhere:** every view, dialog, toast, banner, and the Teams preview card follow the theme. `color-scheme` is set so native controls (selects, scrollbars, date inputs) match.

## The Settings View

- A sixth view, **Settings**, in the sidebar's bottom area (not counted in the 1–5 shortcuts), opened with `,` or `#settings`
- **Layout A:** grouped sections with rows like iPhone Settings, each section a rounded group:
  - Connections
  - Appearance
  - Time Tracking
  - Review Requests
  - Builds and Notifications
- **Connection rows:**
  - **Collapsed:** service name, one status line ("Connected as …", "Not set up", or "From .env"), and a status pill
  - **Edit:** opens the row's fields inline. Secret fields show `••••7Q2a` with Replace and Remove. Each row has Save and Test Connection.
- **Preference rows** save on change, the way the iPhone Settings app does, with a short "Saved" confirmation
- A subtitle under the page title: "Saved on this Mac only. Keys go only to the service they belong to."
- **Reminder time:** a time input. Off disables it.
- **Clone path:** a text field, checked on save to be an existing folder that contains `.git`

## First Run

When Jira has no email or token, from either Settings or `.env`, Home shows a banner: "Connect Jira to see tickets, releases, and time. Open Settings." GitHub-only features keep working, as they do today.

## Constraints

- All earlier constraints hold: Node 20, no npm dependencies, `127.0.0.1` only, `textContent` only, `execFile` with no shell, and no commits unless the user says so
- **Tests** never read the real `.env` or the real `data/settings.json`. They use `DASHBOARD_DATA_DIR` set to a temp dir, as today.
- **Copy** follows the org style: AP Style, title-case headings, contractions, and no first person
- **Apple-style design:** follow the `/apple-design` guidance already used here, including reduced motion and contrast support

## Left to the Builder

- Module layout (for example `lib/settings.js` plus `public/views/settings.js`) and route shapes
- How the settings object is threaded through `ctx` and rebuilt on save
- Exact wording of status lines beyond what's given here
- Whether `config.js` constants become getters or the readers move to the settings object
