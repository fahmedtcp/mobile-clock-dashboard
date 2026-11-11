import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const defaultExec = (file, args) => execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024 }); // failed-step logs can run to several MB

export class GhError extends Error {
  constructor(message, stderr = '') {
    super(message);
    this.name = 'GhError';
    this.stderr = stderr;
  }
}

export function createGh(exec = defaultExec) {
  async function run(args) {
    try {
      const { stdout } = await exec('gh', args);
      return stdout;
    } catch (err) {
      const stderr = String(err.stderr ?? '').trim();
      throw new GhError(stderr || err.message, stderr);
    }
  }
  return { run, json: async (args) => JSON.parse(await run(args)) };
}
