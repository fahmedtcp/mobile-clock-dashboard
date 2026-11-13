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
    const ticket = pr.ticketKey && tickets.get(pr.ticketKey);
    if (!pr.ticketKey) {
      const text = `PR #${pr.number} has no Jira ticket`;
      alerts.push({ kind: 'pr-no-ticket', key: null, pr: pr.number, text, url: pr.url });
    } else if (ticket && FINISHED_STATUSES.includes(ticket.status)) {
      const text = `${ticket.key} is ${ticket.status}, but PR #${pr.number} is still open`;
      alerts.push({ kind: 'finished-but-open', key: ticket.key, pr: pr.number, text, url: pr.url });
    }
  }

  for (const pr of mergedPrs.filter(mine)) {
    const ticket = pr.ticketKey && tickets.get(pr.ticketKey);
    if (ticket && ACTIVE_STATUSES.includes(ticket.status)) {
      const text = `PR #${pr.number} merged, but ${ticket.key} is still ${ticket.status}`;
      alerts.push({ kind: 'merged-but-active', key: ticket.key, pr: pr.number, text, url: ticket.url });
    }
  }

  for (const ticket of sprintTickets) {
    if (NEEDS_BRANCH.includes(ticket.status) && !hasBranch(branches, ticket.key)) {
      const text = `${ticket.key} is ${ticket.status}, but no branch exists for it`;
      alerts.push({ kind: 'ticket-no-branch', key: ticket.key, pr: null, text, url: ticket.url });
    }
  }
  return alerts;
}

async function handleAlerts(ctx, url) {
  const scope = url.searchParams.get('scope') === 'team' ? 'team' : 'mine';
  const sinceIso = new Date(Date.now() - 14 * DAY_MS).toISOString();
  // Jira problems degrade to GitHub-only alerts; the Jira banner reports the cause once.
  const jiraOr = (load, fallback) => (ctx.jira?.configured ? load().catch(() => fallback) : Promise.resolve(fallback));
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
}

export function routes(ctx) {
  return [['GET', /^\/api\/alerts$/, (m, req, url) => handleAlerts(ctx, url)]];
}
