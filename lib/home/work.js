// My Work: one row per ticket with its stage, what's blocking it in plain words, and the one button that fixes it.
// Pure: every input is passed in (see loadHomeSources), so the rules are tested without Jira or GitHub.
import { ticketKey } from '../tickets.js';

const DAY_MS = 864e5;
const BOUNCE_DAYS = 3;
const QUOTE_MAX = 140;
const isQa = (status) => /QA/i.test(status ?? '');
const NOT_STARTED = new Set(['To Do', 'Open']);
const BACK_TO = new Set(['In Progress', 'To Do', 'Open']);
const BUILD_KEYS = {
  'MobileClock iOS': 'mcIos', 'MobileClock Android': 'mcAndroid', 'Mobile Kiosk iOS': 'mkIos', 'Mobile Kiosk Android': 'mkAndroid',
};
const STAGES = ['To Do', 'In Progress', 'In Review', 'Building', 'In QA'];
const TONE_ORDER = { bad: 0, wait: 1, now: 2, ok: 3 };

// kind → [tone, stage label]
const KINDS = {
  'qa-bounce': ['bad', 'Back from QA'],
  'checks-failed': ['bad', 'Checks failing'],
  'changes-requested': ['bad', 'Changes asked'],
  'merged-not-built': ['wait', 'Merged, not built'],
  'qa-missing-platform': ['now', 'In QA'],
  'qa-testing': ['now', 'In QA'],
  behind: ['now', 'Behind develop'],
  'ready-for-qa': ['now', 'Ready for QA'],
  'needs-build': ['now', 'Approved'],
  'move-to-review': ['now', 'Approved'],
  'waiting-review': ['wait', 'In review'],
  'needs-review': ['now', 'Needs reviewer'],
  'no-pr': ['now', 'In Progress'],
  todo: ['ok', 'To Do'],
};

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || null;

// First non-empty line, plain text, clipped with an ellipsis.
export function quoteOf(text) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!line) return null;
  return line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX - 1)}…` : line;
}

function personName(people, { accountId, login }) {
  const person = people.find((p) => (accountId && p.accountId === accountId) || (login && p.github === login));
  return person ? firstName(person.name) : null;
}

// QA sent it back: the newest status change moved it out of QA, by someone else, in the last few days.
function bounce(ticket, input) {
  const { key } = ticket;
  if (isQa(ticket.status)) return null;
  const cutoff = input.now - BOUNCE_DAYS * DAY_MS;
  const newestStatus = (input.changelogs.get(key) ?? []).filter((h) => (h.items ?? []).some((i) => i.field === 'status'))
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];
  const changes = (input.changelogs.get(key) ?? []).flatMap((h) => (h.items ?? [])
    .filter((i) => i.field === 'status' && isQa(i.fromString) && BACK_TO.has(i.toString))
    .map(() => h))
    .filter((h) => h.author?.accountId !== input.me.accountId && Date.parse(h.created) >= cutoff)
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  const change = changes[0];
  if (!change || change !== newestStatus) return null;
  const by = change.author?.accountId;
  const comment = (input.comments.get(key) ?? [])
    .filter((c) => c.authorId === by && Date.parse(c.created) >= Date.parse(change.created) - DAY_MS)
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];
  const who = personName(input.people, { accountId: by }) ?? firstName(change.author?.displayName) ?? 'QA';
  return { who, quote: comment ? quoteOf(comment.text) : null };
}

function qaTester(ticket, people) {
  const assigned = ticket.assignee && people.find((p) => p.qa && p.accountId === ticket.assignee.accountId);
  const person = assigned ?? people.find((p) => p.qa);
  return person ? firstName(person.name) : null;
}

const newest = (builds) => [...builds].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
const otherPlatform = (platform) => (platform === 'iOS' ? 'Android' : 'iOS');

function blockerFor(ticket, input) {
  const { key } = ticket;
  const open = input.prs.filter((p) => ticketKey(p.headRefName, p.title) === key).sort((a, b) => b.number - a.number)[0] ?? null;
  const merged = input.merged.filter((p) => ticketKey(p.headRefName, p.title) === key)
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))[0] ?? null;
  const builds = newest(input.buildComments.get(key) ?? []);
  const behind = open ? input.behind.get(open.number) ?? 0 : 0;
  const openPr = open && { kind: 'open-url', label: 'Open PR', url: open.url };
  const openTicket = { kind: 'open-ticket', label: 'Open ticket', key };
  const make = (kind, text, action, extra = {}) => ({ kind, text, action, quote: null, detail: null, ...extra });

  const bounced = bounce(ticket, input);
  if (bounced) return make('qa-bounce', `${bounced.who} sent it back:`, openPr || openTicket, { quote: bounced.quote, who: bounced.who });

  if (open?.checks === 'failure') {
    const text = ['Checks failed', open.failedChecks.join(', '), behind > 0 && `${behind} behind develop`].filter(Boolean).join(' · ');
    const action = behind > 0
      ? { kind: 'update-branch', label: 'Update branch', pr: open.number }
      : { kind: 'open-url', label: 'Open checks', url: `${open.url}/checks` };
    return make('checks-failed', text, action);
  }
  if (open?.reviewDecision === 'CHANGES_REQUESTED') {
    const who = personName(input.people, { login: open.changesBy }) ?? open.changesBy ?? 'A reviewer';
    return make('changes-requested', `${who} asked for changes`, { kind: 'open-url', label: 'Open review', url: open.url },
      { quote: quoteOf(open.changesBody), who });
  }
  if (isQa(ticket.status)) {
    if (merged && !builds.some((b) => Date.parse(b.created) > Date.parse(merged.mergedAt))) {
      const days = Math.max(1, Math.floor((input.now - Date.parse(merged.mergedAt)) / DAY_MS));
      return make('merged-not-built', `Merged ${days} ${days === 1 ? 'day' : 'days'} ago, no build since.`, openTicket,
        { detail: "QA's latest build doesn't have the fix." });
    }
    const tester = qaTester(ticket, input.people);
    const [latest] = builds;
    const platforms = new Set(builds.filter((b) => b.app === latest?.app).map((b) => b.platform));
    if (tester && latest && open?.approved && platforms.size === 1) {
      const missing = otherPlatform(latest.platform);
      return make('qa-missing-platform', `${tester} is testing build ${latest.number} (${latest.platform}). No ${missing} build yet.`,
        { kind: 'build', label: `Build ${missing}`, pr: open.number, keys: [BUILD_KEYS[`${latest.app} ${missing}`]] },
        { who: tester, build: latest.number, missing });
    }
    if (!tester) return make('qa-testing', 'With QA.', openTicket);
    return make('qa-testing', latest ? `${tester} is testing build ${latest.number}.` : `${tester} is testing it.`, openTicket);
  }
  if (open && behind > 0) return make('behind', `${behind} behind develop`, { kind: 'update-branch', label: 'Update branch', pr: open.number });
  if (open?.approved) {
    if (builds.length && ticket.status === 'Dev Review') {
      return make('ready-for-qa', `Approved with build ${builds[0].number}. Ready for QA.`, { kind: 'request-qa', label: 'Request QA', key });
    }
    if (!builds.length) return make('needs-build', 'Approved. No build yet.', { kind: 'build', label: 'Build', pr: open.number, keys: null });
    return make('move-to-review', 'Approved. Move it to Dev Review.', openTicket);
  }
  if (open && open.reviewRequestedLogins.length) {
    const login = open.reviewRequestedLogins[0];
    return make('waiting-review', `Waiting on ${personName(input.people, { login }) ?? login}'s review`, openPr);
  }
  if (open && !open.isDraft) return make('needs-review', 'No reviewer yet.', openPr);
  if (NOT_STARTED.has(ticket.status)) return make('todo', 'Not started.', { kind: 'start', label: 'Start', key });
  return make('no-pr', open ? 'Draft PR.' : 'No PR yet.', openPr || openTicket);
}

// The buttons follow the ticket's stage: In Progress hands off for review; Dev Review builds (once GitHub says the
// PR is approved) and sends to QA. Other stages keep the blocker's own button.
const prFor = (ticket, input) => input.prs.filter((p) => ticketKey(p.headRefName, p.title) === ticket.key).sort((a, b) => b.number - a.number)[0] ?? null;

function stageButtons(ticket, input, blockerAction) {
  const open = prFor(ticket, input);
  const extra = blockerAction && blockerAction.kind !== 'open-ticket' ? blockerAction : null;
  if (ticket.status === 'In Progress') {
    return { action: { kind: 'request-pr-review', label: 'Request PR Review', key: ticket.key }, secondary: extra };
  }
  if (ticket.status === 'Dev Review') {
    const sendToQa = { kind: 'send-to-qa', label: 'Send to QA', key: ticket.key };
    // Build and Send to QA both wait for GitHub's Approved; until then the row's own button (Open PR, Open review…).
    return open?.approved
      ? { action: { kind: 'build', label: 'Build', pr: open.number, keys: null }, secondary: sendToQa }
      : { action: blockerAction?.kind === 'build' ? null : blockerAction, secondary: null };
  }
  return { action: blockerAction, secondary: null };
}

function stageIndex(ticket, input) {
  if (isQa(ticket.status)) return 4;
  if (NOT_STARTED.has(ticket.status)) return 0;
  const open = input.prs.find((p) => ticketKey(p.headRefName, p.title) === ticket.key);
  if (open?.approved || ticket.status === 'Dev Review') return 3;
  return open && !open.isDraft ? 2 : 1;
}

export function workRows(input) {
  const rows = input.tickets.map((ticket) => {
    const { action: blockerAction, ...blocker } = blockerFor(ticket, input);
    const { action, secondary } = stageButtons(ticket, input, blockerAction);
    const [tone, stageLabel] = KINDS[blocker.kind];
    const index = stageIndex(ticket, input);
    return {
      key: ticket.key, summary: ticket.summary, url: ticket.url, stageIndex: index,
      stageLabel: stageLabel ?? STAGES[index], tone, blocker, action, secondary,
      pr: input.prs.find((p) => ticketKey(p.headRefName, p.title) === ticket.key)?.number ?? null,
    };
  });
  const keyNumber = (key) => Number(key.split('-')[1]);
  return rows.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || keyNumber(b.key) - keyNumber(a.key));
}
