import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheSummary, clearCaches } from '../lib/actions-cache.js';

const caches = [
  { id: 1, key: 'Linux-yarn-a', ref: 'refs/heads/develop', size_in_bytes: 100, last_accessed_at: '2026-11-18T10:00:00Z' },
  { id: 2, key: 'Linux-yarn-b', ref: 'refs/heads/TCPMOB-1410-x', size_in_bytes: 300, last_accessed_at: '2026-11-18T12:00:00Z' },
  { id: 3, key: 'macOS-pods-c', ref: 'refs/heads/develop', size_in_bytes: 50, last_accessed_at: '2026-11-17T09:00:00Z' },
];
function fakeGh(list = caches) {
  const calls = [];
  return {
    calls,
    async json(args, opts) { calls.push({ args, opts }); return { total_count: list.length, actions_caches: list }; },
    async run(args) { calls.push({ args }); return ''; },
  };
}

test('summary groups caches by branch, biggest first, with totals', async () => {
  const s = await cacheSummary(fakeGh());
  assert.equal(s.count, 3);
  assert.equal(s.bytes, 450);
  assert.deepEqual(s.refs.map((r) => [r.branch, r.count, r.bytes, r.lastAccessedAt]), [
    ['TCPMOB-1410-x', 1, 300, '2026-11-18T12:00:00Z'],
    ['develop', 2, 150, '2026-11-18T10:00:00Z'],
  ]);
});

test('clear one branch deletes only its caches; clear all deletes every cache', async () => {
  let gh = fakeGh();
  assert.deepEqual(await clearCaches(gh, { ref: 'refs/heads/develop' }), { deleted: 2, failed: 0 });
  const deletes = (g) => g.calls.filter((c) => c.args.includes('DELETE')).map((c) => c.args[1]);
  assert.deepEqual(deletes(gh), ['repos/tcp-software/mobile-clock/actions/caches/1', 'repos/tcp-software/mobile-clock/actions/caches/3']);
  assert.equal(gh.calls[0].opts?.fresh, true, 'reads the current list, not a cached one');
  gh = fakeGh();
  assert.deepEqual(await clearCaches(gh, {}), { deleted: 3, failed: 0 });
  assert.equal(deletes(gh).length, 3);
});

test('a cache that fails to delete is counted, the rest still go', async () => {
  const gh = fakeGh();
  gh.run = async (args) => { gh.calls.push({ args }); if (args[1].endsWith('/2')) throw new Error('403'); return ''; };
  assert.deepEqual(await clearCaches(gh, {}), { deleted: 2, failed: 1 });
});
