import { api, post, el, ext, sep, glyph, icon, skeleton, empty, toast, showError, confirmSheet } from '../ui.js';
import { rebalance, TICKET_KEY } from '../shared.js';

// Each day carries its own workday length (saved days keep theirs when the setting changes).
const hoursOf = (date) => serverDay(date)?.dayHours ?? local.month?.dayHours ?? 7;
const STEP = 0.5;
let ctx;
let root;
const local = {
  ym: null,          // 'YYYY-MM'
  mode: 'day',       // 'day' | 'month'
  month: null,       // server month
  error: null,
  selected: null,    // 'YYYY-MM-DD'
  edits: new Map(),  // date -> { leaveHours, entries } not yet confirmed (drafts autosave)
  saveTimers: new Map(), // date -> pending autosave timer (one per day, so editing another day never cancels it)
  busy: false,
};

const fmt = (h) => String(Math.round(h * 100) / 100); // Tempo hours can be 3.13; ours are 0.5h steps
const total = (entries) => entries.reduce((a, e) => a + e.hours, 0);
const parse = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
const longDate = (day) => parse(day).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const shortDate = (day) => parse(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
// Step to the next 0.5h mark, so Tempo hours like 3.13 land on 3.5 or 3.
const stepUp = (h) => Math.floor(h * 2 + 1e-9) / 2 + STEP;
const stepDown = (h) => Math.ceil(h * 2 - 1e-9) / 2 - STEP;
const monthName = (ym) => parse(`${ym}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const shiftYm = (ym, n) => { const d = parse(`${ym}-01`); d.setMonth(d.getMonth() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
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
  for (const t of local.saveTimers.values()) clearTimeout(t);
  local.saveTimers.clear();
  return Promise.all(dates.map((d) => saveDraft(d)));
}

async function load(ym = local.ym) {
  await flushDrafts();
  local.ym = ym;
  local.error = null;
  render();
  try {
    local.month = await api(`/api/time/month?ym=${ym}`);
    local.edits.clear();
    if (!local.selected || !local.selected.startsWith(ym)) local.selected = defaultDay();
  } catch (err) {
    local.error = err;
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

// The working copy of a day: unsaved edits if any, else the server's version.
function working(date) {
  if (local.edits.has(date)) return local.edits.get(date);
  const d = serverDay(date);
  return { leaveHours: d.leaveHours, removed: [], entries: d.entries.map((e) => ({ key: e.key, hours: e.hours, manual: e.manual })) };
}

function edit(date, change) {
  const w = structuredClone(working(date));
  change(w);
  if (serverDay(date).state === 'tempo') {
    w.entries = w.entries.filter((e) => e.hours > 0);
    local.edits.set(date, w);
    clearTimeout(local.saveTimers.get(date));
    local.saveTimers.set(date, setTimeout(() => { local.saveTimers.delete(date); saveDraft(date); }, 600));
    render();
    return;
  }
  // Rebalance against the day's original tickets too (minus ones the user removed), so lowering leave
  // brings back tickets that a bigger leave squeezed out.
  const present = new Set(w.entries.map((e) => e.key));
  const day = serverDay(date);
  const pool = (day.pool ?? day.entries)
    .filter((e) => !present.has(e.key) && !w.removed.includes(e.key))
    .map((e) => ({ key: e.key, hours: e.hours, manual: false }));
  // A full day of leave leaves no ticket time, even for hours set by hand; lowering leave refills from the pool.
  w.entries = w.leaveHours >= hoursOf(date) ? [] : rebalance([...w.entries, ...pool], hoursOf(date) - w.leaveHours);
  local.edits.set(date, w);
  clearTimeout(local.saveTimers.get(date));
  local.saveTimers.set(date, setTimeout(() => { local.saveTimers.delete(date); saveDraft(date); }, 600));
  render();
}

const draftRequest = (date, w) => (serverDay(date).state === 'tempo'
  ? [`/api/time/tempo/edits/${date}`, { entries: w.entries.map(({ key, hours }) => ({ key, hours })) }]
  : [`/api/time/day/${date}`, { leaveHours: w.leaveHours, entries: w.entries, confirm: false }]);

async function saveDraft(date) {
  const w = local.edits.get(date);
  if (!w) return;
  if (serverDay(date).state === 'tempo') {
    try { await post(...draftRequest(date, w)); } catch (err) { toast(err.message, 'bad'); }
    render();
    return;
  }
  try {
    await post(`/api/time/day/${date}`, { leaveHours: w.leaveHours, entries: w.entries, confirm: false });
    const d = serverDay(date);
    d.state = w.leaveHours >= hoursOf(date) ? 'leave' : 'review';
  } catch (err) {
    toast(err.message, 'bad');
  }
  render();
}

async function confirmDay(date) {
  const w = working(date);
  local.busy = true;
  render();
  clearTimeout(local.saveTimers.get(date));
  local.saveTimers.delete(date);
  try {
    await post(`/api/time/day/${date}`, { leaveHours: w.leaveHours, entries: w.entries, confirm: true });
    toast(`${parse(date).toLocaleDateString(undefined, { weekday: 'long' })} confirmed`);
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

function info(key) {
  return local.month.tickets.find((t) => t.key === key) ?? serverDay(local.selected)?.entries.find((e) => e.key === key) ?? { key, summary: '', url: null };
}

function evidenceFor(date, key) {
  return serverDay(date).entries.find((e) => e.key === key)?.evidence ?? 'Added by you';
}

// ---------- Tempo ----------

// Differences between what's on screen and Tempo, for a day already in Tempo.
function flagsFor(date) {
  const d = serverDay(date);
  if (d.state !== 'tempo') return [];
  const t = new Map(d.tempoEntries.map((e) => [e.key, e.hours]));
  const y = new Map(working(date).entries.map((e) => [e.key, e.hours]));
  return [...new Set([...t.keys(), ...y.keys()])].sort()
    .map((key) => ({ key, tempoHours: t.get(key) ?? 0, yourHours: y.get(key) ?? 0 }))
    .filter((f) => Math.abs(f.tempoHours - f.yourHours) > 0.001);
}

function flagText(f) {
  if (!f.tempoHours) return `Tempo doesn't have ${f.key}. You added ${fmt(f.yourHours)}h.`;
  const change = f.yourHours ? `You changed it to ${fmt(f.yourHours)}h.` : 'You removed it.';
  return `Tempo has ${f.key} ${fmt(f.tempoHours)}h. ${change} Update it in Tempo by hand.`;
}

const tempoReady = () => local.month?.tempo?.configured && local.month.tempo.status === 'ok';
const sendable = (d) => d.state === 'confirmed' && d.date <= local.month.today && !local.edits.has(d.date);

async function sendToTempo(dates) {
  await flushDrafts();
  let preview;
  try { preview = await api(`/api/time/tempo/preview?dates=${dates.join(',')}`); } catch (err) { toast(err.message, 'bad'); return; }
  const ready = preview.days.filter((d) => d.ok);
  const skipped = preview.days.filter((d) => !d.ok);
  const n = ready.reduce((a, d) => a + d.worklogs.length, 0);
  let results = null;
  const sent = await confirmSheet({
    title: dates.length > 1 ? 'Send Month to Tempo' : 'Send Day to Tempo',
    body: [
      el('p', { class: 'muted' }, 'Each day is checked against Tempo again right before sending. A day that already has Tempo hours is never sent.'),
      n ? el('ul', { class: 'tempo-list' }, ready.flatMap((d) => d.worklogs.map((w) => el('li', {}, `${shortDate(d.date)} · ${w.key} · ${fmt(w.hours)}h · ${w.description || 'No status'}`)))) : el('p', {}, 'Nothing to send.'),
      skipped.length && el('p', { class: 'muted' }, 'Skipped'),
      skipped.length && el('ul', { class: 'tempo-list muted' }, skipped.map((d) => el('li', {}, `${shortDate(d.date)} · ${d.reason}`))),
    ].filter(Boolean),
    confirmLabel: `Send ${n} Worklog${n === 1 ? '' : 's'}`,
    confirmDisabled: !n,
    onConfirm: async () => {
      try { results = (await post('/api/time/tempo/send', { dates: ready.map((d) => d.date) })).results; }
      finally { load(local.ym); } // some days may have gone in even when the request failed
    },
  });
  if (!sent || !results) return;
  await load(local.ym);
  ctx.refresh();
  const fix = local.month.days.filter((d) => d.state === 'tempo' && d.flags?.length);
  const lines = (list, text) => list.map((r) => el('li', {}, `${shortDate(r.date)} · ${text(r)}`));
  const ok = results.filter((r) => r.status === 'sent');
  const bad = results.filter((r) => r.status === 'failed' || r.status === 'partial');
  const skip = results.filter((r) => r.status === 'skipped');
  if (dates.length === 1 && ok.length === 1) { toast(`Sent ${ok[0].sent} worklog${ok[0].sent === 1 ? '' : 's'} to Tempo`); return; }
  await confirmSheet({
    title: 'Tempo Summary',
    body: [
      ok.length && el('p', {}, el('strong', {}, 'Sent')), ok.length && el('ul', { class: 'tempo-list' }, lines(ok, (r) => `${r.sent} worklog${r.sent === 1 ? '' : 's'}`)),
      bad.length && el('p', {}, el('strong', {}, 'Failed')), bad.length && el('ul', { class: 'tempo-list bad' }, lines(bad, (r) => (r.status === 'partial' ? `Partly sent. ${r.errors.join('; ')}` : r.errors.join('; ')))),
      skip.length && el('p', {}, el('strong', {}, 'Skipped')), skip.length && el('ul', { class: 'tempo-list muted' }, lines(skip, (r) => r.reason)),
      fix.length && el('p', {}, el('strong', {}, 'Fix in Tempo')), fix.length && el('ul', { class: 'tempo-list' }, fix.flatMap((d) => flagsFor(d.date).map((f) => el('li', {}, `${shortDate(d.date)} · ${flagText(f)}`)))),
    ].filter(Boolean),
    confirmLabel: 'Done',
  });
}

// ---------- copy / export ----------

function dayText(date) {
  const w = working(date);
  const lines = w.entries.map((e) => `${e.key}\t${fmt(e.hours)}h\t${info(e.key).summary ?? ''}`);
  if (w.leaveHours) lines.push(`Leave\t${fmt(w.leaveHours)}h`);
  return lines.join('\n');
}

function monthText() {
  return local.month.days.filter((d) => d.state === 'confirmed' || d.state === 'leave')
    .map((d) => `${longDate(d.date)}\n${dayText(d.date)}`).join('\n\n');
}

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
  catch { toast('Copy failed. Select the text and press ⌘C.', 'bad'); }
}

// ---------- day mode ----------

function strip() {
  return el('div', { class: 'day-strip', role: 'tablist', 'aria-label': 'Workdays' }, local.month.days.map((d) => {
    const dt = parse(d.date);
    const [label, color] = STATE[d.state];
    const edited = local.edits.has(d.date);
    return el('button', {
      type: 'button', role: 'tab', class: `day-pill ${d.state} ${d.date === local.month.today ? 'today' : ''}`,
      'aria-selected': String(d.date === local.selected), disabled: d.state === 'future',
      title: `${longDate(d.date)} · ${label}`,
      onclick: () => { local.selected = d.date; render(); },
    },
    el('span', { class: 'dp-wd' }, dt.toLocaleDateString(undefined, { weekday: 'short' })),
    el('span', { class: 'dp-n' }, String(dt.getDate())),
    el('span', { class: `dp-state ${d.state === 'tempo' && flagsFor(d.date).length ? 'orange' : color}` }, d.state === 'tempo' && flagsFor(d.date).length ? '•' : d.state === 'confirmed' || d.state === 'tempo' ? icon('check') : d.state === 'leave' ? icon('leave') : edited ? '•' : ''),
    d.leaveHours > 0 && d.leaveHours < d.dayHours ? el('span', { class: 'dp-leave', 'aria-label': `${d.leaveHours}h leave` }) : null);
  }));
}

function stepper(value, { onMinus, onPlus, label, minusDisabled = false, plusDisabled = false }) {
  return el('div', { class: 'stepper', role: 'group', 'aria-label': label },
    el('button', { type: 'button', class: 'step', 'aria-label': `Less ${label}`, disabled: minusDisabled, onclick: onMinus }, '−'),
    el('span', { class: 'step-v' }, `${fmt(value)}h`),
    el('button', { type: 'button', class: 'step', 'aria-label': `More ${label}`, disabled: plusDisabled, onclick: onPlus }, '+'));
}

function dayCard() {
  const date = local.selected;
  const d = serverDay(date);
  if (!d) return null;
  const H = hoursOf(date);
  const w = working(date);
  const inTempo = d.state === 'tempo';
  const readOnly = new Set(d.readOnlyKeys ?? []);
  const flags = flagsFor(date);
  const target = inTempo ? H : H - w.leaveHours;
  const sum = total(w.entries) + (inTempo ? d.leaveHours : 0);
  const ok = Math.abs(sum - target) < 0.001;
  const [label, color] = STATE[local.edits.has(date) && !inTempo ? 'review' : d.state];
  const used = new Set(w.entries.map((e) => e.key));
  const choices = local.month.tickets.filter((t) => !used.has(t.key));

  const select = el('select', { class: 'field add-select', 'aria-label': 'Add a ticket' },
    el('option', { value: '' }, 'Add a ticket…'),
    choices.map((t) => el('option', { value: t.key }, `${t.key} ${t.summary ? `· ${t.summary.slice(0, 60)}` : ''}`)),
    el('option', { value: '__other' }, 'Other key…'));
  select.addEventListener('change', () => {
    let key = select.value;
    if (key === '__other') key = (prompt('Ticket key, for example TCPMOB-1482') ?? '').trim().toUpperCase();
    if (!TICKET_KEY.test(key) || used.has(key)) { select.value = ''; if (key) toast('Enter a key like TCPMOB-1482', 'bad'); return; }
    edit(date, (x) => { x.removed = x.removed.filter((k) => k !== key); x.entries.push({ key, hours: STEP, manual: false }); });
  });

  const rows = w.entries.map((e) => {
    const t = info(e.key);
    const locked = readOnly.has(e.key);
    const up = inTempo ? stepUp : (h) => h + STEP;
    const down = inTempo ? stepDown : (h) => h - STEP;
    return el('li', {},
      el('div', { class: 'row' },
        glyph('ticket', e.manual ? 'indigo' : 'purple'),
        el('div', { class: 'row-body' },
          el('div', { class: 'row-title' }, t.url ? ext(t.url, e.key) : e.key, t.summary ? el('span', { class: 'time-summary' }, ` ${t.summary}`) : null),
          el('div', { class: 'row-sub' }, el('span', {}, inTempo ? (locked ? 'In Tempo · read-only' : 'In Tempo') : evidenceFor(date, e.key)), e.manual && !inTempo && [sep(), el('span', { class: 'manual-tag' }, 'set by you')])),
        locked ? el('div', { class: 'row-trail' }, el('span', { class: 'step-v' }, `${fmt(e.hours)}h`)) : el('div', { class: 'row-trail' },
          stepper(e.hours, {
            label: `hours for ${e.key}`,
            minusDisabled: e.hours <= STEP,
            onMinus: () => edit(date, (x) => { const it = x.entries.find((i) => i.key === e.key); it.hours = down(it.hours); it.manual = true; }),
            onPlus: () => edit(date, (x) => { const it = x.entries.find((i) => i.key === e.key); it.hours = up(it.hours); it.manual = true; }),
          }),
          el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${e.key}`, title: 'Remove', onclick: () => edit(date, (x) => { x.entries = x.entries.filter((i) => i.key !== e.key); x.removed.push(e.key); }) }, icon('x')))));
  });

  const tempoLeaveRow = inTempo && d.leaveHours > 0 && el('li', { class: 'leave-row' },
    el('div', { class: 'row' }, glyph('leave', 'teal'),
      el('div', { class: 'row-body' }, el('div', { class: 'row-title' }, 'Leave'), el('div', { class: 'row-sub' }, 'Hours not logged in Tempo')),
      el('div', { class: 'row-trail' }, el('span', { class: 'step-v' }, `${fmt(d.leaveHours)}h`))));
  const leaveRow = inTempo ? tempoLeaveRow : w.leaveHours > 0 && el('li', { class: 'leave-row' },
    el('div', { class: 'row' },
      glyph('leave', 'teal'),
      el('div', { class: 'row-body' }, el('div', { class: 'row-title' }, 'Leave'), el('div', { class: 'row-sub' }, w.leaveHours >= H ? 'Full day off' : 'Ticket hours fill the rest of the day')),
      el('div', { class: 'row-trail' },
        stepper(w.leaveHours, {
          label: 'leave hours',
          onMinus: () => edit(date, (x) => { x.leaveHours -= STEP; }),
          onPlus: () => edit(date, (x) => { x.leaveHours += STEP; }),
          plusDisabled: w.leaveHours >= H,
        }))));

  const list = el('ul', { class: 'group' }, rows.length || leaveRow ? [...rows, leaveRow] : [empty('calendar', 'No activity found', 'Add the tickets you worked on, or add leave.', 'gray')]);
  list.style.setProperty('--inset', '56px');

  const tempoNote = inTempo
    ? el('div', { class: `banner ${flags.length ? 'info' : 'ok'} tempo-note` }, glyph(flags.length ? 'alert' : 'check', flags.length ? 'orange' : 'green', 'sm'),
      flags.length
        ? el('div', {}, el('strong', {}, 'Your edits differ from Tempo'), el('ul', { class: 'tempo-list' }, flags.map((f) => el('li', {}, flagText(f)))))
        : el('span', {}, 'Already in Tempo. Edits here are notes only; the dashboard never changes Tempo hours.'))
    : null;
  const sendBtn = !inTempo && d.state === 'confirmed' && tempoReady() && el('button', {
    type: 'button', class: 'btn btn-small', disabled: !sendable(d) || local.busy,
    title: sendable(d) ? '' : 'Confirm your changes first',
    onclick: () => sendToTempo([date]),
  }, icon('upload'), 'Send to Tempo');

  return el('section', { class: 'block' },
    el('div', { class: 'day-head' },
      el('div', {}, el('h3', { class: 'day-title' }, longDate(date)), el('span', { class: `chip ${color}` }, label), d.suggested && d.entries.length > 0 && !local.edits.has(date) && el('span', { class: 'chip blue' }, icon('sparkle'), 'Suggested')),
      el('div', { class: 'day-total' },
        el('span', { class: `total ${ok ? 'ok' : sum === 0 ? 'unset' : 'off'}` }, `${fmt(sum)}`, el('span', { class: 'of' }, ` / ${fmt(target)}h`)),
        el('div', { class: 'total-bar', 'aria-hidden': 'true' }, el('span', { style: `width:${Math.min(100, target ? (sum / target) * 100 : 100)}%` })))),
    tempoNote,
    list,
    el('div', { class: 'day-actions' },
      el('div', { class: 'left' },
        select,
        !inTempo && w.leaveHours === 0 && [
          el('button', { type: 'button', class: 'btn btn-small', onclick: () => edit(date, (x) => { x.leaveHours = STEP; }) }, icon('leave'), 'Add Leave'),
          el('button', { type: 'button', class: 'btn btn-small', onclick: () => edit(date, (x) => { x.leaveHours = Math.round(H) / 2; }) }, 'Half-Day Leave'),
          el('button', { type: 'button', class: 'btn btn-small', onclick: () => edit(date, (x) => { x.leaveHours = H; }) }, 'Full-Day Leave')]),
      el('div', { class: 'right' },
        el('button', { type: 'button', class: 'btn btn-small', disabled: !w.entries.length && !w.leaveHours, onclick: () => copy(dayText(date), 'Day') }, icon('copy'), 'Copy Day'),
        sendBtn,
        !inTempo && el('button', { type: 'button', class: 'btn btn-filled', disabled: !ok || local.busy, title: ok ? '' : `Hours need to add up to ${fmt(target)}h`, onclick: () => confirmDay(date) },
          icon('check'), local.busy ? 'Saving…' : d.state === 'confirmed' && !local.edits.has(date) ? 'Confirmed' : 'Confirm Day'))));
}

// ---------- month mode ----------

function monthGrid() {
  const days = local.month.days.filter((d) => d.state !== 'future');
  const keys = [...new Set(days.flatMap((d) => working(d.date).entries.map((e) => e.key)))];
  const hoursOf = (date, key) => working(date).entries.find((e) => e.key === key)?.hours ?? 0;
  // Tempo days: leave is whatever Tempo doesn't cover. Other days: the leave the user set.
  const leaveOf = (d) => (d.state === 'tempo' ? d.leaveHours : working(d.date).leaveHours);
  const toSend = days.filter(sendable).map((d) => d.date);
  const flagged = days.filter((d) => flagsFor(d.date).length).length;
  const table = el('table', { class: 'month-grid' },
    el('thead', {}, el('tr', {},
      el('th', { class: 'sticky' }, 'Ticket'),
      days.map((d) => el('th', { class: `col ${d.state}`, title: `${longDate(d.date)} · ${STATE[d.state][0]}` },
        el('button', { type: 'button', class: 'col-btn', onclick: () => { local.mode = 'day'; local.selected = d.date; render(); } },
          el('span', { class: 'dp-wd' }, parse(d.date).toLocaleDateString(undefined, { weekday: 'narrow' })),
          el('span', {}, String(parse(d.date).getDate())),
          el('span', { class: `mini-dot ${d.state}` })))),
      el('th', { class: 'tot' }, 'Total'))),
    el('tbody', {},
      keys.map((key) => el('tr', {},
        el('th', { class: 'sticky', scope: 'row', title: info(key).summary }, key),
        days.map((d) => {
          const h = hoursOf(d.date, key);
          return el('td', { class: `${d.state === 'confirmed' || d.state === 'tempo' ? 'conf' : 'sugg'} ${h ? '' : 'zero'}`, title: h ? `${key} · ${fmt(h)}h · ${d.state === 'tempo' ? 'In Tempo' : evidenceFor(d.date, key)}` : '' }, h ? fmt(h) : '');
        }),
        el('td', { class: 'tot' }, fmt(days.reduce((a, d) => a + hoursOf(d.date, key), 0))))),
      el('tr', { class: 'leave-line' },
        el('th', { class: 'sticky', scope: 'row' }, 'Leave'),
        days.map((d) => { const l = leaveOf(d); return el('td', {}, l ? fmt(l) : ''); }),
        el('td', { class: 'tot' }, fmt(days.reduce((a, d) => a + leaveOf(d), 0))))),
    el('tfoot', {}, el('tr', {},
      el('th', { class: 'sticky' }, 'Day total'),
      days.map((d) => { const t = total(working(d.date).entries) + leaveOf(d); return el('td', { class: Math.abs(t - d.dayHours) < 0.001 ? 'ok' : 'off' }, fmt(t)); }),
      el('td', { class: 'tot' }, fmt(days.reduce((a, d) => a + total(working(d.date).entries) + leaveOf(d), 0))))));

  return el('section', { class: 'block' },
    el('div', { class: 'section-head' },
      el('div', { class: 'section-title' }, glyph('calendar', 'green', 'sm'), el('h3', {}, 'Month at a Glance')),
      el('div', { class: 'filters' },
        tempoReady() && el('button', { type: 'button', class: 'btn btn-small btn-filled', disabled: !toSend.length, title: toSend.length ? '' : 'No confirmed days waiting for Tempo', onclick: () => sendToTempo(toSend) }, icon('upload'), toSend.length ? `Send Month (${toSend.length} day${toSend.length === 1 ? '' : 's'})` : 'Send Month'),
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => copy(monthText(), 'Confirmed month') }, icon('copy'), 'Copy Month'),
        el('a', { class: 'btn btn-small', href: `/api/time/export?ym=${local.ym}&format=json`, download: `tempo-${local.ym}.json` }, 'Export JSON'),
        el('a', { class: 'btn btn-small', href: `/api/time/export?ym=${local.ym}&format=csv`, download: `tempo-${local.ym}.csv` }, 'Export CSV'))),
    el('div', { class: 'card grid-card' }, el('div', { class: 'grid-scroll' }, table),
      flagged ? el('p', { class: 'muted' }, `${flagged} day${flagged === 1 ? '' : 's'} in Tempo ${flagged === 1 ? 'has' : 'have'} edits to make by hand. Open the day for details.`) : null,
      el('p', { class: 'muted' }, 'Bold hours are confirmed or already in Tempo; light hours are suggestions. Exports include confirmed days only. Click a day to open it.')));
}

// ---------- page ----------

function head() {
  const m = local.month;
  const work = m ? m.days.filter((d) => d.state !== 'future') : [];
  const done = work.filter((d) => d.state === 'confirmed' || d.state === 'leave' || d.state === 'tempo').length;
  const seg = el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'View' }, [['day', 'Day'], ['month', 'Month']].map(([v, l]) =>
    el('button', { type: 'button', role: 'tab', 'aria-selected': String(local.mode === v), onclick: () => { local.mode = v; render(); } }, l)));
  return el('div', { class: 'page-head' },
    el('div', {},
      el('div', { class: 'page-title' }, 'Time'),
      el('div', { class: 'page-sub' }, 'Your Tempo hours, with suggestions from Jira, git, GitHub, and Claude for days not logged yet')),
    el('div', { class: 'time-controls' },
      el('div', { class: 'month-nav' },
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => load(shiftYm(local.ym, -1)) }, '‹'),
        el('span', { class: 'month-name' }, monthName(local.ym)),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next month', disabled: m && local.ym >= m.today.slice(0, 7), onclick: () => load(shiftYm(local.ym, 1)) }, '›')),
      seg),
    m && el('div', { class: 'progress-row' },
      el('span', {}, el('strong', {}, String(done)), ` of ${work.length} workdays confirmed or in Tempo`),
      el('div', { class: 'total-bar wide', 'aria-hidden': 'true' }, el('span', { style: `width:${work.length ? (done / work.length) * 100 : 0}%` }))),
    m && m.tempo && !m.tempo.configured && el('p', { class: 'muted tempo-setup' }, 'Add your Tempo token in ', el('a', { href: '#settings' }, 'Settings'), ' to load and send Tempo hours.'));
}

function tempoBanner() {
  const t = local.month.tempo;
  if (!t || t.status === 'ok') return null;
  if (!t.configured) return null; // shown as a quiet line in the header instead
  return el('div', { class: 'banner error' }, glyph('alert', 'red', 'sm'), el('span', {}, `Tempo unavailable: ${t.status} Showing suggestions only, and sending is off.`));
}

function sourcesBanner() {
  const bad = Object.entries(local.month.sources).filter(([, v]) => v !== 'ok');
  if (!bad.length) return null;
  const names = { claude: 'Claude sessions', git: 'Git commits', jira: 'Jira', github: 'GitHub builds and reviews' };
  return el('div', { class: 'banner info' }, glyph('alert', 'orange', 'sm'),
    el('span', {}, bad.map(([k, v]) => `${names[k]} unavailable: ${v}`).join(' · '), '. Suggestions use the other sources.'));
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
    root.replaceChildren(head(), el('section', { class: 'block setup-block' },
      el('ul', { class: 'group' }, empty('calendar', 'Set your workday hours to start.', 'Time suggests hours from your Jira, git, GitHub, and Claude activity once it knows how long your workday is.', 'green')),
      el('a', { class: 'btn btn-filled', href: '#settings' }, icon('gear'), 'Open Settings')));
    return;
  }
  // replaceChildren doesn't flatten arrays or skip nulls, so build a clean list.
  root.replaceChildren(...[head(), tempoBanner(), sourcesBanner(), ...(local.mode === 'day' ? [strip(), dayCard()] : [monthGrid()])].filter(Boolean));
  root.querySelector('.day-pill[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// Closing the tab inside the autosave window must not drop edits: send them with keepalive.
addEventListener('pagehide', () => {
  for (const [date, t] of local.saveTimers) {
    clearTimeout(t);
    const w = local.edits.get(date);
    if (!w) continue;
    const [url, body] = draftRequest(date, w);
    fetch(url, { method: 'POST', keepalive: true, headers: { 'X-Dashboard': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    const now = new Date();
    load(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  },
  // The month reloads on navigation and after confirm; drafts autosave. If workday hours weren't set when it
  // last loaded, check again on every visit, so setting them in Settings turns Time on right away.
  update() {
    const version = ctx.shared.settingsVersion ?? 0;
    if (local.month?.dayHours === null || local.settingsVersion !== version) { local.settingsVersion = version; load(local.ym); }
  },
};
