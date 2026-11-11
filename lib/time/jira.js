// Jira evidence for time tracking: In Progress windows and the user's own activity, per local day.
import { dayKey, parseDay, workdays } from './days.js';

const ACTIVE = 'In Progress';
const MIN_WINDOW_MS = 10 * 60 * 1000; // shorter = walking a ticket through the workflow, not working on it
const CONCURRENCY = 4;

const statusChanges = (histories) => histories
  .flatMap((h) => (h.items ?? []).filter((i) => i.field === 'status').map((i) => ({ at: h.created, to: i.toString, by: h.author?.accountId })))
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

// Who was assigned at a given moment, from the changelog's assignee changes (falling back to the current assignee).
function assigneeTimeline(histories, currentAssignee) {
  const changes = histories
    .flatMap((h) => (h.items ?? []).filter((i) => i.field === 'assignee').map((i) => ({ at: Date.parse(h.created), from: i.from ?? null, to: i.to ?? null })))
    .sort((a, b) => a.at - b.at);
  return (t) => {
    if (!changes.length) return currentAssignee;
    let who = changes[0].from; // before the first change
    for (const c of changes) { if (c.at <= t) who = c.to; else break; }
    return who;
  };
}

// A ticket is active only while its status is In Progress; any move out closes the window.
// With accountId, a window counts only if the user was the assignee at some point during it —
// leads and teammates often move the user's tickets, so who clicked doesn't matter.
export function inProgressWindows(histories, nowIso, { accountId = null, currentAssignee = null } = {}) {
  const windows = [];
  let open = null;
  for (const c of statusChanges(histories)) {
    if (c.to === ACTIVE && !open) open = c.at;
    else if (c.to !== ACTIVE && open) { windows.push({ start: open, end: c.at }); open = null; }
  }
  if (open) windows.push({ start: open, end: nowIso });
  const assigneeAt = assigneeTimeline(histories, currentAssignee);
  const assignChanges = histories.flatMap((h) => (h.items ?? []).filter((i) => i.field === 'assignee').map(() => Date.parse(h.created)));
  const mine = (w) => {
    const s = Date.parse(w.start), e = Date.parse(w.end);
    return [s, ...assignChanges.filter((t) => t > s && t < e)].some((t) => assigneeAt(t) === accountId);
  };
  return windows.filter((w) => Date.parse(w.end) - Date.parse(w.start) >= MIN_WINDOW_MS && (accountId === null || mine(w)));
}

export function daysTouched(windows, days) {
  const out = new Set();
  for (const day of days) {
    const start = parseDay(day).getTime();
    const end = start + 864e5;
    if (windows.some((w) => Date.parse(w.start) < end && Date.parse(w.end) > start)) out.add(day);
  }
  return out;
}

const BURST_MS = 10 * 60 * 1000;

// The user's own transitions and comments per local day. Actions within 10 minutes of the previous one
// are one burst (walking a ticket through several statuses is one action, not four).
export function ownActivityByDay(histories, comments, accountId) {
  const times = [
    ...statusChanges(histories).filter((c) => c.by === accountId).map((c) => c.at),
    ...comments.filter((c) => c.authorId === accountId).map((c) => c.created),
  ].sort((a, b) => Date.parse(a) - Date.parse(b));
  const m = new Map();
  let last = -Infinity;
  for (const t of times) {
    const ms = Date.parse(t);
    if (ms - last > BURST_MS) { const d = dayKey(t); m.set(d, (m.get(d) ?? 0) + 1); }
    last = ms;
  }
  return m;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

export async function jiraByDay(jira, { ym, accountId, baseUrl, now = new Date().toISOString() }) {
  const jql = `project = TCPMOB AND (assignee was currentUser() OR status changed BY currentUser()) AND updated >= "${ym}-01" AND issuetype not in (Epic, Initiative) ORDER BY key`;
  const issues = await jira.search(jql, ['summary', 'issuetype', 'status', 'assignee'], 300);
  const days = workdays(ym);
  const tickets = new Map();
  const inProgressDays = new Map();
  const activity = new Map();
  await mapLimit(issues, CONCURRENCY, async (issue) => {
    const [histories, comments] = await Promise.all([jira.changelog(issue.key), jira.comments(issue.key)]);
    tickets.set(issue.key, { key: issue.key, summary: issue.fields?.summary ?? '', url: `${String(baseUrl).replace(/\/+$/, '')}/browse/${issue.key}`, issueType: issue.fields?.issuetype?.name ?? '' });
    inProgressDays.set(issue.key, daysTouched(inProgressWindows(histories, now, { accountId, currentAssignee: issue.fields?.assignee?.accountId ?? null }), days));
    activity.set(issue.key, ownActivityByDay(histories, comments, accountId));
  });
  return { tickets, inProgressDays, activity };
}
