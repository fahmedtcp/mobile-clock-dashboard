// Confirmed and draft days, kept in data/time/confirmed.json. Writes are atomic (tmp + rename).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { isWorkday, validDay } from './days.js';
import { KEY_EXACT as KEY } from '../tickets.js';


// Days saved before workday hours became a setting were all 7h.
export const LEGACY_DAY_HOURS = 7;
// Each saved day keeps the workday length it was saved with, so changing the setting never rewrites the past.
export const dayHoursOf = (record) => record?.dayHours ?? LEGACY_DAY_HOURS;
export const isStep = (n) => typeof n === 'number' && Number.isFinite(n) && Math.round(n * 2) === n * 2;

export function createStore(file) {
  let data = null;
  const load = () => {
    if (data) return data;
    if (!existsSync(file)) { data = {}; return data; }
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // Never overwrite hours we can't read: move the damaged file aside, then start fresh.
      const aside = `${file}.corrupt-${Date.now()}`;
      renameSync(file, aside);
      console.error(`Time store was unreadable; kept it at ${aside}`);
      data = {};
    }
    return data;
  };
  return {
    get: (day) => load()[day] ?? null,
    all: () => ({ ...load() }),
    save(day, record) {
      load()[day] = record;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1));
      renameSync(`${file}.tmp`, file);
    },
  };
}

// Returns an error message, or null when the record is acceptable.
export function validateDay(day, record, today) {
  if (!validDay(day)) return 'Invalid date.';
  if (!isWorkday(day)) return 'That day is a weekend.';
  if (day > today) return 'You can\'t log hours for a future day.';
  const H = dayHoursOf(record);
  if (!isStep(H) || H < 4 || H > 10) return 'Workday hours must be 4–10 in 0.5h steps.';
  const leave = record.leaveHours ?? 0;
  if (!isStep(leave) || leave < 0 || leave > H) return `Leave must be 0–${H}h in 0.5h steps.`;
  if (!Array.isArray(record.entries)) return 'Entries must be a list.';
  if (leave >= H && record.entries.length) return 'A full day of leave can\'t also have ticket hours.';
  const seen = new Set();
  for (const e of record.entries) {
    if (!KEY.test(String(e?.key))) return `Invalid ticket key: ${String(e?.key).slice(0, 40)}`;
    if (seen.has(e.key)) return `${e.key} appears twice.`;
    seen.add(e.key);
    if (!isStep(e.hours) || e.hours <= 0) return `${e.key}: hours must be a positive 0.5h step.`;
  }
  if (record.status === 'confirmed') {
    const target = H - leave;
    const total = record.entries.reduce((a, e) => a + e.hours, 0);
    if (total !== target) return `Ticket hours add up to ${total}h; they need to equal ${target}h.`;
  }
  return null;
}
