import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCalendar } from '../lib/calendar.js';

const FROM = '2026-11-13T08:00:00Z';
const TO = '2026-11-13T17:00:00Z';
const meeting = (title, extra = {}) => ({
  title, start: '2026-11-13T14:30:00Z', end: '2026-11-13T14:45:00Z', allDay: false, canceled: false, declined: false, ...extra,
});

// Fake execFile: swiftc "compiles" by writing the binary; `open` runs the app and writes the helper's
// stdout and stderr to the files it was given (open itself exits 0 unless it timed out).
function fakeExec(helper) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === 'swiftc') {
      if (helper.noSwift) return { stdout: '', stderr: 'swiftc: not found', code: 127 };
      writeFileSync(args[args.indexOf('-o') + 1], 'bin');
      return { stdout: '', stderr: '', code: 0 };
    }
    if (file === 'codesign') return { stdout: '', stderr: '', code: 0 };
    const result = helper();
    writeFileSync(args[args.indexOf('--stdout') + 1], result.stdout);
    writeFileSync(args[args.indexOf('--stderr') + 1], result.stderr);
    return { stdout: '', stderr: '', code: result.code === 143 ? 143 : 0 };
  };
  return { exec, calls };
}
const ok = (list) => () => ({ stdout: JSON.stringify(list), stderr: '', code: 0 });
const setup = (helper, opts = {}) => {
  const { exec, calls } = fakeExec(helper);
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'cal-'));
  let t = 1_000_000;
  const cal = createCalendar({ exec, cacheDir, now: () => t, enabled: () => opts.enabled ?? true });
  return { cal, calls, tick: (ms) => { t += ms; } };
};
const helperCalls = (calls) => calls.filter((c) => c.file === 'open').length;

test('compiles once, then runs the binary and keeps timed meetings only', async () => {
  const { cal, calls } = setup(ok([
    meeting('Standup'),
    meeting('Holiday', { allDay: true }),
    meeting('Old sync', { canceled: true }),
    meeting('Declined', { declined: true }),
  ]));
  assert.deepEqual(await cal.meetings(FROM, TO), [{ title: 'Standup', start: '2026-11-13T14:30:00Z', end: '2026-11-13T14:45:00Z' }]);
  await cal.meetings(FROM, TO);
  assert.equal(calls.filter((c) => c.file === 'swiftc').length, 1);
  assert.equal(helperCalls(calls), 1, 'cached for 5 minutes');
  assert.equal(cal.status(), 'ok');
});

test('the cache expires after 5 minutes', async () => {
  const { cal, calls, tick } = setup(ok([meeting('Standup')]));
  await cal.meetings(FROM, TO);
  tick(5 * 60000 + 1);
  await cal.meetings(FROM, TO);
  assert.equal(helperCalls(calls), 2);
});

test('denied permission is "denied", with no meetings and no throw', async () => {
  const { cal } = setup(() => ({ stdout: '', stderr: 'NO_ACCESS', code: 2 }));
  assert.deepEqual(await cal.meetings(FROM, TO), []);
  assert.equal(cal.status(), 'denied');
});

test('swiftc missing, a timeout, or bad JSON is "error", with no meetings', async () => {
  for (const helper of [Object.assign(ok([]), { noSwift: true }), () => ({ stdout: '', stderr: '', code: 143 }), () => ({ stdout: 'nope', stderr: '', code: 0 })]) {
    const { cal } = setup(helper);
    assert.deepEqual(await cal.meetings(FROM, TO), []);
    assert.equal(cal.status(), 'error');
  }
});

test('after an error it retries only once 10 minutes have passed', async () => {
  let fail = true;
  const { cal, calls, tick } = setup(() => (fail ? { stdout: '', stderr: '', code: 1 } : ok([meeting('Standup')])()));
  await cal.meetings(FROM, TO);
  fail = false;
  tick(9 * 60000);
  assert.deepEqual(await cal.meetings(FROM, TO), []);
  assert.equal(helperCalls(calls), 1);
  tick(60001);
  assert.equal((await cal.meetings(FROM, TO)).length, 1);
  assert.equal(cal.status(), 'ok');
});

test('off means no exec at all', async () => {
  const { cal, calls } = setup(ok([meeting('Standup')]), { enabled: false });
  assert.deepEqual(await cal.meetings(FROM, TO), []);
  assert.equal(calls.length, 0);
  assert.equal(cal.status(), 'off');
});

test('titles are clipped to 80 characters and blank titles read "Busy"', async () => {
  const { cal } = setup(ok([meeting('x'.repeat(200)), meeting('  ', { start: '2026-11-13T15:00:00Z' })]));
  const [long, blank] = await cal.meetings(FROM, TO);
  assert.equal(long.title.length, 80);
  assert.equal(blank.title, 'Busy');
});

test('the first run waits up to 2 minutes (the permission prompt), later runs 15 seconds', async () => {
  const { cal, calls, tick } = setup(ok([meeting('Standup')]));
  await cal.meetings(FROM, TO);
  tick(5 * 60000 + 1);
  await cal.meetings(FROM, TO);
  const runs = calls.filter((c) => c.file === 'open');
  assert.deepEqual(runs.map((c) => c.opts.timeout), [120000, 15000]);
});

test('runs as a signed app bundle through open, so macOS can ask for calendar access', async () => {
  const { exec, calls } = fakeExec(ok([meeting('Standup')]));
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'cal-'));
  const cal = createCalendar({ exec, cacheDir, enabled: () => true });
  assert.equal((await cal.meetings(FROM, TO)).length, 1);
  const app = path.join(cacheDir, 'CalendarHelper.app');
  const plist = readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
  assert.match(plist, /<key>NSCalendarsFullAccessUsageDescription<\/key>/);
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
  assert.ok(existsSync(path.join(app, 'Contents', 'MacOS', 'calendar-helper')));
  assert.ok(calls.some((c) => c.file === 'codesign' && c.args.at(-1) === app));
  const run = calls.find((c) => c.file === 'open');
  assert.deepEqual(run.args.filter((a) => a.startsWith('-') && !a.startsWith('--')), ['-W', '-n', '-g']);
  assert.deepEqual(run.args.slice(-4), [app, '--args', FROM, TO]);
});
