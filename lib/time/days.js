// Local-date helpers. Every "day" in time tracking is the machine's local calendar day.

const pad = (n) => String(n).padStart(2, '0');

export function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isWorkday(day) {
  const wd = parseDay(day).getDay();
  return wd >= 1 && wd <= 5;
}

export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 0, 23, 59, 59, 999) };
}

export function workdays(ym) {
  const { start, end } = monthRange(ym);
  const out = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d);
    if (isWorkday(k)) out.push(k);
  }
  return out;
}

// First and last calendar day of a month, as YYYY-MM-DD (for API date ranges).
export function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { from: `${ym}-01`, to: `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
}
export const monthOf = (day) => day.slice(0, 7);
export const validYm = (ym) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym ?? ''));
export const validDay = (day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day ?? '')) && dayKey(parseDay(day)) === day;
