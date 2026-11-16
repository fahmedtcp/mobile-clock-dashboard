// End-of-day to-dos: added at wrap-up (or from ⌘K), shown and notified at the start of the next shift.
// Stored only in the Home file on this Mac. A ticket key (or a leading number) links the to-do to that ticket.
import { randomUUID } from 'node:crypto';
import { dayKey } from '../time/days.js';

const TEXT_MAX = 200;
const KEY_IN_TEXT = /\bTCPMOB-(\d+)\b/i;
const LEADING_NUMBER = /^(\d{2,6})\s+(.+)$/;
const BODY_ITEMS = 2;

// → { text, key } or null when empty or too long.
export function parseTodo(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > TEXT_MAX) return null;
  const leading = text.match(LEADING_NUMBER);
  if (leading) return { text: leading[2].trim(), key: `TCPMOB-${leading[1]}` };
  const inText = text.match(KEY_IN_TEXT);
  return { text, key: inText ? `TCPMOB-${inText[1]}` : null };
}

export const newTodo = (parsed, nowMs, id = randomUUID()) => ({ id, ...parsed, createdAt: nowMs, doneAt: null });

// Open items (oldest first), then today's checked ones. Items from before the last shift say which day they're from.
export function todoView(todos, { now, shift }) {
  const today = dayKey(now);
  const lastShiftStart = shift.prevShiftEnd - (shift.shiftEnd - shift.shiftStart);
  const visible = todos.filter((t) => !t.doneAt || dayKey(new Date(t.doneAt)) === today);
  const order = (t) => [t.doneAt ? 1 : 0, t.createdAt];
  return visible.sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]).map((t) => ({
    id: t.id, text: t.text, key: t.key, createdAt: t.createdAt, done: Boolean(t.doneAt),
    from: !t.doneAt && t.createdAt < lastShiftStart
      ? new Date(t.createdAt).toLocaleDateString('en-US', { weekday: 'long' }) : null,
  }));
}

// The old Note for Tomorrow becomes to-dos, one per non-empty line, once.
export function migrateNote(store, makeId = randomUUID, nowMs = Date.now()) {
  const note = store.get('note');
  if (!note?.text) return;
  const added = note.text.split('\n').map(parseTodo).filter(Boolean).map((p) => newTodo(p, nowMs, makeId()));
  store.save('todos', [...(store.get('todos') ?? []), ...added]);
  store.save('note', null);
}

// The macOS reminder at shift start: weekdays, during the shift, once a day, only with open items.
export function todoReminder({ now, shift, todos, lastSentOn, on }) {
  const open = todos.filter((t) => !t.doneAt);
  const today = dayKey(now);
  if (!on || shift.phase !== 'during' || lastSentOn === today || !open.length) return null;
  const label = (t) => (t.key && !t.text.toUpperCase().includes(t.key) ? `${t.key} ${t.text}` : t.text);
  return {
    day: today,
    title: `${open.length} to-do${open.length === 1 ? '' : 's'} from last night`,
    body: open.slice(0, BODY_ITEMS).map(label).join(' · ') + (open.length > BODY_ITEMS ? ` · and ${open.length - BODY_ITEMS} more` : ''),
  };
}
