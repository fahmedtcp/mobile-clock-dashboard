// On Shift Now: you first, then each teammate and what they're on, from Jira and GitHub.
const isQa = (status) => /QA/i.test(status ?? '');

export function teamOnShift({ people, me, rows, teamTickets, allPrs, shift }) {
  if (!people.length) return [];
  const onShift = shift.phase === 'during';
  const mine = rows.find((r) => r.stageIndex > 0) ?? rows[0];
  const you = { name: 'You', you: true, qa: false, onShift, doing: mine ? `${mine.key} · ${mine.stageLabel}` : 'No ticket in progress' };
  const mates = people.filter((p) => p.github !== me.login).map((person) => {
    const theirs = teamTickets.filter((t) => t.assignee?.accountId && t.assignee.accountId === person.accountId);
    const testing = person.qa && theirs.find((t) => isQa(t.status));
    const working = theirs.find((t) => t.status === 'In Progress');
    const queue = allPrs.filter((pr) => (pr.reviewRequestedLogins ?? []).includes(person.github)).length;
    const doing = testing ? `Testing ${testing.key}`
      : working ? `${working.key} · In Progress`
        : queue ? `Reviewing · ${queue} in queue` : 'No ticket in progress';
    return { name: person.name, you: false, qa: person.qa, onShift, doing };
  });
  return [you, ...mates];
}
