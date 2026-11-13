// Standup draft from evidence the dashboard already has: commits, Jira status changes, PRs, builds. Never chat text.
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const since = (iso, sinceMs) => Date.parse(iso) >= sinceMs;

export function standupDraft({ input, rows, commits, sinceMs }) {
  const parts = new Map(); // key -> clauses, in first-seen order
  const add = (key, clause) => { if (!parts.has(key)) parts.set(key, []); parts.get(key).push(clause); };
  const counts = new Map();
  for (const c of commits.filter((x) => x.key && since(x.at, sinceMs))) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
  for (const [key, n] of counts) add(key, plural(n, 'commit'));
  for (const [key, histories] of input.changelogs) {
    for (const h of histories.filter((x) => x.author?.accountId === input.me.accountId && since(x.created, sinceMs))) {
      for (const item of (h.items ?? []).filter((i) => i.field === 'status')) add(key, `moved to ${item.toString}`);
    }
  }
  for (const pr of input.prs.filter((p) => since(p.createdAt, sinceMs))) {
    const key = rows.find((r) => r.pr === pr.number)?.key ?? pr.headRefName?.match(/TCPMOB-\d+/)?.[0];
    if (key) add(key, `opened PR #${pr.number}`);
  }
  for (const [key, builds] of input.buildComments) {
    for (const b of builds.filter((x) => since(x.created, sinceMs))) add(key, `build ${b.number}`);
  }
  const yesterday = [...parts].map(([key, clauses]) => `${key}: ${clauses.join(', ')}.`).join(' ') || 'Nothing logged.';
  const today = rows.slice(0, 3).map((r) => `${r.key} (${r.stageLabel})`).join(', ');
  const blocked = rows.filter((r) => r.blocker.kind === 'waiting-review').map((r) => `${r.key}: ${r.blocker.text}.`).join(' ');
  return { yesterday, today: today ? `${today}.` : 'Nothing assigned.', blocked: blocked || 'Nothing.' };
}
