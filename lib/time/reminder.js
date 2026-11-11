// End-of-workday nudge to confirm hours, sent as a macOS notification by the server.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { dayKey, isWorkday, parseDay } from './days.js';
import { dayHoursOf } from './store.js';

const resolved = (rec) => rec?.status === 'confirmed' || (rec?.leaveHours ?? 0) >= dayHoursOf(rec);

// One reminder per day at most: today's after reminderAt, else a catch-up for the latest unconfirmed past workday.
export function shouldRemind({ now, reminderAt, lastSentDay, lastSentOn = null, pending, todayRecord }) {
  const no = { send: false, day: null };
  if (reminderAt === 'off' || !/^\d{2}:\d{2}$/.test(reminderAt)) return no;
  const today = dayKey(now);
  if (lastSentOn === today) return no; // never more than one notification per calendar day
  const [h, m] = reminderAt.split(':').map(Number);
  const dueToday = isWorkday(today) && now.getHours() * 60 + now.getMinutes() >= h * 60 + m && !resolved(todayRecord);
  if (dueToday) return lastSentDay === today ? no : { send: true, day: today };
  const latest = pending.filter((d) => d < today).sort().at(-1);
  if (latest && (!lastSentDay || lastSentDay < latest)) return { send: true, day: latest };
  return no;
}

export function reminderText(day, { tickets, hours }, today) {
  const title = day === today ? "Confirm today's hours"
    : `Confirm hours for ${parseDay(day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  const body = tickets ? `${tickets} ticket${tickets === 1 ? '' : 's'}, ${hours}h suggested` : 'Open the dashboard to review the day.';
  return { title, body };
}

const quote = (s) => `"${String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

const defaultExec = (file, args) => new Promise((resolve) => execFile(file, args, { timeout: 10000 }, (err) => resolve({ code: err ? 1 : 0 })));

export function notify({ title, body }, exec = defaultExec) {
  return exec('osascript', ['-e', `display notification ${quote(body)} with title ${quote(title)}`]);
}

// Server-side loop: check every 5 minutes; remember the last reminded day across restarts.
export function startReminders({ timeDir, reminderAt, store, pendingDays, summarize, exec = defaultExec, every = 5 * 60 * 1000 }) {
  const stateFile = path.join(timeDir, 'reminder.json');
  const read = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const check = async () => {
    const now = new Date();
    const today = dayKey(now);
    const state = read();
    const r = shouldRemind({ now, reminderAt: typeof reminderAt === 'function' ? reminderAt() : reminderAt, lastSentDay: state.lastSentDay ?? null, lastSentOn: state.lastSentOn ?? null, pending: await pendingDays(), todayRecord: store.get(today) });
    if (!r.send) return;
    mkdirSync(timeDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ lastSentDay: r.day, lastSentOn: today }));
    let stats = { tickets: 0, hours: 0 };
    try { stats = await summarize(r.day); } catch { /* the generic text is fine */ }
    await notify(reminderText(r.day, stats, today), exec);
  };
  check().catch(() => {});
  return setInterval(() => check().catch(() => {}), every);
}
