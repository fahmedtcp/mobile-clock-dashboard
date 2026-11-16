// Direct GitHub reads for the commands the dashboard already sends to the gh CLI.
// parseRead() recognizes a read and describes it; anything it doesn't fully understand returns null and stays on the CLI.
import { REPO } from '../public/shared.js';
import { GhError } from './gh.js';

const PR_FIELDS = new Set(['number', 'title', 'url', 'author', 'headRefName', 'baseRefName', 'isDraft', 'reviewDecision',
  'statusCheckRollup', 'createdAt', 'reviewRequests', 'latestReviews', 'state', 'mergedAt', 'mergeCommit', 'isCrossRepository']);
const RUN_FIELDS = new Set(['databaseId', 'workflowName', 'headBranch', 'headSha', 'event', 'status', 'conclusion',
  'createdAt', 'updatedAt', 'url', 'displayTitle', 'attempt']);
const SIMPLE_JQ = /^(\.\[\])?(\.[A-Za-z_][\w]*)+( \/\/ "[^"]*")?$/;

// Reads "--flag value" pairs anywhere after the subcommand. Returns null on any flag not in `allowed`.
function flags(rest, allowed, booleans = []) {
  const out = { positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (booleans.includes(arg)) { out[arg] = true; continue; }
    if (arg.startsWith('-')) {
      if (!allowed.includes(arg) || i + 1 >= rest.length) return null;
      const value = rest[++i];
      if (arg === '-f' || arg === '-F') (out[arg] ??= []).push(value); else out[arg] = value;
      continue;
    }
    out.positional.push(arg);
  }
  return out;
}

const fieldList = (raw, known) => {
  const fields = String(raw ?? '').split(',').filter(Boolean);
  return fields.length && fields.every((f) => known.has(f)) ? fields : null;
};
const limitOf = (raw, fallback) => (raw === undefined ? fallback : Number(raw));
const pairs = (list = []) => list.map((kv) => { const i = kv.indexOf('='); return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] : null; });

function parseApi(rest) {
  const f = flags(rest, ['-X', '-f', '-F', '--jq'], ['--paginate']);
  if (!f || f.positional.length !== 1) return null;
  const [path] = f.positional;
  if (path === 'graphql') {
    if (f['-X'] || f['--jq'] || f['--paginate']) return null;
    const entries = pairs(f['-f']);
    const typed = pairs(f['-F']);
    if (entries.includes(null) || typed.includes(null)) return null;
    const query = entries.find(([k]) => k === 'query')?.[1];
    if (!query || entries.length !== 1) return null;
    const variables = Object.fromEntries(typed.map(([k, v]) => [k, /^-?\d+$/.test(v) ? Number(v) : v]));
    return { kind: 'graphql', query, variables };
  }
  const method = f['-X'] ?? 'GET';
  if (method !== 'GET' || f['-F']) return null;
  if (f['-f'] && !f['-X']) return null; // gh turns -f into a POST unless -X GET says otherwise
  const query = pairs(f['-f']);
  if (query.includes(null)) return null;
  const jq = f['--jq'] ?? null;
  if (jq !== null && !SIMPLE_JQ.test(jq)) return null;
  return { kind: 'rest', path, query: Object.fromEntries(query), paginate: Boolean(f['--paginate']), jq };
}

function parsePr(sub, rest) {
  if (sub === 'list') {
    const f = flags(rest, ['-R', '--state', '--base', '--search', '-L', '--json']);
    const fields = f && fieldList(f['--json'], PR_FIELDS);
    if (!fields || f.positional.length) return null;
    const state = f['--state'] ?? 'open';
    if (!['open', 'merged', 'all'].includes(state)) return null;
    return { kind: 'prList', state, base: f['--base'] ?? null, search: f['--search'] ?? null, limit: limitOf(f['-L'], 30), fields };
  }
  if (sub === 'view') {
    const f = flags(rest, ['-R', '--json']);
    const fields = f && fieldList(f['--json'], PR_FIELDS);
    if (!fields || f.positional.length !== 1 || !/^\d+$/.test(f.positional[0])) return null;
    return { kind: 'prView', number: Number(f.positional[0]), fields };
  }
  return null;
}

function parseRun(sub, rest) {
  if (sub === 'list') {
    const f = flags(rest, ['-R', '-L', '-w', '-b', '-e', '-s', '-u', '--json']);
    const fields = f && fieldList(f['--json'], RUN_FIELDS);
    if (!fields || f.positional.length) return null;
    return {
      kind: 'runList', workflow: f['-w'] ?? null, branch: f['-b'] ?? null, event: f['-e'] ?? null,
      status: f['-s'] ?? null, user: f['-u'] ?? null, limit: limitOf(f['-L'], 20), fields,
    };
  }
  if (sub === 'view') {
    const f = flags(rest, ['-R', '--json']);
    if (!f || f['--json'] !== 'jobs' || f.positional.length !== 1 || !/^\d+$/.test(f.positional[0])) return null;
    return { kind: 'runView', id: Number(f.positional[0]), fields: ['jobs'] };
  }
  return null;
}

// args as sent to gh → a read description, or null to use the CLI.
export function parseRead(args) {
  const [cmd, sub, ...rest] = Array.isArray(args) ? args : [];
  if (cmd === 'api') return parseApi([sub, ...rest].filter((a) => a !== undefined));
  if (cmd === 'pr') return parsePr(sub, rest);
  if (cmd === 'run') return parseRun(sub, rest);
  return null;
}

// The small part of jq the dashboard uses, printed the way gh prints --jq results.
export function jqSelect(value, filter) {
  const [, each, pathPart, fallback] = filter.match(/^(\.\[\])?((?:\.[A-Za-z_]\w*)+)(?: \/\/ "([^"]*)")?$/);
  const keys = pathPart.slice(1).split('.');
  const pick = (v) => {
    const got = keys.reduce((o, k) => (o == null ? undefined : o[k]), v);
    const out = got == null || got === false ? (fallback ?? got) : got;
    if (out == null) return 'null';
    return typeof out === 'string' ? out : typeof out === 'object' ? JSON.stringify(out) : String(out);
  };
  return each ? (value ?? []).map(pick).join('\n') : pick(value);
}

// ---------- mapping GitHub answers to gh's --json shapes ----------


const [OWNER, NAME] = REPO.split('/');
const PAGE = 100;
const PR_SCALARS = ['number', 'title', 'url', 'isDraft', 'headRefName', 'baseRefName', 'createdAt', 'state', 'mergedAt', 'isCrossRepository', 'reviewDecision'];
const PR_GRAPHQL = {
  author: 'author { login }',
  mergeCommit: 'mergeCommit { oid }',
  reviewRequests: 'reviewRequests(first: 50) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name slug } } } }',
  latestReviews: 'latestReviews(first: 50) { nodes { author { login } state submittedAt body } }',
  statusCheckRollup: 'commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename '
    + '... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }',
};
const prSelection = (fields) => fields.map((f) => (PR_SCALARS.includes(f) ? f : PR_GRAPHQL[f])).join(' ');

// One page of a pr list or the single pr view, as a GraphQL request.
export function prQuery(read, after) {
  const select = prSelection(read.fields);
  if (read.kind === 'prView') {
    return {
      query: `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${select} } } }`,
      variables: { owner: OWNER, name: NAME, number: read.number },
    };
  }
  const first = Math.min(PAGE, read.limit);
  if (read.state === 'open' && !read.search && !read.base) {
    return {
      query: `query($owner: String!, $name: String!, $first: Int!, $after: String) { repository(owner: $owner, name: $name) { `
        + `pullRequests(states: OPEN, first: $first, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${select} } pageInfo { hasNextPage endCursor } } } }`,
      variables: { owner: OWNER, name: NAME, first, after },
    };
  }
  const q = [`repo:${REPO}`, 'is:pr', read.state === 'merged' ? 'is:merged' : read.state === 'open' ? 'is:open' : null,
    read.base ? `base:${read.base}` : null, read.search, 'sort:created-desc'].filter(Boolean).join(' ');
  return {
    query: `query($q: String!, $first: Int!, $after: String) { search(type: ISSUE, query: $q, first: $first, after: $after) { `
      + `nodes { ... on PullRequest { ${select} } } pageInfo { hasNextPage endCursor } } }`,
    variables: { q, first, after },
  };
}

export function prNodes(read, data) {
  const page = read.state === 'open' && !read.search && !read.base ? data.repository.pullRequests : data.search;
  return { nodes: page.nodes.filter((n) => n && n.number !== undefined), pageInfo: page.pageInfo };
}

const emptyIfNull = (v) => (v == null ? '' : v);
const PR_MAP = {
  author: (n) => (n.author ? { login: n.author.login } : null),
  reviewDecision: (n) => emptyIfNull(n.reviewDecision),
  mergeCommit: (n) => (n.mergeCommit ? { oid: n.mergeCommit.oid } : null),
  reviewRequests: (n) => (n.reviewRequests?.nodes ?? []).map((r) => r.requestedReviewer).filter(Boolean)
    .map((r) => (r.__typename === 'Team' ? { __typename: 'Team', name: r.name, slug: r.slug } : { __typename: r.__typename, login: r.login })),
  latestReviews: (n) => (n.latestReviews?.nodes ?? []).map((r) => ({
    author: r.author ? { login: r.author.login } : null, state: r.state, submittedAt: r.submittedAt, body: r.body,
  })),
  statusCheckRollup: (n) => (n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).map((c) => (c.__typename === 'CheckRun'
    ? { __typename: 'CheckRun', name: c.name, status: c.status, conclusion: emptyIfNull(c.conclusion) }
    : { __typename: 'StatusContext', context: c.context, state: c.state })),
};

export function mapPr(read, n) {
  return Object.fromEntries(read.fields.map((f) => [f, PR_MAP[f] ? PR_MAP[f](n) : n[f]]));
}

export function runRequest(read) {
  const base = `repos/${REPO}/actions`;
  const path = read.workflow ? `${base}/workflows/${encodeURIComponent(read.workflow)}/runs` : `${base}/runs`;
  const query = { per_page: String(Math.min(PAGE, read.limit)) };
  if (read.branch) query.branch = read.branch;
  if (read.event) query.event = read.event;
  if (read.status) query.status = read.status;
  if (read.user) query.actor = read.user;
  return { path, query };
}

const RUN_MAP = {
  databaseId: 'id', workflowName: 'name', headBranch: 'head_branch', headSha: 'head_sha', event: 'event', status: 'status',
  createdAt: 'created_at', updatedAt: 'updated_at', url: 'html_url', displayTitle: 'display_title', attempt: 'run_attempt',
};
// workflowNames: workflow id → its name. A run's own "name" can be a custom run-name; gh shows the workflow's name.
export function mapRun(read, run, workflowNames = new Map()) {
  return Object.fromEntries(read.fields.map((f) => [f,
    f === 'conclusion' ? emptyIfNull(run.conclusion)
      : f === 'workflowName' ? workflowNames.get(run.workflow_id) ?? run.name
        : run[RUN_MAP[f]]]));
}

export function mapJobs(json) {
  return {
    jobs: (json.jobs ?? []).map((j) => ({
      databaseId: j.id, name: j.name, status: j.status, conclusion: emptyIfNull(j.conclusion),
      steps: (j.steps ?? []).map((s) => ({ name: s.name, status: s.status, conclusion: emptyIfNull(s.conclusion), number: s.number })),
    })),
  };
}

// ---------- the client ----------

const API = 'https://api.github.com';
const SIGN_IN = "gh isn't signed in. Run gh auth login.";

// A request that never reached GitHub (DNS, TLS, refused, timeout). The caller retries through the CLI.
export class NetworkError extends Error {
  constructor(message) { super(message); this.name = 'NetworkError'; }
}

function urlFor(path, query = {}) {
  const url = new URL(path.replace(/^\/+/, ''), `${API}/`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}
const nextLink = (header) => header?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;

export function createDirect({ fetch, readToken, timeoutMs = 20000 }) {
  let token = null;

  async function send(url, init = {}, retried = false) {
    if (new URL(url).origin !== API) throw new GhError('Refused a GitHub link that points outside api.github.com.');
    token ??= await readToken();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), timeoutMs);
    let res;
    let body;
    try {
      res = await fetch(url, {
        ...init, signal: abort.signal,
        headers: {
          Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mobile-clock-dashboard',
          'X-GitHub-Api-Version': '2022-11-28', ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
      const text = await res.text(); // inside the timeout: a stalled body times out too
      try { body = text ? JSON.parse(text) : null; } catch {
        if (res.ok) throw new NetworkError("Couldn't read GitHub's reply");
        body = null;
      }
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      throw new NetworkError(`Couldn't reach GitHub (${err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timed out' : 'connection failed'})`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) {
      if (retried) throw new GhError(SIGN_IN);
      token = null; // maybe gh refreshed it: read it again once
      return send(url, init, true);
    }
    if (!res.ok) {
      const path = String(url).slice(API.length + 1).split('?')[0];
      throw new GhError(res.status === 404 ? `HTTP 404: Not Found (${path})` : `HTTP ${res.status}: ${body?.message ?? res.statusText}`);
    }
    return { body, next: nextLink(res.headers.get('link')) };
  }

  async function graphql(query, variables) {
    const { body } = await send(`${API}/graphql`, { method: 'POST', body: JSON.stringify({ query, variables }) });
    if (body?.errors?.length) throw new GhError(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
    return body;
  }

  async function rest(read) {
    let { body, next } = await send(urlFor(read.path, read.query));
    if (read.paginate && Array.isArray(body)) {
      const all = [...body];
      while (next) { ({ body, next } = await send(next)); all.push(...body); }
      body = all;
    }
    return body;
  }

  async function prList(read) {
    const out = [];
    let after = null;
    do {
      const { query, variables } = prQuery(read, after);
      const { nodes, pageInfo } = prNodes(read, (await graphql(query, variables)).data);
      out.push(...nodes.map((n) => mapPr(read, n)));
      after = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
    } while (after && out.length < read.limit);
    return out.slice(0, read.limit);
  }

  let workflowNames = null; // id → name, read once: workflow names change rarely
  async function namesOfWorkflows() {
    if (!workflowNames) {
      const { body } = await send(urlFor(`repos/${REPO}/actions/workflows`, { per_page: '100' }));
      workflowNames = new Map((body?.workflows ?? []).map((w) => [w.id, w.name]));
    }
    return workflowNames;
  }

  async function runList(read) {
    const { path, query } = runRequest(read);
    const names = read.fields.includes('workflowName') ? await namesOfWorkflows() : undefined;
    const out = [];
    for (let page = 1; out.length < read.limit; page++) {
      const { body } = await send(urlFor(path, { ...query, page: String(page) }));
      const runs = body?.workflow_runs ?? [];
      out.push(...runs.map((r) => mapRun(read, r, names)));
      if (runs.length < Number(query.per_page)) break;
    }
    return out.slice(0, read.limit);
  }

  // → { text, json }: json is what gh --json / gh api would print, text is what gh.run would return.
  async function read(r) {
    let json;
    if (r.kind === 'rest') {
      json = await rest(r);
      return { json, text: r.jq ? `${jqSelect(json, r.jq)}\n` : JSON.stringify(json) };
    }
    if (r.kind === 'graphql') json = await graphql(r.query, r.variables);
    else if (r.kind === 'prList') json = await prList(r);
    else if (r.kind === 'prView') {
      const { query, variables } = prQuery(r, null);
      const pr = (await graphql(query, variables)).data?.repository?.pullRequest;
      if (!pr) throw new GhError(`GraphQL: Could not resolve to a PullRequest with the number of ${r.number}.`);
      json = mapPr(r, pr);
    } else if (r.kind === 'runList') json = await runList(r);
    else if (r.kind === 'runView') json = mapJobs((await send(urlFor(`repos/${REPO}/actions/runs/${r.id}/jobs`, { per_page: '100' }))).body);
    return { json, text: JSON.stringify(json) };
  }

  return { read };
}
