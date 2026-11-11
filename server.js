import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOST, PORT, BUILDS, BACKGROUND_REFRESH_MS, JIRA, TEMPO, LOCAL, TIME, CACHE_DIR, DATA_DIR, TIME_DIR, CLAUDE_PROJECTS_DIR } from './config.js';
import { createSettings } from './lib/settings.js';
import { connectionRoutes } from './lib/settings-test.js';
import { createTempo } from './lib/time/tempo.js';
import { snapshot as claudeSnapshot } from './lib/time/claude.js';
import { startReminders } from './lib/time/reminder.js';
import { HttpError, readJson, id, RAW } from './lib/http.js';
import { createJira, JiraError } from './lib/jira.js';
import { createBranchList } from './lib/ghdata.js';
import * as tickets from './lib/tickets.js';
import * as alerts from './lib/alerts.js';
import * as release from './lib/release.js';
import * as testhealth from './lib/testhealth.js';
import * as reviews from './lib/reviews.js';
import * as tsbudget from './lib/tsbudget.js';
import * as simulator from './lib/simulator.js';
import * as time from './lib/time/routes.js';
import * as teams from './lib/teams.js';
import { createGh, GhError } from './lib/gh.js';
import { getPr, createBehindCache, updateBranch } from './lib/prs.js';
import { createTracker, BuildRequestError } from './lib/builds.js';
import { listRuns, rerunFailed, cancelRun, statusStrip, getLogin } from './lib/runs.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = '\0'; }
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || rel.includes('\0')) return send(res, 404, { error: 'Not found' });
  try {
    const body = await readFile(file);
    // no-cache = always revalidate: after an update the browser must never mix old and new ES modules.
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

// Feature modules each export routes(ctx); later tasks append to this list.
const FEATURE_MODULES = [tickets, alerts, release, testhealth, reviews, tsbudget, simulator, time, teams];

// No reminder until workday hours are set: there's nothing to confirm yet.
export const reminderSetting = (t) => (t.reminderOn && t.dayHours != null ? t.reminderAt : 'off');

// Existing users (saved days, no setting yet) keep the 7h they've always had; new teammates start unset.
export function migrateDayHours(settings, store) {
  if (settings.resolved().time.dayHours == null && Object.keys(store.all()).length) settings.update({ time: { dayHours: 7 } });
}

const INJECTABLE = ['jira', 'tickets', 'tempo', 'teams', 'teamsTest', 'teamsQa', 'teamsPrefs'];

// Push resolved Settings into the live config objects, then rebuild every client built from them.
// Called at startup and after each save, so changes apply without a restart. Injected test fakes are kept.
export function applySettings(ctx) {
  const r = ctx.settings.resolved();
  Object.assign(JIRA, r.jira);
  TEMPO.token = r.tempo.token;
  LOCAL.mobileClockPath = r.time.mobileClockPath;
  Object.assign(TIME, { dayHours: r.time.dayHours, reminderOn: r.time.reminderOn, reminderAt: r.time.reminderAt });
  const keep = ctx.injected;
  if (!keep.has('jira')) ctx.jira = createJira(JIRA);
  if (!keep.has('tickets')) ctx.tickets = tickets.createTicketCache(ctx.jira, JIRA.baseUrl);
  if (!keep.has('tempo')) ctx.tempo = createTempo(TEMPO);
  if (!keep.has('teams')) ctx.teams = teams.createTeams({ webhookUrl: r.teams.webhookUrl });
  if (!keep.has('teamsTest')) ctx.teamsTest = teams.createTeams({ webhookUrl: r.teams.testWebhookUrl, label: 'test chat' });
  if (!keep.has('teamsQa')) ctx.teamsQa = teams.createTeams({ webhookUrl: r.teams.qaWebhookUrl, label: 'QA channel' });
  if (!keep.has('teamsPrefs')) ctx.teamsPrefs = { always: r.teams.always, never: r.teams.never };
  ctx.tempoAccountId = null;
  ctx.peopleCacheClear?.();
  ctx.timeMonthCacheClear?.();
  ctx.tempoLogged?.clear();
  ctx.tempoLoggedAt?.clear();
}

export function createServer(options) {
  const { gh, tracker, behind } = options;
  // Tests never read the real settings file: in-memory, 7h workday so existing time tests keep working.
  const testing = Boolean(process.env.NODE_TEST_CONTEXT);
  // Under test, only the non-secret Jira URL may come from the environment; keys in the shell never leak into tests.
  const settings = options.settings ?? createSettings({
    file: testing ? null : path.join(DATA_DIR, 'settings.json'),
    env: testing ? { JIRA_BASE_URL: process.env.JIRA_BASE_URL } : process.env,
    initial: testing ? { time: { dayHours: 7 } } : {},
  });
  Object.assign(JIRA, settings.resolved().jira);
  const jira = options.jira ?? createJira(JIRA);
  const ctx = {
    ...options,
    jira,
    tickets: options.tickets ?? tickets.createTicketCache(jira, JIRA.baseUrl),
    branches: options.branches ?? createBranchList(gh),
    readJson,
    id,
    cacheDir: options.cacheDir ?? CACHE_DIR,
    timeDir: options.timeDir ?? TIME_DIR,
    settings,
    injected: new Set(INJECTABLE.filter((k) => options[k])),
  };
  const routes = [
    ...FEATURE_MODULES.flatMap((mod) => mod.routes(ctx)),
    ['GET', /^\/api\/me$/, async () => ({ login: await getLogin(gh) })],
    ['GET', /^\/api\/prs\/([^/]+)\/behind$/, async (m) => {
      const pr = await getPr(gh, id(m[1]));
      return { behind: await behind.get(pr.baseRefName, pr.headRefName), base: pr.baseRefName };
    }],
    ['POST', /^\/api\/prs\/([^/]+)\/update-branch$/, async (m) => {
      await updateBranch(gh, id(m[1]));
      behind.clear();
      return { ok: true };
    }],
    ['POST', /^\/api\/prs\/([^/]+)\/builds$/, async (m, req) => {
      const n = id(m[1]);
      const { keys } = await readJson(req);
      return tracker.trigger(n, keys);
    }],
    ['GET', /^\/api\/builds$/, () => tracker.refresh()],
    ['GET', /^\/api\/builds-config$/, () => {
      const checked = ctx.settings.resolved().builds.defaultChecked;
      return Object.entries(BUILDS).map(([key, b]) => ({ key, label: b.label, defaultChecked: key !== 'mcIosSim' && checked.includes(key) }));
    }],
    ...connectionRoutes(ctx),
    ['GET', /^\/api\/settings$/, () => ctx.settings.publicView()],
    ['PUT', /^\/api\/settings$/, async (m, req) => {
      ctx.settings.update(await readJson(req));
      applySettings(ctx);
      return ctx.settings.publicView();
    }],
    ['GET', /^\/api\/runs$/, async (m, req, url) => {
      const q = url.searchParams;
      const user = q.get('mine') === '1' ? await getLogin(gh) : undefined;
      return listRuns(gh, { workflow: q.get('workflow') || undefined, branch: q.get('branch') || undefined, user });
    }],
    ['POST', /^\/api\/runs\/([^/]+)\/rerun$/, async (m) => { await rerunFailed(gh, id(m[1])); return { ok: true }; }],
    ['POST', /^\/api\/runs\/([^/]+)\/cancel$/, async (m) => { await cancelRun(gh, id(m[1])); return { ok: true }; }],
    ['GET', /^\/api\/status$/, () => statusStrip(gh)],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);

    // Block DNS rebinding (foreign Host) and cross-site form/fetch POSTs (no custom header without CORS preflight).
    const port = server.address().port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(res, 403, { error: 'Forbidden host.' });
    if (req.method !== 'GET' && req.headers['x-dashboard'] !== '1') return send(res, 403, { error: 'Missing X-Dashboard header.' });

    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (!m || method !== req.method) continue;
      try {
        const out = await handler(m, req, url);
        if (out?.[RAW]) { res.writeHead(200, { 'Cache-Control': 'no-store', ...out.headers }); return res.end(out.body); }
        return send(res, 200, out);
      } catch (err) {
        if (err instanceof HttpError || err instanceof BuildRequestError) return send(res, err.status, { error: err.message, started: err.started });
        if (err instanceof GhError) return send(res, 502, { error: err.message });
        if (err instanceof JiraError) return send(res, [400, 403, 404, 409, 503].includes(err.status) ? err.status : 502, { error: err.message });
        return send(res, 500, { error: err.message });
      }
    }
    send(res, 404, { error: 'Not found' });
  });
  applySettings(ctx); // after routes(), whose ??= defaults are placeholders
  server.ctx = ctx; // the main block wires background jobs to the same stores
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gh = createGh();
  const tracker = createTracker(gh, undefined, { file: path.join(DATA_DIR, 'builds.json') });
  const ts = tsbudget.createTsBudget({ repoPath: () => LOCAL.mobileClockPath, cacheDir: CACHE_DIR, historyFile: path.join(DATA_DIR, 'ts-history.json') });
  const server = createServer({ gh, tracker, behind: createBehindCache(gh), ts });
  const url = `http://localhost:${PORT}`;
  // Already running (for example, started at login by install-app): open that one instead of a second copy,
  // so background jobs, reminders, and build retries never run twice.
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.log(`Dashboard is already running at ${url}`);
    if (!process.env.NO_OPEN) execFile('open', [url], () => process.exit(0)); else process.exit(0);
  });
  server.listen(PORT, HOST, () => {
    console.log(`Dashboard running at ${url}`);
    if (!process.env.NO_OPEN) execFile('open', [url], () => {});
    // Background jobs start only once this process owns the port.
    // TypeScript error count on develop: at most once a day, checked hourly.
    const tsDaily = () => { if (ts.isStale()) ts.runDevelop(); };
    tsDaily();
    setInterval(tsDaily, 3600000);
    // Keep the dashboard's own Claude summaries, so Claude's 30-day log cleanup doesn't lose history.
    const snap = () => claudeSnapshot(CLAUDE_PROJECTS_DIR, TIME_DIR).catch((err) => console.error('Claude snapshot failed:', err.message));
    snap();
    setInterval(snap, 3600000);
    const { ctx } = server;
    migrateDayHours(ctx.settings, ctx.timeStore);
    applySettings(ctx);
    startReminders({
      timeDir: TIME_DIR,
      reminderAt: () => reminderSetting(TIME),
      // A day already in Tempo counts as confirmed, so no reminder for it.
      store: { get: (d) => (ctx.tempoLogged.get(d.slice(0, 7))?.has(d) ? { status: 'confirmed', leaveHours: 0 } : ctx.timeStore.get(d)) },
      pendingDays: ctx.timePending,
      summarize: async (day) => {
        const d = (await ctx.timeMonth(day.slice(0, 7))).days.find((x) => x.date === day);
        return { tickets: d?.entries.length ?? 0, hours: d?.entries.reduce((a, e) => a + e.hours, 0) ?? 0 };
      },
    });
    // Keep watching (and auto-retrying) triggered builds even when no tab is open.
    setInterval(() => {
      if (tracker.list().some((b) => b.status !== 'completed')) tracker.refresh().catch((err) => console.error('Build refresh failed:', err.message));
    }, BACKGROUND_REFRESH_MS);
  });
}
