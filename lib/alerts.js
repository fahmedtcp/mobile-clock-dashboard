import { ACTIVE_STATUSES, FINISHED_STATUSES } from '../config.js';
import { ticketKey, prsWithTickets } from './tickets.js';
import { listMergedPrs } from './ghdata.js';
import { getLogin } from './runs.js';

const DAY_MS = 864e5;
const NEEDS_BRANCH = ['Open', 'In Progress', 'Dev Review'];

function hasBranch(branches, key) {
  const re = new RegExp(`${key}(?!\\d)`, 'i');
  return branches.some((b) => re.test(b));
}

export function computeAlerts({ openPrs, mergedPrs, tickets, sprintTickets, branches, login, scope }) {
  const mine = (pr) => scope === 'team' || pr.author === login;
  const alerts = [];

  for (const pr of openPrs.filter((p) => !p.isDraft && mine(p))) {
    const t = pr.ticketKey && tickets.get(pr.ticketKey);
    if (!pr.ticketKey) {
      alerts.push({ kind: 'pr-no-ticket', key: null, pr: pr.number, text: `PR #${pr.number} has no Jira ticket`, url: pr.url });
    } else if (t && FINISHED_STATUSES.includes(t.status)) {
      alerts.push({ kind: 'finished-but-open', key: t.key, pr: pr.number, text: `${t.key} is ${t.status}, but PR #${pr.number} is still open`, url: pr.url });
    }
  }

  for (const pr of mergedPrs.filter(mine)) {
    const t = pr.ticketKey && tickets.get(pr.ticketKey);
    if (t && ACTIVE_STATUSES.includes(t.status)) {
      alerts.push({ kind: 'merged-but-active', key: t.key, pr: pr.number, text: `PR #${pr.number} merged, but ${t.key} is still ${t.status}`, url: t.url });
    }
  }

  for (const t of sprintTickets) {
    if (NEEDS_BRANCH.includes(t.status) && !hasBranch(branches, t.key)) {
      alerts.push({ kind: 'ticket-no-branch', key: t.key, pr: null, text: `${t.key} is ${t.status}, but no branch exists for it`, url: t.url });
    }
  }
  return alerts;
}

export function routes(ctx) {
  return [
    ['GET', /^\/api\/alerts$/, async (m, req, url) => {
      const scope = url.searchParams.get('scope') === 'team' ? 'team' : 'mine';
      const sinceIso = new Date(Date.now() - 14 * DAY_MS).toISOString();
      // Jira problems degrade to GitHub-only alerts; the Jira banner reports the cause once.
      const jiraOr = (promise, fallback) => (ctx.jira?.configured ? promise().catch(() => fallback) : Promise.resolve(fallback));
      const [{ prs: openPrs }, merged, branches, login, sprintTickets] = await Promise.all([
        prsWithTickets(ctx),
        listMergedPrs(ctx.gh, { sinceIso }),
        ctx.branches.get(),
        getLogin(ctx.gh),
        jiraOr(() => ctx.myTickets(), []),
      ]);
      const mergedPrs = merged.map((p) => ({ ...p, ticketKey: ticketKey(p.headRefName, p.title) }));
      const keys = [...openPrs, ...mergedPrs].map((p) => p.ticketKey).filter(Boolean);
      const tickets = await jiraOr(() => ctx.tickets.get(keys), new Map());
      return computeAlerts({ openPrs, mergedPrs, tickets, sprintTickets, branches, login, scope });
    }],
  ];
}
