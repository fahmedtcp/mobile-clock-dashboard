// Request PR Review: draft a PR in the team's format, create it after the user approves every detail,
// and move the ticket to Dev Review. Nothing here pushes or touches branches; GitHub must already have the branch.
import { REPO, JIRA } from '../config.js';
import { HttpError } from './http.js';
import { adfText } from './jira.js';
import { listPrs } from './prs.js';
import { getLogin } from './runs.js';
import { requireJira, ticketKey, KEY_EXACT } from './tickets.js';

const BASE = 'develop';
const LABELS = ['bug', 'enhancement', 'feature'];
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const TITLE_MAX = 256;
const BODY_MAX = 60000;
const PROBLEM_MAX = 1200;
const FILES_MAX = 30;
export const PLACEHOLDER = /\[fill in[^\]]*\]/i;

export function labelFor(issueType) {
  const type = String(issueType ?? '').toLowerCase();
  if (type === 'bug') return 'bug';
  if (type.includes('feature')) return 'feature';
  return 'enhancement';
}

// Commit subjects as Solution bullets: first line only, no ticket prefix, no merges, no repeats.
function solutionLines(commits, key) {
  const seen = new Set();
  return commits.map((message) => String(message).split('\n')[0].trim())
    .filter((line) => line && !/^Merge\b/i.test(line))
    .map((line) => line.replace(new RegExp(`^${key}[\\s:–-]*`, 'i'), '').trim())
    .filter((line) => line && !seen.has(line.toLowerCase()) && seen.add(line.toLowerCase()));
}

// The format the team already uses: heading, Jira link, Problem / Root Cause / Solution / Testing / Files Changed.
export function draftBody({ key, summary, url, description, commits, files }) {
  const problem = String(description ?? '').trim().slice(0, PROBLEM_MAX) || '[fill in: problem]';
  const solution = solutionLines(commits, key);
  const shown = files.slice(0, FILES_MAX).map((f) => `- \`${f}\``);
  if (files.length > FILES_MAX) shown.push(`- and ${files.length - FILES_MAX} more`);
  return [
    `## ${key} - ${summary}`, '', `[${key}](${url})`, '',
    '### Problem', problem, '',
    '### Root Cause', '[fill in: root cause]', '',
    '### Solution', ...(solution.length ? solution.map((s) => `- ${s}`) : ['[fill in: solution]']), '',
    '### Testing', '- Jest: [fill in]', '- Device: [fill in]', '',
    '### Files Changed', ...(shown.length ? shown : ['- none yet']), '',
  ].join('\n');
}

function exactKey(raw) {
  const key = String(raw).toUpperCase();
  if (!KEY_EXACT.test(key)) throw new HttpError(400, 'Expected a ticket key like TCPMOB-123.');
  return key;
}

async function branchFor(ctx, key) {
  const names = await ctx.branches.get();
  const matches = names.filter((n) => n === key || n.toUpperCase().startsWith(`${key}-`)).sort((a, b) => a.length - b.length);
  if (!matches.length) throw new HttpError(409, `No branch for ${key} on GitHub yet. Push your branch, then try again.`);
  return matches[0];
}

// Reviewers to offer: teammates (Settings → Team) plus people always tagged, minus you and people never tagged.
function reviewerChoices(ctx, me) {
  const { team, teams } = ctx.settings.resolved();
  const always = new Set(teams.always);
  const never = new Set(teams.never);
  const people = [...team.people.filter((p) => !p.qa).map((p) => ({ login: p.github, name: p.name })),
    ...teams.always.map((login) => ({ login, name: login }))];
  const seen = new Set();
  return people.filter((p) => p.login !== me && !never.has(p.login) && !seen.has(p.login) && seen.add(p.login))
    .map((p) => ({ ...p, selected: always.has(p.login) }));
}

async function draft(ctx, key) {
  const jira = requireJira(ctx);
  const [issue, me, open] = await Promise.all([
    jira.getIssue(key, ['summary', 'issuetype', 'status', 'description']), getLogin(ctx.gh), listPrs(ctx.gh),
  ]);
  const existing = open.find((pr) => ticketKey(pr.headRefName, pr.title) === key);
  const fields = issue.fields ?? {};
  const base = { status: fields.status?.name ?? '', key };
  if (existing) return { ...base, existing: { number: existing.number, url: existing.url } };
  const head = await branchFor(ctx, key);
  const compare = await ctx.gh.json(['api', `repos/${REPO}/compare/${BASE}...${encodeURIComponent(head)}`]);
  const url = `${String(JIRA.baseUrl).replace(/\/+$/, '')}/browse/${key}`;
  return {
    ...base,
    existing: null,
    title: `${key} - ${fields.summary ?? ''}`.trim(),
    base: BASE,
    head,
    label: labelFor(fields.issuetype?.name),
    labels: LABELS,
    reviewers: reviewerChoices(ctx, me),
    body: draftBody({
      key, summary: fields.summary ?? '', url, description: adfText(fields.description ?? '').trim(),
      commits: (compare.commits ?? []).map((c) => c.commit?.message ?? ''),
      files: (compare.files ?? []).map((f) => f.filename),
    }),
  };
}

async function create(ctx, key, input) {
  const title = String(input?.title ?? '').trim();
  const body = String(input?.body ?? '');
  const reviewers = Array.isArray(input?.reviewers) ? input.reviewers.map(String) : [];
  if (!title || title.length > TITLE_MAX) throw new HttpError(400, 'Give the PR a title.');
  if (body.length > BODY_MAX) throw new HttpError(400, 'The description is too long.');
  if (PLACEHOLDER.test(body)) throw new HttpError(400, 'Fill in or delete the [fill in: …] parts first.');
  if (!LABELS.includes(input?.label)) throw new HttpError(400, 'Pick bug, enhancement, or feature.');
  if (!reviewers.every((r) => LOGIN.test(r))) throw new HttpError(400, 'Reviewers must be GitHub logins.');
  const head = await branchFor(ctx, key);
  if (input?.head !== head) throw new HttpError(400, `The PR must come from ${head}.`);
  const args = ['pr', 'create', '-R', REPO, '--base', BASE, '--head', head, '--title', title, '--body', body,
    '--assignee', '@me', '--label', input.label];
  if (reviewers.length) args.push('--reviewer', reviewers.join(','));
  const url = (await ctx.gh.run(args)).trim().split('\n').at(-1);
  return { number: Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0), url };
}

async function moveToDevReview(ctx, key) {
  const jira = requireJira(ctx);
  const issue = await jira.getIssue(key, ['status']);
  const from = issue.fields?.status?.name ?? '';
  if (from === 'Dev Review') return { ok: true, already: true };
  const move = (await jira.transitions(key)).find((t) => t.to?.name === 'Dev Review');
  if (!move) throw new HttpError(409, `${key} can't move from ${from} to Dev Review in Jira.`);
  await jira.transition(key, move.id);
  ctx.tickets?.clear?.();
  return { ok: true, from, to: 'Dev Review' };
}

export function routes(ctx) {
  return [
    ['GET', /^\/api\/tickets\/([^/]+)\/pr-draft$/, (m) => draft(ctx, exactKey(m[1]))],
    ['POST', /^\/api\/tickets\/([^/]+)\/pr$/, async (m, req) => create(ctx, exactKey(m[1]), await ctx.readJson(req))],
    ['POST', /^\/api\/tickets\/([^/]+)\/dev-review$/, (m) => moveToDevReview(ctx, exactKey(m[1]))],
  ];
}
