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
const iso = (d) => `${dayKey(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

export function defaultSources(ctx) {
  let lastSnap = 0;
  return {
    reset() { lastSnap = 0; }, // Refresh: read Claude's transcripts again now
    async claude(ym) {
      let problem = null;
      if (Date.now() - lastSnap > SNAPSHOT_TTL_MS) {
        try { await snapshot(CLAUDE_PROJECTS_DIR, ctx.timeDir); lastSnap = Date.now(); } catch (err) { problem = err.message; }
      }
      const data = new Map(workdays(ym).map((d) => [d, loadDay(ctx.timeDir, d)]));
      // Saved history still counts when the transcripts folder is gone; only report it when there's nothing to show.
      if (problem && ![...data.values()].some((list) => list.length)) throw new Error(problem);
      return data;
    },
    async git(ym) {
      const { start, end } = monthRange(ym);
      return commitsByDay(undefined, LOCAL.mobileClockPath, { since: iso(start), until: iso(end) });
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
    const found = await Promise.all(values.map((v) => jira.getIssue(v, fields).catch(() => null)));
    return found.filter(Boolean);
  }
}

const LOGGED_TTL_MS = 5 * 60 * 1000;

// One read of the month's worklogs; also records which days are logged, for the badge and the reminder.
async function tempoLogs(ctx, ym) {
  const { from, to } = monthBounds(ym);
  const logs = await ctx.tempo.worklogs(await tempoAccountId(ctx), from, to);
  ctx.tempoLogged.set(ym, new Set(logs.map((w) => w.date)));
  ctx.tempoLoggedAt.set(ym, Date.now());
  return logs;
}

// Cheap and cached, so pending days know about hand-logged ones without building the whole month.
async function refreshTempoLogged(ctx, ym) {
  if (Date.now() - (ctx.tempoLoggedAt.get(ym) ?? 0) > LOGGED_TTL_MS || !ctx.tempoLogged.has(ym)) await tempoLogs(ctx, ym);
}

// The month's Tempo worklogs by day, with issue ids mapped to keys through Jira. Null when Tempo is off.
async function tempoMonth(ctx, ym) {
  if (!ctx.tempo.configured) return null;
  const logs = await tempoLogs(ctx, ym);
  const ids = [...new Set(logs.map((w) => w.issueId).filter((x) => /^\d+$/.test(x)))];
  const issues = await lookupIssues(ctx.jira, 'id', ids, ['summary']);
  const keyById = new Map(issues.map((i) => [String(i.id), i.key]));
  const summaries = new Map(issues.map((i) => [i.key, i.fields?.summary ?? '']));
  return { byDay: tempoByDay(logs, keyById), summaries };
}

// Differences between the user's edits and Tempo, one per key, in key order.
function tempoFlags(tempoEntries, edits) {
  const t = new Map(tempoEntries.map((e) => [e.key, e.hours]));
  const y = new Map(edits.map((e) => [e.key, e.hours]));
  return [...new Set([...t.keys(), ...y.keys()])].sort()
    .map((key) => ({ key, tempoHours: t.get(key) ?? 0, yourHours: y.get(key) ?? 0 }))
    .filter((f) => Math.abs(f.tempoHours - f.yourHours) > 0.001);
}

async function settle(promise) {
  try { return { value: await promise, error: null }; } catch (err) { return { value: null, error: err.message || 'Failed' }; }
}

export async function buildMonth(ctx, ym) {
  // No workday length yet (a new teammate): time tracking stays off until it's set in Settings.
  const H = TIME.dayHours;
  if (H == null) return { ym, today: ctx.timeToday(), dayHours: null, days: [], tickets: [], sources: {}, tempo: { configured: ctx.tempo.configured, status: ctx.tempo.configured ? 'ok' : 'off' } };
  const src = ctx.timeSources;
  const [c, g, j, t, h] = await Promise.all([settle(src.claude(ym)), settle(src.git(ym)), settle(src.jira(ym)), settle(tempoMonth(ctx, ym)),
    src.github ? settle(src.github(ym)) : { value: null, error: null }]);
  const github = h.value?.byDay ?? new Map();
  const tempo = t.value;
  const tempoState = { configured: ctx.tempo.configured, status: !ctx.tempo.configured ? 'off' : (t.error ?? 'ok') };
  const claude = c.value ?? new Map();
  const git = g.value?.byDay ?? new Map();
  const jira = j.value ?? { tickets: new Map(), inProgressDays: new Map(), activity: new Map() };
  const sources = { claude: c.error ?? 'ok', git: g.error ?? g.value?.error ?? 'ok', jira: j.error ?? 'ok', github: h.error ?? 'ok' };

  // Only real tickets get hours. Without Jira, fall back to every key the other sources saw.
  let known = new Set(jira.tickets.keys());
  if (j.error) {
    for (const list of git.values()) for (const x of list) if (x.key) known.add(x.key);
    for (const list of github.values()) for (const x of list) if (x.key) known.add(x.key);
    for (const list of claude.values()) for (const s of list) for (const seg of s.segments ?? []) if (seg.key) known.add(seg.key);
  }

  const today = ctx.timeToday();
  const ticketInfo = (key) => jira.tickets.get(key) ?? { key, summary: tempo?.summaries.get(key) ?? '', url: `${String(JIRA.baseUrl).replace(/\/+$/, '')}/browse/${key}` };
  const days = workdays(ym).map((date) => {
    if (date > today) return { date, state: 'future', dayHours: H, target: H, leaveHours: 0, entries: [], suggested: false };
    const rec = ctx.timeStore.get(date);
    const dh = rec ? dayHoursOf(rec) : H; // a saved day keeps its own workday length
    const leaveHours = rec?.leaveHours ?? 0;
    const target = dh - leaveHours;
    const inProgress = new Set([...jira.inProgressDays].filter(([, set]) => set.has(date)).map(([k]) => k));
    const activity = new Map([...jira.activity].map(([k, m]) => [k, m.get(date) ?? 0]).filter(([, n]) => n));
    const weights = dayWeights({ inProgress, commits: git.get(date) ?? [], claude: claude.get(date) ?? [], activity, github: github.get(date) ?? [] }, known);
    const evidence = (key) => (weights.has(key) ? evidenceText(weights.get(key).evidence) : 'Added by you');
    // Maybe: evidence that didn't earn hours on its own: someone else's ticket (a review, a build), a ticket past the
    // 5-per-day cap, or one Claude saw mentioned but never worked on as the main topic. The user decides.
    const allWeights = dayWeights({ inProgress, commits: git.get(date) ?? [], claude: claude.get(date) ?? [], activity, github: github.get(date) ?? [] }, ANY);
    const light = new Map();
    for (const sess of claude.get(date) ?? []) {
      const named = new Set((sess.segments ?? []).map((x) => x.key));
      for (const [k, w] of Object.entries(sess.keyCounts ?? {})) if (!named.has(k)) light.set(k, (light.get(k) ?? 0) + w);
    }
    const finish = (d) => {
      const have = new Set(d.entries.map((e) => e.key));
      const cands = new Map();
      for (const [k, v] of allWeights) if (!have.has(k)) cands.set(k, { weight: v.weight, evidence: evidenceText(v.evidence) });
      for (const [k, w] of light) if (!have.has(k) && !cands.has(k) && w >= MAYBE_LIGHT_MIN) cands.set(k, { weight: w / 10, evidence: 'Mentioned in Claude' });
      d.maybe = [...cands].sort((a, b) => b[1].weight - a[1].weight).map(([key, c]) => ({ key, evidence: c.evidence }));
      return d;
    };
    const enrich = (e) => ({ ...ticketInfo(e.key), key: e.key, hours: e.hours, manual: Boolean(e.manual), evidence: evidence(e.key) });

    // The pool is the full-day suggestion: the page refills from it when leave is lowered, even after a reload.
    const pool = allocate(new Map([...weights].map(([k, v]) => [k, v.weight])), dh).map(enrich);
    // Tempo is the source of truth: a day with any Tempo worklog shows Tempo's hours (or the user's edits on top).
    const inTempo = tempo?.byDay.get(date);
    // Edits only mean something against Tempo hours; once a day has none, old edits are stale.
    if (tempo && !inTempo?.length && ctx.tempoEdits.get(date)) ctx.tempoEdits.save(date, null);
    if (inTempo?.length) {
      let edits = ctx.tempoEdits.get(date)?.entries ?? null;
      const flags = edits ? tempoFlags(inTempo, edits) : [];
      if (edits && !flags.length) { ctx.tempoEdits.save(date, null); edits = null; }
      const tempoTotal = inTempo.reduce((a, e) => a + e.hours, 0);
      return finish({
        date, state: 'tempo', dayHours: dh, target: dh, leaveHours: Math.max(0, round2(dh - tempoTotal)),
        entries: (edits ?? inTempo).map(enrich), tempoEntries: inTempo, flags,
        readOnlyKeys: inTempo.map((e) => e.key).filter((k) => !KEY_EXACT.test(k)), pool, suggested: false,
      });
    }
    if (rec) {
      const state = leaveHours >= dh ? 'leave' : rec.status === 'confirmed' ? 'confirmed' : 'review';
      return finish({ date, state, dayHours: dh, target, leaveHours, entries: rec.entries.map(enrich), pool, suggested: false });
    }
    const alloc = allocate(new Map([...weights].map(([k, v]) => [k, v.weight])), target);
    return finish({ date, state: alloc.length ? 'review' : 'nodata', dayHours: dh, target, leaveHours, entries: alloc.map(enrich), pool, suggested: true });
  });
  await nameMaybes(ctx, days, jira.tickets, ticketInfo);
  const tickets = [...known].map(ticketInfo).sort((a, b) => a.key.localeCompare(b.key));
  return { ym, today, dayHours: H, days, tickets, sources, tempo: tempoState };
}

// Give maybe tickets their Jira titles. Tickets that aren't the user's are looked up once per month; epics,
// initiatives, and keys Jira doesn't know are dropped, so the list only offers real work items.
async function nameMaybes(ctx, days, mine, ticketInfo) {
  const unknown = [...new Set(days.flatMap((d) => (d.maybe ?? []).map((m) => m.key)).filter((k) => !mine.has(k)))];
  let found = null;
  if (unknown.length && ctx.jira?.configured) {
    try { found = new Map((await lookupIssues(ctx.jira, 'key', unknown, ['summary', 'issuetype'])).map((i) => [i.key, i])); } catch { found = null; }
  }
  const skip = (k) => {
    if (mine.has(k) || !found) return false; // Jira unreachable: show them without a title rather than hide them
    const i = found.get(k);
    return !i || ['Epic', 'Initiative'].includes(i.fields?.issuetype?.name);
  };
  for (const d of days) {
    if (!d.maybe) continue;
    d.maybe = d.maybe.filter((m) => !skip(m.key)).slice(0, MAYBE_MAX)
      .map((m) => ({ ...ticketInfo(m.key), summary: mine.get(m.key)?.summary ?? found?.get(m.key)?.fields?.summary ?? '', key: m.key, evidence: m.evidence }));
  }
}

const GRACE_DAYS = 5; // last month still counts during the first days of a new month

async function pending(ctx) {
  if (TIME.dayHours == null) return { count: 0, days: [] };
  const today = ctx.timeToday();
  const prev = new Date(`${monthOf(today)}-01T12:00:00`);
  prev.setMonth(prev.getMonth() - 1);
  const months = Number(today.slice(8)) <= GRACE_DAYS ? [monthOf(dayKey(prev)), monthOf(today)] : [monthOf(today)];
  if (ctx.tempo.configured) {
    await Promise.all(months.map((ym) => refreshTempoLogged(ctx, ym).catch(() => { /* fall back to local records */ })));
  }
  const days = months.flatMap(workdays).filter((d) => {
    if (d >= today) return false;
    if (ctx.tempoLogged.get(monthOf(d))?.has(d)) return false;
    const rec = ctx.timeStore.get(d);
    return rec?.status !== 'confirmed' && (rec?.leaveHours ?? 0) < dayHoursOf(rec);
  });
  return { count: days.length, days };
}

// Jira summaries are untrusted and this file opens in Excel/Sheets: neutralize formulas, quote separators.
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function routes(ctx) {
  ctx.timeDir ??= path.join(process.cwd(), 'data', 'time');
  ctx.timeStore ??= createStore(path.join(ctx.timeDir, 'confirmed.json'));
  ctx.timeSources ??= defaultSources(ctx);
  ctx.timeToday ??= () => dayKey(new Date());
  ctx.tempo ??= createTempo(TEMPO);
  ctx.tempoEdits ??= createStore(path.join(ctx.timeDir, 'tempo-edits.json'));
  ctx.tempoLogged ??= new Map();
  ctx.tempoLoggedAt ??= new Map();
  const cache = new Map();
  const clearCache = () => cache.clear();
  ctx.timeMonthCacheClear = clearCache;
  const month = async (ym, { fresh = false } = {}) => {
    if (fresh) { cache.delete(ym); ctx.timeSources.reset?.(); }
    const hit = cache.get(ym);
    if (hit && Date.now() - hit.at <= MONTH_TTL_MS) return hit.data;
    const data = await buildMonth(ctx, ym);
    cache.set(ym, { data, at: Date.now() });
    return data;
  };
  ctx.timeMonth = month;
  ctx.timePending = async () => (await pending(ctx)).days;
  const ymParam = (url) => {
    const ym = url.searchParams.get('ym') || monthOf(ctx.timeToday());
    if (!validYm(ym)) throw new HttpError(400, 'Expected ym like 2026-11.');
    return ym;
  };

  return [
    ['GET', /^\/api\/time\/month$/, (m, req, url) => month(ymParam(url), { fresh: url.searchParams.get('fresh') === '1' })],
    // Refresh a day: drop its unconfirmed draft (and notes on a Tempo day) so fresh suggestions show. Confirmed days stay.
    ['POST', /^\/api\/time\/day\/([^/]+)\/reset$/, (m) => {
      const date = decodeURIComponent(m[1]);
      if (!validDay(date)) throw new HttpError(400, 'Invalid date.');
      if (ctx.timeStore.get(date)?.status === 'confirmed') throw new HttpError(409, 'This day is confirmed, so its hours stay. Edit them instead.');
      ctx.timeStore.save(date, null);
      ctx.tempoEdits.save(date, null);
      cache.clear();
      return { ok: true, date };
    }],
    ['GET', /^\/api\/time\/pending$/, () => pending(ctx)],
    ['POST', /^\/api\/time\/day\/([^/]+)$/, async (m, req) => {
      const date = decodeURIComponent(m[1]);
      const body = await ctx.readJson(req);
      const existing = ctx.timeStore.get(date);
      const dayHours = existing ? dayHoursOf(existing) : TIME.dayHours;
      if (dayHours == null) throw new HttpError(409, 'Set your workday hours in Settings first.');
      const record = {
        status: body.confirm ? 'confirmed' : 'draft',
        dayHours,
        leaveHours: body.leaveHours ?? 0,
        entries: Array.isArray(body.entries) ? body.entries.map((e) => ({ key: String(e?.key ?? '').toUpperCase(), hours: e?.hours, manual: Boolean(e?.manual) })) : body.entries,
        confirmedAt: body.confirm ? new Date().toISOString() : null,
      };
      const error = validateDay(date, record, ctx.timeToday());
      if (error) throw new HttpError(400, error);
      ctx.timeStore.save(date, record);
      cache.clear();
      return { ok: true, date, status: record.status };
    }],
    ['GET', /^\/api\/time\/export$/, async (m, req, url) => {
      const ym = ymParam(url);
      const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';
      const rows = (await month(ym)).days.filter((d) => d.state === 'confirmed' || d.state === 'leave' || d.state === 'tempo').flatMap((d) => (d.state === 'tempo' ? [
        ...(d.leaveHours ? [{ date: d.date, key: 'LEAVE', hours: d.leaveHours, summary: 'Leave', evidence: 'Not logged in Tempo' }] : []),
        ...d.tempoEntries.map((e) => ({ date: d.date, key: e.key, hours: e.hours, summary: d.entries.find((x) => x.key === e.key)?.summary ?? '', evidence: 'In Tempo' })),
      ] : [
        ...(d.leaveHours ? [{ date: d.date, key: 'LEAVE', hours: d.leaveHours, summary: 'Leave', evidence: '' }] : []),
        ...d.entries.map((e) => ({ date: d.date, key: e.key, hours: e.hours, summary: e.summary, evidence: e.evidence })),
      ]));
      const filename = `tempo-${ym}.${format}`;
      if (format === 'json') return raw({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename=${filename}` }, JSON.stringify(rows, null, 2));
      const cols = ['date', 'key', 'hours', 'summary', 'evidence'];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c] ?? '')).join(','))].join('\n');
      return raw({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename=${filename}` }, csv);
    }],
    ...syncRoutes(ctx, { month, clearCache }),
  ];
}
