import { REPO, JIRA, JIRA_PROJECT, FINISHED_STATUSES, JIRA_TTL_MS } from '../config.js';
import { requireJira, toTicket, ticketKey } from './tickets.js';
import { listMergedPrs } from './ghdata.js';
import { listPrs } from './prs.js';

const DAY_MS = 864e5;
const VERSION = /^Mobile (\d+)$/;
const BRANCH = /^release\/1\.(\d+)\.x$/;
const NOTE_GROUPS = [
  ['Fixes', ['Bug']],
  ['Improvements', ['Story', 'Task', 'Internal Development Story']],
];

export function parseVersion(name) {
  const m = String(name ?? '').match(VERSION);
  return m ? Number(m[1]) : null;
}

export function currentRelease(versions, branches) {
  const open = versions
    .filter((v) => !v.released && !v.archived && parseVersion(v.name) !== null)
    .sort((a, b) => parseVersion(a.name) - parseVersion(b.name));
  if (!open.length) return null;
  const v = open[0];
  const nn = parseVersion(v.name);
  const cuts = branches.map((b) => b.match(BRANCH)).filter(Boolean).map((m) => Number(m[1]));
  const prev = Math.max(...cuts.filter((n) => n < nn), -1);
  return {
    name: v.name,
    nn,
    releaseDate: v.releaseDate ?? null,
    branch: `release/1.${nn}.x`,
    branchExists: cuts.includes(nn),
    lastCut: prev >= 0 ? `release/1.${prev}.x` : null,
  };
}

export function releaseLists({ tickets, prsByKey, mergedSinceCut, onBranch, fixKeys }) {
  const prOf = (key) => {
    const p = prsByKey.get(key);
    return p ? { number: p.number, url: p.url, state: p.state } : null;
  };
  const inVersion = tickets.map((t) => ({ ...t, pr: prOf(t.key) }));
  const notMerged = inVersion
    .filter((t) => t.pr?.state !== 'MERGED')
    .map((t) => ({ ...t, mismatch: FINISHED_STATUSES.includes(t.status) }));
  const unplanned = mergedSinceCut.filter((p) => !p.ticketKey || !fixKeys.has(p.ticketKey));
  const cherryPicks = onBranch
    ? mergedSinceCut.filter((p) => p.ticketKey && fixKeys.has(p.ticketKey) && !onBranch.has(p.mergeCommit?.oid))
    : [];
  return { inVersion, notMerged, unplanned, cherryPicks };
}

export function releaseNotes(tickets, versionName) {
  const byNum = (a, b) => Number(a.key.split('-')[1]) - Number(b.key.split('-')[1]);
  const known = new Set(NOTE_GROUPS.flatMap(([, types]) => types));
  const groups = [...NOTE_GROUPS.map(([title, types]) => [title, tickets.filter((t) => types.includes(t.issueType))]),
    ['Other', tickets.filter((t) => !known.has(t.issueType))]];
  let out = `${versionName}\n`;
  for (const [title, list] of groups) {
    if (!list.length) continue;
    out += `\n${title}\n${[...list].sort(byNum).map((t) => `- ${t.key} ${t.summary}`).join('\n')}\n`;
  }
  return out;
}

// ---- data loading ----

async function mergeBaseDate(gh, branch) {
  const out = await gh.run(['api', `repos/${REPO}/compare/${encodeURIComponent(branch)}...develop`, '--jq', '.merge_base_commit.commit.committer.date']);
  return out.trim();
}

// A commit is on the branch when comparing branch...commit says the commit is behind or identical.
async function onBranch(gh, branch, sha) {
  const status = (await gh.run(['api', `repos/${REPO}/compare/${encodeURIComponent(branch)}...${sha}`, '--jq', '.status'])).trim();
  return status === 'behind' || status === 'identical';
}

export function createRelease(ctx, now = () => Date.now()) {
  let cache = null;

  async function load() {
    if (cache && now() - cache.at <= JIRA_TTL_MS) return cache.data;
    const jira = requireJira(ctx);
    const [versions, branches] = await Promise.all([jira.versions(JIRA_PROJECT), ctx.branches.get()]);
    const release = currentRelease(versions, branches);
    if (!release) return { release: null, lists: null, notes: '' };

    const cutDate = release.lastCut ? await mergeBaseDate(ctx.gh, release.lastCut) : new Date(now() - 30 * DAY_MS).toISOString();
    const lookback = new Date(Date.parse(cutDate) - 90 * DAY_MS).toISOString();
    const [issues, mergedWide, open] = await Promise.all([
      jira.search(`project = ${JIRA_PROJECT} AND fixVersion = "${release.name}" ORDER BY key`, ['summary', 'status', 'assignee', 'fixVersions', 'issuetype'], 500),
      listMergedPrs(ctx.gh, { sinceIso: lookback }),
      listPrs(ctx.gh),
    ]);
    const tickets = issues.map((i) => toTicket(i, JIRA.baseUrl));
    const fixKeys = new Set(tickets.map((t) => t.key));
    const withKey = (p, state) => ({ ...p, state, ticketKey: ticketKey(p.headRefName, p.title) });
    const merged = mergedWide.map((p) => withKey(p, 'MERGED'));
    const prsByKey = new Map();
    for (const p of [...open.map((p) => withKey(p, 'OPEN')), ...merged]) if (p.ticketKey) prsByKey.set(p.ticketKey, p);
    const mergedSinceCut = merged.filter((p) => p.mergedAt >= cutDate);

    let contained = null;
    if (release.branchExists) {
      const branchCut = await mergeBaseDate(ctx.gh, release.branch);
      const candidates = merged.filter((p) => p.mergedAt >= branchCut && p.ticketKey && fixKeys.has(p.ticketKey));
      contained = new Set();
      for (const p of candidates) if (await onBranch(ctx.gh, release.branch, p.mergeCommit.oid)) contained.add(p.mergeCommit.oid);
    }

    const data = { release: { ...release, cutDate }, lists: releaseLists({ tickets, prsByKey, mergedSinceCut, onBranch: contained, fixKeys }), notes: releaseNotes(tickets, release.name) };
    cache = { data, at: now() };
    return data;
  }

  return {
    load,
    // Used by the build lookup: null until the release branch exists.
    async containsMerge(pr) {
      if (!pr || pr.state !== 'MERGED' || !pr.mergeCommit?.oid) return null;
      const { release } = await load();
      if (!release?.branchExists) return null;
      return onBranch(ctx.gh, release.branch, pr.mergeCommit.oid);
    },
  };
}

export function routes(ctx) {
  ctx.release = createRelease(ctx);
  return [['GET', /^\/api\/release$/, () => ctx.release.load()]];
}
