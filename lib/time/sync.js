// Tempo preview, send, and edit routes. The browser sends only dates: every worklog is built from the
// server's own confirmed day, and each day is re-checked against Tempo right before posting, so a day
// that already has any Tempo worklog is never sent (no double logs, no updates, no deletes).
import { HttpError } from '../http.js';
import { isWorkday, validDay, monthOf } from './days.js';
import { statusAtEndOfDay, toPayload } from './tempo.js';
import { dayHoursOf } from './store.js';
import { tempoAccountId, lookupIssues } from './routes.js';

const MAX_DATES = 23; // a month of workdays
const KEY = /^([A-Z][A-Z0-9]+-\d+|#\d+)$/; // '#<id>' is a Tempo worklog Jira couldn't map
const NOT_SET_UP = 'Tempo isn\'t set up. Add your Tempo token in Settings.';

function parseDates(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_DATES) {
    throw new HttpError(400, `Send 1–${MAX_DATES} dates.`);
  }
  const dates = [...new Set(list.map(String))];
  for (const date of dates) if (!validDay(date)) throw new HttpError(400, `Invalid date: ${date.slice(0, 20)}`);
  return dates;
}

function requireTempo(ctx) {
  if (!ctx.tempo.configured) throw new HttpError(503, NOT_SET_UP);
}

// Why a day can't be sent, or null. `logged` is the set of dates Tempo already has worklogs for.
function skipReason(ctx, date, logged) {
  if (date > ctx.timeToday()) return 'Future day';
  if (!isWorkday(date)) return 'Not a workday';
  if (logged.has(date)) return 'Already in Tempo';
  const record = ctx.timeStore.get(date);
  if (record?.status !== 'confirmed') return 'Not confirmed';
  if ((record.leaveHours ?? 0) >= dayHoursOf(record) || !record.entries.length) return 'Full day of leave';
  return null;
}

// key -> { id, histories, current } for the given keys, memoized per request.
function ticketLookup(ctx) {
  const cache = new Map();
  const fetchMissing = async (missing) => {
    const issues = await lookupIssues(ctx.jira, 'key', missing, ['status']);
    await Promise.all(missing.map(async (key) => {
      const issue = issues.find((i) => i.key === key);
      if (!issue) { cache.set(key, null); return; }
      const histories = await ctx.jira.changelog(key);
      cache.set(key, { id: String(issue.id), current: issue.fields?.status?.name ?? '', histories });
    }));
  };
  return async (keys) => {
    const missing = keys.filter((key) => !cache.has(key));
    if (missing.length) await fetchMissing(missing);
    return new Map(keys.map((key) => [key, cache.get(key)]));
  };
}

async function worklogsFor(ctx, date, lookup) {
  const entries = ctx.timeStore.get(date).entries;
  const tickets = await lookup(entries.map((e) => e.key));
  return entries.map((e) => {
    const ticket = tickets.get(e.key);
    const description = ticket ? statusAtEndOfDay(ticket.histories, ticket.current, date) : '';
    return { key: e.key, hours: e.hours, issueId: ticket?.id ?? null, description };
  });
}

const previewWorklog = ({ key, hours, description }) => ({ key, hours, description });

// The worklogs to send for a day, or a finished result when the day is skipped or can't be prepared.
async function prepareDay(ctx, date, { accountId, lookup }) {
  try {
    // Fresh check, never cached: any worklog Tempo returns for this day means hands off.
    const fresh = await ctx.tempo.worklogs(accountId, date, date);
    const reason = skipReason(ctx, date, fresh.length ? new Set([date]) : new Set());
    if (reason) return { result: { date, status: 'skipped', sent: 0, reason } };
    return { worklogs: await worklogsFor(ctx, date, lookup) };
  } catch (err) {
    // Nothing was posted for this day; keep going so the other days' results aren't lost.
    return { result: { date, status: 'failed', sent: 0, errors: [err.message] } };
  }
}

// Posts each worklog; one failure doesn't stop the rest.
async function postWorklogs(ctx, date, { accountId, worklogs }) {
  let sent = 0;
  const errors = [];
  for (const worklog of worklogs) {
    const label = `${worklog.key} ${worklog.hours}h`;
    if (!worklog.issueId) { errors.push(`${label}: not found in Jira`); continue; }
    try {
      const { issueId, hours, description } = worklog;
      await ctx.tempo.create(toPayload({ issueId, hours, date, description, accountId }));
      sent++;
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
    }
  }
  return { sent, errors };
}

async function sendDay(ctx, date, { accountId, lookup }) {
  const { result, worklogs } = await prepareDay(ctx, date, { accountId, lookup });
  if (result) return result;
  const { sent, errors } = await postWorklogs(ctx, date, { accountId, worklogs });
  if (!errors.length) {
    ctx.tempoEdits.save(date, null);
    return { date, status: 'sent', sent };
  }
  // Some worklogs went in: the day is now "in Tempo", so record the full day as edits to flag what's missing.
  if (sent) ctx.tempoEdits.save(date, { entries: worklogs.map(({ key, hours }) => ({ key, hours })) });
  return { date, status: sent ? 'partial' : 'failed', sent, errors };
}

function parseEdits(entries) {
  if (!Array.isArray(entries)) throw new HttpError(400, 'Entries must be a list.');
  const seen = new Set();
  return entries.map((e) => {
    const key = String(e?.key ?? '').toUpperCase();
    const hours = e?.hours;
    if (!KEY.test(key)) throw new HttpError(400, `Invalid ticket key: ${key.slice(0, 40)}`);
    if (seen.has(key)) throw new HttpError(400, `${key} appears twice.`);
    seen.add(key);
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24) {
      throw new HttpError(400, `${key}: hours must be between 0 and 24.`);
    }
    return { key, hours };
  });
}

export function syncRoutes(ctx, { month, clearCache }) {
  const locks = new Set();

  const handlePreview = async (m, req, url) => {
    requireTempo(ctx);
    const dates = parseDates(String(url.searchParams.get('dates') ?? '').split(',').filter(Boolean));
    const accountId = await tempoAccountId(ctx);
    const sorted = [...dates].sort();
    const logged = new Set((await ctx.tempo.worklogs(accountId, sorted[0], sorted.at(-1))).map((w) => w.date));
    const lookup = ticketLookup(ctx);
    const days = [];
    for (const date of dates) {
      const reason = skipReason(ctx, date, logged);
      if (reason) { days.push({ date, ok: false, reason, worklogs: [] }); continue; }
      const worklogs = (await worklogsFor(ctx, date, lookup)).map(previewWorklog);
      days.push({ date, ok: true, worklogs });
    }
    const totalHours = days.flatMap((day) => day.worklogs).reduce((sum, w) => sum + w.hours, 0);
    return { days, totalHours };
  };

  const handleSend = async (m, req) => {
    const body = await ctx.readJson(req);
    requireTempo(ctx);
    const dates = parseDates(body?.dates);
    // Claim every date before any await, so a second tab or double click can't race this one.
    const busy = dates.find((date) => locks.has(date));
    if (busy) throw new HttpError(409, `Already sending ${busy}.`);
    dates.forEach((date) => locks.add(date));
    try {
      const accountId = await tempoAccountId(ctx);
      const lookup = ticketLookup(ctx);
      const results = [];
      for (const date of dates) results.push(await sendDay(ctx, date, { accountId, lookup }));
      return { results };
    } finally {
      dates.forEach((date) => locks.delete(date));
      clearCache();
    }
  };

  const handleEdits = async (m, req) => {
    const date = decodeURIComponent(m[1]);
    if (!validDay(date)) throw new HttpError(400, 'Invalid date.');
    const body = await ctx.readJson(req);
    const inTempo = () => ctx.tempoLogged.get(monthOf(date))?.has(date);
    if (!inTempo()) await month(monthOf(date));
    if (!inTempo()) throw new HttpError(400, 'That day isn\'t in Tempo.');
    ctx.tempoEdits.save(date, { entries: parseEdits(body?.entries) });
    clearCache();
    return { ok: true };
  };

  return [
    ['GET', /^\/api\/time\/tempo\/preview$/, handlePreview],
    ['POST', /^\/api\/time\/tempo\/send$/, handleSend],
    ['POST', /^\/api\/time\/tempo\/edits\/([^/]+)$/, handleEdits],
  ];
}
