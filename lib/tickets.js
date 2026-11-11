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
  for (const t of texts) {
    const m = String(t ?? '').match(KEY_IN_TEXT);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

export function validKey(key) {
  const k = String(key ?? '').toUpperCase();
  return KEY_EXACT.test(k) ? k : null;
}

// Only exact keys reach JQL, so nothing from a branch name can alter the query.
export function keysJql(keys) {
  const valid = [...new Set(keys.map(validKey).filter(Boolean))];
  return valid.length ? `key in (${valid.join(', ')})` : null;
}

export function toTicket(issue, baseUrl) {
  const f = issue.fields ?? {};
  return {
    key: issue.key,
    url: `${String(baseUrl).replace(/\/+$/, '')}/browse/${issue.key}`,
    summary: f.summary ?? '',
    status: f.status?.name ?? '',
    statusCategory: f.status?.statusCategory?.key ?? '',
    assignee: f.assignee ? { accountId: f.assignee.accountId, name: f.assignee.displayName } : null,
    fixVersions: (f.fixVersions ?? []).map((v) => v.name),
    issueType: f.issuetype?.name ?? '',
  };
}

export function createTicketCache(jira, baseUrl, now = () => Date.now()) {
  const cache = new Map(); // key -> { ticket|null, at }
  return {
    async get(keys) {
      const wanted = [...new Set(keys.map(validKey).filter(Boolean))];
      const misses = wanted.filter((k) => { const hit = cache.get(k); return !hit || now() - hit.at > JIRA_TTL_MS; });
      const jql = keysJql(misses);
      if (jql) {
        const found = new Map((await jira.search(jql, TICKET_FIELDS, misses.length)).map((i) => [i.key, toTicket(i, baseUrl)]));
        for (const k of misses) cache.set(k, { ticket: found.get(k) ?? null, at: now() });
      }
      const out = new Map();
      for (const k of wanted) { const t = cache.get(k)?.ticket; if (t) out.set(k, t); }
      return out;
    },
    clear: () => cache.clear(),
  };
}

// The four comments the build workflows post after a successful dev build.
const BUILD_COMMENT = /^(?:(\S+) )?pushed build number (\d+) for (MobileClock IOS|Mobile Kiosk IOS|Mobile Clock Android|Mobile Kiosk Android) to (testflight|firebase distribution)/i;

export function parseBuildComments(comments) {
  const out = [];
  for (const c of comments) {
    const m = String(c.text ?? '').trim().match(BUILD_COMMENT);
    if (!m) continue;
    const target = m[3].toLowerCase();
    out.push({
      app: target.includes('kiosk') ? 'Mobile Kiosk' : 'MobileClock',
      platform: /\bios\b/.test(target) ? 'iOS' : 'Android', // word match: 'kiosk' contains 'ios'
      number: m[2],
      user: m[1] ?? null,
      created: c.created,
    });
  }
  return out;
}

export function requireJira(ctx) {
  if (!ctx.jira?.configured) throw new JiraError(503, "Jira isn't connected. Add your Jira URL, email, and token in Settings.");
  return ctx.jira;
}

export async function prsWithTickets(ctx) {
  const prs = await listPrs(ctx.gh);
  for (const pr of prs) { pr.ticketKey = ticketKey(pr.headRefName, pr.title); pr.ticket = null; }
  if (!ctx.jira?.configured) return { prs, ticketError: null };
  try {
    const map = await ctx.tickets.get(prs.map((p) => p.ticketKey).filter(Boolean));
    for (const pr of prs) pr.ticket = map.get(pr.ticketKey) ?? null;
    return { prs, ticketError: null };
  } catch (err) {
    return { prs, ticketError: err.message };
  }
}

const MY_TICKETS_JQL = `project = ${JIRA_PROJECT} AND assignee = currentUser() AND status in ("To Do","Open","In Progress","Dev Review") ORDER BY status`;
const BUILD_ID = /^\d+-\d+$/;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

function pathKey(raw) {
  const key = validKey(decodeURIComponent(raw));
  if (!key) throw new HttpError(400, 'Expected a ticket key like TCPMOB-123.');
  return key;
}

// Plain text → Atlassian Document Format. Lines between ``` fences become one code block.
export function toAdf(text) {
  const content = [];
  let code = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim().startsWith('```')) {
      if (code) { content.push({ type: 'codeBlock', content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] }); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    content.push(line.trim() ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' });
  }
  if (code) content.push({ type: 'codeBlock', content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] });
  return { type: 'doc', version: 1, content };
}

async function loadTicket(ctx, key) {
  return toTicket(await requireJira(ctx).getIssue(key, ['summary', 'status', 'assignee', 'fixVersions', 'issuetype']), JIRA.baseUrl);
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
  const pr = prs.filter((p) => ticketKey(p.headRefName, p.title) === key).sort((a, b) => b.number - a.number)[0] ?? null;
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

export function routes(ctx) {
  ctx.myTickets = async () => (await requireJira(ctx).search(MY_TICKETS_JQL, ['summary', 'status', 'assignee', 'fixVersions', 'issuetype'], 100)).map((i) => toTicket(i, JIRA.baseUrl));

  return [
    ['GET', /^\/api\/jira\/status$/, async () => {
      if (!ctx.jira?.configured) return { configured: false, ok: false, error: "Jira isn't connected. Add your Jira URL, email, and token in Settings." };
      try {
        const me = await ctx.jira.myself();
        return { configured: true, ok: true, name: me.displayName };
      } catch (err) {
        return { configured: true, ok: false, error: err.message };
      }
    }],
    ['GET', /^\/api\/prs$/, () => prsWithTickets(ctx)],
    ['GET', /^\/api\/tickets\/mine$/, () => ctx.myTickets()],
    ['GET', /^\/api\/lookup\/([^/]+)$/, (m) => lookup(ctx, pathKey(m[1]))],

    // Send to QA: Dev Review → QA Review, only after a dev build was posted to the ticket. Never comments.
    ['POST', /^\/api\/tickets\/([^/]+)\/qa$/, async (m) => {
      const key = pathKey(m[1]);
      const jira = requireJira(ctx);
      const ticket = await loadTicket(ctx, key);
      if (ticket.status !== 'Dev Review') throw new HttpError(409, `${key} is ${ticket.status}, not Dev Review.`);
      if (!parseBuildComments(await jira.comments(key)).length) throw new HttpError(409, `${key} has no dev build posted yet. Build it first.`);
      const transitions = await jira.transitions(key);
      const qa = transitions.find((t) => t.to?.name === 'QA Review');
      if (!qa) throw new HttpError(409, `No QA Review transition from ${ticket.status}. Available: ${transitions.map((t) => t.to?.name).join(', ') || 'none'}.`);
      await jira.transition(key, qa.id);
      ctx.tickets.clear();
      return { ok: true, from: ticket.status, to: 'QA Review' };
    }],

    // Start: create the branch from develop and assign to me if unassigned. Never changes status.
    ['POST', /^\/api\/tickets\/([^/]+)\/start$/, async (m) => {
      const key = pathKey(m[1]);
      const jira = requireJira(ctx);
      const ticket = await loadTicket(ctx, key);
      if (!['To Do', 'Open'].includes(ticket.status)) throw new HttpError(409, `${key} is ${ticket.status}; Start is only for To Do or Open tickets.`);
      const branch = branchName(key, ticket.summary);
      const sha = (await ctx.gh.run(['api', `repos/${REPO}/git/ref/heads/develop`, '--jq', '.object.sha'])).trim();
      // An existing branch isn't an error: a retry after a failed assign must still finish the job.
      let existed = false;
      try {
        await ctx.gh.run(['api', '-X', 'POST', `repos/${REPO}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`]);
      } catch (err) {
        if (!(err instanceof GhError && /already exists/i.test(err.message))) throw err;
        existed = true;
      }
      let assigned = false;
      if (!ticket.assignee) {
        await jira.assign(key, (await jira.myself()).accountId);
        assigned = true;
      }
      ctx.tickets.clear();
      return { ok: true, branch, assigned, ...(existed ? { existed: true } : {}) };
    }],

    // Create a Jira bug from a dashboard build that failed for good.
    ['POST', /^\/api\/builds\/([^/]+)\/bug$/, async (m, req) => {
      if (!BUILD_ID.test(m[1])) throw new HttpError(400, 'Unknown build id.');
      const build = ctx.tracker.list().find((b) => b.id === m[1]);
      if (!build) throw new HttpError(404, 'Build not found. It may have been cleared by a server restart.');
      if (build.status !== 'completed' || !FAILED.has(build.conclusion)) throw new HttpError(409, 'Only builds that failed for good can become a bug.');
      const { summary, description } = await ctx.readJson(req);
      const title = String(summary ?? '').trim();
      if (!title || title.length > 255) throw new HttpError(400, 'Summary is required and must be 255 characters or fewer.');
      const jira = requireJira(ctx);
      const types = await jira.issueTypes(JIRA_PROJECT);
      if (!types.includes('Bug')) throw new HttpError(409, `Bug isn't available in ${JIRA_PROJECT}. Available: ${types.join(', ')}.`);
      const { key } = await jira.createIssue({ project: { key: JIRA_PROJECT }, issuetype: { name: 'Bug' }, summary: title, description: toAdf(description) });
      const url = `${JIRA.baseUrl.replace(/\/+$/, '')}/browse/${key}`;
      // The bug exists now; a link failure must not look like a failed create, or a retry files a duplicate.
      const related = ticketKey(build.branch);
      if (related) {
        try { await jira.link('Relates', key, related); }
        catch (err) { return { key, url, linkError: err.message }; }
      }
      return { key, url };
    }],
  ];
}

export { JIRA };
