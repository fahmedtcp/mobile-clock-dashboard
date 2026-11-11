# Tempo Sync Design

Date: 2026-11-11
Builds on: time tracking (`2026-11-10-time-tracking-design.md`), implemented and working

## Intent

The Time view suggests hours, but the user still types them into Tempo with a hand-edited Python script. Older months are already logged in Tempo, so the dashboard's suggestions for those months are noise. Tempo is the source of truth.

The Time view should load what Tempo already has, fill only the gaps with suggestions, and send the gaps to Tempo with one button, without ever risking a double log.

## Goals

- Show Tempo's worklogs for every day that has them, instead of suggestions
- Send a day, or a whole month, to Tempo with one button and a preview
- Never double log, never change or delete anything already in Tempo
- Flag days where the user's edits differ from Tempo, so they fix them in Tempo by hand

## Non-Goals

- Updating or deleting Tempo worklogs
- Logging leave to Tempo
- Logging time for anyone but the current user

## Anti-Goals

- A day logged twice in Tempo, from a stale page, a double click, or a second tab
- Any Tempo write without a preview and a confirm
- The Tempo token reaching the browser, logs, or any file other than `.env`

## Decided by the User

- **Tempo first:** each month starts by loading Tempo. Days with any Tempo worklog show Tempo's hours.
- **Editable:** the user can still edit any day, including days already in Tempo.
- **Send per day and per month:** each day has its own **Send to Tempo** button, and Month view has **Send Month**.
- **Existing Tempo days are never sent:** if a day has any worklog in Tempo, the dashboard doesn't send it. It flags the day and tells the user to change it in Tempo by hand, because sending could double log.

- **Only TCPMOB in Tempo:** the user logs nothing else in Tempo: no leave, meetings, or internal issues. Any non-TCPMOB worklog that still shows up is displayed read-only, with its key and exact hours, and counts toward the day's total.

## Edits on Days Already in Tempo (Claude's Call)

- On a day with any Tempo worklog, Tempo's hours replace anything the dashboard stored for that day earlier, including confirmed records from before this feature. Old records aren't compared, so already-logged months show no flags.
- Edits the user makes on top of Tempo's hours are stored separately from confirmed days, for example `tempoEdits: { 'YYYY-MM-DD': [{ key, hours }] }`. The flag compares these edits with Tempo's current hours. When Tempo later matches them (the user fixed it by hand), the edit record is dropped.
- These edits are notes, not sends: the 7h rule and Confirm don't apply. Hours keep 0.5h steps, but Tempo hours that aren't 0.5h steps (for example 2.33h) are shown and kept exactly as Tempo has them until the user changes them.

## Accepted Defaults (Claude's Calls, Approved by the User)

These match the user's current script:
- **Description:** the ticket's Jira status on that day, such as "In Progress" or "Dev Review." Use the status the ticket was in at the end of that workday, from the changelog the time feature already reads.
- **Start time:** `09:00:00`
- **Leave:** not sent. On a Tempo day with less than 7h logged, the missing hours show as leave. On a day with more than 7h, the total shows as is.
- **Setup:** `TEMPO_TOKEN` in `.env`. The Tempo account ID is the Jira `myself` account ID.

## Tempo API (v4, `https://api.tempo.io/4`)

- **Read:** `GET /worklogs/user/{accountId}?from=YYYY-MM-DD&to=YYYY-MM-DD`, paged (`limit`, `offset`, `metadata.next`). Worklogs carry `issue.id` but no key, so the dashboard maps issue IDs to keys with a Jira search (`id in (…)`).
- **Write:** `POST /worklogs` with `{ issueId, timeSpentSeconds, startDate, startTime, authorAccountId, description }`. Jira issue IDs come from the Jira search the time feature already does.
- **Auth:** `Authorization: Bearer <TEMPO_TOKEN>`

## Day States

| State | Meaning | Send? |
|---|---|---|
| In Tempo | Tempo has at least one worklog for the day | Never |
| In Tempo, edited | As above, and the user's hours differ | Never. Flag: "Tempo has TCPMOB-1521 3.5h. You changed it to 5h. Update it in Tempo by hand." One line per ticket that differs. |
| Confirmed | Nothing in Tempo, confirmed in the dashboard | Yes |
| Needs Review, No Data, Leave, Future | As today | No (Confirm first). A full leave day has nothing to send. |

A sent day becomes In Tempo after the reload. Its local record stays, but Tempo's data wins on display.

## Sending

**Preview:** a sheet listing each day and its worklogs (`date · key · hours · description`), the total hours, and the days that will be skipped and why. The confirm button reads **Send N Worklogs**.

**Per day:** a **Send to Tempo** button on a Confirmed day with nothing in Tempo.

**Send Month:** in Month mode, sends every past or current Confirmed day in the month that has nothing in Tempo. At the end, a summary lists sent days, failed days with Tempo's error, and **Fix in Tempo** days (In Tempo, edited).

**Double-log guards (all required):**
- Immediately before posting a day, the server fetches that day from Tempo again. If any worklog exists, it skips the whole day and reports it as "Already in Tempo."
- The server never sends the same day twice at once (a per-day lock), and the button disables while sending.
- A day sends all of its worklogs or reports which ones failed. Failed worklogs aren't retried automatically. After a partial failure, the day shows as In Tempo (it now has some worklogs), with the flag listing what's missing so the user finishes it by hand.
- Days send one after another, not in parallel.

**After sending:** the month reloads from Tempo.

## Server and Security

- All Tempo calls run on the server. The token never goes to the browser.
- Send routes follow the existing write rules: `X-Dashboard` header, Host check, and validation on the server. The server builds every worklog from its own stored confirmed day, never from worklog data sent by the browser. The browser sends only the date or month.
- Only dates up to today, and only Confirmed days, can be sent.
- Tempo reads are cached per month for a short time, and the pre-send check always bypasses the cache.
- Without `TEMPO_TOKEN`, the Time view works as it does today, and the send buttons are replaced by a short setup note.

## Constraints

- All earlier constraints hold: Node 20, no npm dependencies, `127.0.0.1` only, `textContent` only, no commits unless the user says so
- Tests must never call the real Tempo API. Use fakes, as with Teams and Jira.
- No Jira writes for this feature

## Left to the Builder

- Module layout (for example `lib/time/tempo.js`) and route names
- Cache length for Tempo reads
- How the In Tempo state and the edited flag look, within the existing design system
- Whether Copy Day and Export stay as they are (they should keep working)
