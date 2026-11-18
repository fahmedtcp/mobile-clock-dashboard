import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview, buildHistory, median } from '../lib/build-overview.js';

const NOW = new Date(2026, 10, 18, 14, 0).getTime(); // Wednesday 2 PM local
const iso = (ms) => new Date(ms).toISOString();
let nextId = 1;
function rest({ file, branch = 'TCPMOB-1764-x', actor = 'me', status = 'completed', conclusion = 'success', start = NOW - 3600e3, mins = 30, id = nextId++ }) {
  return { file, r: { id, html_url: `u${id}`, head_branch: branch, actor: { login: actor }, status, conclusion: status === 'completed' ? conclusion : null, created_at: iso(start), run_started_at: iso(start), updated_at: iso(start + mins * 60e3), run_attempt: 1 } };
}

function fakeGh(runs) {
  const calls = [];
  return {
    calls,
    async json(args) {
      calls.push(args);
      const file = args[1].split('/').at(-2);
      const actor = args.find((a) => a.startsWith('actor='))?.slice(6);
      return { workflow_runs: runs.filter((x) => x.file === file && (!actor || x.r.actor.login === actor)).map((x) => x.r) };
    },
  };
}
const tracker = (builds = []) => ({ list: () => builds, waitingRetries: () => builds.filter((b) => b.status === 'waiting-slot') });
const queue = (entries = []) => ({ list: () => entries });
const overview = (runs, { builds = [], entries = [] } = {}) =>
  buildOverview({ gh: fakeGh(runs), tracker: tracker(builds), queue: queue(entries), login: 'me', now: () => NOW });

test('median([]) is null; median([3,1,2]) is 2; even count averages', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('slots show busy run and median of last 20 successes', async () => {
  const runs = [rest({ file: 'run-mc-ios.yml', status: 'in_progress', actor: 'hamza', start: NOW - 14 * 60e3 })];
  for (let i = 0; i < 22; i++) runs.push(rest({ file: 'run-mc-ios.yml', actor: 'hamza', start: NOW - (i + 2) * 3600e3, mins: i < 20 ? 38 : 90 }));
  runs.push(rest({ file: 'run-mc-ios.yml', actor: 'hamza', conclusion: 'failure', mins: 5, start: NOW - 1800e3 }));
  const o = await overview(runs, { entries: [{ id: 'q1', key: 'mcIos', prNumber: 5, branch: 'TCPMOB-1800-y', queuedAt: NOW - 60e3 }] });
  const [mc, mk] = o.slots;
  assert.equal(mc.file, 'run-mc-ios.yml');
  assert.equal(mc.label, 'iOS MobileClock');
  assert.equal(mc.busy.ticketKey, 'TCPMOB-1764');
  assert.equal(mc.busy.actor, 'hamza');
  assert.equal(mc.medianMs, 38 * 60e3);
  assert.equal(mc.waiting, 1);
  assert.equal(mk.busy, null);
  assert.equal(mk.medianMs, null);
});

test('running includes everyone and marks mine', async () => {
  const o = await overview([
    rest({ file: 'run-mc-ios.yml', status: 'in_progress', actor: 'hamza' }),
    rest({ file: 'run-mc-android.yml', status: 'queued', actor: 'me', branch: 'TCPMOB-1790-z' }),
  ]);
  assert.deepEqual(o.running.map((r) => [r.label, r.mine, r.ticketKey]).sort(),
    [['Android MobileClock', true, 'TCPMOB-1790'], ['iOS MobileClock', false, 'TCPMOB-1764']]);
});

test('history keeps only my completed runs, newest first, joined to tracker builds', async () => {
  const runs = [
    rest({ file: 'run-mk-ios.yml', start: NOW - 2 * 3600e3, id: 71 }),
    rest({ file: 'run-mc-android.yml', conclusion: 'failure', start: NOW - 3600e3, id: 72 }),
    rest({ file: 'run-mc-android.yml', status: 'in_progress', start: NOW - 60e3 }),
    rest({ file: 'run-mk-android.yml', actor: 'hamza' }),
  ];
  const builds = [{ id: 'b', runId: 72, key: 'mcAndroid', retries: 1, status: 'completed', conclusion: 'failure', classification: { kind: 'code', label: 'Compile error' } }];
  const o = await overview(runs, { builds });
  assert.deepEqual(o.history.map((h) => h.runId), [72, 71]);
  assert.equal(o.history[0].build.classification.label, 'Compile error');
  assert.equal(o.history[1].build, null);
  assert.equal(o.history[1].durationMs, 30 * 60e3);
});

test('history asks GitHub for my runs in the last 14 days', async () => {
  const gh = fakeGh([]);
  await buildOverview({ gh, tracker: tracker(), queue: queue(), login: 'me', now: () => NOW });
  const mine = gh.calls.filter((a) => a.includes('actor=me'));
  assert.equal(mine.length, 4);
  assert.ok(mine.every((a) => a.includes('created=>=2026-11-04') && a.includes('per_page=100')));
});

test('week counts since Monday with retriesSaved and iOS median', async () => {
  const monday = new Date(2026, 10, 16, 9, 0).getTime();
  const sunday = new Date(2026, 10, 15, 9, 0).getTime();
  const runs = [
    rest({ file: 'run-mk-ios.yml', start: monday, mins: 30, id: 81 }),
    rest({ file: 'run-mc-ios.yml', start: monday + 3600e3, mins: 40, id: 82 }),
    rest({ file: 'run-mc-android.yml', conclusion: 'failure', start: monday + 7200e3 }),
    rest({ file: 'run-mc-android.yml', start: sunday }),
  ];
  const builds = [{ id: 'b', runId: 81, key: 'mkIos', status: 'completed', conclusion: 'success', retries: 1, triggeredAt: monday }];
  const o = await overview(runs, { builds });
  assert.deepEqual(o.week, { count: 3, passed: 2, retriesSaved: 1, iosMedianMs: 35 * 60e3 });
});

test('waiting lists queue entries and retry waits, oldest first', async () => {
  const builds = [{ id: 'w', key: 'mkIos', label: 'iOS MobileKiosk', status: 'waiting-slot', prNumber: 9, branch: 'TCPMOB-9-a', waitingSince: NOW - 5e3, file: 'run-mk-ios.yml' }];
  const entries = [{ id: 'q', key: 'mcIos', prNumber: 5, branch: 'TCPMOB-5-b', queuedAt: NOW - 9e3 }];
  const o = await overview([], { builds, entries });
  assert.deepEqual(o.waiting.map((w) => [w.id, w.kind, w.label, w.ticketKey, w.since]), [
    ['q', 'queue', 'iOS MobileClock', 'TCPMOB-5', NOW - 9e3],
    ['w', 'retry', 'iOS MobileKiosk', 'TCPMOB-9', NOW - 5e3],
  ]);
  assert.equal(o.slots[1].waiting, 1);
});

test('buildHistory everyone: all actors completed runs from 14 days, mine marked, no actor filter sent', async () => {
  const gh = fakeGh([
    rest({ file: 'run-mc-ios.yml', actor: 'hamza', start: NOW - 2 * 3600e3 }),
    rest({ file: 'run-mk-android.yml', actor: 'me', start: NOW - 3600e3 }),
    rest({ file: 'run-mc-ios.yml', actor: 'hamza', status: 'in_progress' }),
  ]);
  const h = await buildHistory({ gh, tracker: tracker(), login: 'me', now: () => NOW });
  assert.deepEqual(h.map((r) => [r.label, r.actor, r.mine]), [['Android MobileKiosk', 'me', true], ['iOS MobileClock', 'hamza', false]]);
  assert.ok(gh.calls.every((a) => !a.some((x) => x.startsWith('actor='))));
  assert.ok(gh.calls.every((a) => a.includes('created=>=2026-11-04')));
});
