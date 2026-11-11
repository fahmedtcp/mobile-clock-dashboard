process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mentionsIn, summarizeSessions, scanAll, snapshot, loadDay } from '../lib/time/claude.js';

const u = (text, ts, extra = {}) => ({ type: 'user', sessionId: 's1', timestamp: ts, gitBranch: 'TCPMOB-1-old', message: { role: 'user', content: text }, ...extra });

test('mentionsIn weights by source and strips system reminders', () => {
  assert.deepEqual(mentionsIn(u('work on tcpmob-1480 <system-reminder>TCPMOB-9 TCPMOB-9</system-reminder>', 't')), [{ key: 'TCPMOB-1480', weight: 1 }]);
  assert.deepEqual(mentionsIn({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'git switch TCPMOB-1480-x' } }, { type: 'thinking', thinking: 'TCPMOB-2' }] } }), [{ key: 'TCPMOB-1480', weight: 1 }]);
  assert.deepEqual(mentionsIn({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done with TCPMOB-7' }] } }), [{ key: 'TCPMOB-7', weight: 1 }]);
  assert.deepEqual(mentionsIn({ type: 'user', message: { content: [{ type: 'tool_result', content: 'TCPMOB-3 TCPMOB-3' }] } }), [{ key: 'TCPMOB-3', weight: 0.1 }, { key: 'TCPMOB-3', weight: 0.1 }]);
  assert.deepEqual(mentionsIn({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'TCPMOB-8' }] }] } }), [{ key: 'TCPMOB-8', weight: 0.1 }]);
  assert.deepEqual(mentionsIn({ type: 'attachment', attachment: { content: 'TCPMOB-4' } }), []);
  assert.deepEqual(mentionsIn({ type: 'system', content: 'TCPMOB-5' }), []);
});

test('session key is most-mentioned key, not branch; branch only as fallback', () => {
  const recs = [u('TCPMOB-1480', '2026-11-06T15:00:00Z'), u('TCPMOB-1480 again', '2026-11-06T15:10:00Z')];
  const [s] = summarizeSessions(recs).get('2026-11-06');
  assert.equal(s.segments[0].key, 'TCPMOB-1480');
  assert.equal(s.keyCounts['TCPMOB-1480'], 2);
  const [f] = summarizeSessions([u('no key here', '2026-11-06T15:00:00Z'), u('still none', '2026-11-06T15:05:00Z')]).get('2026-11-06');
  assert.equal(f.segments[0].key, 'TCPMOB-1');
});

test('active minutes ignore gaps over 15 minutes', () => {
  const [s] = summarizeSessions([u('TCPMOB-5', '2026-11-06T15:00:00Z'), u('x', '2026-11-06T15:10:00Z'), u('y', '2026-11-06T16:00:00Z')]).get('2026-11-06');
  assert.equal(s.activeMinutes, 10);
});

test('a session that switches tickets is split at the switch', () => {
  const recs = ['15:00', '15:05', '15:10'].map((t) => u('TCPMOB-10', `2026-11-06T${t}:00Z`))
    .concat(['15:20', '15:25', '15:30', '15:35'].map((t) => u('TCPMOB-11', `2026-11-06T${t}:00Z`)));
  const [s] = summarizeSessions(recs).get('2026-11-06');
  assert.deepEqual(s.segments.map((g) => g.key), ['TCPMOB-10', 'TCPMOB-11']);
  assert.ok(s.segments[0].activeMinutes > 0 && s.segments[1].activeMinutes > 0);
});

test('sidechain records merge into their parent session', () => {
  const m = summarizeSessions([u('TCPMOB-5', '2026-11-06T15:00:00Z'), u('TCPMOB-5', '2026-11-06T15:05:00Z', { isSidechain: true })]);
  assert.equal(m.get('2026-11-06').length, 1);
});

test('a session across local midnight is split per day', () => {
  const m = summarizeSessions([u('TCPMOB-5', '2026-11-06T05:50:00Z'), u('TCPMOB-5', '2026-11-06T06:05:00Z')]); // 23:50 and 00:05 local
  assert.deepEqual([...m.keys()].sort(), ['2026-11-05', '2026-11-06']);
});

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-'));
  mkdirSync(path.join(dir, 'proj', 'nested'), { recursive: true });
  return dir;
}

test('scanAll skips malformed lines and streams large files', async () => {
  const dir = tmp();
  const big = JSON.stringify({ type: 'user', sessionId: 's2', timestamp: '2026-11-06T15:02:00Z', message: { content: [{ type: 'tool_result', content: 'x'.repeat(5 * 1024 * 1024) }] } });
  writeFileSync(path.join(dir, 'proj', 'a.jsonl'), [JSON.stringify(u('TCPMOB-7', '2026-11-06T15:00:00Z', { sessionId: 's2' })), '{"type":"user", trunc', big, JSON.stringify(u('TCPMOB-7', '2026-11-06T15:05:00Z', { sessionId: 's2' }))].join('\n'));
  writeFileSync(path.join(dir, 'proj', 'nested', 'b.jsonl'), JSON.stringify(u('TCPMOB-8', '2026-11-07T15:00:00Z', { sessionId: 's3' })));
  const m = await scanAll(dir);
  assert.equal(m.get('2026-11-06').length, 1);
  assert.equal(m.get('2026-11-06')[0].segments[0].key, 'TCPMOB-7');
  assert.ok(m.has('2026-11-07'));
});

test('scanAll on a missing dir returns empty', async () => {
  assert.equal((await scanAll('/definitely/missing/dir')).size, 0);
});

test('snapshot writes per-day files, keeps days whose transcripts are gone, stores no message text', async () => {
  const dir = tmp();
  const timeDir = mkdtempSync(path.join(tmpdir(), 'time-'));
  const file = path.join(dir, 'proj', 'c.jsonl');
  writeFileSync(file, [u('work on TCPMOB-9 secret words', '2026-11-04T15:00:00Z', { sessionId: 's9' }), u('more', '2026-11-04T15:10:00Z', { sessionId: 's9' })].map((r) => JSON.stringify(r)).join('\n'));
  const r = await snapshot(dir, timeDir);
  assert.equal(r.days, 1);
  const out = path.join(timeDir, 'claude', '2026-11-04.json');
  assert.ok(existsSync(out));
  assert.ok(!readFileSync(out, 'utf8').includes('secret words'));
  rmSync(file);
  await snapshot(dir, timeDir);
  assert.equal(loadDay(timeDir, '2026-11-04')[0].sessionId, 's9');
  assert.deepEqual(loadDay(timeDir, '2026-01-01'), []);
});

test('light-only mentions (tool output) below weight 1 do not pick the ticket; branch fallback does', () => {
  const tr = (ts) => ({ type: 'user', sessionId: 's5', timestamp: ts, gitBranch: 'TCPMOB-1482-x', message: { content: [{ type: 'tool_result', content: 'Merge PR from TCPMOB-33-fmla' }] } });
  const [s] = summarizeSessions([tr('2026-11-06T15:00:00Z'), tr('2026-11-06T15:05:00Z'), tr('2026-11-06T15:10:00Z')]).get('2026-11-06');
  assert.deepEqual(s.segments.map((g) => g.key), ['TCPMOB-1482']);
  assert.equal(s.keyCounts['TCPMOB-33'], 0.3);
});

test('snapshot reports a missing transcripts folder instead of succeeding', async () => {
  await assert.rejects(snapshot('/definitely/missing/projects', mkdtempSync(path.join(tmpdir(), 't-'))), /Claude transcripts not found/);
});
