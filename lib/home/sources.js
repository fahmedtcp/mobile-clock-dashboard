// Everything Home's pure rules need, loaded from Jira, GitHub, and the build tracker.
// A failing source only empties its own inputs and reports in `errors`; Home renders the rest.
import { JIRA_PROJECT } from '../../config.js';
import { listPrs } from '../prs.js';
import { listMergedPrs } from '../ghdata.js';
import { getLogin } from '../runs.js';
import { JIRA, parseBuildComments, toTicket, ticketKey } from '../tickets.js';

const PER_KEY_TTL_MS = 60000;
const CONCURRENCY = 4;
const MERGED_DAYS = 14;
const QA_STATUSES = '"QA Review"';
const FIELDS = ['summary', 'status', 'assignee', 'fixVersions', 'issuetype'];
const MY_WORK_JQL = `project = ${JIRA_PROJECT} AND ((assignee = currentUser() AND status in ("To Do","Open","In Progress","Dev Review"))`
  + ` OR (assignee was currentUser() AND status in (${QA_STATUSES}) AND updated >= -${MERGED_DAYS}d)) ORDER BY updated DESC`;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const settle = (promise, fallback) => promise.then((value) => ({ value, error: null }), (err) => ({ value: fallback, error: err.message || 'Failed' }));

// Per-process caches live on ctx so tests get fresh ones with each server.
function caches(ctx) {
  ctx.homeCache ??= { perKey: new Map(), accountIds: new Map(), me: null };
  return ctx.homeCache;
}

async function perKey(ctx, key) {
  const { perKey: cache } = caches(ctx);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= PER_KEY_TTL_MS) return hit.value;
  const [comments, changelog] = await Promise.all([ctx.jira.comments(key), ctx.jira.changelog(key)]);
  const value = { comments, changelog, builds: parseBuildComments(comments) };
  cache.set(key, { value, at: Date.now() });
  return value;
}

async function resolvePeople(ctx) {
  const { accountIds } = caches(ctx);
  const people = ctx.settings.resolved().team.people;
  return Promise.all(people.map(async (person) => {
    // Only found accounts are cached, so a failed or empty lookup is tried again next time.
    if (!accountIds.has(person.jiraEmail)) {
      const accountId = await ctx.jira.userByEmail(person.jiraEmail).catch(() => null);
      if (accountId) accountIds.set(person.jiraEmail, accountId);
    }
    return { ...person, accountId: accountIds.get(person.jiraEmail) ?? null };
  }));
}

async function loadGithub(ctx) {
  const login = await getLogin(ctx.gh);
  const sinceIso = new Date(Date.now() - MERGED_DAYS * 864e5).toISOString();
  const [allPrs, merged] = await Promise.all([listPrs(ctx.gh), listMergedPrs(ctx.gh, { base: 'develop', sinceIso })]);
  const prs = allPrs.filter((pr) => pr.author === login);
  const behind = new Map(await Promise.all(prs.map(async (pr) => [pr.number,
    await ctx.behind.get(pr.baseRefName, pr.headRefName).catch(() => 0)])));
  return { login, allPrs, prs, merged: merged.filter((pr) => pr.author === login), behind };
}

// The Jira work that doesn't need GitHub: who you are, your tickets, teammates. Starts at the same time as GitHub.
async function loadJiraBase(ctx) {
  const { jira } = ctx;
  const home = caches(ctx);
  const team = async () => {
    const people = await resolvePeople(ctx);
    const ids = people.map((p) => p.accountId).filter(Boolean);
    const teamTickets = ids.length
      ? (await jira.search(`assignee in (${ids.map((id) => `"${id}"`).join(',')}) AND status in ("In Progress",${QA_STATUSES}) ORDER BY updated DESC`,
        FIELDS, 50)).map((issue) => toTicket(issue, JIRA.baseUrl))
      : [];
    return { people, teamTickets };
  };
  const [me, issues, { people, teamTickets }] = await Promise.all([home.me ?? jira.myself(), jira.search(MY_WORK_JQL, FIELDS, 50), team()]);
  home.me = me;
  return { accountId: me.accountId, found: issues.map((issue) => toTicket(issue, JIRA.baseUrl)), people, teamTickets };
}

// The rest, once GitHub says which PR tickets to add: those tickets, then comments and history for each.
async function loadJira(ctx, base, prKeys) {
  const { found, people, teamTickets, accountId } = base;
  const known = new Set(found.map((t) => t.key));
  // Merged PRs bring their tickets only while QA still has them; finished work stays out of My Work.
  const extra = [...(await ctx.tickets.get(prKeys.keys.filter((key) => !known.has(key)))).values()]
    .filter((t) => /QA/i.test(t.status) || prKeys.open.has(t.key));
  const tickets = [...found, ...extra];
  const details = await mapLimit(tickets, CONCURRENCY, (t) => perKey(ctx, t.key));
  return {
    accountId,
    tickets,
    people,
    teamTickets,
    comments: new Map(tickets.map((t, i) => [t.key, details[i].comments])),
    changelogs: new Map(tickets.map((t, i) => [t.key, details[i].changelog])),
    buildComments: new Map(tickets.map((t, i) => [t.key, details[i].builds])),
  };
}

const EMPTY_JIRA = {
  accountId: null, tickets: [], people: [], teamTickets: [], comments: new Map(), changelogs: new Map(), buildComments: new Map(),
};
const EMPTY_GITHUB = { login: null, allPrs: [], prs: [], merged: [], behind: new Map() };

// → { input: WorkInput & { allPrs, teamTickets }, errors: { jira?, github? } }
export async function loadHomeSources(ctx, now = new Date()) {
  const jiraOn = Boolean(ctx.jira?.configured);
  const baseP = jiraOn ? settle(loadJiraBase(ctx), null) : null; // runs while GitHub loads
  const github = await settle(loadGithub(ctx), EMPTY_GITHUB);
  const base = baseP && await baseP;
  const keyOf = (pr) => ticketKey(pr.headRefName, pr.title);
  const prKeys = {
    keys: [...github.value.prs, ...github.value.merged].map(keyOf).filter(Boolean),
    open: new Set(github.value.prs.map(keyOf).filter(Boolean)),
  };
  const jira = !jiraOn ? { value: EMPTY_JIRA, error: "Jira isn't connected." }
    : base.error ? { value: EMPTY_JIRA, error: base.error }
      : await settle(loadJira(ctx, base.value, prKeys), EMPTY_JIRA);
  const { login, ...gh } = github.value;
  const { accountId, ...jiraInputs } = jira.value;
  const errors = {};
  if (github.error) errors.github = github.error;
  if (jira.error) errors.jira = jira.error;
  return { input: { me: { accountId, login }, ...gh, ...jiraInputs, now }, errors };
}
