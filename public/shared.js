// Pure helpers used by both the server (lib/) and the page. No DOM or Node APIs.

// TCPMOB-123 + summary → "TCPMOB-123-summary-in-kebab-case", ≤100 chars, valid git ref.
export const TICKET_KEY = /^TCPMOB-\d+$/;

export function branchName(key, summary) {
  const slug = String(summary ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const full = slug ? `${key}-${slug}` : key;
  return full.slice(0, 100).replace(/-+$/, '');
}

// ---- time tracking (shared by server and page so drafts rebalance identically) ----

const STEP = 0.5;
export const MAX_TICKETS = 5;

// weights: Map<key, number> → [{ key, hours }] in 0.5h steps, ≥0.5 each, ≤5 tickets, summing exactly to target.
export function allocate(weights, target, maxTickets = MAX_TICKETS) {
  const units = Math.round(target / STEP);
  let kept = [...weights.entries()].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, maxTickets);
  while (kept.length > units) kept.pop();
  if (!kept.length || units <= 0) return [];
  const extra = units - kept.length; // every kept ticket already has one unit (0.5h)
  const total = kept.reduce((a, [, w]) => a + w, 0);
  const shares = kept.map(([key, w]) => {
    const exact = (w / total) * extra;
    return { key, units: 1 + Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = units - shares.reduce((a, s) => a + s.units, 0);
  for (const s of [...shares].sort((a, b) => b.rem - a.rem)) { if (left <= 0) break; s.units += 1; left -= 1; }
  return shares.map((s) => ({ key: s.key, hours: s.units * STEP })).sort((a, b) => b.hours - a.hours);
}

// Keep the user's manual hours; spread what's left over the other entries by their previous hours.
export function rebalance(entries, target) {
  const manual = entries.filter((e) => e.manual);
  const auto = entries.filter((e) => !e.manual);
  const left = target - manual.reduce((a, e) => a + e.hours, 0);
  if (left < 0 || !auto.length) return entries;
  const weights = new Map(auto.map((e) => [e.key, e.hours || STEP]));
  const spread = new Map(allocate(weights, left, auto.length).map((x) => [x.key, x.hours]));
  return entries.flatMap((e) => (e.manual ? [e] : spread.has(e.key) ? [{ ...e, hours: spread.get(e.key) }] : []));
}
