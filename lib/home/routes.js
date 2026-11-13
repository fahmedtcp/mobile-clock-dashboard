// GET /api/home: everything the shift-aware Home shows, in one response. Meeting titles pass through memory only.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config.js';
import { HttpError } from '../http.js';
import { shiftState } from '../../public/shared.js';
import { createStore } from '../time/store.js';
import { commitsByDay } from '../time/git.js';
import { dayKey } from '../time/days.js';
import { defaultExec } from '../calendar.js';
import { loadHomeSources } from './sources.js';
import { workRows } from './work.js';
import { feedItems } from './feed.js';
import { pickHeadline } from './headline.js';
import { unpushedBranches, wrapChecklist } from './wrap.js';
import { standupDraft } from './standup.js';
import { teamOnShift } from './team.js';

const CACHE_MS = 30000;
const FEED_WINDOW_MS = 48 * 36e5;
const NOTE_MAX = 1000;
const STANDUP = /stand-?up/i;
const PLAN_SIZE = 3;

function firstName(people, login) {
  const person = people.find((p) => p.github === login);
  return person ? person.name.split(/\s+/)[0] : login;
}

async function todaysMeetings(ctx, now) {
  if (!ctx.settings.resolved().calendar.on) return [];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  // No milliseconds: the Swift helper's ISO8601DateFormatter rejects fractional seconds.
  const plain = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return ctx.calendar.meetings(plain(start), plain(end));
}

async function localGit(ctx, sinceMs, now) {
  const repo = ctx.settings.resolved().time.mobileClockPath;
  if (!existsSync(repo)) return { unpushed: [], commits: [] };
  const exec = ctx.homeExec ?? defaultExec;
  const [unpushed, log] = await Promise.all([
    unpushedBranches(exec, repo, now.getTime()),
    commitsByDay(undefined, repo, { since: new Date(sinceMs).toISOString(), until: now.toISOString() }),
  ]);
  return { unpushed, commits: [...log.byDay.values()].flat().map((c) => ({ key: c.key, at: c.at })) };
}

async function hoursState(ctx, now) {
  const record = ctx.timeStore?.get(dayKey(now));
  const pastDays = await ctx.timePending?.().catch(() => []) ?? [];
  return { todayPending: record?.status !== 'confirmed', pastDays: pastDays.length };
}

async function buildHome(ctx, store) {
  const now = ctx.homeNow();
  const cfg = ctx.settings.resolved().shift;
  const shift = shiftState(now, cfg);
  // Standup covers the previous shift and this one so far (Monday reads back to Friday).
  const standupSince = shift.prevShiftEnd - (shift.shiftEnd - shift.shiftStart);
  const { input, errors } = await loadHomeSources(ctx, now);
  const [meetings, git, hours] = await Promise.all([
    todaysMeetings(ctx, now), localGit(ctx, standupSince, now), hoursState(ctx, now),
  ]);
  const calendar = ctx.calendar.status();
  if (calendar === 'denied') errors.calendar = 'Calendar access was denied. Allow it in System Settings → Privacy & Security → Calendars.';
  if (calendar === 'error') {
    const why = ctx.calendar.reason?.();
    errors.calendar = `Couldn't read the Calendar app${why ? ` (${why})` : ''}.`;
  }

  const rows = workRows(input);
  const lastSeen = store.get('lastSeen') ?? 0;
  const feed = feedItems(input, { sinceMs: Math.min(now - FEED_WINDOW_MS, shift.prevShiftEnd) }).map((item) => ({ ...item, unread: Date.parse(item.at) > lastSeen }));
  const reviews = input.allPrs.filter((pr) => pr.reviewRequestedLogins.includes(input.me.login))
    .map((pr) => ({ pr: pr.number, author: firstName(input.people, pr.author), title: pr.title, url: pr.url, since: pr.createdAt }));
  const wrap = shift.moment === 'wrap' ? wrapChecklist({ unpushed: git.unpushed, hoursPending: hours.todayPending, rows }) : [];
  const standupMeeting = meetings.find((m) => STANDUP.test(m.title) && Date.parse(m.end) > now);
  return {
    now: now.toISOString(),
    generatedAt: new Date().toISOString(),
    shift: { ...cfg, ...shift },
    meetings,
    calendar,
    team: teamOnShift({ people: input.people, me: input.me, rows, teamTickets: input.teamTickets, allPrs: input.allPrs, shift }),
    work: rows,
    feed,
    headline: pickHeadline({ rows, builds: ctx.tracker.list?.() ?? [], meetings, reviews, wrap, shift, now }),
    wrap,
    standup: standupMeeting
      ? { at: standupMeeting.start, ...standupDraft({ input, rows, commits: git.commits, sinceMs: standupSince }) }
      : null,
    note: store.get('note'),
    plan: rows.filter((r) => r.action).slice(0, PLAN_SIZE).map((r) => ({
      key: r.key, text: r.blocker.quote ? `${r.blocker.text} “${r.blocker.quote}”` : r.blocker.text, action: r.action,
    })),
    waiting: { reviews, hoursPending: hours.pastDays },
    errors,
  };
}

export function routes(ctx) {
  ctx.homeNow ??= () => new Date();
  const store = createStore(path.join(ctx.homeDir ?? ctx.timeDir ?? DATA_DIR, 'home.json'));
  let cached = null; // { at, body }

  async function handleHome(match, req, url) {
    const fresh = url.searchParams.get('fresh') === '1';
    if (!fresh && cached && Date.now() - cached.at <= CACHE_MS) {
      const now = ctx.homeNow();
      const cfg = ctx.settings.resolved().shift;
      return { ...cached.body, now: now.toISOString(), shift: { ...cfg, ...shiftState(now, cfg) } };
    }
    const body = await buildHome(ctx, store);
    cached = { at: Date.now(), body };
    return body;
  }

  function handleSeen() {
    const lastSeen = ctx.homeNow().getTime();
    store.save('lastSeen', lastSeen);
    cached = null;
    return { lastSeen };
  }

  async function handleNote(match, req) {
    const { text } = await ctx.readJson(req);
    if (typeof text !== 'string' || text.length > NOTE_MAX) throw new HttpError(400, `Keep the note under ${NOTE_MAX} characters.`);
    const note = text.trim() ? { text: text.trim(), savedAt: ctx.homeNow().toISOString() } : null;
    store.save('note', note);
    cached = null;
    return { note };
  }

  return [
    ['GET', /^\/api\/home$/, handleHome],
    ['POST', /^\/api\/home\/seen$/, handleSeen],
    ['PUT', /^\/api\/home\/note$/, handleNote],
  ];
}
