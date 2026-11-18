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

// ---------- cards ----------

// Untrusted text (Jira summaries, names) must not turn into links or formatting in the card.
const escapeMd = (text) => String(text ?? '').replace(/[\\`*_[\]]/g, (c) => `\\${c}`);
const cleanName = (name) => String(name ?? '').replace(/[<>/]/g, '').trim();
export const mentionText = (name) => `<at>${cleanName(name)}</at>`;

const textBlock = (text, extra = {}) => ({ type: 'TextBlock', text, wrap: true, ...extra });

function adaptiveMessage(body, entities) {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body,
        msteams: { width: 'Full', entities },
      },
    }],
  };
}

function personMention(person) {
  const name = cleanName(person.name);
  return { type: 'mention', text: mentionText(person.name), mentioned: { id: person.email, name } };
}

const TEXT_MAX = 2000;

// Default messages, editable in Settings. {name} placeholders are filled in; unknown ones stay as typed.
export const REVIEW_TEMPLATE = 'Hey Team!\n\nTicket: [{ticket}]({ticketUrl})\n\nPR: [PR#{pr}]({prUrl})\n\n'
  + 'is ready for Dev-Review, Kindly take a peak at your convenience.\n\nThanks';
export const QA_TEMPLATE = '[{ticketUrl}]({ticketUrl}) is ready for PRE-QA. Builds are mentioned in the ticket.\n\n{qaTag}';

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(values, name) ? String(values[name]) : match));

export const defaultReviewText = ({ key, ticketUrl, prNumber, prUrl }, template = '') =>
  fill(template || REVIEW_TEMPLATE, { ticket: key, ticketUrl, pr: prNumber, prUrl });

// {qaTag} becomes "@TagName": plain text the user can move anywhere; buildQaCard turns it into the mention.
export const defaultQaText = ({ key = '', ticketUrl, tagName = 'MobileHardware_QA' }, template = '') =>
  fill(template || QA_TEMPLATE, { ticket: key, ticketUrl, qaTag: `@${cleanName(tagName)}` });

// The message body the user typed (their own words, so links and bold work), or the default when none was sent.
export function validText(raw, fallback) {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string') throw new HttpError(400, 'Message text must be text.');
  const text = raw.trim();
  if (!text) throw new HttpError(400, 'Message text can\'t be empty.');
  if (text.length > TEXT_MAX) throw new HttpError(400, 'Keep the message under 2,000 characters.');
  return text;
}

// Title (escaped Jira summary), the message text, then the mentions, so they keep notifying people.
export function buildCard({ key, summary, ticketUrl, prNumber, prUrl, people = [], text }) {
  const footer = people.map((p) => (p.email ? mentionText(p.name) : escapeMd(cleanName(p.name)))).join(' ');
  const body = [
    textBlock(`${key} ${escapeMd(summary)}`.trim(), { weight: 'Bolder', size: 'Large' }),
    textBlock(text ?? defaultReviewText({ key, ticketUrl, prNumber, prUrl })),
    ...(footer ? [textBlock(footer)] : []),
  ];
  return adaptiveMessage(body, people.filter((p) => p.email).map(personMention));
}

// "Ready for PRE-QA" message for the QA channel. The tag sits wherever "@TagName" is in the text: a real @mention
// when its Teams tag ID is known, otherwise bold text (Workflows can't look tags up by name). No "@TagName", no tag.
export function buildQaCard({ summary, ticketUrl, tag, text }) {
  const name = cleanName(tag.name);
  const message = text ?? defaultQaText({ ticketUrl, tagName: name });
  const at = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
  const tagged = message.search(at) !== -1;
  const body = [
    textBlock(escapeMd(summary), { weight: 'Bolder', size: 'Large' }),
    textBlock(message.replace(at, tag.id ? mentionText(name) : `**${escapeMd(name)}**`)),
  ];
  const mention = { type: 'mention', text: mentionText(name), mentioned: { id: tag.id, name, type: 'tag' } };
  return adaptiveMessage(body, tag.id && tagged ? [mention] : []);
}

// ---------- webhook client ----------

const withStatus = (message, status) => Object.assign(new Error(message), { status });

export function createTeams({ webhookUrl, fetch = globalThis.fetch, label = 'review channel' }) {
  const configured = validWebhookUrl(webhookUrl);
  return {
    configured,
    async send(payload) {
      if (!configured) throw withStatus(`Teams isn't set up. Add the ${label} webhook in Settings.`, 503);
      let response;
      try {
        response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        throw withStatus(`Can't reach Teams: ${err.message}`, 502);
      }
      if (!response.ok) throw withStatus(`Teams rejected the message (${response.status}).`, 502);
    },
  };
}

// ---------- people ----------

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

async function githubName(gh, login) {
  try {
    return (await gh.run(['api', `users/${encodeURIComponent(login)}`, '--jq', '.name // ""'])).trim() || login;
  } catch {
    return login;
  }
}

// The email of the Jira user whose display name matches exactly, or null (a plain-text name is fine).
async function jiraEmail(jira, name) {
  try {
    const match = (await jira.userSearch(name)).find((u) => u.displayName?.toLowerCase() === name.toLowerCase());
    return match?.emailAddress ?? null;
  } catch {
    return null;
  }
}

// GitHub login → { name, email }: the name from the GitHub profile, the email from a Jira user with that exact name.
function createPeople(ctx) {
  const cache = new Map(); // login -> { login, name, email: from Jira }; overrides apply on top at return
  ctx.peopleCacheClear = () => cache.clear();
  return async (login) => {
    // Email overrides come from Settings at call time, so a change applies without a restart.
    const override = ctx.settings?.resolved().teams.people?.[login] ?? null;
    if (!cache.has(login)) {
      const name = await githubName(ctx.gh, login);
      const email = ctx.jira?.configured && name !== login ? await jiraEmail(ctx.jira, name) : null;
      cache.set(login, { login, name, email });
    }
    const person = cache.get(login);
    return { ...person, email: override ?? person.email };
  };
}

// ---------- ticket + PR details ----------

const jiraBase = () => String(JIRA.baseUrl).replace(/\/+$/, '');

function qaKey(raw) {
  const key = decodeURIComponent(raw).toUpperCase();
  if (!KEY_EXACT.test(key)) throw new HttpError(400, 'Expected a ticket key like TCPMOB-123.');
  return key;
}

const QA_STATUSES = new Set(['Dev Review', 'QA Review']);

async function qaDetails(ctx, key) {
  const jira = requireJira(ctx);
  const issue = await jira.getIssue(key, ['summary', 'status']);
  const status = issue.fields?.status?.name ?? '';
  let reason = null;
  // Dev Review: about to move to QA. QA Review: already moved, so QA can be messaged again.
  if (!QA_STATUSES.has(status)) reason = `${key} is ${status}, not Dev Review or QA Review.`;
  else if (!parseBuildComments(await jira.comments(key)).length) {
    reason = `${key} has no dev build posted yet. Build it first.`;
  }
  return { key, summary: issue.fields?.summary || key, ticketUrl: `${jiraBase()}/browse/${key}`, status, reason };
}

const PR_FIELDS = 'number,title,url,author,headRefName,isDraft,state,reviewRequests';

async function ticketSummary(jira, key, fallback) {
  if (!key || !jira?.configured) return fallback;
  try {
    return (await jira.getIssue(key, ['summary'])).fields?.summary || fallback;
  } catch {
    return fallback;
  }
}

async function currentUser(ctx, login) {
  if (ctx.jira?.configured) {
    try {
      const me = await ctx.jira.myself();
      return { login, name: me.displayName || login, email: me.emailAddress ?? null };
    } catch { /* keep login */ }
  }
  return { login, name: login, email: null };
}

// Requested reviewers minus people who've left (TEAMS_NEVER), plus people always tagged (TEAMS_ALWAYS).
function reviewerLogins(pr, { always, never }, myLogin) {
  const requested = (pr.reviewRequests ?? []).map((r) => r.login).filter(Boolean);
  return [...new Set([...requested, ...always])].filter((l) => !never.includes(l) && l !== myLogin);
}

async function details(ctx, prNumber, lookup) {
  const pr = await ctx.gh.json(['pr', 'view', String(prNumber), '-R', REPO, '--json', PR_FIELDS]);
  const prefs = ctx.teamsPrefs; // read before awaiting, so a Settings save mid-request can't change this one
  const key = ticketKey(pr.headRefName, pr.title);
  const summary = await ticketSummary(ctx.jira, key, pr.title);
  const login = await getLogin(ctx.gh);
  const me = await currentUser(ctx, login);
  const reviewers = await Promise.all(reviewerLogins(pr, prefs, login).map((l) => lookup(l)));
  const base = jiraBase();
  return {
    pr, login,
    key: key ?? `#${pr.number}`,
    title: key ? `${key} ${summary}` : pr.title,
    summary: key ? summary : pr.title.replace(/^#\d+\s*/, ''),
    ticketUrl: key && base ? `${base}/browse/${key}` : pr.url,
    people: [me, ...reviewers.filter((p) => p.login !== login)],
  };
}

// ---------- sending ----------

const COOLDOWN_MS = 30 * 60 * 1000;
const REVIEW_CHANNEL = { key: 'teams', label: 'review channel' };
const QA_CHANNEL = { key: 'teamsQa', label: 'QA channel' };

function sendTarget(ctx, test, channel) {
  const target = test ? ctx.teamsTest : ctx[channel.key];
  if (!target.configured) {
    throw new HttpError(503, `Teams isn't set up. Add the ${test ? 'test chat' : channel.label} webhook in Settings.`);
  }
  return target;
}

// One real send per id per COOLDOWN_MS; test sends are free.
function createCooldown() {
  const sentAt = new Map(); // id -> ms
  return {
    until: (id) => (sentAt.has(id) ? sentAt.get(id) + COOLDOWN_MS : null),
    assertReady(id, label) {
      const since = Date.now() - (sentAt.get(id) ?? 0);
      if (since < COOLDOWN_MS) {
        const minutes = Math.ceil((COOLDOWN_MS - since) / 60000);
        throw new HttpError(429, `Already sent for ${label}. You can send again in ${minutes} minutes.`);
      }
    },
    mark: (id) => sentAt.set(id, Date.now()),
    release: (id) => sentAt.delete(id),
  };
}

async function deliver({ target, cooldown, id, test }, card) {
  if (!test) cooldown.mark(id); // set before sending so a double click can't post twice
  try {
    await target.send(card);
  } catch (err) {
    if (!test) cooldown.release(id);
    throw new HttpError(err.status ?? 502, err.message);
  }
  return { ok: true, test: Boolean(test), sentAt: new Date().toISOString() };
}

const teamsSettings = (ctx) => ctx.settings?.resolved().teams ?? {};

function qaTag(ctx) {
  const teams = teamsSettings(ctx);
  return { name: teams.qaTagName || 'MobileHardware_QA', id: teams.qaTagId || '' };
}

const qaDefaultText = (ctx, qa) => defaultQaText({ ...qa, tagName: qaTag(ctx).name }, teamsSettings(ctx).qaTemplate);
const reviewDefaultText = (ctx, values) => defaultReviewText(values, teamsSettings(ctx).reviewTemplate);

function validateReviewInput(logins) {
  if (!Array.isArray(logins)) throw new HttpError(400, 'Expected { logins: [], text: "" }.');
}

// People added in the sheet just for one message: GitHub logins, at most 5, never saved.
const ADDED_MAX = 5;
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;
function validAdded(added) {
  if (!Array.isArray(added) || added.length > ADDED_MAX || !added.every((l) => GITHUB_LOGIN.test(String(l)))) {
    throw new HttpError(400, `Add up to ${ADDED_MAX} people by GitHub login, like octocat.`);
  }
  return added.map(String);
}

function assertCanRequestReview({ pr, login }, prNumber) {
  if (pr.author?.login !== login) throw new HttpError(409, 'You can only request reviews on your own PRs.');
  if (pr.state !== 'OPEN' || pr.isDraft) throw new HttpError(409, `#${prNumber} isn't an open, ready-for-review PR.`);
}

function chosenPeople(people, logins) {
  const byLogin = new Map(people.map((p) => [p.login, p]));
  const unknown = logins.filter((l) => !byLogin.has(l));
  if (unknown.length) throw new HttpError(400, `Not on this PR: ${unknown.join(', ')}`);
  return logins.map((l) => byLogin.get(l));
}

// ---------- routes ----------

// QA channel message: Dev Review or QA Review, with a dev build posted. Preview first; test chat first.
async function handleQaPreview({ ctx, cooldown }, key) {
  const qa = await qaDetails(ctx, key);
  const tag = qaTag(ctx);
  return {
    configured: ctx.teamsQa.configured, testConfigured: ctx.teamsTest.configured,
    key, title: qa.summary, ticketUrl: qa.ticketUrl, tag: { name: tag.name, mention: Boolean(tag.id) },
    status: qa.status, ready: !qa.reason, reason: qa.reason,
    cooldownUntil: cooldown.until(key),
    defaultText: qaDefaultText(ctx, qa),
  };
}

// force: the user chose Send Anyway inside the cooldown; deliver() still restarts the timer.
async function handleQaSend({ ctx, cooldown }, key, req) {
  const { test = false, text: rawText, force = false } = (await ctx.readJson(req)) ?? {};
  const target = sendTarget(ctx, test, QA_CHANNEL);
  if (!test && force !== true) cooldown.assertReady(key, key);
  const qa = await qaDetails(ctx, key);
  if (qa.reason) throw new HttpError(409, qa.reason);
  const text = validText(rawText, qaDefaultText(ctx, qa));
  const card = buildQaCard({ summary: qa.summary, ticketUrl: qa.ticketUrl, tag: qaTag(ctx), text });
  return deliver({ target, cooldown, id: key, test }, card);
}

async function handleReviewPreview({ ctx, cooldown, lookup }, prNumber) {
  const review = await details(ctx, prNumber, lookup);
  return {
    configured: ctx.teams.configured,
    testConfigured: ctx.teamsTest.configured,
    title: review.title, key: review.key, ticketUrl: review.ticketUrl,
    prNumber: review.pr.number, prUrl: review.pr.url,
    people: review.people.map((p) => ({ ...p, selected: true })),
    cooldownUntil: cooldown.until(prNumber),
    defaultText: reviewDefaultText(ctx, { key: review.key, ticketUrl: review.ticketUrl, prNumber: review.pr.number, prUrl: review.pr.url }),
  };
}

async function handleReviewSend({ ctx, cooldown, lookup }, prNumber, req) {
  const { logins = [], text: rawText, test = false, added = [], force = false } = await ctx.readJson(req);
  const target = sendTarget(ctx, test, REVIEW_CHANNEL);
  validateReviewInput(logins);
  validText(rawText, ''); // reject bad text before any lookups
  const extra = validAdded(added);
  if (!test && force !== true) cooldown.assertReady(prNumber, `#${prNumber}`);
  const review = await details(ctx, prNumber, lookup);
  assertCanRequestReview(review, prNumber);
  const known = new Set(review.people.map((p) => p.login));
  const addedPeople = await Promise.all(extra.filter((l) => !known.has(l)).map((l) => lookup(l)));
  const people = chosenPeople([...review.people, ...addedPeople], logins);
  const { key, summary, ticketUrl, pr } = review;
  const text = validText(rawText, reviewDefaultText(ctx, { key, ticketUrl, prNumber: pr.number, prUrl: pr.url }));
  const card = buildCard({ key, summary, ticketUrl, prNumber: pr.number, prUrl: pr.url, people, text });
  return deliver({ target, cooldown, id: prNumber, test }, card);
}

export function routes(ctx) {
  // Real values come from Settings (applySettings in server.js); these are placeholders until then.
  ctx.teams ??= createTeams({ webhookUrl: '' });
  ctx.teamsTest ??= createTeams({ webhookUrl: '', label: 'test chat' });
  ctx.teamsQa ??= createTeams({ webhookUrl: '', label: 'QA channel' });
  ctx.teamsPrefs ??= { always: [], never: [] };
  const review = { ctx, lookup: createPeople(ctx), cooldown: createCooldown() }; // cooldown by PR number
  const qa = { ctx, cooldown: createCooldown() }; // cooldown by ticket key

  return [
    ['GET', /^\/api\/tickets\/([^/]+)\/qa-request$/, (m) => handleQaPreview(qa, qaKey(m[1]))],
    ['POST', /^\/api\/tickets\/([^/]+)\/qa-request$/, (m, req) => handleQaSend(qa, qaKey(m[1]), req)],
    ['GET', /^\/api\/prs\/([^/]+)\/review-request$/, (m) => handleReviewPreview(review, ctx.id(m[1]))],
    ['GET', /^\/api\/people\/([^/]+)$/, (m) => {
      const login = decodeURIComponent(m[1]);
      if (!GITHUB_LOGIN.test(login)) throw new HttpError(400, 'Use a GitHub login, like octocat.');
      return review.lookup(login);
    }],
    ['POST', /^\/api\/prs\/([^/]+)\/review-request$/, (m, req) => handleReviewSend(review, ctx.id(m[1]), req)],
  ];
}
