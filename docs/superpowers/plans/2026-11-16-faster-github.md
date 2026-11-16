# Faster GitHub Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard's GitHub reads go straight to GitHub's API, share and briefly reuse identical reads, and stop Home's duplicate and sequential work.

**Architecture:** Only the real `createGh()` changes: it recognizes the read commands callers already send (`api …`, `pr list/view --json`, `run list/view --json`) and answers them with `fetch`, mapping to the exact fields `gh` would return; everything else, and every write, still runs the CLI. A 15-second request-time cache with in-flight sharing sits in front. Home runs Jira and GitHub in parallel and stops forcing a refresh on first load.

**Tech Stack:** Node 20 `fetch`, GitHub REST v3 and GraphQL v4, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-16-faster-github-design.md`

## Global Constraints

- Zero npm dependencies
- The token comes from `gh auth token`, lives in memory only, and never appears in logs, files, errors, or any host other than `api.github.com`
- Callers and the 28 test files that fake `gh` stay unchanged
- Writes (`pr create`, `workflow run`, `run rerun/cancel/download`, `api -X PUT/POST …`) always use the CLI and clear the cache
- Direct reads are off when `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy` or `ALL_PROXY` is set
- A connection failure (DNS, TLS, refused, timeout) falls back to the CLI for that call; HTTP errors throw `GhError`
- Results match `gh` for the requested `--json` fields and order
- No commits until the user asks

## Review Focus

1. **A `--json` field the mapper doesn't produce** (a caller adds a field later): the call must fall back to the CLI, not return `undefined` (Task 1 test `unknown json fields fall back`)
2. **`conclusion` / `reviewDecision` nulls:** `gh` prints `""` where GitHub returns `null`; callers compare to strings (Task 2 tests)
3. **Token expiry mid-session:** a 401 re-reads the token once, then throws a sign-in error with no token text (Task 3 test)
4. **Two identical requests at once** share one fetch; a write in between clears the cache (Task 4 test)
5. **`fresh=1` right after a merge** shows new data, not the 15-second copy (Task 5 test)

---

### Task 1: Read-Command Parser and `--jq` Subset

**Files:**
- Create: `lib/github-direct.js` (pure parsing; later tasks add mapping and fetch)
- Test: `test/github-direct.test.js`

**Interfaces:**
- Produces: `parseRead(args: string[]) → Read | null` where `Read` is one of
  - `{ kind: 'rest', path, query: {k: v}, paginate: boolean, jq: string|null }` (from `api <path>` with optional `--paginate`, `-X GET`, `-f k=v`, `--jq f`)
  - `{ kind: 'graphql', query, variables }` (from `api graphql -f query=… -F k=v`; `-F` values that look numeric become numbers)
  - `{ kind: 'prList', state: 'open'|'merged'|'all', base: string|null, search: string|null, limit: number, fields: string[] }`
  - `{ kind: 'prView', number, fields }`
  - `{ kind: 'runList', workflow: string|null, branch: string|null, event: string|null, status: string|null, limit, fields }`
  - `{ kind: 'runView', id, fields: ['jobs'] }`
  - `null` for anything else: writes, `-X` other than GET, `--slurp`, `-u`, `--job`, `--log-failed`, `-n`, unknown flags, unknown `--json` fields, `--jq` outside the subset
- Produces: `jqSelect(value, filter) → string` printing like `gh --jq`: strings raw, numbers and booleans as text, `.[].a` one line per item, `.a // ""` defaulting. Supported filters: `.a`, `.a.b.c`, `.[].a`, `.a // "x"`.
- Known `--json` fields: PR: `number,title,url,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,createdAt,reviewRequests,latestReviews,state,mergedAt,mergeCommit,isCrossRepository`; run: `databaseId,workflowName,headBranch,headSha,event,status,conclusion,createdAt,updatedAt,url,displayTitle,attempt`; run view: `jobs`.

- [ ] **Step 1: Failing tests** — each call site's real args (copy from `lib/prs.js`, `lib/runs.js`, `lib/ghdata.js`, `lib/teams.js`, `lib/ticket-panel.js`, `lib/tickets.js`, `lib/builds.js`, `lib/release.js`, `lib/testhealth.js`, `lib/reviews.js`, `lib/pr-request.js`, `lib/settings-test.js`) parse to the expected `Read`; flags after `--json` (testhealth's `-b`) still parse; writes, `-u`, `--slurp`, `--log-failed`, and `api -X PUT` return `null`; `unknown json fields fall back` (`--json number,labels` → `null`); `jqSelect({ login: 'x' }, '.login') === 'x'`, `jqSelect([{name:'a'},{name:'b'}], '.[].name') === 'a\nb'`, `jqSelect({ name: null }, '.name // ""') === ''`, `jqSelect({ behind_by: 3 }, '.behind_by') === '3'`; the time-tracking filters (`[.head.ref, .title] | @tsv`, the reviews `myReviews` expression) return `null` from `parseRead`.
- [ ] **Step 2: Run** `node --test test/github-direct.test.js` → FAIL (module not found)
- [ ] **Step 3: Implement** `parseRead` and `jqSelect`
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Ledger** (no commit)

---

### Task 2: Map GitHub Responses to `gh` Shapes

**Files:**
- Modify: `lib/github-direct.js`
- Test: `test/github-direct.test.js`

**Interfaces:**
- Produces: `prQuery(read) → { query, variables }` and `mapPrs(read, data) → object[]` / `mapPr(read, data) → object`; `runRequest(read) → { path, query }` and `mapRuns(read, json) → object[]`; `mapJobs(json) → { jobs }`. Each output object has exactly `read.fields`.
- Mapping rules (from `gh` 2.x output):
  - PR `author` → `{ login }`; `reviewDecision` null → `""`; `state` `OPEN|MERGED|CLOSED`; `mergeCommit` → `{ oid }` or `null`; `mergedAt` null stays `null`
  - `reviewRequests` → `[{ login }]` for users, `[{ name, slug }]` for teams
  - `latestReviews` → `[{ author: { login }, state, submittedAt, body }]`
  - `statusCheckRollup` → last commit's rollup contexts: CheckRun `{ __typename: 'CheckRun', name, status, conclusion }` (conclusion `""` when null), StatusContext `{ __typename: 'StatusContext', context, state }`; no commit → `[]`
  - Lists: open PRs from `repository.pullRequests(states: OPEN, orderBy: {field: CREATED_AT, direction: DESC})`; `merged`/`all` with `--search` from `search(type: ISSUE, query: "repo:<REPO> is:pr <is:merged> <base:…> <search>")`, newest created first; follow cursors up to `limit`
  - Runs: `databaseId`←`id`, `workflowName`←`name`, `headBranch`←`head_branch`, `headSha`←`head_sha`, `event`, `status`, `conclusion` null → `""`, `createdAt`←`created_at`, `updatedAt`←`updated_at`, `url`←`html_url`, `displayTitle`←`display_title`, `attempt`←`run_attempt`; path `actions/workflows/<file>/runs` with `-w`, else `actions/runs`; `branch`, `event`, `status`, `per_page` from flags
  - Jobs: `{ databaseId: id, name, status, conclusion: c ?? '', steps: [{ name, status, conclusion: c ?? '', number }] }`

- [ ] **Step 1: Failing tests** — sample GraphQL and REST payloads (hand-written, a few PRs/runs) map to the exact `gh` shapes above, including the null → `""` cases, team review requests, a PR with no commits, and list order.
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** the query builders and mappers
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Ledger**

---

### Task 3: Direct Client (Token, Fetch, Errors)

**Files:**
- Modify: `lib/github-direct.js`
- Test: `test/github-direct.test.js`

**Interfaces:**
- Produces: `createDirect({ fetch, readToken: () => Promise<string>, timeoutMs = 20000 }) → { read(read: Read) → Promise<{ text: string, json: any }> }`
- `NetworkError` (exported class) for connection failures and timeouts; HTTP failures throw `GhError` (from `lib/gh.js`) with `gh`-like messages: 404 `HTTP 404: Not Found (<path>)`, 401 after one token re-read `gh isn't signed in. Run gh auth login.`, others `HTTP <status>: <GitHub message>`. Messages never contain the token or headers.
- Requests go only to `https://api.github.com`, with `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `User-Agent: mobile-clock-dashboard`, `X-GitHub-Api-Version: 2022-11-28`. REST `paginate` follows `Link: rel="next"`.
- `text` is what `gh` would print: `jqSelect` output when `jq` is set, else `JSON.stringify(json)`.

- [ ] **Step 1: Failing tests** with a fake `fetch`: headers and host; pagination concatenates pages; 401 re-reads the token once and retries; second 401 throws the sign-in message; a thrown `TypeError('fetch failed')` and an abort become `NetworkError`; no error message contains the fake token `ghp_secret123`.
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** `createDirect` (AbortController timeout)
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Ledger**

---

### Task 4: Wire Into `createGh` (Cache, In-Flight, Fallbacks)

**Files:**
- Modify: `lib/gh.js`
- Test: `test/gh.test.js`

**Interfaces:**
- Consumes: `parseRead`, `createDirect`, `NetworkError`
- Produces: `createGh(exec = defaultExec, { fetch = globalThis.fetch, env = process.env, now = Date.now } = {}) → { run(args), json(args), clearCache() }`
- `readToken` runs `exec('gh', ['auth', 'token'])` once and caches the trimmed stdout in a closure; re-read on demand from `createDirect`.
- For `run`/`json`: if `parseRead(args)` is null, or a proxy variable is set, or a previous `NetworkError` happened in the last 60 s → CLI. Else direct; on `NetworkError` → CLI for this call. `json` returns parsed JSON, `run` returns text.
- Cache: key `JSON.stringify(args)`, 15 s, reads only; in-flight promises shared; any CLI call that isn't a read clears the cache; `clearCache()` clears it. Errors aren't cached.

- [ ] **Step 1: Failing tests** with fake `exec` (records calls; answers `auth token`) and fake `fetch`: a mapped read never calls `exec` beyond `auth token`; a write calls `exec` and clears the cache; two identical reads at once make one fetch; a repeat within 15 s makes none and after 15 s makes one (fake `now`); `HTTPS_PROXY` set → CLI; a `NetworkError` → CLI result returned; an unmapped read (`--slurp`) → CLI; `clearCache()` forces a new fetch. The existing `test/gh.test.js` cases still pass.
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** full suite `DASHBOARD_DATA_DIR=$(mktemp -d) TIME_REMINDER=off npm test` → all pass
- [ ] **Step 5: Ledger**

---

### Task 5: Home in Parallel; Refresh Clears the Cache

**Files:**
- Modify: `lib/home/sources.js` (Jira search starts with GitHub), `lib/home/routes.js` (`fresh=1` → `ctx.gh.clearCache?.()`), `lib/settings-test.js` (GitHub test → `ctx.gh.clearCache?.()` first), `public/views/home.js` (first load uses cached `/api/home`; Refresh/pull-to-refresh pass `fresh=1`)
- Test: `test/home-routes.test.js`, `test/settings-connection.test.js`

- [ ] **Step 1: Failing tests** — `fresh=1 clears the GitHub cache` (fake gh with a `clearCache` spy: called on `?fresh=1`, not on a plain load); `home starts Jira and GitHub together` (fake gh and Jira that each wait 200 ms: `/api/home` finishes in under 350 ms); the GitHub connection test calls `clearCache`.
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** — in `loadHomeSources`, start `jira.search(MY_WORK_JQL…)` before awaiting GitHub, then add PR-only tickets after both settle
- [ ] **Step 4: Run** full suite → all pass
- [ ] **Step 5: Ledger**

---

### Task 6: Prove It Matches and Measure

**Files:**
- Create (scratchpad, not committed): `compare-gh.mjs`
- Modify: `README.md` (one paragraph: reads go direct, actions use `gh`, proxy falls back)

- [ ] **Step 1:** Script runs each mapped read from Task 1's list both through the CLI and direct against the real repo (read-only), then diffs the JSON: same fields, same values, same order. Prints one line per command, never the token.
- [ ] **Step 2:** Fix any difference with a failing unit test first (Task 2 style), until the script reports no differences, or a difference is ruled harmless and ledgered.
- [ ] **Step 3:** Restart the service; time the same endpoints as the baseline (`/api/home?fresh=1`, `/api/home`, `/api/prs`, `/api/runs`, `/api/status`, `/api/alerts`), twice each.
- [ ] **Step 4:** Full suite → all pass; ledger the before/after table.
