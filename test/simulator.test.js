import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseBooted, createSimulator } from '../lib/simulator.js';
import { GhError } from '../lib/gh.js';

const BOOTED = JSON.stringify({ devices: {
  'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [{ udid: 'U1', name: 'iPhone 16', state: 'Booted' }],
  'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [],
} });

test('parseBooted reads simctl json', () => {
  assert.deepEqual(parseBooted(BOOTED), [{ udid: 'U1', name: 'iPhone 16', runtime: 'iOS 18.2' }]);
  assert.deepEqual(parseBooted('{"devices":{}}'), []);
});

function setup({ ghError = null, gate = null } = {}) {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'sim-'));
  const calls = [];
  const gh = { async run(args) {
    calls.push(['gh', ...args]);
    if (ghError) throw ghError;
    if (gate) await gate;
    const dir = args[args.indexOf('-D') + 1];
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'mobileClock.zip'), 'zip');
    return '';
  } };
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'xcrun' && args.includes('list')) return { stdout: BOOTED, stderr: '', code: 0 };
    if (file === 'ditto') mkdirSync(path.join(args.at(-1), 'mobileClockDev.app'), { recursive: true });
    if (file === '/usr/libexec/PlistBuddy') return { stdout: 'com.tcp.mobileclock.dev\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  return { sim: createSimulator({ gh, exec, cacheDir }), calls, cacheDir };
}

test('install runs download → unzip → plist → install → launch in order', async () => {
  const { sim, calls, cacheDir } = setup();
  const res = await sim.install(42, 'U1');
  assert.deepEqual(res, { ok: true, bundleId: 'com.tcp.mobileclock.dev' });
  const steps = calls.map((c) => c[0] === 'xcrun' ? `xcrun ${c[2]}` : c[0]);
  assert.deepEqual(steps, ['xcrun list', 'gh', 'ditto', '/usr/libexec/PlistBuddy', 'xcrun install', 'xcrun launch']);
  const gh = calls.find((c) => c[0] === 'gh');
  assert.deepEqual(gh.slice(1, 7), ['run', 'download', '42', '-R', 'tcp-software/mobile-clock', '-n']);
  assert.equal(gh[7], '.app build artifacts for simulator');
  const install = calls.find((c) => c[2] === 'install');
  assert.deepEqual(install, ['xcrun', 'simctl', 'install', 'U1', path.join(cacheDir, 'sim', '42', 'app', 'mobileClockDev.app')]);
  assert.deepEqual(calls.at(-1), ['xcrun', 'simctl', 'launch', 'U1', 'com.tcp.mobileclock.dev']);
});

test('unknown udid → 400 before any download', async () => {
  const { sim, calls } = setup();
  await assert.rejects(sim.install(42, 'NOPE'), (e) => e.status === 400);
  assert.ok(!calls.some((c) => c[0] === 'gh'));
});

test('second concurrent install → 409', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { sim } = setup({ gate });
  const first = sim.install(42, 'U1');
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(sim.install(43, 'U1'), (e) => e.status === 409);
  release();
  await first;
});

test('missing artifact → 404 with clear message', async () => {
  const { sim } = setup({ ghError: new GhError('no artifact matches any of the names or patterns provided', 'no artifact matches') });
  await assert.rejects(sim.install(42, 'U1'), (e) => e.status === 404 && /no simulator build/i.test(e.message));
});
