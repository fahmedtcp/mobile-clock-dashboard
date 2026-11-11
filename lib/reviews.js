import { REPO } from '../config.js';

const DAY_MS = 864e5;
const OVERDUE_DAYS = 2;
const CACHE_MS = 300000;
const BOT = 'claude[bot]';
const [OWNER, NAME] = REPO.split('/');

const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft createdAt
        author { login }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        timelineItems(itemTypes: REVIEW_REQUESTED_EVENT, last: 20) {
          nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } }
        }
      }
    }
  }
}`;

export function fromGraphql(node) {
  const lastRequest = new Map();
  for (const e of node.timelineItems?.nodes ?? []) {
    const login = e.requestedReviewer?.login;
    if (login && (!lastRequest.has(login) || e.createdAt > lastRequest.get(login))) lastRequest.set(login, e.createdAt);
  }
  const requests = (node.reviewRequests?.nodes ?? [])
    .map((r) => r.requestedReviewer?.login)
    .filter(Boolean)
    .map((login) => ({ login, requestedAt: lastRequest.get(login) ?? node.createdAt }));
  return { number: node.number, title: node.title, url: node.url, author: node.author?.login ?? '', isDraft: node.isDraft, createdAt: node.createdAt, requests };
}

export function reviewQueue(prs, now = new Date()) {
  const days = (iso) => Math.floor((now - Date.parse(iso)) / DAY_MS);
  const reviewers = new Map();
  const waiting = [];
  for (const pr of prs) {
    if (pr.isDraft || !pr.requests.length) continue;
    for (const r of pr.requests) {
      const d = days(r.requestedAt);
      const cur = reviewers.get(r.login) ?? { login: r.login, count: 0, oldestDays: 0 };
      cur.count += 1;
      cur.oldestDays = Math.max(cur.oldestDays, d);
      reviewers.set(r.login, cur);
    }
    const waitingDays = Math.max(...pr.requests.map((r) => days(r.requestedAt)));
    waiting.push({ number: pr.number, title: pr.title, url: pr.url, author: pr.author, waitingOn: pr.requests.map((r) => r.login), waitingDays, overdue: waitingDays > OVERDUE_DAYS });
  }
  return {
    byReviewer: [...reviewers.values()].sort((a, b) => b.count - a.count || b.oldestDays - a.oldestDays),
    prs: waiting.sort((a, b) => b.waitingDays - a.waitingDays),
  };
}

export function latestBotSummary(comments) {
  const bot = comments.filter((c) => c.user?.login === BOT).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return bot ? { id: bot.id, body: bot.body, createdAt: bot.created_at } : null;
}

export function routes(ctx) {
  let queueCache = null;
  const aiCache = new Map();
  return [
    ['GET', /^\/api\/reviews$/, async () => {
      if (queueCache && Date.now() - queueCache.at <= CACHE_MS) return queueCache.data;
      const data = await ctx.gh.json(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${OWNER}`, '-F', `name=${NAME}`]);
      const prs = (data?.data?.repository?.pullRequests?.nodes ?? []).map(fromGraphql);
      const queue = reviewQueue(prs);
      queueCache = { data: queue, at: Date.now() };
      return queue;
    }],
    ['GET', /^\/api\/prs\/([^/]+)\/ai-review$/, async (m) => {
      const n = ctx.id(m[1]);
      const hit = aiCache.get(n);
      if (hit && Date.now() - hit.at <= CACHE_MS) return hit.data;
      const [comments, inline] = await Promise.all([
        ctx.gh.json(['api', '--paginate', '--slurp', `repos/${REPO}/issues/${n}/comments?per_page=100`]),
        ctx.gh.json(['api', '--paginate', '--slurp', `repos/${REPO}/pulls/${n}/comments?per_page=100`]),
      ]);
      const data = {
        summary: latestBotSummary(comments.flat()),
        inlineCount: inline.flat().filter((c) => c.user?.login === BOT).length,
      };
      aiCache.set(n, { data, at: Date.now() });
      return data;
    }],
  ];
}
