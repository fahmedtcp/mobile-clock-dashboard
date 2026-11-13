// Meetings from the macOS Calendar app, read locally through a small EventKit helper (tools/calendar.swift).
// Titles stay in memory: never logged, never written to disk, never used by Time.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const SOURCE = path.join(ROOT, 'tools', 'calendar.swift');
const CACHE_MS = 5 * 60000;
const BACKOFF_MS = 10 * 60000;
const COMPILE_TIMEOUT_MS = 120000;
const RUN_TIMEOUT_MS = 15000;
const FIRST_RUN_TIMEOUT_MS = 120000; // the first run may sit on the macOS permission prompt
const TITLE_MAX = 80;
const DENIED_EXIT = 2;

export function defaultExec(file, args, { timeout }) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
    });
  });
}

const toMeeting = (e) => ({ title: String(e.title ?? '').trim().slice(0, TITLE_MAX) || 'Busy', start: e.start, end: e.end });

export function createCalendar({ exec = defaultExec, cacheDir, now = () => Date.now(), enabled }) {
  const binary = path.join(cacheDir, 'calendar-helper');
  const cache = new Map(); // `${from}|${to}` -> { at, meetings }
  let state = 'ok';
  let failedAt = null;
  let everRan = false;

  async function ensureBinary() {
    const stale = !existsSync(binary) || (existsSync(SOURCE) && statSync(binary).mtimeMs < statSync(SOURCE).mtimeMs);
    if (!stale) return true;
    mkdirSync(cacheDir, { recursive: true });
    const built = await exec('swiftc', ['-O', SOURCE, '-o', binary], { timeout: COMPILE_TIMEOUT_MS });
    return built.code === 0 && existsSync(binary);
  }

  async function read(from, to) {
    if (!(await ensureBinary())) return { state: 'error' };
    const run = await exec(binary, [from, to], { timeout: everRan ? RUN_TIMEOUT_MS : FIRST_RUN_TIMEOUT_MS });
    if (run.code === DENIED_EXIT) return { state: 'denied' };
    if (run.code !== 0) return { state: 'error' };
    try {
      const list = JSON.parse(run.stdout);
      if (!Array.isArray(list)) return { state: 'error' };
      const meetings = list.filter((e) => !e.allDay && !e.canceled && !e.declined).map(toMeeting)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      return { state: 'ok', meetings };
    } catch {
      return { state: 'error' };
    }
  }

  async function meetings(from, to) {
    if (!enabled()) return [];
    const id = `${from}|${to}`;
    const hit = cache.get(id);
    if (hit && now() - hit.at <= CACHE_MS) return hit.meetings;
    if (failedAt != null && now() - failedAt < BACKOFF_MS) return [];
    const result = await read(from, to);
    state = result.state;
    if (state !== 'ok') { failedAt = now(); return []; }
    failedAt = null;
    everRan = true;
    cache.set(id, { at: now(), meetings: result.meetings });
    return result.meetings;
  }

  return { meetings, status: () => (enabled() ? state : 'off') };
}
