import { REPO, JIRA } from '../config.js';
import { HttpError } from './http.js';
import { ticketKey, requireJira, parseBuildComments, KEY_EXACT } from './tickets.js';
import { getLogin } from './runs.js';

// "Request review" messages to a Teams channel through a Workflows webhook.
// Card text follows the user's own template; only the ticket, title, links, and people change.

const ALLOWED_HOSTS = [/\.logic\.azure\.com$/i, /\.powerplatform\.com$/i, /\.webhook\.office\.com$/i];

export function validWebhookUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? '')); } catch { return false; }
  return url.protocol === 'https:' && ALLOWED_HOSTS.some((re) => re.test(url.hostname));
}

// Untrusted text (Jira summaries, notes) must not turn into links or formatting in the card.
const escapeMd = (s) => String(s ?? '').replace(/[\\`*_[\]]/g, (c) => `\\${c}`);
const cleanName = (s) => String(s ?? '').replace(/[<>/]/g, '').trim();
export const mentionText = (name) => `<at>${cleanName(name)}</at>`;

export function buildCard({ key, summary, ticketUrl, prNumber, prUrl, people = [], note = '' }) {
  const block = (text, extra = {}) => ({ type: 'TextBlock', text, wrap: true, ...extra });
  const tagged = people.filter((p) => p.email);
  const footer = people.map((p) => (p.email ? mentionText(p.name) : escapeMd(cleanName(p.name)))).join(' ');
  const body = [
    block(`${key} ${escapeMd(summary)}`.trim(), { weight: 'Bolder', size: 'Large' }),
    block('Hey Team!'),
    block(`Ticket: [${key}](${ticketUrl})\n\nPR: [PR#${prNumber}](${prUrl})`),
    block('is ready for Dev-Review, Kindly take a peak at your convenience.'),
    ...(note.trim() ? [block(escapeMd(note.trim()))] : []),
    block('Thanks'),
    ...(footer ? [block(footer)] : []),
  ];
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body,
        msteams: {
          width: 'Full',
          entities: tagged.map((p) => ({ type: 'mention', text: mentionText(p.name), mentioned: { id: p.email, name: cleanName(p.name) } })),
        },
      },
    }],
  };
}

// "Ready for PRE-QA" message for the QA channel, in the team's own format. The tag is a real @mention
// only when its Teams tag ID is known; otherwise it's bold text (Workflows can't look tags up by name).
export function buildQaCard({ summary, ticketUrl, tag }) {
  const block = (text, extra = {}) => ({ type: 'TextBlock', text, wrap: true, ...extra });
  const name = cleanName(tag.name);
  const body = [
    block(escapeMd(summary), { weight: 'Bolder', size: 'Large' }),
    block(`[${ticketUrl}](${ticketUrl}) is ready for PRE-QA. Builds are mentioned in the ticket.`),
    block(tag.id ? mentionText(name) : `**${escapeMd(name)}**`),
  ];
  const entities = tag.id ? [{ type: 'mention', text: mentionText(name), mentioned: { id: tag.id, name, type: 'tag' } }] : [];
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body, msteams: { width: 'Full', entities } },
    }],
  };
}

export function createTeams({ webhookUrl, fetch = globalThis.fetch, label = 'review channel' }) {
  const configured = validWebhookUrl(webhookUrl);
  return {
    configured,
    async send(payload) {
      if (!configured) throw Object.assign(new Error(`Teams isn't set up. Add the ${label} webhook in Settings.`), { status: 503 });
      let res;
      try {
        res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      } catch (err) {
        throw Object.assign(new Error(`Can't reach Teams: ${err.message}`), { status: 502 });
      }
      if (!res.ok) throw Object.assign(new Error(`Teams rejected the message (${res.status}).`), { status: 502 });
    },
  };
}

// ---------- people + routes ----------

const COOLDOWN_MS = 30 * 60 * 1000;
const NOTE_MAX = 500;

// "a, b ,," → ['a', 'b'] (TEAMS_ALWAYS / TEAMS_NEVER)
export const parseLogins = (raw) => String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);

// TEAMS_PEOPLE="login=email,login=email" fills in people whose Jira profile hides their email.
export function parsePeopleMap(raw) {
  const out = new Map();
  for (const pair of String(raw ?? '').split(',')) {
    const [login, email] = pair.split('=').map((x) => x?.trim());
    if (login && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email ?? '')) out.set(login, email);
  }
  return out;
}

// GitHub login → { name, email }: the name from the GitHub profile, the email from a Jira user with that exact name.
function createPeople(ctx) {
  const cache = new Map(); // login -> { login, name, email: from Jira }; overrides apply on top at return
  ctx.peopleCacheClear = () => cache.clear();
  return async (login) => {
    // Email overrides come from Settings at call time, so a change applies without a restart.
    const override = ctx.settings?.resolved().teams.people?.[login] ?? null;
    if (cache.has(login)) { const c = cache.get(login); return { ...c, email: override ?? c.email }; }
    let name = login;
    try { name = (await ctx.gh.run(['api', `users/${encodeURIComponent(login)}`, '--jq', '.name // ""'])).trim() || login; } catch { /* keep login */ }
    let email = null;
    if (!email && ctx.jira?.configured && name !== login) {
      try {
        const match = (await ctx.jira.userSearch(name)).find((u) => u.displayName?.toLowerCase() === name.toLowerCase());
        email = match?.emailAddress ?? null;
      } catch { /* plain-text name is fine */ }
    }
    const person = { login, name, email };
    cache.set(login, person);
    return { ...person, email: override ?? email };
  };
}

function qaKey(raw) {
  const key = decodeURIComponent(raw).toUpperCase();
  if (!KEY_EXACT.test(key)) throw new HttpError(400, 'Expected a ticket key like TCPMOB-123.');
  return key;
}

async function qaDetails(ctx, key) {
  const jira = requireJira(ctx);
  const issue = await jira.getIssue(key, ['summary', 'status']);
  const status = issue.fields?.status?.name ?? '';
  let reason = null;
  if (status !== 'Dev Review') reason = `${key} is ${status}, not Dev Review.`;
  else if (!parseBuildComments(await jira.comments(key)).length) reason = `${key} has no dev build posted yet. Build it first.`;
  return { summary: issue.fields?.summary || key, ticketUrl: `${String(JIRA.baseUrl).replace(/\/+$/, '')}/browse/${key}`, reason };
}

async function details(ctx, n, lookup) {
  const { always, never } = ctx.teamsPrefs;
  const pr = await ctx.gh.json(['pr', 'view', String(n), '-R', REPO, '--json', 'number,title,url,author,headRefName,isDraft,state,reviewRequests']);
  const key = ticketKey(pr.headRefName, pr.title);
  let summary = pr.title;
  if (key && ctx.jira?.configured) {
    try { summary = (await ctx.jira.getIssue(key, ['summary'])).fields?.summary || pr.title; } catch { /* PR title fallback */ }
  }
  const login = await getLogin(ctx.gh);
  let me = { login, name: login, email: null };
  if (ctx.jira?.configured) {
    try { const m = await ctx.jira.myself(); me = { login, name: m.displayName || login, email: m.emailAddress ?? null }; } catch { /* keep login */ }
  }
  // Requested reviewers minus people who've left (TEAMS_NEVER), plus people always tagged (TEAMS_ALWAYS).
  const logins = [...new Set([...(pr.reviewRequests ?? []).map((r) => r.login).filter(Boolean), ...always])]
    .filter((l) => !never.includes(l) && l !== login);
  const reviewers = await Promise.all(logins.map((l) => lookup(l)));
  const base = String(JIRA.baseUrl).replace(/\/+$/, '');
  return {
    pr, login,
    key: key ?? `#${pr.number}`,
    title: key ? `${key} ${summary}` : pr.title,
    summary: key ? summary : pr.title.replace(/^#\d+\s*/, ''),
    ticketUrl: key && base ? `${base}/browse/${key}` : pr.url,
    people: [me, ...reviewers.filter((p) => p.login !== login)],
  };
}

export function routes(ctx) {
  // Real values come from Settings (applySettings in server.js); these are placeholders until then.
  ctx.teams ??= createTeams({ webhookUrl: '' });
  ctx.teamsTest ??= createTeams({ webhookUrl: '', label: 'test chat' });
  ctx.teamsQa ??= createTeams({ webhookUrl: '', label: 'QA channel' });
  ctx.teamsPrefs ??= { always: [], never: [] };
  const lookup = createPeople(ctx);
  const lastSent = new Map(); // pr number -> ms
  const qaSent = new Map(); // ticket key -> ms
  const tagOf = () => { const t = ctx.settings?.resolved().teams ?? {}; return { name: t.qaTagName || 'MobileHardware_QA', id: t.qaTagId || '' }; };

  return [
    // Request QA Review: same rules as Send to QA (Dev Review, dev build posted). Preview first; test chat first.
    ['GET', /^\/api\/tickets\/([^/]+)\/qa-request$/, async (m) => {
      const key = qaKey(m[1]);
      const d = await qaDetails(ctx, key);
      const tag = tagOf();
      return {
        configured: ctx.teamsQa.configured, testConfigured: ctx.teamsTest.configured,
        key, title: d.summary, ticketUrl: d.ticketUrl, tag: { name: tag.name, mention: Boolean(tag.id) },
        ready: !d.reason, reason: d.reason,
        cooldownUntil: qaSent.has(key) ? qaSent.get(key) + COOLDOWN_MS : null,
      };
    }],
    ['POST', /^\/api\/tickets\/([^/]+)\/qa-request$/, async (m, req) => {
      const key = qaKey(m[1]);
      const { test = false } = (await ctx.readJson(req)) ?? {};
      const target = test ? ctx.teamsTest : ctx.teamsQa;
      if (!target.configured) throw new HttpError(503, `Teams isn't set up. Add the ${test ? 'test chat' : 'QA channel'} webhook in Settings.`);
      const since = Date.now() - (qaSent.get(key) ?? 0);
      if (!test && since < COOLDOWN_MS) throw new HttpError(429, `Already sent for ${key}. You can send again in ${Math.ceil((COOLDOWN_MS - since) / 60000)} minutes.`);
      const d = await qaDetails(ctx, key);
      if (d.reason) throw new HttpError(409, d.reason);
      if (!test) qaSent.set(key, Date.now()); // before sending, so a double click can't post twice
      try {
        await target.send(buildQaCard({ summary: d.summary, ticketUrl: d.ticketUrl, tag: tagOf() }));
      } catch (err) {
        if (!test) qaSent.delete(key);
        throw new HttpError(err.status ?? 502, err.message);
      }
      return { ok: true, test: Boolean(test), sentAt: new Date().toISOString() };
    }],
    ['GET', /^\/api\/prs\/([^/]+)\/review-request$/, async (m) => {
      const n = ctx.id(m[1]);
      const d = await details(ctx, n, lookup);
      return {
        configured: ctx.teams.configured,
        testConfigured: ctx.teamsTest.configured,
        title: d.title, key: d.key, ticketUrl: d.ticketUrl, prNumber: d.pr.number, prUrl: d.pr.url,
        people: d.people.map((p) => ({ ...p, selected: true })),
        cooldownUntil: lastSent.has(n) ? lastSent.get(n) + COOLDOWN_MS : null,
      };
    }],
    ['POST', /^\/api\/prs\/([^/]+)\/review-request$/, async (m, req) => {
      const n = ctx.id(m[1]);
      const { logins = [], note = '', test = false } = await ctx.readJson(req);
      const target = test ? ctx.teamsTest : ctx.teams;
      if (!target.configured) throw new HttpError(503, `Teams isn't set up. Add the ${test ? 'test chat' : 'review channel'} webhook in Settings.`);
      if (!Array.isArray(logins) || typeof note !== 'string') throw new HttpError(400, 'Expected { logins: [], note: "" }.');
      if (note.length > NOTE_MAX) throw new HttpError(400, `Keep the note under ${NOTE_MAX} characters.`);
      const since = Date.now() - (lastSent.get(n) ?? 0);
      if (!test && since < COOLDOWN_MS) throw new HttpError(429, `Already sent for #${n}. You can send again in ${Math.ceil((COOLDOWN_MS - since) / 60000)} minutes.`);
      const d = await details(ctx, n, lookup);
      if (d.pr.author?.login !== d.login) throw new HttpError(409, 'You can only request reviews on your own PRs.');
      if (d.pr.state !== 'OPEN' || d.pr.isDraft) throw new HttpError(409, `#${n} isn't an open, ready-for-review PR.`);
      const byLogin = new Map(d.people.map((p) => [p.login, p]));
      const unknown = logins.filter((l) => !byLogin.has(l));
      if (unknown.length) throw new HttpError(400, `Not on this PR: ${unknown.join(', ')}`);
      if (!test) lastSent.set(n, Date.now()); // set before sending so a double click can't post twice; test sends are free
      try {
        await target.send(buildCard({ key: d.key, summary: d.summary, ticketUrl: d.ticketUrl, prNumber: d.pr.number, prUrl: d.pr.url, people: logins.map((l) => byLogin.get(l)), note }));
      } catch (err) {
        if (!test) lastSent.delete(n);
        throw new HttpError(err.status ?? 502, err.message);
      }
      return { ok: true, test: Boolean(test), sentAt: new Date().toISOString() };
    }],
  ];
}
