// "Why Nh?": one ticket's dated evidence for one day, plus the point math behind its hours.
// Built from sources the month already loaded; Claude contributes only ids, times, and counts, never chat text.
import { REPO } from '../../config.js';
import { dayKey } from './days.js';
import { dayWeights, weightParts, allocate } from './allocate.js';

const ANY = { has: () => true };

// Deterministic "9:12 AM" in the machine's local time (Intl inserts a narrow no-break space before AM/PM).
export function clockTime(iso) {
  const date = new Date(iso);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

function duration(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes % 60);
  return hours ? `${hours}h${minutes ? ` ${minutes}m` : ''}` : `${minutes}m`;
}

const shortId = (id) => `${id.slice(0, 6)}…${id.slice(-4)}`;
const onDay = (date) => (event) => dayKey(event.at) === date;

function jiraLines(events, date) {
  return events.filter(onDay(date)).map((event) => (event.kind === 'status'
    ? { at: event.at, source: 'jira', text: `${event.from} → ${event.to}`, detail: event.mine ? 'by you' : `by ${event.by || 'someone else'}` }
    : { at: event.at, source: 'jira', text: 'Commented', detail: 'by you' }));
}

function claudeLine(session, key) {
  const minutes = (session.segments ?? []).filter((s) => s.key === key).reduce((sum, s) => sum + s.activeMinutes, 0);
  const mentions = session.mentionCounts?.[key];
  const parts = [`${clockTime(session.start)}–${clockTime(session.end)}`];
  if (minutes) parts.push(`${duration(minutes)} active`);
  if (Number.isInteger(mentions)) parts.push(`${mentions} mention${mentions === 1 ? '' : 's'}`);
  return { at: session.start, source: 'claude', text: `Claude session ${shortId(session.sessionId)}`, detail: parts.join(' · ') };
}

function claudeLines(sessions, key) {
  const touches = (session) => (session.segments ?? []).some((s) => s.key === key) || (session.keyCounts?.[key] ?? 0) > 0;
  return sessions.filter(touches).map((session) => claudeLine(session, key));
}

function gitLines(commits, key) {
  return commits.filter((c) => c.key === key).map((c) => ({
    at: c.at, source: 'git', text: `Commit ${c.sha.slice(0, 7)} "${c.subject}"`, ...(c.branch ? { detail: `on ${c.branch}` } : {}),
  }));
}

function githubLines(items, key) {
  return items.filter((item) => item.key === key).map((item) => (item.kind === 'build'
    ? { at: item.at, source: 'github', text: `Build ${item.workflow || 'workflow'} dispatched`, detail: `run #${item.runId}`,
      url: `https://github.com/${REPO}/actions/runs/${item.runId}` }
    : { at: item.at, source: 'github', text: `Reviewed PR #${item.pr}`, url: `https://github.com/${REPO}/pull/${item.pr}` }));
}

function dayEvents({ sources, signals, date, key }) {
  return [
    ...jiraLines(sources.jira.events?.get(key) ?? [], date),
    ...claudeLines(signals.claude, key),
    ...gitLines(signals.commits, key),
    ...githubLines(signals.github, key),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const weightsOnly = (weights) => new Map([...weights].map(([k, v]) => [k, v.weight]));

function outcome({ day, key, signals, known }) {
  const entry = day.entries.find((e) => e.key === key);
  if (!entry) return { mode: 'maybe' };
  const weights = dayWeights(signals, known);
  if (day.suggested) {
    const dayPoints = day.entries.reduce((sum, e) => sum + (weights.get(e.key)?.weight ?? 0), 0);
    return { mode: 'suggested', dayPoints, hours: entry.hours, dayHours: day.dayHours };
  }
  const target = day.state === 'tempo' ? day.dayHours : day.dayHours - (day.leaveHours ?? 0);
  const suggested = allocate(weightsOnly(weights), target).find((e) => e.key === key);
  return { mode: 'saved', suggestedHours: suggested?.hours ?? 0, hours: entry.hours };
}

// { sources, signals, day, known } come from the month build; returns the Evidence the page renders.
export function ticketDayEvidence({ sources, signals, day, known, key }) {
  const evidence = dayWeights(signals, ANY).get(key)?.evidence;
  const parts = evidence ? weightParts(evidence) : [];
  return {
    date: day.date,
    key,
    events: dayEvents({ sources, signals, date: day.date, key }),
    parts,
    total: parts.reduce((sum, p) => sum + p.points, 0),
    outcome: outcome({ day, key, signals, known }),
  };
}
