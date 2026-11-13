// Time tracking routes: assemble a month from all sources, save days, list pending days, export.
import path from 'node:path';
import { CLAUDE_PROJECTS_DIR, LOCAL, JIRA, TIME, TEMPO, REPO } from '../../config.js';
import { githubByDay } from './github.js';
import { getLogin } from '../runs.js';
import { createTempo, tempoByDay, round2 } from './tempo.js';
import { syncRoutes } from './sync.js';
import { HttpError, raw } from '../http.js';
import { dayKey, workdays, monthRange, monthBounds, validYm, validDay, monthOf } from './days.js';
import { snapshot, loadDay } from './claude.js';
import { commitsByDay } from './git.js';
import { jiraByDay } from './jira.js';
import { dayWeights, allocate, evidenceText } from './allocate.js';
import { createStore, validateDay, dayHoursOf } from './store.js';
import { requireJira, KEY_EXACT } from '../tickets.js';

const MONTH_TTL_MS = 5 * 60 * 1000;
const MAYBE_MAX = 4;          // "maybe you worked on" tickets per day
const MAYBE_LIGHT_MIN = 0.5;  // tool-output-only Claude mentions need about 5 before they're worth asking about
const ANY = { has: () => true }; // dayWeights without the "my tickets only" filter
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');
const localTime = (date) => [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad2).join(':');
const localIso = (date) => `${dayKey(date)}T${localTime(date)}`;

export function defaultSources(ctx) {
  let lastSnap = 0;
  return {
    reset() { lastSnap = 0; }, // Refresh: read Claude's transcripts again now
    async claude(ym) {
      let problem = null;
      if (Date.now() - lastSnap > SNAPSHOT_TTL_MS) {
        try {
          await snapshot(CLAUDE_PROJECTS_DIR, ctx.timeDir);
          lastSnap = Date.now();
        } catch (err) {
          problem = err.message;
        }
      }
      const sessionsByDay = new Map(workdays(ym).map((day) => [day, loadDay(ctx.timeDir, day)]));
      // Saved history still counts when the transcripts folder is gone; only report it when there's nothing to show.
      if (problem && ![...sessionsByDay.values()].some((list) => list.length)) throw new Error(problem);
      return sessionsByDay;
    },
    async git(ym) {
      const { start, end } = monthRange(ym);
      return commitsByDay(undefined, LOCAL.mobileClockPath, { since: localIso(start), until: localIso(end) });
    },
    async github(ym) {
      return githubByDay(ctx.gh, { repo: REPO, login: await getLogin(ctx.gh), ym });
    },
    async jira(ym) {
      const jira = requireJira(ctx);
      // Shared with Tempo and cleared on every Settings save, so switching Jira accounts takes effect.
      return jiraByDay(jira, { ym, accountId: await tempoAccountId(ctx), baseUrl: JIRA.baseUrl });
    },
  };
}

export async function tempoAccountId(ctx) {
  ctx.tempoAccountId ??= (await requireJira(ctx).myself()).accountId;
  return ctx.tempoAccountId;
}

// Issues by id or key. Jira fails the whole `in (…)` query when one value is unknown or hidden,
// so fall back to one lookup per value and leave the misses out.
export async function lookupIssues(jira, field, values, fields) {
  if (!values.length) return [];
  try {
    return await jira.search(`${field} in (${values.join(',')})`, fields, values.length);
  } catch {
    const found = await Promise.all(values.map((value) => jira.getIssue(value, fields).catch(() => null)));
    return found.filter(Boolean);
  }
}

const LOGGED_TTL_MS = 5 * 60 * 1000;

// One read of the month's worklogs; also records which days are logged, for the badge and the reminder.
async function tempoLogs(ctx, ym) {
  const { from, to } = monthBounds(ym);
  const logs = await ctx.tempo.worklogs(await tempoAccountId(ctx), from, to);
  ctx.tempoLogged.set(ym, new Set(logs.map((log) => log.date)));
  ctx.tempoLoggedAt.set(ym, Date.now());
  return logs;
}

// Cheap and cached, so pending days know about hand-logged ones without building the whole month.
async function refreshTempoLogged(ctx, ym) {
  const stale = Date.now() - (ctx.tempoLoggedAt.get(ym) ?? 0) > LOGGED_TTL_MS;
  if (stale || !ctx.tempoLogged.has(ym)) await tempoLogs(ctx, ym);
}

// The month's Tempo worklogs by day, with issue ids mapped to keys through Jira. Null when Tempo is off.
async function tempoMonth(ctx, ym) {
  if (!ctx.tempo.configured) return null;
  const logs = await tempoLogs(ctx, ym);
  const ids = [...new Set(logs.map((log) => log.issueId).filter((id) => /^\d+$/.test(id)))];
  const issues = await lookupIssues(ctx.jira, 'id', ids, ['summary']);
  const keyById = new Map(issues.map((issue) => [String(issue.id), issue.key]));
  const summaries = new Map(issues.map((issue) => [issue.key, issue.fields?.summary ?? '']));
  return { byDay: tempoByDay(logs, keyById), summaries };
}

// Differences between the user's edits and Tempo, one per key, in key order.
function tempoFlags(tempoEntries, edits) {
  const tempoHours = new Map(tempoEntries.map((e) => [e.key, e.hours]));
  const yourHours = new Map(edits.map((e) => [e.key, e.hours]));
  return [...new Set([...tempoHours.keys(), ...yourHours.keys()])].sort()
    .map((key) => ({ key, tempoHours: tempoHours.get(key) ?? 0, yourHours: yourHours.get(key) ?? 0 }))
    .filter((flag) => Math.abs(flag.tempoHours - flag.yourHours) > 0.001);
}

async function settle(promise) {
  try {
    return { value: await promise, error: null };
  } catch (err) {
    return { value: null, error: err.message || 'Failed' };
  }
}

const NOT_LOADED = { value: null, error: null };
const noJira = () => ({ tickets: new Map(), inProgressDays: new Map(), activity: new Map() });

function tempoStatus(ctx, error) {
  return { configured: ctx.tempo.configured, status: ctx.tempo.configured ? (error ?? 'ok') : 'off' };
}

// Every source at once; a failing source leaves an empty default and its message in `sources`.
async function loadSources(ctx, ym) {
  const src = ctx.timeSources;
  const [claude, git, jira, tempo, github] = await Promise.all([
    settle(src.claude(ym)), settle(src.git(ym)), settle(src.jira(ym)), settle(tempoMonth(ctx, ym)),
    src.github ? settle(src.github(ym)) : NOT_LOADED,
  ]);
  return {
    claude: claude.value ?? new Map(),
    git: git.value?.byDay ?? new Map(),
    github: github.value?.byDay ?? new Map(),
    jira: jira.value ?? noJira(),
    jiraFailed: Boolean(jira.error),
    tempo: tempo.value,
    tempoState: tempoStatus(ctx, tempo.error),
    sources: {
      claude: claude.error ?? 'ok',
      git: git.error ?? git.value?.error ?? 'ok',
      jira: jira.error ?? 'ok',
      github: github.error ?? 'ok',
    },
  };
}

// Only real tickets get hours. Without Jira, fall back to every key the other sources saw.
function knownTickets({ jira, jiraFailed, git, github, claude }) {
  const known = new Set(jira.tickets.keys());
  if (!jiraFailed) return known;
  for (const commits of git.values()) for (const commit of commits) if (commit.key) known.add(commit.key);
  for (const events of github.values()) for (const event of events) if (event.key) known.add(event.key);
  for (const sessions of claude.values()) {
    for (const session of sessions) for (const seg of session.segments ?? []) if (seg.key) known.add(seg.key);
  }
  return known;
}

function ticketInfoLookup(jira, tempo) {
  return (key) => jira.tickets.get(key) ?? {
    key,
    summary: tempo?.summaries.get(key) ?? '',
    url: `${String(JIRA.baseUrl).replace(/\/+$/, '')}/browse/${key}`,
  };
}

function daySignals(sources, date) {
  const { jira, git, claude, github } = sources;
  const inProgress = new Set([...jira.inProgressDays].filter(([, days]) => days.has(date)).map(([key]) => key));
  const activity = new Map([...jira.activity].map(([key, byDay]) => [key, byDay.get(date) ?? 0]).filter(([, n]) => n));
  return {
    inProgress, commits: git.get(date) ?? [], claude: claude.get(date) ?? [], activity, github: github.get(date) ?? [],
  };
}

const weightsOnly = (weights) => new Map([...weights].map(([key, v]) => [key, v.weight]));

// Weight of keys Claude saw only in passing (tool output) in sessions where they never named a segment.
function lightMentions(sessions) {
  const light = new Map();
  for (const session of sessions) {
    const named = new Set((session.segments ?? []).map((seg) => seg.key));
    for (const [key, weight] of Object.entries(session.keyCounts ?? {})) {
      if (!named.has(key)) light.set(key, (light.get(key) ?? 0) + weight);
    }
  }
  return light;
}

// Maybe: evidence that didn't earn hours on its own: someone else's ticket (a review, a build), a ticket past the
// 5-per-day cap, or one Claude saw mentioned but never worked on as the main topic. The user decides.
function maybeCandidates(entries, allWeights, light) {
  const have = new Set(entries.map((e) => e.key));
  const candidates = new Map();
  for (const [key, v] of allWeights) {
    if (!have.has(key)) candidates.set(key, { weight: v.weight, evidence: evidenceText(v.evidence) });
  }
  for (const [key, weight] of light) {
    if (have.has(key) || candidates.has(key) || !(weight >= MAYBE_LIGHT_MIN)) continue;
    candidates.set(key, { weight: weight / 10, evidence: 'Mentioned in Claude' });
  }
  return [...candidates].sort((a, b) => b[1].weight - a[1].weight).map(([key, c]) => ({ key, evidence: c.evidence }));
}

function entryEnricher(ticketInfo, weights) {
  const evidence = (key) => (weights.has(key) ? evidenceText(weights.get(key).evidence) : 'Added by you');
  return (e) => ({
    ...ticketInfo(e.key), key: e.key, hours: e.hours, manual: Boolean(e.manual), evidence: evidence(e.key),
  });
}

// Tempo is the source of truth: a day with any Tempo worklog shows Tempo's hours (or the user's edits on top).
function tempoDay(ctx, { date, dayHours, inTempo, enrich, pool }) {
  let edits = ctx.tempoEdits.get(date)?.entries ?? null;
  const flags = edits ? tempoFlags(inTempo, edits) : [];
  if (edits && !flags.length) {
    ctx.tempoEdits.save(date, null);
    edits = null;
  }
  const tempoTotal = inTempo.reduce((sum, e) => sum + e.hours, 0);
  return {
    date, state: 'tempo', dayHours, target: dayHours, leaveHours: Math.max(0, round2(dayHours - tempoTotal)),
    entries: (edits ?? inTempo).map(enrich), tempoEntries: inTempo, flags,
    readOnlyKeys: inTempo.map((e) => e.key).filter((key) => !KEY_EXACT.test(key)), pool, suggested: false,
  };
}

function savedState(record, dayHours, leaveHours) {
  if (leaveHours >= dayHours) return 'leave';
  return record.status === 'confirmed' ? 'confirmed' : 'review';
}

// One workday's state, entries, and maybe list, in the field order the page reads.
function buildDay(ctx, date, month) {
  if (date > month.today) {
    const hours = month.dayHours;
    return { date, state: 'future', dayHours: hours, target: hours, leaveHours: 0, entries: [], suggested: false };
  }
  const record = ctx.timeStore.get(date);
  const dayHours = record ? dayHoursOf(record) : month.dayHours; // a saved day keeps its own workday length
  const leaveHours = record?.leaveHours ?? 0;
  const target = dayHours - leaveHours;
  const signals = daySignals(month, date);
  const weights = dayWeights(signals, month.known);
  const enrich = entryEnricher(month.ticketInfo, weights);
  // The pool is the full-day suggestion: the page refills from it when leave is lowered, even after a reload.
  const pool = allocate(weightsOnly(weights), dayHours).map(enrich);
  const inTempo = month.tempo?.byDay.get(date);
  // Edits only mean something against Tempo hours; once a day has none, old edits are stale.
  if (month.tempo && !inTempo?.length && ctx.tempoEdits.get(date)) ctx.tempoEdits.save(date, null);

  let day;
  if (inTempo?.length) {
    day = tempoDay(ctx, { date, dayHours, inTempo, enrich, pool });
  } else if (record) {
    const state = savedState(record, dayHours, leaveHours);
    day = { date, state, dayHours, target, leaveHours, entries: record.entries.map(enrich), pool, suggested: false };
  } else {
    const entries = allocate(weightsOnly(weights), target).map(enrich);
    const state = entries.length ? 'review' : 'nodata';
    day = { date, state, dayHours, target, leaveHours, entries, pool, suggested: true };
  }
  day.maybe = maybeCandidates(day.entries, dayWeights(signals, ANY), lightMentions(signals.claude));
  return day;
}

export async function buildMonth(ctx, ym) {
  // No workday length yet (a new teammate): time tracking stays off until it's set in Settings.
  const dayHours = TIME.dayHours;
  if (dayHours == null) {
    const tempo = tempoStatus(ctx, null);
    return { ym, today: ctx.timeToday(), dayHours: null, days: [], tickets: [], sources: {}, tempo };
  }
  const loaded = await loadSources(ctx, ym);
  const known = knownTickets(loaded);
  const today = ctx.timeToday();
  const ticketInfo = ticketInfoLookup(loaded.jira, loaded.tempo);
  const month = { ...loaded, known, today, dayHours, ticketInfo };
  const days = workdays(ym).map((date) => buildDay(ctx, date, month));
  await nameMaybes(ctx, days, loaded.jira.tickets, ticketInfo);
  const tickets = [...known].map(ticketInfo).sort((a, b) => a.key.localeCompare(b.key));
  return { ym, today, dayHours, days, tickets, sources: loaded.sources, tempo: loaded.tempoState };
}

// Give maybe tickets their Jira titles. Tickets that aren't the user's are looked up once per month; epics,
// initiatives, and keys Jira doesn't know are dropped, so the list only offers real work items.
async function nameMaybes(ctx, days, mine, ticketInfo) {
  const maybeKeys = days.flatMap((day) => (day.maybe ?? []).map((m) => m.key));
  const unknown = [...new Set(maybeKeys.filter((key) => !mine.has(key)))];
  const found = await lookupMaybes(ctx, unknown);
  const skip = (key) => {
    if (mine.has(key) || !found) return false; // Jira unreachable: show them without a title rather than hide them
    const issue = found.get(key);
    return !issue || ['Epic', 'Initiative'].includes(issue.fields?.issuetype?.name);
  };
  const summaryOf = (key) => mine.get(key)?.summary ?? found?.get(key)?.fields?.summary ?? '';
  for (const day of days) {
    if (!day.maybe) continue;
    day.maybe = day.maybe.filter((m) => !skip(m.key)).slice(0, MAYBE_MAX)
      .map((m) => ({ ...ticketInfo(m.key), summary: summaryOf(m.key), key: m.key, evidence: m.evidence }));
  }
}

// key -> issue for tickets that aren't the user's, or null when there are none or Jira can't answer.
async function lookupMaybes(ctx, keys) {
  if (!keys.length || !ctx.jira?.configured) return null;
  try {
    const issues = await lookupIssues(ctx.jira, 'key', keys, ['summary', 'issuetype']);
    return new Map(issues.map((issue) => [issue.key, issue]));
  } catch {
    return null;
  }
}

const GRACE_DAYS = 5; // last month still counts during the first days of a new month

async function pending(ctx) {
  if (TIME.dayHours == null) return { count: 0, days: [] };
  const today = ctx.timeToday();
  const lastMonth = new Date(`${monthOf(today)}-01T12:00:00`);
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const months = Number(today.slice(8)) <= GRACE_DAYS ? [monthOf(dayKey(lastMonth)), monthOf(today)] : [monthOf(today)];
  if (ctx.tempo.configured) {
    const fallBackToLocalRecords = () => {};
    await Promise.all(months.map((ym) => refreshTempoLogged(ctx, ym).catch(fallBackToLocalRecords)));
  }
  const days = months.flatMap(workdays).filter((day) => {
    if (day >= today) return false;
    if (ctx.tempoLogged.get(monthOf(day))?.has(day)) return false;
    const record = ctx.timeStore.get(day);
    return record?.status !== 'confirmed' && (record?.leaveHours ?? 0) < dayHoursOf(record);
  });
  return { count: days.length, days };
}

// Jira summaries are untrusted and this file opens in Excel/Sheets: neutralize formulas, quote separators.
export function csvCell(v) {
  let text = String(v ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const EXPORT_COLUMNS = ['date', 'key', 'hours', 'summary', 'evidence'];
const EXPORTED_STATES = new Set(['confirmed', 'leave', 'tempo']);

function leaveRow(day, evidence) {
  return day.leaveHours ? [{ date: day.date, key: 'LEAVE', hours: day.leaveHours, summary: 'Leave', evidence }] : [];
}

// A Tempo day exports what Tempo has; any other exported day exports its saved entries.
function exportRows(day) {
  if (day.state === 'tempo') {
    return [
      ...leaveRow(day, 'Not logged in Tempo'),
      ...day.tempoEntries.map((e) => ({
        date: day.date, key: e.key, hours: e.hours,
        summary: day.entries.find((x) => x.key === e.key)?.summary ?? '', evidence: 'In Tempo',
      })),
    ];
  }
  return [
    ...leaveRow(day, ''),
    ...day.entries.map((e) => ({
      date: day.date, key: e.key, hours: e.hours, summary: e.summary, evidence: e.evidence,
    })),
  ];
}

function exportFile(ym, format, rows) {
  const disposition = `attachment; filename=tempo-${ym}.${format}`;
  if (format === 'json') {
    const json = JSON.stringify(rows, null, 2);
    return raw({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': disposition }, json);
  }
  const lines = rows.map((row) => EXPORT_COLUMNS.map((col) => csvCell(row[col] ?? '')).join(','));
  const csv = [EXPORT_COLUMNS.join(','), ...lines].join('\n');
  return raw({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': disposition }, csv);
}

function dayParam(match) {
  const date = decodeURIComponent(match[1]);
  if (!validDay(date)) throw new HttpError(400, 'Invalid date.');
  return date;
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return entries;
  return entries.map((e) => ({ key: String(e?.key ?? '').toUpperCase(), hours: e?.hours, manual: Boolean(e?.manual) }));
}

function dayRecord(body, dayHours) {
  return {
    status: body.confirm ? 'confirmed' : 'draft',
    dayHours,
    leaveHours: body.leaveHours ?? 0,
    entries: normalizeEntries(body.entries),
    confirmedAt: body.confirm ? new Date().toISOString() : null,
  };
}

function initTimeContext(ctx) {
  ctx.timeDir ??= path.join(process.cwd(), 'data', 'time');
  ctx.timeStore ??= createStore(path.join(ctx.timeDir, 'confirmed.json'));
  ctx.timeSources ??= defaultSources(ctx);
  ctx.timeToday ??= () => dayKey(new Date());
  ctx.tempo ??= createTempo(TEMPO);
  ctx.tempoEdits ??= createStore(path.join(ctx.timeDir, 'tempo-edits.json'));
  ctx.tempoLogged ??= new Map();
  ctx.tempoLoggedAt ??= new Map();
}

// The month, built at most once per MONTH_TTL_MS unless `fresh` asks for a rebuild (which also re-reads Claude).
function monthCache(ctx) {
  const cache = new Map();
  const month = async (ym, { fresh = false } = {}) => {
    if (fresh) {
      cache.delete(ym);
      ctx.timeSources.reset?.();
    }
    const hit = cache.get(ym);
    if (hit && Date.now() - hit.at <= MONTH_TTL_MS) return hit.data;
    const data = await buildMonth(ctx, ym);
    cache.set(ym, { data, at: Date.now() });
    return data;
  };
  return { month, clearCache: () => cache.clear() };
}

export function routes(ctx) {
  initTimeContext(ctx);
  const { month, clearCache } = monthCache(ctx);
  ctx.timeMonthCacheClear = clearCache;
  ctx.timeMonth = month;
  ctx.timePending = async () => (await pending(ctx)).days;

  const ymParam = (url) => {
    const ym = url.searchParams.get('ym') || monthOf(ctx.timeToday());
    if (!validYm(ym)) throw new HttpError(400, 'Expected ym like 2026-11.');
    return ym;
  };

  const handleMonth = (m, req, url) => month(ymParam(url), { fresh: url.searchParams.get('fresh') === '1' });

  // Refresh a day: drop its unconfirmed draft (and notes on a Tempo day) so fresh suggestions show.
  // Confirmed days stay.
  const handleResetDay = (m) => {
    const date = dayParam(m);
    if (ctx.timeStore.get(date)?.status === 'confirmed') {
      throw new HttpError(409, 'This day is confirmed, so its hours stay. Edit them instead.');
    }
    ctx.timeStore.save(date, null);
    ctx.tempoEdits.save(date, null);
    clearCache();
    return { ok: true, date };
  };

  const handleSaveDay = async (m, req) => {
    const date = decodeURIComponent(m[1]);
    const body = await ctx.readJson(req);
    const existing = ctx.timeStore.get(date);
    const dayHours = existing ? dayHoursOf(existing) : TIME.dayHours;
    if (dayHours == null) throw new HttpError(409, 'Set your workday hours in Settings first.');
    const record = dayRecord(body, dayHours);
    const error = validateDay(date, record, ctx.timeToday());
    if (error) throw new HttpError(400, error);
    ctx.timeStore.save(date, record);
    clearCache();
    return { ok: true, date, status: record.status };
  };

  const handleExport = async (m, req, url) => {
    const ym = ymParam(url);
    const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';
    const rows = (await month(ym)).days.filter((day) => EXPORTED_STATES.has(day.state)).flatMap(exportRows);
    return exportFile(ym, format, rows);
  };

  return [
    ['GET', /^\/api\/time\/month$/, handleMonth],
    ['POST', /^\/api\/time\/day\/([^/]+)\/reset$/, handleResetDay],
    ['GET', /^\/api\/time\/pending$/, () => pending(ctx)],
    ['POST', /^\/api\/time\/day\/([^/]+)$/, handleSaveDay],
    ['GET', /^\/api\/time\/export$/, handleExport],
    ...syncRoutes(ctx, { month, clearCache }),
  ];
}
