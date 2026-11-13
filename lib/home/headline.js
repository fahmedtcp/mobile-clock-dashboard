// The hero's one sentence: the most important thing right now, first match wins.
const MEETING_SOON_MS = 15 * 60000;
const DAY_MS = 864e5;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const finalFailure = (b, now) => b.status === 'completed' && b.conclusion === 'failure'
  && (b.classification?.kind === 'code' || b.retries >= b.maxRetries) && now - b.triggeredAt <= DAY_MS;

export function pickHeadline({ rows, builds, meetings, reviews, wrap, shift, now }) {
  const failed = builds.find((b) => finalFailure(b, now));
  if (failed) {
    return {
      text: failed.retries ? `${failed.label} failed after ${plural(failed.retries, 'retry', 'retries')}.` : `${failed.label} failed.`,
      sub: failed.reason?.lines?.[0] ?? '',
      action: { kind: 'scroll', label: 'Details', target: 'builds' },
      secondary: failed.runId ? { kind: 'rerun', label: 'Rerun', runId: failed.runId } : null,
    };
  }
  const pushedBack = rows.find((r) => r.blocker.kind === 'qa-bounce' || r.blocker.kind === 'changes-requested');
  if (pushedBack) {
    const { who, kind, quote } = pushedBack.blocker;
    return {
      text: kind === 'qa-bounce' ? `${who} sent ${pushedBack.key} back.` : `${who} asked for changes on #${pushedBack.pr}.`,
      sub: quote ?? '', action: pushedBack.action, secondary: null,
    };
  }
  const testing = rows.find((r) => r.blocker.kind === 'qa-missing-platform');
  if (testing) {
    const { who, build, missing } = testing.blocker;
    return {
      text: `${who} is testing your ${testing.key} right now.`,
      sub: `Build ${build} is with them. Start the ${missing} build so they can test both platforms this shift.`,
      action: testing.action, secondary: { kind: 'open-ticket', label: 'Open ticket', key: testing.key },
    };
  }
  const meeting = meetings.find((m) => Date.parse(m.start) > now && Date.parse(m.start) - now <= MEETING_SOON_MS);
  if (meeting) {
    const minutes = Math.max(1, Math.round((Date.parse(meeting.start) - now) / 60000));
    return { text: `${meeting.title} in ${minutes} min.`, sub: '', action: null, secondary: null };
  }
  const [review] = reviews;
  if (review) {
    return {
      text: `${review.author} is waiting on your review of #${review.pr}.`, sub: review.title,
      action: { kind: 'open-url', label: 'Open', url: review.url }, secondary: null,
    };
  }
  const open = wrap.filter((item) => !item.done).length;
  if (shift.moment === 'wrap' && open) {
    return { text: `${plural(open, 'thing')} before you log off.`, sub: '', action: { kind: 'scroll', label: 'Start checklist', target: 'wrap' }, secondary: null };
  }
  const [top] = rows;
  return {
    text: "Nothing's stuck.",
    sub: top ? `${top.key}: ${top.blocker.text}` : 'No tickets assigned to you right now.',
    action: top?.action ?? null, secondary: null,
  };
}
