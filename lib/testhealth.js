import { REPO } from '../config.js';

const DAY_MS = 864e5;
const CACHE_MS = 300000;
const RUN_FIELDS = 'databaseId,workflowName,headSha,headBranch,conclusion,status,createdAt,url';

export const TEST_WORKFLOWS = [
  { key: 'unit', label: 'Unit tests (develop)', file: 'run-tests.yml', branch: 'develop' },
  { key: 'detoxIos', label: 'Detox iOS', file: 'run-detox-ios.yml', branch: null },
  { key: 'detoxIosSelf', label: 'Detox iOS (self-hosted)', file: 'run-detox-ios-selfhosted.yml', branch: null },
  { key: 'detoxAndroidSelf', label: 'Detox Android (self-hosted)', file: 'run-detox-android-selfhosted.yml', branch: null },
];

export function passRate(runs, now = Date.now()) {
  const counted = runs.filter((r) => r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion));
  const passed = counted.filter((r) => r.conclusion === 'success').length;
  const latest = [...counted].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  // Every run, oldest → newest, for the run strip; in-progress runs show as their status.
  const recent = [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((r) => (r.status === 'completed' ? r.conclusion || 'neutral' : r.status));
  return {
    recent,
    rate: counted.length ? passed / counted.length : null,
    passed,
    total: counted.length,
    latest,
    latestAgeDays: latest ? Math.floor((now - Date.parse(latest.createdAt)) / DAY_MS) : null,
  };
}

// Same commit, same workflow, both a failure and a success: the run outcome flipped without a code change.
export function flakyRuns(runs) {
  const groups = new Map();
  for (const r of runs) {
    if (r.status !== 'completed' || !['failure', 'success'].includes(r.conclusion)) continue;
    const k = `${r.workflowName}\0${r.headSha}`;
    if (!groups.has(k)) groups.set(k, { workflowName: r.workflowName, headSha: r.headSha, branch: r.headBranch, failedUrl: null, passedUrl: null });
    const g = groups.get(k);
    if (r.conclusion === 'failure') g.failedUrl ??= r.url; else g.passedUrl ??= r.url;
  }
  return [...groups.values()].filter((g) => g.failedUrl && g.passedUrl);
}

export function routes(ctx) {
  let cache = null;
  return [['GET', /^\/api\/tests$/, async () => {
    if (cache && Date.now() - cache.at <= CACHE_MS) return cache.data;
    const suites = await Promise.all(TEST_WORKFLOWS.map(async ({ key, label, file, branch }) => {
      const args = ['run', 'list', '-R', REPO, '-w', file, '-L', '30', '--json', RUN_FIELDS];
      if (branch) args.push('-b', branch);
      let runs = [];
      try { runs = await ctx.gh.json(args); } catch { runs = []; } // a missing or disabled workflow shouldn't sink the page
      return { key, label, file, ...passRate(runs) };
    }));
    const recent = await ctx.gh.json(['run', 'list', '-R', REPO, '-L', '100', '--json', RUN_FIELDS]);
    const data = { suites, flaky: flakyRuns(recent) };
    cache = { data, at: Date.now() };
    return data;
  }]];
}
