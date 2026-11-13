process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseLog, commitsByDay } from '../lib/time/git.js';

test('subject key wins over branch key; late-night commit counts on the local day', () => {
  const out = 'aaa\t2026-11-05T23:30:00-06:00\trefs/heads/TCPMOB-1-old\tTCPMOB-2: start new ticket\n'
    + 'bbb\t2026-11-06T10:00:00-06:00\trefs/remotes/origin/TCPMOB-3-x\tfix thing\n'
    + 'ccc\t2026-11-06T11:00:00-06:00\trefs/heads/develop\tchore: bump\n';
  const commits = parseLog(out);
  assert.deepEqual(commits.map((c) => [c.sha, c.day, c.key]),
    [['aaa', '2026-11-05', 'TCPMOB-2'], ['bbb', '2026-11-06', 'TCPMOB-3'], ['ccc', '2026-11-06', null]]);
});

test('commitsByDay passes --no-merges and the author email, dedupes shas', async () => {
  const calls = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'repo-'));
  const exec = async (file, args) => {
    calls.push(args);
    if (args.includes('config')) return { stdout: 'me@tcp.com\n', stderr: '', code: 0 };
    const stdout = 'aaa\t2026-11-05T10:00:00-06:00\trefs/heads/TCPMOB-2-x\tw\n'
      + 'aaa\t2026-11-05T10:00:00-06:00\trefs/remotes/origin/TCPMOB-2-x\tw\n';
    return { stdout, stderr: '', code: 0 };
  };

  const result = await commitsByDay(exec, dir, { since: '2026-11-01T00:00:00', until: '2026-11-30T23:59:59' });

  const log = calls.find((args) => args.includes('log'));
  for (const flag of ['--no-merges', '--all', '--source', '--author=me@tcp.com']) assert.ok(log.includes(flag), flag);
  assert.equal(result.byDay.get('2026-11-05').length, 1);
  assert.equal(result.error, null);
});

test('missing repo returns empty map with error', async () => {
  const exec = async () => ({ stdout: '', stderr: '', code: 0 });
  const result = await commitsByDay(exec, '/definitely/missing', { since: 'a', until: 'b' });
  assert.equal(result.byDay.size, 0);
  assert.match(result.error, /mobile-clock folder in Settings/);
});

test('git failure is reported, not thrown', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'repo-'));
  const exec = async () => ({ stdout: '', stderr: 'fatal: not a git repository', code: 128 });
  const result = await commitsByDay(exec, dir, { since: 'a', until: 'b' });
  assert.match(result.error, /not a git repository/);
});
