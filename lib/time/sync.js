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
  if (!Array.isArray(list) || !list.length || list.length > MAX_DATES) throw new HttpError(400, `Send 1–${MAX_DATES} dates.`);
  const dates = [...new Set(list.map(String))];
  for (const d of dates) if (!validDay(d)) throw new HttpError(400, `Invalid date: ${d.slice(0, 20)}`);
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
  const rec = ctx.timeStore.get(date);
  if (rec?.status !== 'confirmed') return 'Not confirmed';
  if ((rec.leaveHours ?? 0) >= dayHoursOf(rec) || !rec.entries.length) return 'Full day of leave';
  return null;
}

// key -> { id, histories, current } for the given keys, memoized per request.
function ticketLookup(ctx) {
  const cache = new Map();
  return async (keys) => {
    const missing = keys.filter((k) => !cache.has(k));
    if (missing.length) {
      const issues = await lookupIssues(ctx.jira, 'key', missing, ['status']);
      await Promise.all(missing.map(async (key) => {
        const issue = issues.find((i) => i.key === key);
        cache.set(key, issue ? { id: String(issue.id), current: issue.fields?.status?.name ?? '', histories: await ctx.jira.changelog(key) } : null);
      }));
    }
    return new Map(keys.map((k) => [k, cache.get(k)]));
  };
}

async function worklogsFor(ctx, date, lookup) {
  const entries = ctx.timeStore.get(date).entries;
  const info = await lookup(entries.map((e) => e.key));
  return entries.map((e) => {
    const t = info.get(e.key);
    return { key: e.key, hours: e.hours, issueId: t?.id ?? null, description: t ? statusAtEndOfDay(t.histories, t.current, date) : '' };
  });
}

export function syncRoutes(ctx, { month, clearCache }) {
  const locks = new Set();

  return [
    ['GET', /^\/api\/time\/tempo\/preview$/, async (m, req, url) => {
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
        days.push({ date, ok: true, worklogs: (await worklogsFor(ctx, date, lookup)).map(({ key, hours, description }) => ({ key, hours, description })) });
      }
      const totalHours = days.flatMap((d) => d.worklogs).reduce((a, w) => a + w.hours, 0);
      return { days, totalHours };
    }],

    ['POST', /^\/api\/time\/tempo\/send$/, async (m, req) => {
      const body = await ctx.readJson(req);
      requireTempo(ctx);
      const dates = parseDates(body?.dates);
      // Claim every date before any await, so a second tab or double click can't race this one.
      const busy = dates.find((d) => locks.has(d));
      if (busy) throw new HttpError(409, `Already sending ${busy}.`);
      dates.forEach((d) => locks.add(d));
      try {
        const accountId = await tempoAccountId(ctx);
        const lookup = ticketLookup(ctx);
        const results = [];
        for (const date of dates) {
          let worklogs;
          try {
            // Fresh check, never cached: any worklog Tempo returns for this day means hands off.
            const fresh = await ctx.tempo.worklogs(accountId, date, date);
            const reason = skipReason(ctx, date, fresh.length ? new Set([date]) : new Set());
            if (reason) { results.push({ date, status: 'skipped', sent: 0, reason }); continue; }
            worklogs = await worklogsFor(ctx, date, lookup);
          } catch (err) {
            // Nothing was posted for this day; keep going so the other days' results aren't lost.
            results.push({ date, status: 'failed', sent: 0, errors: [err.message] });
            continue;
          }
          let sent = 0;
          const errors = [];
          for (const w of worklogs) {
            if (!w.issueId) { errors.push(`${w.key} ${w.hours}h: not found in Jira`); continue; }
            try {
              await ctx.tempo.create(toPayload({ issueId: w.issueId, hours: w.hours, date, description: w.description, accountId }));
              sent++;
            } catch (err) {
              errors.push(`${w.key} ${w.hours}h: ${err.message}`);
            }
          }
          if (!errors.length) { ctx.tempoEdits.save(date, null); results.push({ date, status: 'sent', sent }); continue; }
          // Some worklogs went in: the day is now "in Tempo", so record the full day as edits to flag what's missing.
          if (sent) ctx.tempoEdits.save(date, { entries: worklogs.map(({ key, hours }) => ({ key, hours })) });
          results.push({ date, status: sent ? 'partial' : 'failed', sent, errors });
        }
        return { results };
      } finally {
        dates.forEach((d) => locks.delete(d));
        clearCache();
      }
    }],

    ['POST', /^\/api\/time\/tempo\/edits\/([^/]+)$/, async (m, req) => {
      const date = decodeURIComponent(m[1]);
      if (!validDay(date)) throw new HttpError(400, 'Invalid date.');
      const body = await ctx.readJson(req);
      if (!ctx.tempoLogged.get(monthOf(date))?.has(date)) await month(monthOf(date));
      if (!ctx.tempoLogged.get(monthOf(date))?.has(date)) throw new HttpError(400, 'That day isn\'t in Tempo.');
      if (!Array.isArray(body?.entries)) throw new HttpError(400, 'Entries must be a list.');
      const seen = new Set();
      const entries = body.entries.map((e) => {
        const key = String(e?.key ?? '').toUpperCase();
        const hours = e?.hours;
        if (!KEY.test(key)) throw new HttpError(400, `Invalid ticket key: ${key.slice(0, 40)}`);
        if (seen.has(key)) throw new HttpError(400, `${key} appears twice.`);
        seen.add(key);
        if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24) throw new HttpError(400, `${key}: hours must be between 0 and 24.`);
        return { key, hours };
      });
      ctx.tempoEdits.save(date, { entries });
      clearCache();
      return { ok: true };
    }],
  ];
}
