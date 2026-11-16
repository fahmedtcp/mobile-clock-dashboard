# Faster Dashboard: Direct GitHub Reads, No Duplicate Calls

Date: 2026-11-16
Builds on: `main` at 494a860

## Intent

The dashboard feels slow. Measured on the user's running copy:

| Request | Time |
|---|---|
| Home, full refresh | 3.3–6.5 s |
| `/api/prs` | 2.8 s every time (no cache) |
| `/api/alerts` | 2.9–3.7 s |
| `/api/runs` | 2.2–2.6 s |
| `/api/status` | 1.5 s |

Three causes:

1. **Every GitHub read starts the `gh` CLI.** That's about 0.75 s before any work; the same small call made directly takes about 0.45 s.
2. **The same calls repeat.** Home and the PR list each fetch the open PRs (about 2.5 s each), and Home's first load always forces a full refresh past its 30-second cache.
3. **Home runs its sources one after another.** GitHub finishes before Jira starts.

## Goals

- Reads talk to GitHub's REST and GraphQL APIs directly, with a token obtained from `gh auth token`.
- Each distinct GitHub read happens once per moment: concurrent requests share one in-flight call, and a short request-time cache (no background refresh) serves repeats.
- Home starts Jira and GitHub work at the same time.
- Opening Home uses the server's 30-second cache; Refresh still forces a rebuild.

Target: Home about 2 s cold and instant when reopened within 30 s; a poll cycle about 3 s of GitHub time instead of about 7 s.

## Non-Goals

- **Background loading.** The user ruled it out: nothing fetches unless a request asks.
- **Rewriting actions.** Creating PRs, starting workflows, rerun, cancel, update-branch, branch creation, and artifact downloads keep using `gh`. They're rare clicks and the riskiest to change.
- Changing what any page shows.

## Anti-Goals

- **Leaking the token.** It lives in memory only: never logged, never written to disk, never sent anywhere but `api.github.com`, never in an error message.
- **Different data.** Direct reads must return the same shapes the callers get from `gh` today; a page that renders differently is a bug.
- **New setup for teammates.** Anyone whose `gh` is signed in today keeps working with no new settings.

## Constraints

- Zero npm dependencies; Node 20 `fetch`.
- The 28 test files that fake `gh` keep working unchanged.
- No commits until the user asks.

## Approaches

| Approach | Trade-off | Picked |
|---|---|---|
| **A. Direct reads, `gh` for actions** | Most of the speed; actions untouched | **Yes** |
| B. Direct for everything | No extra speed (actions are rare), more risk on PR creation and builds | No |
| C. Keep `gh`; only dedupe and parallelize | Smallest change, about half the gain | No |

The user picked A.

## Design (Claude's Calls)

**Where the change lives.** Inside the real `createGh()` in `lib/gh.js`, not at the 36 call sites. `gh.json(args)` and `gh.run(args)` recognize the read commands below and answer them directly; anything else, and every write, still runs the CLI. Callers and test fakes don't change.

**Reads served directly** (each returns what the CLI returns for the same arguments):

| CLI call today | Direct call |
|---|---|
| `api <path>` (GET, optional `--paginate`, `-X GET -f k=v`) | REST GET, following `Link` pages when `--paginate` |
| `api <path> --jq <filter>` for simple filters (`.a.b`, `.[].a`, `.a // ""`) | REST GET + the same selection in JS |
| `api graphql -f query=… -F k=v` | GraphQL POST |
| `pr list … --json <fields>` (open, merged with `--search`, `--state all --search`) | GraphQL search/pullRequests, mapped to gh's field names |
| `pr view <n> --json <fields>` | GraphQL `pullRequest(number:)` |
| `run list … --json <fields>` (with `-w`, `-b`, `-e`, `-s`, `-L`) | REST `actions/runs` (or `workflows/<file>/runs`), mapped to gh's field names |
| `run view <id> --json jobs` | REST `actions/runs/<id>/jobs` |

Anything with a filter or flag the mapper doesn't know (for example the two complex `--jq` expressions in time tracking) falls back to the CLI, so correctness never depends on full coverage.

**Token.** Read once with `gh auth token`, kept in memory, read again once if GitHub answers 401. If `gh` isn't signed in, the existing "sign in to GitHub" errors still appear.

**Errors.** Direct failures throw the same `GhError` type with a message like the CLI's, without the token or request headers.

**Shared in-flight calls and a short cache.** In `createGh`, identical read arguments made while one is in flight share that promise. Results are kept for 15 seconds (request-time only, no timers). Writes clear the cache. Callers that already cache (behind counts, branches, tickets) keep their own caches.

**Home.** `loadHomeSources` starts the Jira search at the same time as the GitHub work. Tickets that only come from PR branches are fetched after both finish. The page's first load uses the normal cached `/api/home`; Refresh and pull-to-refresh still pass `fresh=1`.

**Proof the shapes match.** A one-off script (not in the test suite) runs each mapped read both ways against the real repo, read-only, and diffs the JSON. The user sees its output before merge.

## Left to the Builder

- The GraphQL queries and field mapping for each `pr` and `run` shape
- How the 15-second cache keys arguments
- Request timeouts (about 20 s, like the CLI)

## Claude's Calls After the Builder Check

- **Connection failures fall back to `gh`.** A direct read that can't connect (DNS, TLS, timeout, refused) retries that one call through the CLI. HTTP answers (401 after one token re-read, 403, 404, 5xx) throw `GhError` as the CLI would. If `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY` or `ALL_PROXY` is set, direct reads are off entirely and everything uses `gh`, because Node's `fetch` ignores proxies.
- **Refresh bypasses the 15-second cache.** `createGh` exposes `clearCache()`. It's called by `/api/home?fresh=1`, by Settings' GitHub connection test, and by every write that runs through `gh` (so a build, rerun, update-branch, or PR creation is visible right away).
- **"Same shapes" means the fields each call asks for.** `gh … --json <fields>` already returns only those fields, so the direct mapping returns exactly the requested top-level fields, with nested objects carrying at least the fields any caller reads (`author.login`, `reviewRequests[].login`/`name`, `latestReviews[].state/submittedAt/body/author.login`, `statusCheckRollup[].name/context/conclusion/state/status`, `mergeCommit.oid`). Order matches the CLI: `pr list` newest first by creation; `run list` newest first. The comparison script reports any difference in those fields or order, and Claude runs it against the real repo, read-only, with the user's signed-in `gh`, before asking to merge.
- **Tests never reach the network.** `createGh` takes an injectable `fetch` and token reader; unit tests cover the command mapping, fallbacks, cache, and token handling with fakes.
- **Not mapped (fall back to `gh` as designed):** `run list -u <user>` and `api --paginate --slurp`.
