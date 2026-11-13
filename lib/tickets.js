import { JIRA, JIRA_TTL_MS, JIRA_PROJECT, REPO } from '../config.js';
import { JiraError } from './jira.js';
import { listPrs } from './prs.js';
import { GhError } from './gh.js';
import { HttpError } from './http.js';
import { branchName } from '../public/shared.js';

export { branchName };

const KEY_IN_TEXT = /TCPMOB-\d+/i;
export const KEY_EXACT = /^TCPMOB-\d+$/;
const TICKET_FIELDS = ['summary', 'status', 'assignee', 'fixVersions', 'issuetype'];

export function ticketKey(...texts) {
  for (const text of texts) {
    const match = String(text ?? '').match(KEY_IN_TEXT);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

export function validKey(key) {
  const upper = String(key ?? '').toUpperCase();
  return KEY_EXACT.test(upper) ? upper : null;
}

const uniqueValidKeys = (keys) => [...new Set(keys.map(validKey).filter(Boolean))];
const browseUrl = (baseUrl, key) => `${String(baseUrl).replace(/\/+$/, '')}/browse/${key}`;

// Only exact keys reach JQL, so nothing from a branch name can alter the query.
export function keysJql(keys) {
  const valid = uniqueValidKeys(keys);
  return valid.length ? `key in (${valid.join(', ')})` : null;
}

export function toTicket(issue, baseUrl) {
  const fields = issue.fields ?? {};
  return {
    key: issue.key,
    url: browseUrl(baseUrl, issue.key),
    summary: fields.summary ?? '',
    status: fields.status?.name ?? '',
    statusCategory: fields.status?.statusCategory?.key ?? '',
    assignee: fields.assignee ? { accountId: fields.assignee.accountId, name: fields.assignee.displayName } : null,
    fixVersions: (fields.fixVersions ?? []).map((v) => v.name),
    issueType: fields.issuetype?.name ?? '',
  };
}

export function createTicketCache(jira, baseUrl, now = () => Date.now()) {
  const cache = new Map(); // key -> { ticket|null, at }
  const isStale = (key) => { const hit = cache.get(key); return !hit || now() - hit.at > JIRA_TTL_MS; };

  // Misses are cached as null too, so a missing ticket isn't searched again until the TTL passes.
  async function fetchMisses(misses) {
    const jql = keysJql(misses);
    if (!jql) return;
    const issues = await jira.search(jql, TICKET_FIELDS, misses.length);
    const found = new Map(issues.map((issue) => [issue.key, toTicket(issue, baseUrl)]));
    for (const key of misses) cache.set(key, { ticket: found.get(key) ?? null, at: now() });
  }

  return {
    async get(keys) {
      const wanted = uniqueValidKeys(keys);
      await fetchMisses(wanted.filter(isStale));
      const out = new Map();
      for (const key of wanted) {
        const ticket = cache.get(key)?.ticket;
        if (ticket) out.set(key, ticket);
      }
      return out;
    },
    clear: () => cache.clear(),
  };
}

// The four comments the build workflows post after a successful dev build.
const BUILD_APPS = 'MobileClock IOS|Mobile Kiosk IOS|Mobile Clock Android|Mobile Kiosk Android';
const BUILD_COMMENT = new RegExp(
  `^(?:(\\S+) )?pushed build number (\\d+) for (${BUILD_APPS}) to (testflight|firebase distribution)`, 'i');

export function parseBuildComments(comments) {
  const out = [];
  for (const comment of comments) {
    const match = String(comment.text ?? '').trim().match(BUILD_COMMENT);
    if (!match) continue;
    const [, user, number, appTarget] = match;
    const target = appTarget.toLowerCase();
    out.push({
      app: target.includes('kiosk') ? 'Mobile Kiosk' : 'MobileClock',
      platform: /\bios\b/.test(target) ? 'iOS' : 'Android', // word match: 'kiosk' contains 'ios'
      number,
      user: user ?? null,
      created: comment.created,
    });
  }
  return out;
}

const JIRA_NOT_CONNECTED = "Jira isn't connected. Add your Jira URL, email, and token in Settings.";

export function requireJira(ctx) {
  if (!ctx.jira?.configured) throw new JiraError(503, JIRA_NOT_CONNECTED);
  return ctx.jira;
}

export async function prsWithTickets(ctx) {
  const prs = await listPrs(ctx.gh);
  for (const pr of prs) {
    pr.ticketKey = ticketKey(pr.headRefName, pr.title);
    pr.ticket = null;
  }
  if (!ctx.jira?.configured) return { prs, ticketError: null };
  try {
    const byKey = await ctx.tickets.get(prs.map((p) => p.ticketKey).filter(Boolean));
    for (const pr of prs) pr.ticket = byKey.get(pr.ticketKey) ?? null;
    return { prs, ticketError: null };
  } catch (err) {
    return { prs, ticketError: err.message };
  }
}

const MY_TICKETS_JQL = `project = ${JIRA_PROJECT} AND assignee = currentUser()`
  + ' AND status in ("To Do","Open","In Progress","Dev Review") ORDER BY status';
const BUILD_ID = /^\d+-\d+$/;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

function pathKey(raw) {
  const key = validKey(decodeURIComponent(raw));
  if (!key) throw new HttpError(400, 'Expected a ticket key like TCPMOB-123.');
  return key;
}

// Plain text → Atlassian Document Format. Lines between ``` fences become one code block.
const adfText = (text) => [{ type: 'text', text }];
const adfCodeBlock = (lines) => ({ type: 'codeBlock', content: lines.length ? adfText(lines.join('\n')) : [] });
const adfParagraph = (line) => (line.trim() ? { type: 'paragraph', content: adfText(line) } : { type: 'paragraph' });

export function toAdf(text) {
  const content = [];
  let code = null; // lines of the open ``` fence, or null outside one
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim().startsWith('```')) {
      if (code) content.push(adfCodeBlock(code));
      code = code ? null : [];
    } else if (code) {
      code.push(line);
    } else {
      content.push(adfParagraph(line));
    }
  }
  if (code) content.push(adfCodeBlock(code));
  return { type: 'doc', version: 1, content };
}

async function loadTicket(ctx, key) {
  return toTicket(await requireJira(ctx).getIssue(key, TICKET_FIELDS), JIRA.baseUrl);
}

export async function lookup(ctx, key) {
  const jira = requireJira(ctx);
  const [ticket, comments, runs, prs] = await Promise.all([
    loadTicket(ctx, key),
    jira.comments(key),
    ctx.gh.json(['run', 'list', '-R', REPO, '-e', 'workflow_dispatch', '-s', 'success', '-L', '100',
      '--json', 'databaseId,workflowName,headBranch,createdAt,url,displayTitle']),
    ctx.gh.json(['pr', 'list', '-R', REPO, '--state', 'all', '--search', key, '-L', '20',
      '--json', 'number,url,state,baseRefName,headRefName,title,mergedAt,mergeCommit']),
  ]);
  const re = new RegExp(`${key}(?!\\d)`, 'i');
  const newestFirst = prs.filter((p) => ticketKey(p.headRefName, p.title) === key).sort((a, b) => b.number - a.number);
  const pr = newestFirst[0] ?? null;
  const release = ctx.release ? await ctx.release.containsMerge(pr) : null;
  return {
    ticket,
    jiraBuilds: parseBuildComments(comments),
    trackedBuilds: ctx.tracker.list().filter((b) => re.test(b.branch)),
    runs: runs.filter((r) => re.test(r.headBranch)),
    pr: pr && { number: pr.number, url: pr.url, state: pr.state },
    mergedToDevelop: Boolean(pr && pr.state === 'MERGED' && pr.baseRefName === 'develop'),
    onReleaseBranch: release,
  };
}

async function handleJiraStatus(ctx) {
  if (!ctx.jira?.configured) return { configured: false, ok: false, error: JIRA_NOT_CONNECTED };
  try {
    const me = await ctx.jira.myself();
    return { configured: true, ok: true, name: me.displayName };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}

// Send to QA: Dev Review → QA Review, only after a dev build was posted to the ticket. Never comments.
async function handleSendToQa(ctx, key) {
  const jira = requireJira(ctx);
  const ticket = await loadTicket(ctx, key);
  if (ticket.status !== 'Dev Review') throw new HttpError(409, `${key} is ${ticket.status}, not Dev Review.`);
  if (!parseBuildComments(await jira.comments(key)).length) {
    throw new HttpError(409, `${key} has no dev build posted yet. Build it first.`);
  }
  const transitions = await jira.transitions(key);
  const qa = transitions.find((t) => t.to?.name === 'QA Review');
  if (!qa) {
    const available = transitions.map((t) => t.to?.name).join(', ') || 'none';
    throw new HttpError(409, `No QA Review transition from ${ticket.status}. Available: ${available}.`);
  }
  await jira.transition(key, qa.id);
  ctx.tickets.clear();
  return { ok: true, from: ticket.status, to: 'QA Review' };
}

// Returns true when the branch already existed. That isn't an error: a retry after a failed assign must
// still finish the job.
async function createBranchFromDevelop(gh, branch) {
  const sha = (await gh.run(['api', `repos/${REPO}/git/ref/heads/develop`, '--jq', '.object.sha'])).trim();
  try {
    await gh.run(['api', '-X', 'POST', `repos/${REPO}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`]);
    return false;
  } catch (err) {
    if (!(err instanceof GhError && /already exists/i.test(err.message))) throw err;
    return true;
  }
}

// Start: create the branch from develop and assign to me if unassigned. Never changes status.
async function handleStart(ctx, key) {
  const jira = requireJira(ctx);
  const ticket = await loadTicket(ctx, key);
  if (!['To Do', 'Open'].includes(ticket.status)) {
    throw new HttpError(409, `${key} is ${ticket.status}; Start is only for To Do or Open tickets.`);
  }
  const branch = branchName(key, ticket.summary);
  const existed = await createBranchFromDevelop(ctx.gh, branch);
  let assigned = false;
  if (!ticket.assignee) {
    await jira.assign(key, (await jira.myself()).accountId);
    assigned = true;
  }
  ctx.tickets.clear();
  return { ok: true, branch, assigned, ...(existed ? { existed: true } : {}) };
}

function failedBuild(ctx, buildId) {
  if (!BUILD_ID.test(buildId)) throw new HttpError(400, 'Unknown build id.');
  const build = ctx.tracker.list().find((b) => b.id === buildId);
  if (!build) throw new HttpError(404, 'Build not found. It may have been cleared by a server restart.');
  if (build.status !== 'completed' || !FAILED.has(build.conclusion)) {
    throw new HttpError(409, 'Only builds that failed for good can become a bug.');
  }
  return build;
}

// Create a Jira bug from a dashboard build that failed for good.
async function handleCreateBug(ctx, buildId, req) {
  const build = failedBuild(ctx, buildId);
  const { summary, description } = await ctx.readJson(req);
  const title = String(summary ?? '').trim();
  if (!title || title.length > 255) {
    throw new HttpError(400, 'Summary is required and must be 255 characters or fewer.');
  }
  const jira = requireJira(ctx);
  const types = await jira.issueTypes(JIRA_PROJECT);
  if (!types.includes('Bug')) {
    throw new HttpError(409, `Bug isn't available in ${JIRA_PROJECT}. Available: ${types.join(', ')}.`);
  }
  const { key } = await jira.createIssue({
    project: { key: JIRA_PROJECT }, issuetype: { name: 'Bug' }, summary: title, description: toAdf(description),
  });
  const url = browseUrl(JIRA.baseUrl, key);
  // The bug exists now; a link failure must not look like a failed create, or a retry files a duplicate.
  const related = ticketKey(build.branch);
  if (related) {
    try { await jira.link('Relates', key, related); }
    catch (err) { return { key, url, linkError: err.message }; }
  }
  return { key, url };
}

export function routes(ctx) {
  ctx.myTickets = async () => {
    const issues = await requireJira(ctx).search(MY_TICKETS_JQL, TICKET_FIELDS, 100);
    return issues.map((issue) => toTicket(issue, JIRA.baseUrl));
  };

  return [
    ['GET', /^\/api\/jira\/status$/, () => handleJiraStatus(ctx)],
    ['GET', /^\/api\/prs$/, () => prsWithTickets(ctx)],
    ['GET', /^\/api\/tickets\/mine$/, () => ctx.myTickets()],
    ['GET', /^\/api\/lookup\/([^/]+)$/, (m) => lookup(ctx, pathKey(m[1]))],
    ['POST', /^\/api\/tickets\/([^/]+)\/qa$/, (m) => handleSendToQa(ctx, pathKey(m[1]))],
    ['POST', /^\/api\/tickets\/([^/]+)\/start$/, (m) => handleStart(ctx, pathKey(m[1]))],
    ['POST', /^\/api\/builds\/([^/]+)\/bug$/, (m, req) => handleCreateBug(ctx, m[1], req)],
  ];
}

export { JIRA };
