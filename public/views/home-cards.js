// Card builders for the shift-aware Home. Each takes data from /api/home plus `act(action)` and returns a node (or null).
// All text goes through el() → textContent, so Jira and calendar text can never become markup.
import { el, ext, glyph, freshness } from '../ui.js';
import { ticketLink } from '../tickets-ui.js';
import { shiftState, labelRows, linkTokens, prUrl } from '../shared.js';

const STAGE_COUNT = 5;

// Plain text with every ticket key and "#123" turned into a link: keys open the ticket panel, PRs open GitHub.
export const linked = (text) => linkTokens(text).map((tok) => (tok.t === 'ticket' ? ticketLink(tok.v)
  : tok.t === 'pr' ? ext(prUrl(tok.n), tok.v) : tok.v));
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const pctOfShift = (shift, iso) => {
  const start = Date.parse(shift.shiftStart);
  return Math.min(100, Math.max(0, ((Date.parse(iso) - start) / (Date.parse(shift.shiftEnd) - start)) * 100));
};
const hm = (minutes) => (minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`);

function actionButton(action, act, { filled = false } = {}) {
  if (!action) return null;
  return el('button', { type: 'button', class: `btn btn-small ${filled ? 'btn-filled' : ''}`, onclick: (e) => { e.stopPropagation(); act(action); } },
    action.label);
}

function card(id, title, look, { count = null, hot = false, trail = null } = {}, ...body) {
  return el('section', { class: 'hc', id: `hc-${id}`, 'aria-labelledby': `hc-${id}-h` },
    el('div', { class: 'hc-head' }, glyph(look[0], look[1], 'sm'),
      el('h3', { id: `hc-${id}-h` }, title),
      count != null && el('span', { class: `hc-count ${hot ? 'hot' : ''}` }, String(count)),
      trail && el('span', { class: 'hc-trail' }, trail)),
    ...body);
}

// ---------- hero ----------

function nextMeetingText(meetings, now) {
  const next = meetings.find((m) => Date.parse(m.start) > now);
  if (!next) return null;
  const minutes = Math.round((Date.parse(next.start) - now) / 60000);
  return `${next.title} in ${minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes} min`}`;
}

// The server's clock, moved forward by the time since the response arrived.
export const nowOf = (home) => new Date(Date.parse(home.now) + (Date.now() - (home.fetchedAt ?? Date.now())));

const LABEL_TOP = 30;   // px from the rail's top to the first label row
const LABEL_ROW = 36;   // px per extra row when labels would touch
const minutesText = (ms) => hm(Math.max(1, Math.round(ms / 60000)));

// A4: an 18px pill per meeting with a two-line label under it. Past meetings fade, the live one is green with
// "now", the next one is bold with "in 52m". Labels that would touch drop to the next row (see layoutLabels).
function meetingMarks(shift, meetings, now) {
  const t = now.getTime();
  const next = meetings.find((m) => Date.parse(m.start) > t);
  return meetings.flatMap((m) => {
    const start = Date.parse(m.start);
    const end = Date.parse(m.end);
    const state = end <= t ? 'done' : start <= t ? 'live' : m === next ? 'next' : '';
    const from = pctOfShift(shift, m.start);
    const width = Math.max(0.8, pctOfShift(shift, m.end) - from);
    const center = from + width / 2;
    const tag = state === 'live' ? el('span', { class: 'tag live' }, 'now')
      : state === 'next' ? el('span', { class: 'tag next' }, `in ${minutesText(start - t)}`) : null;
    return [
      el('i', { class: `mtg ${state}`, style: `left:${from}%;width:${width}%`, title: `${m.title} · ${clock(m.start)}–${clock(m.end)}` }),
      el('i', { class: 'stem', style: `left:${center}%` }),
      el('span', { class: `mlbl c ${state}`, style: `left:${center}%`, 'data-from': from, 'data-to': Math.min(100, from + width) },
        el('b', {}, m.title), tag, el('br'), el('span', { class: 't' }, `${clock(m.start)} · ${minutesText(end - start)}`)),
    ];
  });
}

// Once the rail has a width: put touching labels on lower rows, stretch their stems, and grow the rail to fit.
function layoutLabels(rail) {
  const labels = [...rail.querySelectorAll('.mlbl')];
  const stems = [...rail.querySelectorAll('.stem')];
  if (!labels.length) return;
  const box = rail.getBoundingClientRect();
  // Centered by default; a label that would spill past either end aligns to its block's edge instead.
  for (const label of labels) {
    label.className = label.className.replace(/\b[lrc]\b/, 'c');
    label.style.left = `${(Number(label.dataset.from) + Number(label.dataset.to)) / 2}%`;
    const r = label.getBoundingClientRect();
    if (r.right > box.right) { label.className = label.className.replace(/\bc\b/, 'r'); label.style.left = `${label.dataset.to}%`; }
    if (r.left < box.left) { label.className = label.className.replace(/\bc\b/, 'l'); label.style.left = `${label.dataset.from}%`; }
  }
  const origin = box.left;
  const rows = labelRows(labels.map((l) => { const r = l.getBoundingClientRect(); return [r.left - origin, r.right - origin]; }));
  labels.forEach((label, i) => {
    label.style.top = `${LABEL_TOP + rows[i] * LABEL_ROW}px`;
    stems[i].style.height = `${LABEL_TOP - 22 + rows[i] * LABEL_ROW}px`;
  });
  rail.style.height = `${LABEL_TOP + (Math.max(...rows) + 1) * LABEL_ROW}px`;
}

export function shiftLine(shift, meetings, now) {
  if (shift.phase === 'weekend') return null;
  const live = shiftState(now, shift);
  const pct = live.progress * 100;
  const left = live.phase === 'before' ? `Starts in ${hm(live.startsInMinutes)}`
    : live.phase === 'after' ? 'Shift over' : `${hm(live.minutesLeft)} left`;
  const label = (hhmm) => new Date(`2000-01-01T${hhmm}:00`).toLocaleTimeString([], { hour: 'numeric' });
  const line = el('div', { class: 'shiftline', role: 'img', 'aria-label': `Shift ${label(shift.start)} to ${label(shift.end)}, ${left}` },
    el('span', {}, label(shift.start)),
    el('div', { class: 'rail', 'aria-hidden': 'true' },
      el('i', { class: 'base' }), el('i', { class: 'past', style: `width:${pct}%` }),
      el('i', { class: 'pin', style: `left:${100 - (shift.wrapMinutes / ((Date.parse(shift.shiftEnd) - Date.parse(shift.shiftStart)) / 60000)) * 100}%`, title: 'Wrap-up starts' }),
      ...meetingMarks(shift, meetings, now),
      live.phase === 'during' && el('i', { class: 'now', style: `left:${pct}%` })),
    el('span', { class: 'left-time' }, label(shift.end), ' · ', el('b', {}, left)));
  const rail = line.querySelector('.rail');
  new ResizeObserver(() => layoutLabels(rail)).observe(rail);
  return line;
}

export function heroCard(home, act) {
  const now = Date.parse(home.now);
  const date = new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const meetingNote = nextMeetingText(home.meetings, now);
  const { headline } = home;
  const team = home.team.length ? el('div', { class: 'team' },
    el('div', { class: 'team-h' }, home.shift.phase === 'during' ? 'On Shift Now' : 'Team'),
    home.team.map((m) => el('div', { class: 'mate' },
      el('span', { class: `av ${m.onShift ? 'on' : ''}`, 'aria-hidden': 'true' }, m.you ? 'You' : initials(m.name)),
      el('span', { class: 'who' }, m.name, m.qa ? el('span', { class: 'qa' }, ' · QA') : null),
      el('span', { class: 'doing' }, linked(m.doing))))) : null;
  return el('section', { class: `hero-card ${team ? '' : 'solo'}`, 'aria-label': 'Your shift' },
    el('div', {},
      el('div', { class: 'hello' }, [date, clock(home.now), meetingNote].filter(Boolean).join(' · '),
        ' ', freshness({ at: home.generatedAt, intervalMs: 60000 })),
      ...[home.errors.github && `GitHub didn't load, so pull request details are missing: ${home.errors.github}`, home.errors.calendar]
        .filter(Boolean).map((text) => el('p', { class: 'hero-warn', role: 'status' }, text)),
      el('h2', { class: 'headline' }, linked(headline.text)),
      headline.sub && el('p', { class: 'subline' }, linked(headline.sub)),
      (headline.action || headline.secondary) && el('div', { class: 'hero-actions' },
        actionButton(headline.action, act, { filled: true }), actionButton(headline.secondary, act))),
    team,
    shiftLine(home.shift, home.meetings, nowOf(home)));
}

const initials = (name) => name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

// ---------- my work ----------

function stageDots(row) {
  const dots = [];
  for (let i = 0; i < STAGE_COUNT; i++) {
    const state = i < row.stageIndex ? 'done' : i === row.stageIndex ? row.tone : '';
    if (i) dots.push(el('i', { class: `ln ${i <= row.stageIndex ? 'done' : ''}` }));
    dots.push(el('i', { class: `stp ${state}` }));
  }
  return el('div', { class: 'steps-col' }, el('div', { class: 'steps', 'aria-hidden': 'true' }, dots), el('div', { class: 'stage' }, row.stageLabel));
}

export function workCard(rows, act, error) {
  const body = rows.length
    ? rows.map((row) => el('div', {
      class: 'tk', role: 'button', tabindex: '0', 'aria-label': `${row.key}: ${row.blocker.text}`,
      onclick: (e) => { if (!e.target.closest('button, a')) act({ kind: 'open-ticket', key: row.key }); }, // links inside the row do their own thing
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) act({ kind: 'open-ticket', key: row.key }); },
    },
    el('div', { class: 'tk-id' }, ticketLink(row.key), el('span', { class: 'sum' }, row.summary)),
    stageDots(row),
    el('div', { class: 'block' }, el('b', {}, linked(row.blocker.text)), row.blocker.quote && el('span', { class: 'muted' }, ' “', linked(row.blocker.quote), '”'),
      row.blocker.detail && el('span', { class: 'muted' }, ' ', linked(row.blocker.detail)),
      ...(row.todos ?? []).map((t) => el('div', { class: 'pin' }, el('span', { class: 'pin-dot', 'aria-hidden': 'true' }), linked(t.text),
        t.from ? el('span', { class: 'faint' }, ` · from ${t.from}`) : null))),
    el('div', { class: 'acts' }, actionButton(row.secondary, act),
      actionButton(row.action, act, { filled: true }))))
    : [el('p', { class: 'muted hc-empty' }, error ? `Couldn't load your tickets: ${error}` : 'No tickets assigned to you right now.')];
  return card('work', 'My Work', ['ticket', 'purple'], { count: rows.length, trail: 'Click a ticket for its panel' }, ...body);
}

// ---------- feed ----------

export function feedCard(items, { id, title, onMarkRead, emptyText }) {
  const unread = items.filter((i) => i.unread).length;
  const body = items.length ? items.map((item) => el('div', { class: `item ${item.unread ? 'unread' : ''}` },
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    el('span', { class: 'av', 'aria-hidden': 'true' }, initials(item.who)),
    el('div', { class: 'body' }, el('b', {}, item.who), ' ', linked(item.text), item.quote && el('div', { class: 'quote' }, linked(item.quote))),
    el('span', { class: 'when' }, clock(item.at))))
    : [el('p', { class: 'muted hc-empty' }, emptyText)];
  const trail = onMarkRead && unread ? el('button', { type: 'button', class: 'link-btn', onclick: onMarkRead }, 'Mark read') : null;
  return card(id, title, ['sparkle', 'blue'], { count: unread || null, hot: unread > 0, trail }, ...body);
}

// ---------- waiting, today, plan, standup, wrap, note ----------

export function waitingCard(waiting, act) {
  const rows = [
    ...waiting.reviews.map((r) => el('div', { class: 'rowx' },
      el('div', { class: 't' }, el('b', {}, 'Review ', ext(r.url, `#${r.pr}`), ` for ${r.author}`), el('div', { class: 's' }, linked(r.title))),
      actionButton({ kind: 'open-url', label: 'Open', url: r.url }, act))),
    waiting.hoursPending > 0 && el('div', { class: 'rowx' },
      el('div', { class: 't' }, el('b', {}, `Confirm ${waiting.hoursPending} ${waiting.hoursPending === 1 ? 'day' : 'days'} of hours`),
        el('div', { class: 's' }, 'Suggestions ready · not in Tempo yet')),
      actionButton({ kind: 'go', label: 'Open Time', view: 'time' }, act)),
  ].filter(Boolean);
  if (!rows.length) return null;
  return card('waiting', 'Waiting on You', ['clock', 'orange'], { count: rows.length }, ...rows);
}

export function todayCard(shift, meetings) {
  const blocks = [];
  let cursor = Date.parse(shift.shiftStart);
  const end = Date.parse(shift.shiftEnd);
  const free = (from, to) => to - from >= 15 * 60000 && blocks.push({ free: true, from, to });
  for (const m of meetings.filter((x) => Date.parse(x.end) > cursor && Date.parse(x.start) < end)) {
    free(cursor, Date.parse(m.start));
    blocks.push({ free: false, from: Date.parse(m.start), to: Date.parse(m.end), title: m.title });
    cursor = Math.max(cursor, Date.parse(m.end));
  }
  free(cursor, end);
  return card('today', "Today's Shift", ['calendar', 'indigo'], { trail: meetings.length ? 'From your calendar' : 'No meetings' },
    ...blocks.map((b) => el('div', { class: 'mrow' },
      el('span', { class: `bar ${b.free ? 'free' : ''}`, 'aria-hidden': 'true' }),
      el('time', {}, `${clock(new Date(b.from).toISOString())} – ${clock(new Date(b.to).toISOString())}`),
      el('div', { class: 't' }, el('b', {}, b.free ? 'Focus' : b.title), el('div', { class: 's' }, hm(Math.round((b.to - b.from) / 60000)))))));
}

export function planCard(plan, act) {
  if (!plan.length) return null;
  return card('plan', 'Plan for This Shift', ['bolt', 'teal'], {},
    el('ol', { class: 'plan' }, plan.map((p) => el('li', { class: 'rowx' },
      el('div', { class: 't' }, el('b', {}, ticketLink(p.key)), el('div', { class: 's' }, linked(p.text))), actionButton(p.action, act)))));
}

export function standupCard(standup, act) {
  if (!standup) return null;
  const text = `Yesterday: ${standup.yesterday}\nToday: ${standup.today}\nBlocked: ${standup.blocked}`;
  return card('standup', `Standup at ${clock(standup.at)}`, ['team', 'green'], {
    trail: el('button', { type: 'button', class: 'link-btn', onclick: () => act({ kind: 'copy', text, done: 'Standup copied.' }) }, 'Copy'),
  }, el('div', { class: 'note' },
    el('b', {}, 'Yesterday'), el('p', {}, linked(standup.yesterday)),
    el('b', {}, 'Today'), el('p', {}, linked(standup.today)),
    el('b', {}, 'Blocked'), el('p', {}, linked(standup.blocked))),
  el('p', { class: 'foot' }, 'From your Jira changes, commits, PRs, and builds. Never chat text.'));
}

export function wrapCard(items, act) {
  if (!items.length) return null;
  const left = items.filter((i) => !i.done).length;
  return card('wrap', 'Before You Log Off', ['moon', 'indigo'], { count: left || null, hot: left > 0 },
    ...items.map((item) => el('div', { class: `check ${item.done ? 'ok' : ''}` },
      el('span', { class: `box ${item.done ? 'ok' : 'todo'}`, 'aria-hidden': 'true' }, item.done ? '✓' : ''),
      el('div', { class: 't' }, el('b', {}, linked(item.title)), el('div', { class: 's' }, linked(item.sub))),
      !item.done && actionButton(item.action, act))));
}

// To-dos: open ones first (oldest first), then today's checked ones. Typing TCPMOB-123 or "123 …" links a ticket.
function todoItem(todo, handlers) {
  return el('div', { class: `todo ${todo.done ? 'ok' : ''}` },
    el('button', {
      type: 'button', class: `box ${todo.done ? 'ok' : 'empty'}`, role: 'checkbox', 'aria-checked': String(todo.done),
      'aria-label': `${todo.done ? 'Uncheck' : 'Check off'}: ${todo.text}`, onclick: () => handlers.toggle(todo),
    }, todo.done ? '✓' : ''),
    el('div', { class: 't' }, el('span', {}, linked(todo.text)),
      todo.key && !todo.text.toUpperCase().includes(todo.key) && [' ', ticketLink(todo.key)],
      todo.from && el('span', { class: 'from' }, `from ${todo.from}`)),
    el('button', { type: 'button', class: 'todo-x', 'aria-label': `Delete: ${todo.text}`, onclick: () => handlers.remove(todo) }, '×'));
}

export function todoCard(todos, { title, trail = null, alwaysShow = false, handlers }) {
  const open = todos.filter((t) => !t.done).length;
  if (!todos.length && !alwaysShow) return null;
  const input = el('input', {
    class: 'field todo-input', type: 'text', maxlength: '200', autocomplete: 'off', spellcheck: 'true',
    placeholder: 'Add a to-do…', title: 'A ticket key like TCPMOB-123, or a number first, links the ticket', 'aria-label': 'New to-do',
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      const text = e.target.value;
      e.target.value = ''; // empty first, so the redraw that shows the new to-do isn't skipped
      handlers.add(text);
    },
  });
  return card('todos', title, ['check', open ? 'orange' : 'green'], { count: open || null, hot: false, trail },
    ...todos.map((t) => todoItem(t, handlers)),
    el('div', { class: 'todo-add' }, input, el('kbd', {}, 'Return')));
}
