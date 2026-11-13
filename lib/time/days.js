// Local-date helpers. Every "day" in time tracking is the machine's local calendar day.

const pad = (n) => String(n).padStart(2, '0');

export function dayKey(date) {
  const local = date instanceof Date ? date : new Date(date);
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}

export function parseDay(day) {
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  return new Date(year, month - 1, dayOfMonth);
}

export function isWorkday(day) {
  const weekday = parseDay(day).getDay();
  return weekday >= 1 && weekday <= 5;
}

export function monthRange(ym) {
  const [year, month] = ym.split('-').map(Number);
  return { start: new Date(year, month - 1, 1), end: new Date(year, month, 0, 23, 59, 59, 999) };
}

export function workdays(ym) {
  const { start, end } = monthRange(ym);
  const out = [];
  for (const date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
    const day = dayKey(date);
    if (isWorkday(day)) out.push(day);
  }
  return out;
}

// First and last calendar day of a month, as YYYY-MM-DD (for API date ranges).
export function monthBounds(ym) {
  const [year, month] = ym.split('-').map(Number);
  return { from: `${ym}-01`, to: `${ym}-${pad(new Date(year, month, 0).getDate())}` };
}

export const monthOf = (day) => day.slice(0, 7);
export const validYm = (ym) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym ?? ''));
export const validDay = (day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day ?? '')) && dayKey(parseDay(day)) === day;
