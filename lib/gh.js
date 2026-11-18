import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseRead, createDirect, NetworkError } from './github-direct.js';

const execFileAsync = promisify(execFile);
// Failed-step logs can run to several MB.
const defaultExec = (file, args) => execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024 });

export class GhError extends Error {
  constructor(message, stderr = '') {
    super(message);
    this.name = 'GhError';
    this.stderr = stderr;
  }
}

const CACHE_MS = 15000;
const NETWORK_BACKOFF_MS = 60000;
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

// Commands that change something on GitHub. They always run the CLI and clear the read cache.
function isWrite(args) {
  const [cmd, sub] = args;
  if (cmd === 'pr') return ['create', 'merge', 'edit', 'close', 'reopen', 'review', 'comment', 'ready'].includes(sub);
  if (cmd === 'workflow') return sub === 'run';
  if (cmd === 'run') return ['rerun', 'cancel', 'delete'].includes(sub);
  if (cmd === 'api') {
    const method = args[args.indexOf('-X') + 1];
    return args.includes('-X') ? method !== 'GET' : args.includes('-f') && sub !== 'graphql';
  }
  return false;
}

// gh with the common reads answered straight from GitHub (lib/github-direct.js). Writes, unusual reads, a proxy,
// or a recent connection failure use the CLI. Identical reads share one call and are reused for 15 seconds.
// Direct reads are on with the real CLI, or when a test passes its own fetch; a fake exec alone never reaches the network.
export function createGh(exec = defaultExec, options = {}) {
  const { env = process.env, now = Date.now } = options;
  const fetchImpl = options.fetch ?? (exec === defaultExec ? globalThis.fetch : null);
  const direct = fetchImpl && !PROXY_VARS.some((v) => env[v])
    ? createDirect({ fetch: fetchImpl, readToken })
    : null;
  const cache = new Map(); // JSON args -> { at, promise<{ text, json }> }

  // Signed out or gh missing: mark it so the read falls back to the CLI, which shows the usual sign-in error.
  async function readToken() {
    try {
      return String((await exec('gh', ['auth', 'token'])).stdout).trim();
    } catch {
      throw Object.assign(new Error('gh token unavailable'), { tokenUnreadable: true });
    }
  }
  let networkFailedAt = null;

  async function cli(args) {
    try {
      const { stdout } = await exec('gh', args);
      return stdout;
    } catch (err) {
      const stderr = String(err.stderr ?? '').trim();
      throw new GhError(stderr || err.message, stderr);
    }
  }

  async function viaCliOrDirect(args, read) {
    const directOk = direct && read && (networkFailedAt === null || now() - networkFailedAt >= NETWORK_BACKOFF_MS);
    if (directOk) {
      try {
        return await direct.read(read);
      } catch (err) {
        if (err instanceof NetworkError) networkFailedAt = now();
        else if (!err?.tokenUnreadable) throw err;
      }
    }
    const text = await cli(args);
    return { text, get json() { return JSON.parse(text); } };
  }

  function load(args, { fresh = false } = {}) {
    const read = parseRead(args);
    if (!read) {
      if (!isWrite(args)) return viaCliOrDirect(args, null);
      cache.clear();
      const done = viaCliOrDirect(args, null);
      done.then(() => cache.clear(), () => cache.clear()); // reads made while it ran saw the old state
      return done;
    }
    const key = JSON.stringify(args);
    const hit = cache.get(key);
    if (hit && !fresh && now() - hit.at < CACHE_MS) return hit.promise;
    const promise = viaCliOrDirect(args, read);
    cache.set(key, { at: now(), promise });
    promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
    return promise;
  }

  return {
    run: async (args, opts) => (await load(args, opts)).text,
    json: async (args, opts) => structuredClone((await load(args, opts)).json), // opts.fresh skips a cache hit
    clearCache: () => cache.clear(),
  };
}
