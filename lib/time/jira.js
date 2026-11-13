// Jira evidence for time tracking: In Progress windows and the user's own activity, per local day.
import { dayKey, parseDay, workdays } from './days.js';

const ACTIVE = 'In Progress';
const MIN_WINDOW_MS = 10 * 60 * 1000; // shorter = walking a ticket through the workflow, not working on it
const CONCURRENCY = 4;

const statusChanges = (histories) => histories
  .flatMap((h) => (h.items ?? []).filter((i) => i.field === 'status')
    .map((i) => ({ at: h.created, to: i.toString, by: h.author?.accountId })))
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

// Who was assigned at a given moment, from the changelog's assignee changes (falling back to the current assignee).
function assigneeTimeline(histories, currentAssignee) {
  const changes = histories
    .flatMap((h) => (h.items ?? []).filter((i) => i.field === 'assignee')
      .map((i) => ({ at: Date.parse(h.created), from: i.from ?? null, to: i.to ?? null })))
    .sort((a, b) => a.at - b.at);
  return (time) => {
    if (!changes.length) return currentAssignee;
    let who = changes[0].from; // before the first change
    for (const change of changes) {
      if (!(change.at <= time)) break;
      who = change.to;
    }
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
  const assignChanges = histories
    .flatMap((h) => (h.items ?? []).filter((i) => i.field === 'assignee').map(() => Date.parse(h.created)));
  const mine = (w) => {
    const start = Date.parse(w.start), end = Date.parse(w.end);
    return [start, ...assignChanges.filter((t) => t > start && t < end)].some((t) => assigneeAt(t) === accountId);
  };
  const longEnough = (w) => Date.parse(w.end) - Date.parse(w.start) >= MIN_WINDOW_MS;
  return windows.filter((w) => longEnough(w) && (accountId === null || mine(w)));
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
// A ticket's dated events for the evidence timeline: every status change (with who made it) and the
// times of the user's own comments. Comment text is never kept.
export function jiraEvents(histories, comments, accountId) {
  const statuses = histories.flatMap((h) => (h.items ?? []).filter((i) => i.field === 'status').map((i) => ({
    at: h.created, kind: 'status', from: i.fromString ?? '', to: i.toString ?? '',
    by: h.author?.displayName ?? '', mine: h.author?.accountId === accountId,
  })));
  const mine = comments.filter((c) => c.authorId === accountId).map((c) => ({ at: c.created, kind: 'comment', mine: true }));
  return [...statuses, ...mine].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function ownActivityByDay(histories, comments, accountId) {
  const times = [
    ...statusChanges(histories).filter((c) => c.by === accountId).map((c) => c.at),
    ...comments.filter((c) => c.authorId === accountId).map((c) => c.created),
  ].sort((a, b) => Date.parse(a) - Date.parse(b));
  const bursts = new Map();
  let last = -Infinity;
  for (const time of times) {
    const ms = Date.parse(time);
    if (ms - last > BURST_MS) {
      const day = dayKey(time);
      bursts.set(day, (bursts.get(day) ?? 0) + 1);
    }
    last = ms;
  }
  return bursts;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const index = i++;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}

export async function jiraByDay(jira, { ym, accountId, baseUrl, now = new Date().toISOString() }) {
  const jql = 'project = TCPMOB AND (assignee was currentUser() OR status changed BY currentUser())'
    + ` AND updated >= "${ym}-01" AND issuetype not in (Epic, Initiative) ORDER BY key`;
  const issues = await jira.search(jql, ['summary', 'issuetype', 'status', 'assignee'], 300);
  const days = workdays(ym);
  const tickets = new Map();
  const inProgressDays = new Map();
  const activity = new Map();
  const events = new Map();
  await mapLimit(issues, CONCURRENCY, async (issue) => {
    const [histories, comments] = await Promise.all([jira.changelog(issue.key), jira.comments(issue.key)]);
    tickets.set(issue.key, {
      key: issue.key,
      summary: issue.fields?.summary ?? '',
      url: `${String(baseUrl).replace(/\/+$/, '')}/browse/${issue.key}`,
      issueType: issue.fields?.issuetype?.name ?? '',
    });
    const currentAssignee = issue.fields?.assignee?.accountId ?? null;
    inProgressDays.set(issue.key, daysTouched(inProgressWindows(histories, now, { accountId, currentAssignee }), days));
    activity.set(issue.key, ownActivityByDay(histories, comments, accountId));
    events.set(issue.key, jiraEvents(histories, comments, accountId));
  });
  return { tickets, inProgressDays, activity, events };
}
