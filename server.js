import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  HOST, PORT, BUILDS, BACKGROUND_REFRESH_MS, JIRA, TEMPO, LOCAL, TIME,
  CACHE_DIR, DATA_DIR, TIME_DIR, CLAUDE_PROJECTS_DIR,
} from './config.js';
import { createSettings } from './lib/settings.js';
import { createCalendar } from './lib/calendar.js';
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
import * as ticketPanel from './lib/ticket-panel.js';
import * as home from './lib/home/routes.js';
import { createGh, GhError } from './lib/gh.js';
import { getPr, createBehindCache, updateBranch } from './lib/prs.js';
import { createTracker, BuildRequestError } from './lib/builds.js';
import { listRuns, rerunFailed, cancelRun, statusStrip, getLogin } from './lib/runs.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const HOUR_MS = 3600000;

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
    const content = await readFile(file);
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    // no-cache = always revalidate: after an update the browser must never mix old and new ES modules.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

// Feature modules each export routes(ctx); later tasks append to this list.
const FEATURE_MODULES = [tickets, alerts, release, testhealth, reviews, tsbudget, simulator, time, teams, ticketPanel, home];

// No reminder until workday hours are set: there's nothing to confirm yet.
export const reminderSetting = (time) => (time.reminderOn && time.dayHours != null ? time.reminderAt : 'off');

// Existing users (saved days, no setting yet) keep the 7h they've always had; new teammates start unset.
export function migrateDayHours(settings, store) {
  const hasSavedDays = Object.keys(store.all()).length > 0;
  if (settings.resolved().time.dayHours == null && hasSavedDays) settings.update({ time: { dayHours: 7 } });
}

const INJECTABLE = ['jira', 'tickets', 'tempo', 'teams', 'teamsTest', 'teamsQa', 'teamsPrefs'];

// Push resolved Settings into the live config objects, then rebuild every client built from them.
// Called at startup and after each save, so changes apply without a restart. Injected test fakes are kept.
export function applySettings(ctx) {
  const current = ctx.settings.resolved();
  Object.assign(JIRA, current.jira);
  TEMPO.token = current.tempo.token;
  LOCAL.mobileClockPath = current.time.mobileClockPath;
  const { dayHours, reminderOn, reminderAt } = current.time;
  Object.assign(TIME, { dayHours, reminderOn, reminderAt });
  rebuildClients(ctx, current);
  ctx.tempoAccountId = null;
  ctx.peopleCacheClear?.();
  ctx.timeMonthCacheClear?.();
  ctx.tempoLogged?.clear();
  ctx.tempoLoggedAt?.clear();
}

// Tests never read the real settings file: in-memory, 7h workday so existing time tests keep working.
// Under test, only the non-secret Jira URL may come from the environment; keys in the shell never leak into tests.
function defaultSettings() {
  const testing = Boolean(process.env.NODE_TEST_CONTEXT);
  return createSettings({
    file: testing ? null : path.join(DATA_DIR, 'settings.json'),
    env: testing ? { JIRA_BASE_URL: process.env.JIRA_BASE_URL } : process.env,
    initial: testing ? { time: { dayHours: 7 } } : {},
  });
}

function createContext(options) {
  const settings = options.settings ?? defaultSettings();
  Object.assign(JIRA, settings.resolved().jira);
  const jira = options.jira ?? createJira(JIRA);
  return {
    ...options,
    jira,
    tickets: options.tickets ?? tickets.createTicketCache(jira, JIRA.baseUrl),
    branches: options.branches ?? createBranchList(options.gh),
    readJson,
    id,
    cacheDir: options.cacheDir ?? CACHE_DIR,
    calendar: options.calendar ?? createCalendar({
      cacheDir: options.cacheDir ?? CACHE_DIR, enabled: () => settings.resolved().calendar.on,
    }),
    timeDir: options.timeDir ?? TIME_DIR,
    settings,
    injected: new Set(INJECTABLE.filter((k) => options[k])),
  };
}

async function handleBehind(ctx, match) {
  const pr = await getPr(ctx.gh, id(match[1]));
  return { behind: await ctx.behind.get(pr.baseRefName, pr.headRefName), base: pr.baseRefName };
}

async function handleUpdateBranch(ctx, match) {
  await updateBranch(ctx.gh, id(match[1]));
  ctx.behind.clear();
  return { ok: true };
}

async function handleTriggerBuilds(ctx, match, req) {
  const prNumber = id(match[1]);
  const { keys } = await readJson(req);
  return ctx.tracker.trigger(prNumber, keys);
}

function handleBuildsConfig(ctx) {
  const checked = ctx.settings.resolved().builds.defaultChecked;
  return Object.entries(BUILDS).map(([key, build]) => ({
    key,
    label: build.label,
    defaultChecked: key !== 'mcIosSim' && checked.includes(key),
  }));
}

async function handleSaveSettings(ctx, req) {
  ctx.settings.update(await readJson(req));
  applySettings(ctx);
  return ctx.settings.publicView();
}

async function handleListRuns(ctx, url) {
  const query = url.searchParams;
  const user = query.get('mine') === '1' ? await getLogin(ctx.gh) : undefined;
  const workflow = query.get('workflow') || undefined;
  const branch = query.get('branch') || undefined;
  return listRuns(ctx.gh, { workflow, branch, user });
}

async function handleRerun(ctx, match) {
  await rerunFailed(ctx.gh, id(match[1]));
  return { ok: true };
}

async function handleCancel(ctx, match) {
  await cancelRun(ctx.gh, id(match[1]));
  return { ok: true };
}

function coreRoutes(ctx) {
  return [
    ['GET', /^\/api\/me$/, async () => ({ login: await getLogin(ctx.gh) })],
    ['GET', /^\/api\/prs\/([^/]+)\/behind$/, (m) => handleBehind(ctx, m)],
    ['POST', /^\/api\/prs\/([^/]+)\/update-branch$/, (m) => handleUpdateBranch(ctx, m)],
    ['POST', /^\/api\/prs\/([^/]+)\/builds$/, (m, req) => handleTriggerBuilds(ctx, m, req)],
    ['GET', /^\/api\/builds$/, () => ctx.tracker.refresh()],
    ['GET', /^\/api\/builds-config$/, () => handleBuildsConfig(ctx)],
    ...connectionRoutes(ctx),
    ['GET', /^\/api\/settings$/, () => ctx.settings.publicView()],
    ['PUT', /^\/api\/settings$/, (m, req) => handleSaveSettings(ctx, req)],
    ['GET', /^\/api\/runs$/, (m, req, url) => handleListRuns(ctx, url)],
    ['POST', /^\/api\/runs\/([^/]+)\/rerun$/, (m) => handleRerun(ctx, m)],
    ['POST', /^\/api\/runs\/([^/]+)\/cancel$/, (m) => handleCancel(ctx, m)],
    ['GET', /^\/api\/status$/, () => statusStrip(ctx.gh)],
  ];
}

const JIRA_PASSTHROUGH = [400, 403, 404, 409, 503];

function sendError(res, err) {
  if (err instanceof HttpError || err instanceof BuildRequestError) {
    return send(res, err.status, { error: err.message, started: err.started });
  }
  if (err instanceof GhError) return send(res, 502, { error: err.message });
  if (err instanceof JiraError) {
    return send(res, JIRA_PASSTHROUGH.includes(err.status) ? err.status : 502, { error: err.message });
  }
  return send(res, 500, { error: err.message });
}

async function sendResult(res, handler, args) {
  try {
    const out = await handler(...args);
    if (out?.[RAW]) {
      res.writeHead(200, { 'Cache-Control': 'no-store', ...out.headers });
      return res.end(out.body);
    }
    return send(res, 200, out);
  } catch (err) {
    return sendError(res, err);
  }
}

// Block DNS rebinding (foreign Host) and cross-site form/fetch POSTs (no custom header without CORS preflight).
// Returns the 403 message to send, or null when the request may proceed.
function untrustedReason(req, port) {
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return 'Forbidden host.';
  if (req.method !== 'GET' && req.headers['x-dashboard'] !== '1') return 'Missing X-Dashboard header.';
  return null;
}

function rebuildClients(ctx, current) {
  const { teams: teamsConfig } = current;
  const keep = ctx.injected;
  if (!keep.has('jira')) ctx.jira = createJira(JIRA);
  if (!keep.has('tickets')) ctx.tickets = tickets.createTicketCache(ctx.jira, JIRA.baseUrl);
  if (!keep.has('tempo')) ctx.tempo = createTempo(TEMPO);
  if (!keep.has('teams')) ctx.teams = teams.createTeams({ webhookUrl: teamsConfig.webhookUrl });
  if (!keep.has('teamsTest')) {
    ctx.teamsTest = teams.createTeams({ webhookUrl: teamsConfig.testWebhookUrl, label: 'test chat' });
  }
  if (!keep.has('teamsQa')) {
    ctx.teamsQa = teams.createTeams({ webhookUrl: teamsConfig.qaWebhookUrl, label: 'QA channel' });
  }
  if (!keep.has('teamsPrefs')) ctx.teamsPrefs = { always: teamsConfig.always, never: teamsConfig.never };
}

export function createServer(options) {
  const ctx = createContext(options);
  const routes = [...FEATURE_MODULES.flatMap((mod) => mod.routes(ctx)), ...coreRoutes(ctx)];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
    const rejection = untrustedReason(req, server.address().port);
    if (rejection) return send(res, 403, { error: rejection });

    for (const [method, pattern, handler] of routes) {
      const match = url.pathname.match(pattern);
      if (match && method === req.method) return sendResult(res, handler, [match, req, url]);
    }
    send(res, 404, { error: 'Not found' });
  });
  applySettings(ctx); // after routes(), whose ??= defaults are placeholders
  server.ctx = ctx; // the main block wires background jobs to the same stores
  return server;
}

// A day already in Tempo counts as confirmed, so no reminder for it.
function reminderStore(ctx) {
  return {
    get: (day) => (ctx.tempoLogged.get(day.slice(0, 7))?.has(day)
      ? { status: 'confirmed', leaveHours: 0 }
      : ctx.timeStore.get(day)),
  };
}

async function summarizeDay(ctx, day) {
  const summary = (await ctx.timeMonth(day.slice(0, 7))).days.find((entry) => entry.date === day);
  return {
    tickets: summary?.entries.length ?? 0,
    hours: summary?.entries.reduce((total, entry) => total + entry.hours, 0) ?? 0,
  };
}

function every(ms, job) {
  job();
  setInterval(job, ms);
}

// Background jobs start only once this process owns the port.
function startBackgroundJobs({ ctx }, { tracker, ts }) {
  // TypeScript error count on develop: at most once a day, checked hourly.
  every(HOUR_MS, () => { if (ts.isStale()) ts.runDevelop(); });
  // Keep the dashboard's own Claude summaries, so Claude's 30-day log cleanup doesn't lose history.
  every(HOUR_MS, () => claudeSnapshot(CLAUDE_PROJECTS_DIR, TIME_DIR)
    .catch((err) => console.error('Claude snapshot failed:', err.message)));
  migrateDayHours(ctx.settings, ctx.timeStore);
  applySettings(ctx);
  startReminders({
    timeDir: TIME_DIR,
    reminderAt: () => reminderSetting(TIME),
    store: reminderStore(ctx),
    pendingDays: ctx.timePending,
    summarize: (day) => summarizeDay(ctx, day),
  });
  // Keep watching (and auto-retrying) triggered builds even when no tab is open.
  setInterval(() => {
    if (!tracker.list().some((build) => build.status !== 'completed')) return;
    tracker.refresh().catch((err) => console.error('Build refresh failed:', err.message));
  }, BACKGROUND_REFRESH_MS);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gh = createGh();
  const tracker = createTracker(gh, undefined, { file: path.join(DATA_DIR, 'builds.json') });
  const ts = tsbudget.createTsBudget({
    repoPath: () => LOCAL.mobileClockPath,
    cacheDir: CACHE_DIR,
    historyFile: path.join(DATA_DIR, 'ts-history.json'),
  });
  const server = createServer({ gh, tracker, behind: createBehindCache(gh), ts });
  const url = `http://localhost:${PORT}`;
  const openInBrowser = (done) => execFile('open', [url], done);
  // Already running (for example, started at login by install-app): open that one instead of a second copy,
  // so background jobs, reminders, and build retries never run twice.
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.log(`Dashboard is already running at ${url}`);
    if (!process.env.NO_OPEN) openInBrowser(() => process.exit(0)); else process.exit(0);
  });
  server.listen(PORT, HOST, () => {
    console.log(`Dashboard running at ${url}`);
    if (!process.env.NO_OPEN) openInBrowser(() => {});
    startBackgroundJobs(server, { tracker, ts });
  });
}
