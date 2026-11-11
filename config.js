import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Tests never read the real .env, so they can never reach real Teams, Jira, or GitHub settings.
if (!process.env.NODE_TEST_CONTEXT) loadEnv(path.join(ROOT, '.env'));

export const REPO = 'tcp-software/mobile-clock';
export const PORT = 4317;
export const HOST = '127.0.0.1';

export const BUILDS = {
  mcAndroid: { file: 'run-mc-android.yml', label: 'Android MobileClock', buildType: 'release dev' },
  mkAndroid: { file: 'run-mk-android.yml', label: 'Android Mobile Kiosk', buildType: 'release dev' },
  mcIos: { file: 'run-mc-ios.yml', label: 'iOS MobileClock', buildType: 'release dev' },
  mkIos: { file: 'run-mk-ios.yml', label: 'iOS MobileKiosk', buildType: 'release dev' },
  // Dev-only simulator build: produces a .app artifact, uploads nothing to the store.
  mcIosSim: { file: 'run-mc-ios.yml', label: 'iOS MobileClock (Simulator .app)', buildType: 'build dev .app' },
};

export const STATUS = [
  { key: 'nightly', label: 'iOS MC nightly', file: 'run-ios-mc-nightly.yml', branch: null },
  { key: 'devTests', label: 'develop unit tests', file: 'run-tests.yml', branch: 'develop' },
];

export const STALE_APPROVED_DAYS = 7;
export const STALE_OPEN_DAYS = 14;
export const BEHIND_TTL_MS = 300000;

// Auto-retry for dashboard-triggered builds: reruns failed jobs up to this many times (3 attempts total).
export const MAX_RETRIES = 2;
export const BACKGROUND_REFRESH_MS = 30000;

// ---- v2 ----
// Live values: filled from Settings by applySettings (server.js), which also reads .env.
export const JIRA = { baseUrl: '', email: '', token: '' };
export const JIRA_PROJECT = 'TCPMOB';
export const ACTIVE_STATUSES = ['To Do', 'Open', 'In Progress', 'Dev Review'];
export const FINISHED_STATUSES = ['Release Candidate', 'Done'];
export const JIRA_TTL_MS = 60000;
export const BRANCH_TTL_MS = 300000;
export const CACHE_DIR = path.join(ROOT, 'cache');
export const DATA_DIR = process.env.DASHBOARD_DATA_DIR ?? path.join(ROOT, 'data'); // override for test runs

// ---- time tracking ----
export const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects');
export const TIME_DIR = path.join(DATA_DIR, 'time');
export const TIME_WEIGHTS = { inProgress: 2, commit: 1, commitCap: 5, claudePer30: 1, claudeCap: 6, activity: 0.5, activityCap: 1, build: 0.5, buildCap: 1, review: 1, reviewCap: 2 };
// Live values pushed from Settings on startup and on every save (see applySettings in server.js).
export const LOCAL = { mobileClockPath: '' };
export const TIME = { dayHours: null, reminderOn: true, reminderAt: '20:30' };
export const TEMPO = { token: '', baseUrl: 'https://api.tempo.io/4', startTime: '09:00:00' };
