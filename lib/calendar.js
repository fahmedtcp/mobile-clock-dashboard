// Meetings from the macOS Calendar app, read locally through a small EventKit helper (tools/calendar.swift).
// The helper is built into a tiny invisible app (CalendarHelper.app) and started with `open`, because macOS only
// asks for calendar access on behalf of an app with a usage description; a bare program run by the background
// service is denied without a prompt. Titles are never logged or used by Time; the helper's output passes through a
// private file that is deleted as soon as it's read.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const SOURCE = path.join(ROOT, 'tools', 'calendar.swift');
const CACHE_MS = 5 * 60000;
const BACKOFF_MS = 10 * 60000;
const COMPILE_TIMEOUT_MS = 120000;
const RUN_TIMEOUT_MS = 15000;
const FIRST_RUN_TIMEOUT_MS = 120000; // the first run may sit on the macOS permission prompt
const TITLE_MAX = 80;
const BUNDLE_ID = 'com.tcpsoftware.mobile-clock-dashboard.calendar';
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Mobile Clock Dashboard Calendar</string>
  <key>CFBundleExecutable</key><string>calendar-helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSCalendarsFullAccessUsageDescription</key><string>Shows today's meetings on the dashboard's shift line. Meeting details stay on this Mac.</string>
</dict>
</plist>
`;

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
  const app = path.join(cacheDir, 'CalendarHelper.app');
  const binary = path.join(app, 'Contents', 'MacOS', 'calendar-helper');
  const cache = new Map(); // `${from}|${to}` -> { at, meetings }
  const inFlight = new Map(); // `${from}|${to}` -> Promise<Meeting[]>, so loads at the same moment share one run
  let state = 'ok';
  let failedAt = null;
  let everRan = false;
  let reason = null; // why the last read failed (tool exit codes and open's own message; never helper output)

  async function ensureBinary() {
    const stale = !existsSync(binary) || (existsSync(SOURCE) && statSync(binary).mtimeMs < statSync(SOURCE).mtimeMs);
    if (!stale) return null;
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(path.join(app, 'Contents', 'Info.plist'), INFO_PLIST);
    const built = await exec('swiftc', ['-O', SOURCE, '-o', binary], { timeout: COMPILE_TIMEOUT_MS });
    if (built.code !== 0 || !existsSync(binary)) return `swiftc exited ${built.code}: ${built.stderr.trim().slice(0, 200)}`;
    // Ad-hoc signature: gives the app a stable identity for the permission macOS remembers.
    const signed = await exec('codesign', ['--force', '--sign', '-', app], { timeout: COMPILE_TIMEOUT_MS });
    return signed.code === 0 ? null : `codesign exited ${signed.code}: ${signed.stderr.trim().slice(0, 200)}`;
  }

  // `open -W` waits for the app; -n starts a fresh copy; -g keeps it in the background.
  async function runApp(from, to) {
    const dir = path.join(cacheDir, `run-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    const out = path.join(dir, 'out');
    const err = path.join(dir, 'err');
    try {
      const run = await exec('open', ['-W', '-n', '-g', '--stdout', out, '--stderr', err, app, '--args', from, to],
        { timeout: everRan ? RUN_TIMEOUT_MS : FIRST_RUN_TIMEOUT_MS });
      const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
      return { code: run.code, openStderr: run.stderr, stdout: read(out), stderr: read(err) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function read(from, to) {
    const buildError = await ensureBinary();
    if (buildError) return { state: 'error', reason: buildError };
    const run = await runApp(from, to);
    if (run.stderr.includes('NO_ACCESS')) return { state: 'denied' };
    // `open -W` can lose track of a helper that already exited and report an error; its output still counts.
    if (run.code !== 0 && !run.stdout.trim()) return { state: 'error', reason: `open exited ${run.code}: ${run.openStderr.trim().slice(0, 200)}` };
    if (!run.stdout.trim()) return { state: 'error', reason: `the helper printed nothing${run.stderr.trim() ? ` (${run.stderr.trim().slice(0, 120)})` : ''}` };
    try {
      const list = JSON.parse(run.stdout);
      if (!Array.isArray(list)) return { state: 'error', reason: 'the helper output was not a list' };
      const meetings = list.filter((e) => !e.allDay && !e.canceled && !e.declined).map(toMeeting)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      return { state: 'ok', meetings };
    } catch {
      return { state: 'error', reason: 'the helper output was not readable' };
    }
  }

  async function meetings(from, to) {
    if (!enabled()) return [];
    const id = `${from}|${to}`;
    const hit = cache.get(id);
    if (hit && now() - hit.at <= CACHE_MS) return hit.meetings;
    if (failedAt != null && now() - failedAt < BACKOFF_MS) return [];
    if (!inFlight.has(id)) inFlight.set(id, refresh(from, to, id).finally(() => inFlight.delete(id)));
    return inFlight.get(id);
  }

  async function refresh(from, to, id) {
    const result = await read(from, to);
    state = result.state;
    reason = result.reason ?? null;
    if (state !== 'ok') { failedAt = now(); return []; }
    failedAt = null;
    everRan = true;
    cache.set(id, { at: now(), meetings: result.meetings });
    return result.meetings;
  }

  return { meetings, status: () => (enabled() ? state : 'off'), reason: () => reason };
}
