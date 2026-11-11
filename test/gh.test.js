import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGh, GhError } from '../lib/gh.js';

test('run passes args as argv to gh and returns stdout', async () => {
  const calls = [];
  const gh = createGh(async (file, args) => { calls.push([file, args]); return { stdout: 'ok\n' }; });
  assert.equal(await gh.run(['pr', 'list', '--ref', 'epic/TCPMOB-1423 x']), 'ok\n');
  assert.deepEqual(calls, [['gh', ['pr', 'list', '--ref', 'epic/TCPMOB-1423 x']]]);
});

test('json parses stdout', async () => {
  const gh = createGh(async () => ({ stdout: '[{"a":1}]' }));
  assert.deepEqual(await gh.json([]), [{ a: 1 }]);
});

test('failure becomes GhError carrying stderr', async () => {
  const gh = createGh(async () => { throw Object.assign(new Error('x'), { stderr: 'gh: To get started, run gh auth login' }); });
  await assert.rejects(gh.run([]), (e) => e instanceof GhError && e.stderr.includes('gh auth login'));
});
