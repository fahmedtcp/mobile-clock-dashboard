import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listMergedPrs, createBranchList } from '../lib/ghdata.js';

test('listMergedPrs queries merged PRs into base since a date and flattens author', async () => {
  let args;
  const gh = { json: async (a) => { args = a; return [{ number: 1, author: { login: 'x' } }]; } };
  const prs = await listMergedPrs(gh, { sinceIso: '2026-10-23T12:00:00Z' });
  assert.deepEqual(args.slice(0, 11), ['pr', 'list', '-R', 'tcp-software/mobile-clock', '--state', 'merged', '--base', 'develop', '--search', 'merged:>=2026-10-23', '-L']);
  assert.equal(prs[0].author, 'x');
});

test('branch list is cached for 5 minutes', async () => {
  let calls = 0; let t = 0;
  const gh = { run: async () => { calls++; return 'develop\nrelease/1.45.x\n'; } };
  const list = createBranchList(gh, () => t);
  assert.deepEqual(await list.get(), ['develop', 'release/1.45.x']);
  await list.get();
  t = 300001;
  await list.get();
  assert.equal(calls, 2);
});
