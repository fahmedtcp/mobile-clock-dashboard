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

// login -> when that reviewer was last requested, from the PR timeline.
function lastRequestTimes(timelineEvents) {
  const lastRequest = new Map();
  for (const event of timelineEvents) {
    const login = event.requestedReviewer?.login;
    if (login && (!lastRequest.has(login) || event.createdAt > lastRequest.get(login))) {
      lastRequest.set(login, event.createdAt);
    }
  }
  return lastRequest;
}

export function fromGraphql(node) {
  const lastRequest = lastRequestTimes(node.timelineItems?.nodes ?? []);
  const requests = (node.reviewRequests?.nodes ?? [])
    .map((r) => r.requestedReviewer?.login)
    .filter(Boolean)
    .map((login) => ({ login, requestedAt: lastRequest.get(login) ?? node.createdAt }));
  const { number, title, url, isDraft, createdAt } = node;
  return { number, title, url, author: node.author?.login ?? '', isDraft, createdAt, requests };
}

export function reviewQueue(prs, now = new Date()) {
  const days = (iso) => Math.floor((now - Date.parse(iso)) / DAY_MS);
  const reviewers = new Map();
  const waiting = [];
  for (const pr of prs) {
    if (pr.isDraft || !pr.requests.length) continue;
    for (const request of pr.requests) {
      const reviewer = reviewers.get(request.login) ?? { login: request.login, count: 0, oldestDays: 0 };
      reviewer.count += 1;
      reviewer.oldestDays = Math.max(reviewer.oldestDays, days(request.requestedAt));
      reviewers.set(request.login, reviewer);
    }
    const waitingDays = Math.max(...pr.requests.map((r) => days(r.requestedAt)));
    const { number, title, url, author } = pr;
    const waitingOn = pr.requests.map((r) => r.login);
    waiting.push({ number, title, url, author, waitingOn, waitingDays, overdue: waitingDays > OVERDUE_DAYS });
  }
  return {
    byReviewer: [...reviewers.values()].sort((a, b) => b.count - a.count || b.oldestDays - a.oldestDays),
    prs: waiting.sort((a, b) => b.waitingDays - a.waitingDays),
  };
}

const isBot = (comment) => comment.user?.login === BOT;

export function latestBotSummary(comments) {
  const bot = comments.filter(isBot).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return bot ? { id: bot.id, body: bot.body, createdAt: bot.created_at } : null;
}

async function loadReviewQueue(gh) {
  const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${OWNER}`, '-F', `name=${NAME}`];
  const response = await gh.json(args);
  const prs = (response?.data?.repository?.pullRequests?.nodes ?? []).map(fromGraphql);
  return reviewQueue(prs);
}

async function loadAiReview(gh, prNumber) {
  const allPages = (path) => gh.json(['api', '--paginate', '--slurp', `repos/${REPO}/${path}?per_page=100`]);
  const [comments, inline] = await Promise.all([
    allPages(`issues/${prNumber}/comments`),
    allPages(`pulls/${prNumber}/comments`),
  ]);
  return { summary: latestBotSummary(comments.flat()), inlineCount: inline.flat().filter(isBot).length };
}

export function routes(ctx) {
  let queueCache = null;
  const aiCache = new Map(); // pr number -> { data, at }
  const fresh = (entry) => entry && Date.now() - entry.at <= CACHE_MS;

  async function handleReviews() {
    if (fresh(queueCache)) return queueCache.data;
    const queue = await loadReviewQueue(ctx.gh);
    queueCache = { data: queue, at: Date.now() };
    return queue;
  }

  async function handleAiReview(prNumber) {
    const hit = aiCache.get(prNumber);
    if (fresh(hit)) return hit.data;
    const data = await loadAiReview(ctx.gh, prNumber);
    aiCache.set(prNumber, { data, at: Date.now() });
    return data;
  }

  return [
    ['GET', /^\/api\/reviews$/, () => handleReviews()],
    ['GET', /^\/api\/prs\/([^/]+)\/ai-review$/, (m) => handleAiReview(ctx.id(m[1]))],
  ];
}
