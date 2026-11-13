import { execFile } from 'node:child_process';
import { readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { REPO } from '../config.js';
import { HttpError } from './http.js';
import { GhError } from './gh.js';

const ARTIFACT = '.app build artifacts for simulator';
const NO_SIM_BUILD = 'This run has no simulator build. Trigger the "Simulator .app" build to get one.';

function defaultExec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
    });
  });
}

// "com.apple.CoreSimulator.SimRuntime.iOS-18-2" → "iOS 18.2"
function runtimeName(id) {
  const parts = id.match(/SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)/);
  return parts ? `${parts[1]} ${parts[2]}.${parts[3]}` : id;
}

export function parseBooted(json) {
  const devices = JSON.parse(json).devices ?? {};
  return Object.entries(devices).flatMap(([runtime, list]) => list
    .filter((d) => d.state === 'Booted')
    .map((d) => ({ udid: d.udid, name: d.name, runtime: runtimeName(runtime) })));
}

function findApp(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry.endsWith('.app') && statSync(full).isDirectory()) return full;
    if (statSync(full).isDirectory()) {
      const nested = findApp(full);
      if (nested) return nested;
    }
  }
  return null;
}

export function createSimulator({ gh, exec = defaultExec, cacheDir }) {
  let busy = false;

  async function run(file, args) {
    const result = await exec(file, args);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(0, 300);
      throw new HttpError(502, `${path.basename(file)} ${args[0] ?? ''} failed: ${detail}`);
    }
    return result.stdout;
  }

  async function booted() {
    return parseBooted(await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
  }

  async function downloadArtifact(runId, dir) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      await gh.run(['run', 'download', String(runId), '-R', REPO, '-n', ARTIFACT, '-D', dir]);
    } catch (err) {
      if (err instanceof GhError && /no artifact|not found/i.test(err.message)) throw new HttpError(404, NO_SIM_BUILD);
      throw err;
    }
  }

  async function unpackApp(dir) {
    const zip = readdirSync(dir).find((f) => f.endsWith('.zip'));
    if (!zip) throw new HttpError(502, 'The downloaded artifact has no zip file.');
    const appDir = path.join(dir, 'app');
    await run('ditto', ['-x', '-k', path.join(dir, zip), appDir]);
    const app = findApp(appDir);
    if (!app) throw new HttpError(502, 'No .app found in the artifact.');
    return app;
  }

  async function installAndLaunch(udid, app) {
    const plist = path.join(app, 'Info.plist');
    const bundleId = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).trim();
    await run('xcrun', ['simctl', 'install', udid, app]);
    await run('xcrun', ['simctl', 'launch', udid, bundleId]);
    return bundleId;
  }

  async function install(runId, udid) {
    if (busy) throw new HttpError(409, 'Another simulator install is in progress.');
    busy = true;
    try {
      if (!(await booted()).some((d) => d.udid === udid)) throw new HttpError(400, 'That simulator isn\'t booted.');
      const dir = path.join(cacheDir, 'sim', String(runId));
      await downloadArtifact(runId, dir);
      const bundleId = await installAndLaunch(udid, await unpackApp(dir));
      return { ok: true, bundleId };
    } finally {
      busy = false;
    }
  }

  return { booted, install };
}

const UDID = /^[0-9A-F-]{36}$/i;

async function handleInstall(ctx, match, req) {
  const runId = ctx.id(match[1]);
  const { udid } = await ctx.readJson(req);
  if (typeof udid !== 'string' || !UDID.test(udid)) throw new HttpError(400, 'Pick a booted simulator.');
  return ctx.sim.install(runId, udid);
}

export function routes(ctx) {
  ctx.sim ??= createSimulator({ gh: ctx.gh, cacheDir: ctx.cacheDir });
  return [
    ['GET', /^\/api\/simulators$/, () => ctx.sim.booted()],
    ['POST', /^\/api\/runs\/([^/]+)\/install$/, (m, req) => handleInstall(ctx, m, req)],
  ];
}
