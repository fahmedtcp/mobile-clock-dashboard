import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, extractReason } from '../lib/builds.js';
import { MAX_RETRIES } from '../config.js';

const REPO = 'tcp-software/mobile-clock';
const T0 = Date.parse('2026-11-06T12:00:00Z');
const run = (attempt, status, conclusion = '') => ({ databaseId: 77, createdAt: '2026-11-06T12:00:03Z', attempt, status, conclusion, url: 'u77' });

// Fake gh: `current` is what `gh run list` returns; reruns and reason lookups are recorded.
function setup() {
  const calls = [];
  const gh = {
    current: run(1, 'queued'),
    rerunError: null,
    async run(args) {
      calls.push(args);
      if (args[1] === 'rerun' && this.rerunError) throw this.rerunError;
      if (args[1] === 'view' && args.includes('--log-failed')) {
        return 'IOS MobileKiosk Build\tUNKNOWN STEP\t2026-11-06T12:18:11.39Z [altool] The Internet connection appears to be offline. (-1009)\n'
          + 'IOS MobileKiosk Build\tUNKNOWN STEP\t2026-11-06T12:19:02.24Z ##[error]Process completed with exit code 1.\n';
      }
      return '';
    },
    async json(args) {
      if (args[0] === 'pr') return { state: 'OPEN', reviewDecision: 'APPROVED', headRefName: 'b' };
      if (args[1] === 'view') return { jobs: [{ name: 'IOS MobileKiosk Build', databaseId: 5, conclusion: 'failure', steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'Release iOS Mobile Kiosk App Dev', conclusion: 'failure' }] }] };
      return [this.current];
    },
  };
  const tracker = createTracker(gh, () => T0);
  return { gh, calls, tracker, reruns: () => calls.filter((a) => a[1] === 'rerun') };
}

test('MAX_RETRIES is 2 (3 attempts total)', () => {
  assert.equal(MAX_RETRIES, 2);
});

test('failed run is rerun with --failed and shows as queued', async () => {
  const { gh, tracker, reruns } = setup();
  await tracker.trigger(1, ['mkIos']);
  gh.current = run(1, 'completed', 'failure');
  const [b] = await tracker.refresh();
  assert.deepEqual(reruns(), [['run', 'rerun', '77', '--failed', '-R', REPO]]);
  assert.equal(b.status, 'queued');
  assert.equal(b.retries, 1);
  assert.equal(b.conclusion, null);
});

test('stale completed result from the old attempt does not trigger a second rerun', async () => {
  const { gh, tracker, reruns } = setup();
  await tracker.trigger(1, ['mkIos']);
  gh.current = run(1, 'completed', 'failure');
  await tracker.refresh();
  const [b] = await tracker.refresh(); // GitHub still reports attempt 1
  assert.equal(reruns().length, 1);
  assert.equal(b.status, 'queued');
  gh.current = run(2, 'in_progress');
  assert.equal((await tracker.refresh())[0].status, 'in_progress');
  assert.equal((await tracker.refresh())[0].attempt, 2);
});

test('gives up after MAX_RETRIES and records the failure reason', async () => {
  const { gh, tracker, reruns } = setup();
  await tracker.trigger(1, ['mkIos']);
  for (const attempt of [1, 2]) {
    gh.current = run(attempt, 'completed', 'failure');
    await tracker.refresh();
  }
  gh.current = run(3, 'completed', 'failure');
  const [b] = await tracker.refresh();
  assert.equal(reruns().length, 2);
  assert.equal(b.status, 'completed');
  assert.equal(b.conclusion, 'failure');
  assert.equal(b.reason.step, 'IOS MobileKiosk Build › Release iOS Mobile Kiosk App Dev');
  assert.deepEqual(b.reason.lines, ['[altool] The Internet connection appears to be offline. (-1009)']);
});

test('cancelled and successful runs are never retried', async () => {
  for (const conclusion of ['cancelled', 'success']) {
    const { gh, tracker, reruns } = setup();
    await tracker.trigger(1, ['mkIos']);
    gh.current = run(1, 'completed', conclusion);
    const [b] = await tracker.refresh();
    assert.equal(reruns().length, 0);
    assert.equal(b.status, 'completed');
    assert.equal(b.conclusion, conclusion);
  }
});

test('timed_out is retried', async () => {
  const { gh, tracker, reruns } = setup();
  await tracker.trigger(1, ['mkIos']);
  gh.current = run(1, 'completed', 'timed_out');
  await tracker.refresh();
  assert.equal(reruns().length, 1);
});

test('rerun that gh refuses ends the build with that error as the reason', async () => {
  const { gh, tracker } = setup();
  await tracker.trigger(1, ['mkIos']);
  gh.rerunError = new Error('run 77 cannot be rerun; its workflow file may be broken');
  gh.current = run(1, 'completed', 'failure');
  const [b] = await tracker.refresh();
  assert.equal(b.status, 'completed');
  assert.equal(b.conclusion, 'failure');
  assert.match(b.reason.lines.join(' '), /cannot be rerun/);
});

test('overlapping refresh calls share one pass, so a failure is rerun once', async () => {
  const { gh, tracker, reruns } = setup();
  await tracker.trigger(1, ['mkIos']);
  gh.current = run(1, 'completed', 'failure');
  await Promise.all([tracker.refresh(), tracker.refresh()]);
  assert.equal(reruns().length, 1);
});

test('extractReason keeps the last 3 specific error lines, stripped of prefixes and ANSI', () => {
  const log = [
    'Job\tUNKNOWN STEP\t2026-11-06T12:00:00.1Z npm WARN deprecated foo',
    'Job\tUNKNOWN STEP\t2026-11-06T12:00:01.1Z error: one',
    'Job\tUNKNOWN STEP\t2026-11-06T12:00:02.1Z error: two',
    'Job\tUNKNOWN STEP\t2026-11-06T12:00:02.2Z error: two',
    'Job\tUNKNOWN STEP\t2026-11-06T12:00:03.1Z Build FAILED',
    'Job\tUNKNOWN STEP\t2026-11-06T12:00:04.1Z \u001b[31mfastlane finished with errors\u001b[0m',
    'Job\tUNKNOWN STEP\t2026-11-06T12:00:05.1Z ##[error]Process completed with exit code 1.',
  ].join('\n');
  assert.deepEqual(extractReason(log), ['error: two', 'Build FAILED', 'fastlane finished with errors']);
});

test('extractReason falls back to the last non-empty lines when nothing matches', () => {
  assert.deepEqual(extractReason('J\tS\t2026-11-06T12:00:00Z a\nJ\tS\t2026-11-06T12:00:01Z b\n'), ['a', 'b']);
});

test('extractReason strips caret-notation ANSI and skips tag-only lines', () => {
  const log = [
    'J\tS\t2026-11-06T12:18:11.38Z [Application Loader Error Output]: [ContentDelivery.Uploader.600003E7C5C0] ',
    'J\tS\t2026-11-06T12:18:11.39Z [Application Loader Error Output]: [altool.600003E7C5C0] The Internet connection appears to be offline. (-1009)',
    'J\tS\t2026-11-06T12:18:11.40Z [12:18:11]: ^[[31mfastlane finished with errors^[[0m',
  ].join('\n');
  assert.deepEqual(extractReason(log), [
    '[Application Loader Error Output]: [altool.600003E7C5C0] The Internet connection appears to be offline. (-1009)',
    '[12:18:11]: fastlane finished with errors',
  ]);
});

test('code failure is not retried; reason and classification set on first failure', async () => {
  const { gh, tracker, reruns } = setup();
  const origRun = gh.run.bind(gh);
  gh.run = async (args) => (args.includes('--log-failed') ? "J\tS\t2026-11-06T12:00:00Z src/a.ts(1,1): error TS2322: bad\n" : origRun(args));
  await tracker.trigger(1, ['mkIos']);
  gh.current = run(1, 'completed', 'failure');
  const [b] = await tracker.refresh();
  assert.equal(reruns().length, 0);
  assert.equal(b.status, 'completed');
  assert.deepEqual(b.classification, { kind: 'code', label: 'TypeScript error' });
  assert.ok(b.reason.lines[0].includes('error TS2322'));
});

test('infra failure still retries and records classification', async () => {
  const { gh, tracker, reruns } = setup();
  await tracker.trigger(1, ['mkIos']);
  gh.current = run(1, 'completed', 'failure');
  const [b] = await tracker.refresh();
  assert.equal(reruns().length, 1);
  assert.deepEqual(b.classification, { kind: 'infra', label: 'Network issue' });
});

test('compile error far above the last 3 error lines is still classified as code and not retried', async () => {
  const { gh, tracker, reruns } = setup();
  const origRun = gh.run.bind(gh);
  const log = [
    'J\tS\t2026-11-06T12:00:00Z /Users/runner/work/x/App.swift:10:5: error: cannot find foo in scope',
    ...Array.from({ length: 40 }, (_, i) => `J\tS\t2026-11-06T12:00:01Z noise line ${i}`),
    'J\tS\t2026-11-06T12:00:02Z ** BUILD FAILED **',
    'J\tS\t2026-11-06T12:00:03Z [!] Error building the application - see the log above',
    'J\tS\t2026-11-06T12:00:04Z fastlane finished with errors',
  ].join('\n');
  gh.run = async (args) => (args.includes('--log-failed') ? log : origRun(args));
  await tracker.trigger(1, ['mkIos']);
  gh.current = run(1, 'completed', 'failure');
  const [b] = await tracker.refresh();
  assert.equal(reruns().length, 0);
  assert.deepEqual(b.classification, { kind: 'code', label: 'Compile error' });
  assert.equal(b.reason.lines.length, 3);
});
