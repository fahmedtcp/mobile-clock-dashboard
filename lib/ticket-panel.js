// Ticket side panel and "last build" chips: a ticket's context without opening Jira.
// Jira description and comments are untrusted text: they're returned as plain strings, never markup.
import { REPO, JIRA } from '../config.js';
import { HttpError } from './http.js';
import { JiraError, adfText } from './jira.js';
import { requireJira, parseBuildComments, ticketKey, KEY_EXACT } from './tickets.js';
import { dayKey, monthOf } from './time/days.js';

const BUILD_TTL_MS = 10 * 60 * 1000;
const MAX_KEYS = 50;
const CONCURRENCY = 4;
const DESCRIPTION_MAX = 300;
const COMMENT_MAX = 200;
const PANEL_FIELDS = ['summary', 'status', 'assignee', 'fixVersions', 'issuetype', 'description'];

const newestFirst = (a, b) => Date.parse(b.created) - Date.parse(a.created);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function parseKeys(raw) {
  const keys = [...new Set(String(raw ?? '').split(',').map((k) => k.trim().toUpperCase()).filter(Boolean))];
  if (!keys.length || keys.length > MAX_KEYS || !keys.every((k) => KEY_EXACT.test(k))) {
    throw new HttpError(400, 'Send 1–50 ticket keys like TCPMOB-123.');
  }
  return keys;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Newest build per app and platform, newest first.
function latestPerTarget(comments) {
  const seen = new Set();
  return parseBuildComments(comments).sort(newestFirst).filter((build) => {
    const target = `${build.app} ${build.platform}`;
    if (seen.has(target)) return false;
    seen.add(target);
    return true;
  }).map(({ number, app, platform, destination, created }) => ({ number, app, platform, destination, created }));
}

function buildCache() {
  const cache = new Map(); // key -> { build | null, at }
  return async function latestBuild(jira, key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at <= BUILD_TTL_MS) return hit.build;
    const build = latestPerTarget(await jira.comments(key))[0] ?? null;
    cache.set(key, { build, at: Date.now() });
    return build;
  };
}

function panelTicket(issue) {
  const fields = issue.fields ?? {};
  return {
    key: issue.key,
    type: fields.issuetype?.name ?? '',
    summary: fields.summary ?? '',
    status: fields.status?.name ?? '',
    assignee: fields.assignee?.displayName ?? null,
    fixVersions: (fields.fixVersions ?? []).map((v) => v.name),
    url: `${String(JIRA.baseUrl).replace(/\/+$/, '')}/browse/${issue.key}`,
  };
}

function panelComments(comments) {
  return [...comments].sort(newestFirst).slice(0, 3).map((c) => ({
    author: c.author,
    created: c.created,
    text: clip(String(c.text ?? '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 2).join('\n'), COMMENT_MAX),
  }));
}

async function panelPrs(gh, key) {
  const prs = await gh.json(['pr', 'list', '-R', REPO, '--state', 'all', '--search', key, '-L', '20',
    '--json', 'number,title,url,state,reviewDecision,headRefName']);
  return prs.filter((pr) => ticketKey(pr.headRefName, pr.title) === key).sort((a, b) => b.number - a.number).slice(0, 3)
    .map(({ number, title, url, state, reviewDecision }) => ({ number, title, url, state, reviewDecision: reviewDecision ?? '' }));
}

// Hours actually logged: Tempo days count their Tempo hours, saved days count only once confirmed.
const loggedEntries = (day) => (day.tempoEntries ?? (day.state === 'confirmed' ? day.entries : []));

// This month's logged hours for the key, from the cached month only (never a cold build);
// null when time tracking is off or the month isn't loaded yet.
function panelHours(ctx, key) {
  const ym = monthOf(ctx.timeToday?.() ?? dayKey(new Date()));
  const month = ctx.timeMonthPeek?.(ym);
  if (!month || month.dayHours == null) return null;
  const hours = month.days.flatMap(loggedEntries).filter((e) => e.key === key).reduce((s, e) => s + e.hours, 0);
  return { ym, hours: Math.round(hours * 100) / 100 };
}

async function loadIssue(jira, key) {
  try {
    return await jira.getIssue(key, PANEL_FIELDS);
  } catch (err) {
    if (err instanceof JiraError && err.status === 404) throw new HttpError(404, `Couldn't find ${key} in Jira.`);
    throw err;
  }
}

async function ticketPanel(ctx, key) {
  const jira = requireJira(ctx);
  const issue = await loadIssue(jira, key);
  // GitHub being down only empties the PR list.
  const [comments, prs] = await Promise.all([jira.comments(key), panelPrs(ctx.gh, key).catch(() => [])]);
  const hours = panelHours(ctx, key);
  const ticket = panelTicket(issue);
  const builds = latestPerTarget(comments);
  return {
    ticket,
    description: clip(adfText(issue.fields?.description ?? '').trim(), DESCRIPTION_MAX),
    comments: panelComments(comments),
    builds,
    prs,
    hours,
    canSendToQa: ticket.status === 'Dev Review' && builds.length > 0,
  };
}

function panelKey(raw) {
  let key = '';
  try { key = decodeURIComponent(raw).toUpperCase(); } catch { /* malformed escape: rejected below */ }
  if (!KEY_EXACT.test(key)) throw new HttpError(400, 'Expected a ticket key like TCPMOB-123.');
  return key;
}

export function routes(ctx) {
  const latestBuild = buildCache();
  const handleLatestBuilds = async (m, req, url) => {
    const keys = parseKeys(url.searchParams.get('keys'));
    const jira = requireJira(ctx);
    // A Jira error for one key just leaves that key out.
    const builds = await mapLimit(keys, CONCURRENCY, (key) => latestBuild(jira, key).catch(() => null));
    return Object.fromEntries(keys.map((key, i) => [key, builds[i]]).filter(([, build]) => build));
  };
  return [
    ['GET', /^\/api\/builds\/latest$/, handleLatestBuilds],
    ['GET', /^\/api\/tickets\/([^/]+)\/panel$/, (m) => ticketPanel(ctx, panelKey(m[1]))],
  ];
}
