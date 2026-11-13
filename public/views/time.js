import { api, post, el, ext, sep, glyph, icon, skeleton, empty, toast, confirmSheet, freshness } from '../ui.js';
import { ticketLink, buildChip, loadLatestBuilds } from '../tickets-ui.js';
import { rebalance, TICKET_KEY } from '../shared.js';

const STEP = 0.5;
const MONTH_FRESH_MS = 5 * 60 * 1000; // the server rebuilds the month at most this often
const AUTOSAVE_MS = 600;
let ctx;
let root;
const local = {
  ym: null,          // 'YYYY-MM'
  mode: 'day',       // 'day' | 'month'
  month: null,       // server month
  error: null,
  selected: null,    // 'YYYY-MM-DD'
  edits: new Map(),  // date -> { leaveHours, entries } not yet confirmed (drafts autosave)
  // date -> pending autosave timer (one per day, so editing another day never cancels it)
  saveTimers: new Map(),
  busy: false,
  refreshing: null,  // date being refreshed
  loadError: null,   // a reload failed while the last good month stays on screen
  evidence: new Map(),     // `${date}|${key}` -> Evidence | { loading } | { error }
  openEvidence: new Set(), // which "Why?" timelines are expanded
  settingsVersion: 0,
};

const formatHours = (h) => String(Math.round(h * 100) / 100); // Tempo hours can be 3.13; ours are 0.5h steps
const sumHours = (entries) => entries.reduce((sum, e) => sum + e.hours, 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const toDate = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
const toYm = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const longDate = (day) => toDate(day).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const shortDate = (day) =>
  toDate(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
// Step to the next 0.5h mark, so Tempo hours like 3.13 land on 3.5 or 3.
const stepUp = (h) => Math.floor(h * 2 + 1e-9) / 2 + STEP;
const stepDown = (h) => Math.ceil(h * 2 - 1e-9) / 2 - STEP;
const monthName = (ym) => toDate(`${ym}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

function shiftYm(ym, months) {
  const date = toDate(`${ym}-01`);
  date.setMonth(date.getMonth() + months);
  return toYm(date);
}

const STATE = {
  confirmed: ['Confirmed', 'green'],
  review: ['Review', 'orange'],
  nodata: ['No Data', ''],
  leave: ['Leave', 'purple'],
  tempo: ['In Tempo', 'green'],
  future: ['Upcoming', ''],
};

// ---------- data ----------

// Save every pending draft now (before reloading, switching months, or leaving the page).
function flushDrafts() {
  const dates = [...local.saveTimers.keys()];
  for (const timer of local.saveTimers.values()) clearTimeout(timer);
  local.saveTimers.clear();
  return Promise.all(dates.map((date) => saveDraft(date)));
}

async function load(ym = local.ym, { fresh = false } = {}) {
  await flushDrafts();
  local.ym = ym;
  local.error = null;
  render();
  try {
    local.month = await api(`/api/time/month?ym=${ym}${fresh ? '&fresh=1' : ''}`);
    local.edits.clear();
    local.evidence.clear();
    local.loadError = null;
    if (!local.selected || !local.selected.startsWith(ym)) local.selected = defaultDay();
  } catch (err) {
    if (local.month?.ym === ym) local.loadError = err; else local.error = err;
  }
  render();
}

function defaultDay() {
  const days = local.month.days;
  const today = days.find((d) => d.date === local.month.today && d.state !== 'future');
  if (today) return today.date;
  const review = [...days].reverse().find((d) => d.state === 'review' || d.state === 'nodata');
  return (review ?? days.find((d) => d.state !== 'future') ?? days[0])?.date ?? null;
}

const serverDay = (date) => local.month.days.find((d) => d.date === date);
// Each day carries its own workday length (saved days keep theirs when the setting changes).
const hoursOf = (date) => serverDay(date)?.dayHours ?? local.month?.dayHours ?? 7;
const isTempoDay = (date) => serverDay(date).state === 'tempo';

// The working copy of a day: unsaved edits if any, else the server's version.
function workingCopy(date) {
  if (local.edits.has(date)) return local.edits.get(date);
  const day = serverDay(date);
  const entries = day.entries.map((e) => ({ key: e.key, hours: e.hours, manual: e.manual }));
  return { leaveHours: day.leaveHours, removed: [], entries };
}

function editDay(date, change) {
  const draft = structuredClone(workingCopy(date));
  change(draft);
  draft.entries = isTempoDay(date) ? draft.entries.filter((e) => e.hours > 0) : rebalanced(date, draft);
  local.edits.set(date, draft);
  scheduleSave(date);
  render();
}

// Rebalance against the day's original tickets too (minus ones the user removed), so lowering leave
// brings back tickets that a bigger leave squeezed out.
function rebalanced(date, draft) {
  const day = serverDay(date);
  const present = new Set(draft.entries.map((e) => e.key));
  const pool = (day.pool ?? day.entries)
    .filter((e) => !present.has(e.key) && !draft.removed.includes(e.key))
    .map((e) => ({ key: e.key, hours: e.hours, manual: false }));
  // A full day of leave leaves no ticket time, even for hours set by hand; lowering leave refills from the pool.
  const dayHours = hoursOf(date);
  return draft.leaveHours >= dayHours ? [] : rebalance([...draft.entries, ...pool], dayHours - draft.leaveHours);
}

const addTicket = (date, key) => editDay(date, (draft) => {
  draft.removed = draft.removed.filter((k) => k !== key);
  draft.entries.push({ key, hours: STEP, manual: false });
});

const removeTicket = (date, key) => editDay(date, (draft) => {
  draft.entries = draft.entries.filter((e) => e.key !== key);
  draft.removed.push(key);
});

const setTicketHours = (date, key, step) => editDay(date, (draft) => {
  const entry = draft.entries.find((e) => e.key === key);
  entry.hours = step(entry.hours);
  entry.manual = true;
});

const setLeaveHours = (date, hours) => editDay(date, (draft) => { draft.leaveHours = hours; });

function scheduleSave(date) {
  clearTimeout(local.saveTimers.get(date));
  local.saveTimers.set(date, setTimeout(() => { local.saveTimers.delete(date); saveDraft(date); }, AUTOSAVE_MS));
}

function cancelSave(date) {
  clearTimeout(local.saveTimers.get(date));
  local.saveTimers.delete(date);
}

const draftRequest = (date, draft) => (isTempoDay(date)
  ? [`/api/time/tempo/edits/${date}`, { entries: draft.entries.map(({ key, hours }) => ({ key, hours })) }]
  : [`/api/time/day/${date}`, { leaveHours: draft.leaveHours, entries: draft.entries, confirm: false }]);

async function saveDraft(date) {
  const draft = local.edits.get(date);
  if (!draft) return;
  const inTempo = isTempoDay(date);
  try {
    await post(...draftRequest(date, draft));
    if (!inTempo) serverDay(date).state = draft.leaveHours >= hoursOf(date) ? 'leave' : 'review';
  } catch (err) {
    toast(err.message, 'bad');
  }
  render();
}

async function confirmDay(date) {
  const draft = workingCopy(date);
  local.busy = true;
  render();
  cancelSave(date);
  try {
    await post(`/api/time/day/${date}`, { leaveHours: draft.leaveHours, entries: draft.entries, confirm: true });
    toast(`${toDate(date).toLocaleDateString(undefined, { weekday: 'long' })} confirmed`);
    const next = local.month.days.find((d) => d.date > date && (d.state === 'review' || d.state === 'nodata'));
    await load(local.ym);
    if (next) local.selected = next.date;
    ctx.refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
  local.busy = false;
  render();
}

function ticketInfo(key) {
  return local.month.tickets.find((t) => t.key === key)
    ?? serverDay(local.selected)?.entries.find((e) => e.key === key)
    ?? { key, summary: '', url: null };
}

function evidenceFor(date, key) {
  return serverDay(date).entries.find((e) => e.key === key)?.evidence ?? 'Added by you';
}

// ---------- Tempo ----------

// Differences between what's on screen and Tempo, for a day already in Tempo.
function flagsFor(date) {
  const day = serverDay(date);
  if (day.state !== 'tempo') return [];
  const tempo = new Map(day.tempoEntries.map((e) => [e.key, e.hours]));
  const yours = new Map(workingCopy(date).entries.map((e) => [e.key, e.hours]));
  return [...new Set([...tempo.keys(), ...yours.keys()])].sort()
    .map((key) => ({ key, tempoHours: tempo.get(key) ?? 0, yourHours: yours.get(key) ?? 0 }))
    .filter((f) => Math.abs(f.tempoHours - f.yourHours) > 0.001);
}

function flagText(flag) {
  if (!flag.tempoHours) return `Tempo doesn't have ${flag.key}. You added ${formatHours(flag.yourHours)}h.`;
  const change = flag.yourHours ? `You changed it to ${formatHours(flag.yourHours)}h.` : 'You removed it.';
  return `Tempo has ${flag.key} ${formatHours(flag.tempoHours)}h. ${change} Update it in Tempo by hand.`;
}

const tempoReady = () => local.month?.tempo?.configured && local.month.tempo.status === 'ok';
const sendable = (day) => day.state === 'confirmed' && day.date <= local.month.today && !local.edits.has(day.date);

async function sendToTempo(dates) {
  await flushDrafts();
  let preview;
  try {
    preview = await api(`/api/time/tempo/preview?dates=${dates.join(',')}`);
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }
  const results = await confirmSend(dates, preview);
  if (!results) return;
  await load(local.ym);
  ctx.refresh();
  const sent = results.filter((r) => r.status === 'sent');
  if (dates.length === 1 && sent.length === 1) {
    toast(`Sent ${plural(sent[0].sent, 'worklog')} to Tempo`);
    return;
  }
  await showSendSummary(results);
}

// Shows what will be sent; resolves to the send results, or null when nothing was sent.
async function confirmSend(dates, preview) {
  const ready = preview.days.filter((d) => d.ok);
  const skipped = preview.days.filter((d) => !d.ok);
  const count = ready.reduce((n, d) => n + d.worklogs.length, 0);
  let results = null;
  const sent = await confirmSheet({
    title: dates.length > 1 ? 'Send Month to Tempo' : 'Send Day to Tempo',
    body: sendPreviewBody(ready, skipped, count),
    confirmLabel: `Send ${plural(count, 'Worklog')}`,
    confirmDisabled: !count,
    onConfirm: async () => {
      try { results = (await post('/api/time/tempo/send', { dates: ready.map((d) => d.date) })).results; }
      finally { load(local.ym); } // some days may have gone in even when the request failed
    },
  });
  return sent ? results : null;
}

function sendPreviewBody(ready, skipped, count) {
  const worklogLine = (day, log) =>
    `${shortDate(day.date)} · ${log.key} · ${formatHours(log.hours)}h · ${log.description || 'No status'}`;
  const worklogItems = ready.flatMap((day) => day.worklogs.map((log) => el('li', {}, worklogLine(day, log))));
  return [
    el('p', { class: 'muted' }, 'Each day is checked against Tempo again right before sending. '
      + 'A day that already has Tempo hours is never sent.'),
    count ? el('ul', { class: 'tempo-list' }, worklogItems) : el('p', {}, 'Nothing to send.'),
    skipped.length && el('p', { class: 'muted' }, 'Skipped'),
    skipped.length && el('ul', { class: 'tempo-list muted' },
      skipped.map((day) => el('li', {}, `${shortDate(day.date)} · ${day.reason}`))),
  ].filter(Boolean);
}

function showSendSummary(results) {
  const withStatus = (...statuses) => results.filter((r) => statuses.includes(r.status));
  const dated = (text) => (r) => `${shortDate(r.date)} · ${text(r)}`;
  const failure = (r) => (r.status === 'partial' ? `Partly sent. ${r.errors.join('; ')}` : r.errors.join('; '));
  const toFix = local.month.days.filter((d) => d.state === 'tempo' && d.flags?.length);
  const fixLines = (day) => flagsFor(day.date).map((f) => `${shortDate(day.date)} · ${flagText(f)}`);
  return confirmSheet({
    title: 'Tempo Summary',
    body: [
      ...summaryGroup('Sent', 'tempo-list', withStatus('sent'), dated((r) => plural(r.sent, 'worklog'))),
      ...summaryGroup('Failed', 'tempo-list bad', withStatus('failed', 'partial'), dated(failure)),
      ...summaryGroup('Skipped', 'tempo-list muted', withStatus('skipped'), dated((r) => r.reason)),
      ...summaryGroup('Fix in Tempo', 'tempo-list', toFix, fixLines),
    ],
    confirmLabel: 'Done',
  });
}

// A bold heading and its list, or nothing when there are no items. `lines` maps an item to one or more lines.
function summaryGroup(title, listClass, items, lines) {
  if (!items.length) return [];
  return [
    el('p', {}, el('strong', {}, title)),
    el('ul', { class: listClass }, items.flatMap(lines).map((text) => el('li', {}, text))),
  ];
}

// ---------- refresh ----------

// Whether refreshing would throw away something the user hasn't confirmed.
function hasUnconfirmedChanges(day) {
  const unsaved = local.edits.has(day.date);
  if (day.state === 'tempo') return Boolean(day.flags?.length) || unsaved;
  return day.state !== 'confirmed' && (!day.suggested || unsaved);
}

async function refreshDay(date) {
  const day = serverDay(date);
  const discardsChanges = hasUnconfirmedChanges(day);
  if (discardsChanges && !(await confirmRefresh(date))) return;
  cancelSave(date);
  local.edits.delete(date);
  local.refreshing = date;
  render();
  try {
    if (discardsChanges) await post(`/api/time/day/${date}/reset`);
    await load(local.ym, { fresh: true });
    toast(day.state === 'confirmed'
      ? 'Refreshed. Confirmed hours stay as they are.'
      : 'Refreshed with the latest activity');
  } catch (err) {
    toast(err.message, 'bad');
  }
  local.refreshing = null;
  render();
}

const confirmRefresh = (date) => confirmSheet({
  title: 'Refresh This Day?',
  body: [el('p', {}, `Your unconfirmed changes for ${longDate(date)} are replaced with fresh suggestions.`)],
  confirmLabel: 'Refresh',
});

// ---------- copy / export ----------

function dayText(date) {
  const draft = workingCopy(date);
  const lines = draft.entries.map((e) => `${e.key}\t${formatHours(e.hours)}h\t${ticketInfo(e.key).summary ?? ''}`);
  if (draft.leaveHours) lines.push(`Leave\t${formatHours(draft.leaveHours)}h`);
  return lines.join('\n');
}

function monthText() {
  return local.month.days.filter((d) => d.state === 'confirmed' || d.state === 'leave')
    .map((d) => `${longDate(d.date)}\n${dayText(d.date)}`).join('\n\n');
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast('Copy failed. Select the text and press ⌘C.', 'bad');
  }
}

// ---------- day mode ----------

function dayStrip() {
  return el('div', { class: 'day-strip', role: 'tablist', 'aria-label': 'Workdays' }, local.month.days.map(dayPill));
}

function dayPill(day) {
  const date = toDate(day.date);
  const [label, color] = STATE[day.state];
  const flagged = day.state === 'tempo' && flagsFor(day.date).length > 0;
  const partLeave = day.leaveHours > 0 && day.leaveHours < day.dayHours;
  return el('button', {
    type: 'button', role: 'tab', class: `day-pill ${day.state} ${day.date === local.month.today ? 'today' : ''}`,
    'aria-selected': String(day.date === local.selected), disabled: day.state === 'future',
    title: `${longDate(day.date)} · ${label}`,
    onclick: () => { local.selected = day.date; render(); },
  },
  el('span', { class: 'dp-wd' }, date.toLocaleDateString(undefined, { weekday: 'short' })),
  el('span', { class: 'dp-n' }, String(date.getDate())),
  el('span', { class: `dp-state ${flagged ? 'orange' : color}` }, pillMark(day, flagged)),
  partLeave ? el('span', { class: 'dp-leave', 'aria-label': `${day.leaveHours}h leave` }) : null);
}

// Flagged Tempo days get an orange dot, done days a check or leave icon, edited days a dot.
function pillMark(day, flagged) {
  if (flagged) return '•';
  if (day.state === 'confirmed' || day.state === 'tempo') return icon('check');
  if (day.state === 'leave') return icon('leave');
  return local.edits.has(day.date) ? '•' : '';
}

function stepper(value, { onMinus, onPlus, label, minusDisabled = false, plusDisabled = false }) {
  const step = (ariaLabel, disabled, onclick, text) =>
    el('button', { type: 'button', class: 'step', 'aria-label': ariaLabel, disabled, onclick }, text);
  return el('div', { class: 'stepper', role: 'group', 'aria-label': label },
    step(`Less ${label}`, minusDisabled, onMinus, '−'),
    el('span', { class: 'step-v' }, `${formatHours(value)}h`),
    step(`More ${label}`, plusDisabled, onPlus, '+'));
}

function insetGroup(items) {
  const list = el('ul', { class: 'group' }, items);
  list.style.setProperty('--inset', '56px');
  return list;
}

function ticketTitle(key, { url, summary }) {
  return el('div', { class: 'row-title' },
    TICKET_KEY.test(key) ? ticketLink(key) : url ? ext(url, key) : key,
    summary ? el('span', { class: 'time-summary' }, ` ${summary}`) : null);
}

// Tickets with weak evidence: offered, never added on their own. Adding one works like "Add a ticket".
function maybeList(date, day, used) {
  const items = (day.maybe ?? []).filter((m) => !used.has(m.key));
  if (!items.length || day.state === 'future') return null;
  const hint = day.state === 'tempo'
    ? 'Not in Tempo. Add any you worked on, then add it in Tempo too.'
    : 'Some activity, not enough to suggest. Add any you worked on.';
  return el('div', { class: 'maybe' },
    el('div', { class: 'maybe-head' },
      el('span', { class: 'maybe-title' }, 'Maybe'),
      el('span', { class: 'muted' }, hint)),
    insetGroup(items.map((item) => maybeRow(date, item))));
}

function maybeRow(date, item) {
  return el('li', {},
    el('div', { class: 'row' }, glyph('ticket', 'gray'),
      el('div', { class: 'row-body' }, ticketTitle(item.key, item),
        el('div', { class: 'row-sub' }, item.evidence, whyButton(date, item.key, 'Why?'))),
      el('div', { class: 'row-trail' },
        el('button', {
          type: 'button', class: 'btn btn-small', 'aria-label': `Add ${item.key}`,
          onclick: () => addTicket(date, item.key),
        }, '+ Add'))),
    evidenceRegion(date, item.key));
}

// ---------- evidence ("Why Nh?") ----------

const evidenceId = (date, key) => `${date}|${key}`;

function whyButton(date, key, label) {
  if (!TICKET_KEY.test(key)) return null;
  const open = local.openEvidence.has(evidenceId(date, key));
  return el('button', {
    type: 'button', class: 'why-pill', 'aria-expanded': String(open), onclick: () => toggleEvidence(date, key),
  }, label, el('span', { class: 'why-chev', 'aria-hidden': 'true' }, '›'));
}

async function toggleEvidence(date, key) {
  const id = evidenceId(date, key);
  // Closing drops it, so reopening after an edit shows today's numbers.
  if (local.openEvidence.delete(id)) { local.evidence.delete(id); render(); return; }
  local.openEvidence.add(id);
  if (!local.evidence.has(id)) {
    local.evidence.set(id, { loading: true });
    render();
    try {
      local.evidence.set(id, await api(`/api/time/evidence?date=${date}&key=${encodeURIComponent(key)}`));
    } catch (err) {
      local.evidence.set(id, { error: err.message });
    }
  }
  render();
}

// Same "9:12 AM" format the server uses, in this Mac's local time.
function clockTime(iso) {
  const date = new Date(iso);
  const hours = date.getHours();
  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

function evidenceEvent(event) {
  return el('li', {},
    el('time', { datetime: event.at }, clockTime(event.at)),
    el('span', { class: `ev-dot src-${event.source}`, 'aria-hidden': 'true' }),
    el('span', { class: 'ev-text' },
      event.url ? ext(event.url, event.text) : event.text,
      event.detail && el('span', { class: 'ev-detail' }, ` · ${event.detail}`)));
}

function outcomeText({ total, outcome }) {
  if (outcome.mode === 'suggested') {
    return `= ${formatHours(total)} of ${formatHours(outcome.dayPoints)} points → ${formatHours(outcome.hours)}h of ${formatHours(outcome.dayHours)}h`;
  }
  if (outcome.mode === 'saved') {
    return `Today's evidence suggests ${formatHours(outcome.suggestedHours)}h; you have ${formatHours(outcome.hours)}h`;
  }
  return 'Not enough to suggest hours';
}

function evidenceBody(evidence) {
  if (evidence.loading) return [el('div', { class: 'sk title' }), el('div', { class: 'sk sub' })];
  if (evidence.error) return [el('p', { class: 'banner error' }, `Couldn't load the evidence: ${evidence.error}`)];
  return [
    el('div', { class: 'ev-head' }, el('strong', {}, `Evidence for ${longDate(evidence.date)}`), el('span', {}, 'Local time')),
    evidence.events.length
      ? el('ul', { class: 'timeline' }, evidence.events.map(evidenceEvent))
      : el('p', { class: 'muted' }, 'No activity found for this ticket on this day.'),
    el('div', { class: 'weights' },
      evidence.parts.map((part) => el('span', { class: 'weight' }, `${part.label} `, el('b', {}, formatHours(part.points)))),
      el('span', { class: 'weight total' }, outcomeText(evidence))),
  ];
}

function evidenceRegion(date, key) {
  const id = evidenceId(date, key);
  if (!local.openEvidence.has(id)) return null;
  return el('div', { class: 'evidence', role: 'region', 'aria-label': `Evidence for ${key}` },
    ...evidenceBody(local.evidence.get(id) ?? { loading: true }));
}

function dayCard() {
  const date = local.selected;
  const day = serverDay(date);
  if (!day) return null;
  const draft = workingCopy(date);
  const used = new Set(draft.entries.map((e) => e.key));
  const totals = dayTotals(date, draft);
  return el('section', { class: 'block' },
    dayHeader(date, totals),
    day.state === 'tempo' ? tempoNote(flagsFor(date)) : null,
    ticketList(date, draft),
    maybeList(date, day, used),
    dayActions(date, { draft, used, ...totals }));
}

// Tempo days count Tempo's leave toward the full day; other days fill what the user's leave leaves over.
function dayTotals(date, draft) {
  const day = serverDay(date);
  const inTempo = day.state === 'tempo';
  const target = inTempo ? hoursOf(date) : hoursOf(date) - draft.leaveHours;
  const sum = sumHours(draft.entries) + (inTempo ? day.leaveHours : 0);
  return { target, sum, ok: Math.abs(sum - target) < 0.001 };
}

function dayHeader(date, { target, sum, ok }) {
  const day = serverDay(date);
  const edited = local.edits.has(date);
  const [label, color] = STATE[edited && day.state !== 'tempo' ? 'review' : day.state];
  const refreshing = local.refreshing === date;
  const suggested = day.suggested && day.entries.length > 0 && !edited;
  return el('div', { class: 'day-head' },
    el('div', {},
      el('h3', { class: 'day-title' }, longDate(date)),
      el('span', { class: `chip ${color}` }, label),
      suggested && el('span', { class: 'chip blue' }, icon('sparkle'), 'Suggested'),
      el('button', {
        type: 'button', class: 'btn btn-small day-refresh', disabled: refreshing,
        title: 'Read Jira, git, GitHub, Claude, and Tempo again for this day', onclick: () => refreshDay(date),
      }, icon('refresh'), refreshing ? 'Refreshing…' : 'Refresh')),
    el('div', { class: 'day-total' },
      el('span', { class: `total ${ok ? 'ok' : sum === 0 ? 'unset' : 'off'}` },
        `${formatHours(sum)}`, el('span', { class: 'of' }, ` / ${formatHours(target)}h`)),
      el('div', { class: 'total-bar', 'aria-hidden': 'true' },
        el('span', { style: `width:${Math.min(100, target ? (sum / target) * 100 : 100)}%` }))));
}

function tempoNote(flags) {
  const differs = flags.length > 0;
  return el('div', { class: `banner ${differs ? 'info' : 'ok'} tempo-note` },
    glyph(differs ? 'alert' : 'check', differs ? 'orange' : 'green', 'sm'),
    differs
      ? el('div', {}, el('strong', {}, 'Your edits differ from Tempo'),
        el('ul', { class: 'tempo-list' }, flags.map((f) => el('li', {}, flagText(f)))))
      : el('span', {}, 'Already in Tempo. Edits here are notes only; the dashboard never changes Tempo hours.'));
}

function ticketList(date, draft) {
  const rows = draft.entries.map((entry) => ticketRow(date, entry));
  const leave = leaveRow(date, draft);
  return insetGroup(rows.length || leave
    ? [...rows, leave]
    : [empty('calendar', 'No activity found', 'Add the tickets you worked on, or add leave.', 'gray')]);
}

function ticketRow(date, entry) {
  const day = serverDay(date);
  const inTempo = day.state === 'tempo';
  const locked = (day.readOnlyKeys ?? []).includes(entry.key);
  const source = inTempo ? (locked ? 'In Tempo · read-only' : 'In Tempo') : evidenceFor(date, entry.key);
  return el('li', {},
    el('div', { class: 'row' },
      glyph('ticket', entry.manual ? 'indigo' : 'purple'),
      el('div', { class: 'row-body' },
        ticketTitle(entry.key, ticketInfo(entry.key)),
        el('div', { class: 'row-sub' },
          el('span', {}, source),
          entry.manual && !inTempo && [sep(), el('span', { class: 'manual-tag' }, 'set by you')],
          buildChip(entry.key),
          whyButton(date, entry.key, `Why ${formatHours(entry.hours)}h?`))),
      el('div', { class: 'row-trail' },
        locked ? el('span', { class: 'step-v' }, `${formatHours(entry.hours)}h`) : ticketControls(date, entry))),
    evidenceRegion(date, entry.key));
}

function ticketControls(date, entry) {
  // Tempo hours can be off the 0.5h grid, so they snap to the next mark instead of moving by a step.
  const inTempo = isTempoDay(date);
  const up = inTempo ? stepUp : (h) => h + STEP;
  const down = inTempo ? stepDown : (h) => h - STEP;
  return [
    stepper(entry.hours, {
      label: `hours for ${entry.key}`,
      minusDisabled: entry.hours <= STEP,
      onMinus: () => setTicketHours(date, entry.key, down),
      onPlus: () => setTicketHours(date, entry.key, up),
    }),
    el('button', {
      type: 'button', class: 'icon-btn', 'aria-label': `Remove ${entry.key}`, title: 'Remove',
      onclick: () => removeTicket(date, entry.key),
    }, icon('x')),
  ];
}

// Tempo days show Tempo's leave read-only; other days get a leave stepper once leave is added.
function leaveRow(date, draft) {
  const day = serverDay(date);
  if (day.state === 'tempo') {
    return day.leaveHours > 0
      && leaveItem('Hours not logged in Tempo', el('span', { class: 'step-v' }, `${formatHours(day.leaveHours)}h`));
  }
  const dayHours = hoursOf(date);
  return draft.leaveHours > 0 && leaveItem(
    draft.leaveHours >= dayHours ? 'Full day off' : 'Ticket hours fill the rest of the day',
    stepper(draft.leaveHours, {
      label: 'leave hours',
      onMinus: () => editDay(date, (next) => { next.leaveHours -= STEP; }),
      onPlus: () => editDay(date, (next) => { next.leaveHours += STEP; }),
      plusDisabled: draft.leaveHours >= dayHours,
    }));
}

function leaveItem(sub, trail) {
  return el('li', { class: 'leave-row' },
    el('div', { class: 'row' },
      glyph('leave', 'teal'),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, 'Leave'),
        el('div', { class: 'row-sub' }, sub)),
      el('div', { class: 'row-trail' }, trail)));
}

function dayActions(date, { draft, used, target, ok }) {
  const day = serverDay(date);
  const inTempo = day.state === 'tempo';
  return el('div', { class: 'day-actions' },
    el('div', { class: 'left' },
      addTicketSelect(date, used),
      !inTempo && draft.leaveHours === 0 && leaveButtons(date)),
    el('div', { class: 'right' },
      el('button', {
        type: 'button', class: 'btn btn-small', disabled: !draft.entries.length && !draft.leaveHours,
        onclick: () => copyText(dayText(date), 'Day'),
      }, icon('copy'), 'Copy Day'),
      !inTempo && day.state === 'confirmed' && tempoReady() && sendDayButton(day),
      !inTempo && confirmButton(day, { target, ok })));
}

function addTicketSelect(date, used) {
  const choices = local.month.tickets.filter((t) => !used.has(t.key));
  const select = el('select', { class: 'field add-select', 'aria-label': 'Add a ticket' },
    el('option', { value: '' }, 'Add a ticket…'),
    choices.map((t) => el('option', { value: t.key }, `${t.key} ${t.summary ? `· ${t.summary.slice(0, 60)}` : ''}`)),
    el('option', { value: '__other' }, 'Other key…'));
  select.addEventListener('change', () => {
    let key = select.value;
    if (key === '__other') key = (prompt('Ticket key, for example TCPMOB-1482') ?? '').trim().toUpperCase();
    if (!TICKET_KEY.test(key) || used.has(key)) {
      select.value = '';
      if (key) toast('Enter a key like TCPMOB-1482', 'bad');
      return;
    }
    addTicket(date, key);
  });
  return select;
}

function leaveButtons(date) {
  const dayHours = hoursOf(date);
  const button = (hours, ...label) =>
    el('button', { type: 'button', class: 'btn btn-small', onclick: () => setLeaveHours(date, hours) }, ...label);
  return [
    button(STEP, icon('leave'), 'Add Leave'),
    button(Math.round(dayHours) / 2, 'Half-Day Leave'),
    button(dayHours, 'Full-Day Leave'),
  ];
}

function sendDayButton(day) {
  return el('button', {
    type: 'button', class: 'btn btn-small', disabled: !sendable(day) || local.busy,
    title: sendable(day) ? '' : 'Confirm your changes first',
    onclick: () => sendToTempo([day.date]),
  }, icon('upload'), 'Send to Tempo');
}

function confirmButton(day, { target, ok }) {
  const alreadyConfirmed = day.state === 'confirmed' && !local.edits.has(day.date);
  return el('button', {
    type: 'button', class: 'btn btn-filled', disabled: !ok || local.busy,
    title: ok ? '' : `Hours need to add up to ${formatHours(target)}h`, onclick: () => confirmDay(day.date),
  }, icon('check'), local.busy ? 'Saving…' : alreadyConfirmed ? 'Confirmed' : 'Confirm Day');
}

// ---------- month mode ----------

const ticketHours = (date, key) => workingCopy(date).entries.find((e) => e.key === key)?.hours ?? 0;
// Tempo days: leave is whatever Tempo doesn't cover. Other days: the leave the user set.
const leaveOf = (day) => (day.state === 'tempo' ? day.leaveHours : workingCopy(day.date).leaveHours);
const dayTotal = (day) => sumHours(workingCopy(day.date).entries) + leaveOf(day);
const sumOver = (days, hours) => days.reduce((sum, day) => sum + hours(day), 0);

function monthGrid() {
  const days = local.month.days.filter((d) => d.state !== 'future');
  const toSend = days.filter(sendable).map((d) => d.date);
  const flagged = days.filter((d) => flagsFor(d.date).length).length;
  return el('section', { class: 'block' },
    el('div', { class: 'section-head' },
      el('div', { class: 'section-title' }, glyph('calendar', 'green', 'sm'), el('h3', {}, 'Month at a Glance')),
      monthActions(toSend)),
    el('div', { class: 'card grid-card' }, el('div', { class: 'grid-scroll' }, monthTable(days)),
      flagged ? el('p', { class: 'muted' }, flaggedNote(flagged)) : null,
      el('p', { class: 'muted' }, 'Bold hours are confirmed or already in Tempo; light hours are suggestions. '
        + 'Exports include confirmed days only. Click a day to open it.')));
}

const flaggedNote = (count) =>
  `${plural(count, 'day')} in Tempo ${count === 1 ? 'has' : 'have'} edits to make by hand. Open the day for details.`;

function monthActions(toSend) {
  const exportLink = (format, label) => el('a', {
    class: 'btn btn-small', href: `/api/time/export?ym=${local.ym}&format=${format}`,
    download: `tempo-${local.ym}.${format}`,
  }, label);
  return el('div', { class: 'filters' },
    tempoReady() && el('button', {
      type: 'button', class: 'btn btn-small btn-filled', disabled: !toSend.length,
      title: toSend.length ? '' : 'No confirmed days waiting for Tempo', onclick: () => sendToTempo(toSend),
    }, icon('upload'), toSend.length ? `Send Month (${plural(toSend.length, 'day')})` : 'Send Month'),
    el('button', { type: 'button', class: 'btn btn-small', onclick: () => copyText(monthText(), 'Confirmed month') },
      icon('copy'), 'Copy Month'),
    exportLink('json', 'Export JSON'),
    exportLink('csv', 'Export CSV'));
}

function monthTable(days) {
  const keys = [...new Set(days.flatMap((d) => workingCopy(d.date).entries.map((e) => e.key)))];
  return el('table', { class: 'month-grid' },
    el('thead', {}, el('tr', {},
      el('th', { class: 'sticky' }, 'Ticket'),
      days.map((day) => monthColumnHead(day)),
      el('th', { class: 'tot' }, 'Total'))),
    el('tbody', {},
      keys.map((key) => monthTicketRow(days, key)),
      el('tr', { class: 'leave-line' },
        el('th', { class: 'sticky', scope: 'row' }, 'Leave'),
        days.map((day) => { const leave = leaveOf(day); return el('td', {}, leave ? formatHours(leave) : ''); }),
        el('td', { class: 'tot' }, formatHours(sumOver(days, leaveOf))))),
    el('tfoot', {}, el('tr', {},
      el('th', { class: 'sticky' }, 'Day total'),
      days.map((day) => {
        const hours = dayTotal(day);
        return el('td', { class: Math.abs(hours - day.dayHours) < 0.001 ? 'ok' : 'off' }, formatHours(hours));
      }),
      el('td', { class: 'tot' }, formatHours(sumOver(days, dayTotal))))));
}

function openDay(date) {
  local.mode = 'day';
  local.selected = date;
  render();
}

function monthColumnHead(day) {
  const date = toDate(day.date);
  return el('th', { class: `col ${day.state}`, title: `${longDate(day.date)} · ${STATE[day.state][0]}` },
    el('button', { type: 'button', class: 'col-btn', onclick: () => openDay(day.date) },
      el('span', { class: 'dp-wd' }, date.toLocaleDateString(undefined, { weekday: 'narrow' })),
      el('span', {}, String(date.getDate())),
      el('span', { class: `mini-dot ${day.state}` })));
}

function monthTicketRow(days, key) {
  return el('tr', {},
    el('th', { class: 'sticky', scope: 'row', title: ticketInfo(key).summary }, key),
    days.map((day) => monthCell(day, key)),
    el('td', { class: 'tot' }, formatHours(sumOver(days, (day) => ticketHours(day.date, key)))));
}

function monthCell(day, key) {
  const hours = ticketHours(day.date, key);
  const done = day.state === 'confirmed' || day.state === 'tempo';
  const source = () => (day.state === 'tempo' ? 'In Tempo' : evidenceFor(day.date, key));
  return el('td', {
    class: `${done ? 'conf' : 'sugg'} ${hours ? '' : 'zero'}`,
    title: hours ? `${key} · ${formatHours(hours)}h · ${source()}` : '',
  }, hours ? formatHours(hours) : '');
}

// ---------- page ----------

function head() {
  const month = local.month;
  return el('div', { class: 'page-head' },
    el('div', {},
      el('div', { class: 'page-title' }, 'Time'),
      el('div', { class: 'page-sub' },
        'Your Tempo hours, with suggestions from Jira, git, GitHub, and Claude for days not logged yet')),
    el('div', { class: 'time-controls' }, monthNav(), viewSwitch()),
    month && month.generatedAt && freshness({
      at: month.generatedAt, intervalMs: MONTH_FRESH_MS, error: local.loadError, onRefresh: () => load(local.ym, { fresh: true }),
    }),
    month && progressRow(month),
    month && month.tempo && !month.tempo.configured && el('p', { class: 'muted tempo-setup' },
      'Add your Tempo token in ', el('a', { href: '#settings' }, 'Settings'), ' to load and send Tempo hours.'));
}

function monthNav() {
  const month = local.month;
  return el('div', { class: 'month-nav' },
    el('button', {
      type: 'button', class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => load(shiftYm(local.ym, -1)),
    }, '‹'),
    el('span', { class: 'month-name' }, monthName(local.ym)),
    el('button', {
      type: 'button', class: 'icon-btn', 'aria-label': 'Next month',
      disabled: month && local.ym >= month.today.slice(0, 7), onclick: () => load(shiftYm(local.ym, 1)),
    }, '›'));
}

function viewSwitch() {
  return el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'View' },
    [['day', 'Day'], ['month', 'Month']].map(([mode, label]) => el('button', {
      type: 'button', role: 'tab', 'aria-selected': String(local.mode === mode),
      onclick: () => { local.mode = mode; render(); },
    }, label)));
}

function progressRow(month) {
  const workdays = month.days.filter((d) => d.state !== 'future');
  const done = workdays.filter((d) => d.state === 'confirmed' || d.state === 'leave' || d.state === 'tempo').length;
  return el('div', { class: 'progress-row' },
    el('span', {}, el('strong', {}, String(done)), ` of ${workdays.length} workdays confirmed or in Tempo`),
    el('div', { class: 'total-bar wide', 'aria-hidden': 'true' },
      el('span', { style: `width:${workdays.length ? (done / workdays.length) * 100 : 0}%` })));
}

function tempoBanner() {
  const tempo = local.month.tempo;
  if (!tempo || tempo.status === 'ok') return null;
  if (!tempo.configured) return null; // shown as a quiet line in the header instead
  return el('div', { class: 'banner error' }, glyph('alert', 'red', 'sm'),
    el('span', {}, `Tempo unavailable: ${tempo.status} Showing suggestions only, and sending is off.`));
}

function sourcesBanner() {
  const failing = Object.entries(local.month.sources).filter(([, status]) => status !== 'ok');
  if (!failing.length) return null;
  const names = { claude: 'Claude sessions', git: 'Git commits', jira: 'Jira', github: 'GitHub builds and reviews' };
  return el('div', { class: 'banner info' }, glyph('alert', 'orange', 'sm'),
    el('span', {}, failing.map(([source, status]) => `${names[source]} unavailable: ${status}`).join(' · '),
      '. Suggestions use the other sources.'));
}

function setupBlock() {
  const why = 'Time suggests hours from your Jira, git, GitHub, and Claude activity '
    + 'once it knows how long your workday is.';
  return el('section', { class: 'block setup-block' },
    el('ul', { class: 'group' }, empty('calendar', 'Set your workday hours to start.', why, 'green')),
    el('a', { class: 'btn btn-filled', href: '#settings' }, icon('gear'), 'Open Settings'));
}

function render() {
  if (!root) return;
  if (local.error) {
    root.replaceChildren(head(), el('div', { class: 'banner error' }, local.error.message));
    return;
  }
  if (!local.month || local.month.ym !== local.ym) {
    root.replaceChildren(head(), el('ul', { class: 'group' }, skeleton(4)));
    return;
  }
  if (local.month.dayHours === null) {
    root.replaceChildren(head(), setupBlock());
    return;
  }
  const body = local.mode === 'day' ? [dayStrip(), dayCard()] : [monthGrid()];
  // replaceChildren doesn't flatten arrays or skip nulls, so build a clean list.
  root.replaceChildren(...[head(), tempoBanner(), sourcesBanner(), ...body].filter(Boolean));
  const day = local.mode === 'day' && serverDay(local.selected);
  if (day) loadLatestBuilds([...day.entries, ...(day.maybe ?? [])].map((e) => e.key));
  root.querySelector('.day-pill[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// Closing the tab inside the autosave window must not drop edits: send them with keepalive.
addEventListener('pagehide', () => {
  for (const [date, timer] of local.saveTimers) {
    clearTimeout(timer);
    const draft = local.edits.get(date);
    if (!draft) continue;
    const [url, body] = draftRequest(date, draft);
    fetch(url, {
      method: 'POST', keepalive: true,
      headers: { 'X-Dashboard': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  local.saveTimers.clear();
});

export default {
  id: 'time',
  title: 'Time',
  mount(container, appCtx) {
    ctx = appCtx;
    local.settingsVersion = ctx.shared.settingsVersion ?? 0;
    root = el('div', { class: 'view-inner' });
    container.append(root);
    load(toYm(new Date()));
  },
  // The month reloads on navigation and after confirm; drafts autosave. If workday hours weren't set when it
  // last loaded, check again on every visit, so setting them in Settings turns Time on right away.
  refresh: () => load(local.ym, { fresh: true }),
  update() {
    const version = ctx.shared.settingsVersion ?? 0;
    if (local.month?.dayHours === null || local.settingsVersion !== version) {
      local.settingsVersion = version;
      load(local.ym);
    }
  },
};
