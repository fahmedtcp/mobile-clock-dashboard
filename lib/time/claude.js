// Claude Code transcripts → per-day session summaries (no message text is ever kept).
import { createReadStream, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { dayKey } from './days.js';

const KEY = /TCPMOB-\d+/gi;
const FULL = 1;
const LIGHT = 0.1;
const GAP_MS = 15 * 60 * 1000;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
// A key needs at least this much weight (one real mention, or ten in tool output) to name a segment;
// below it, git log / status noise would decide the ticket, so the branch is used instead.
const MIN_KEY_WEIGHT = 1;

const keysIn = (text, weight) => (String(text ?? '').match(KEY) ?? []).map((k) => ({ key: k.toUpperCase(), weight }));

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c?.type === 'text' ? c.text : '')).join('\n');
  return '';
}

// Weighted ticket-key mentions in one transcript record (see the spec's "Which Mentions Count").
export function mentionsIn(rec) {
  if (!rec || rec.isMeta || rec.isCompactSummary) return [];
  const content = rec.message?.content;
  if (rec.type === 'user') {
    if (typeof content === 'string') return keysIn(content.replace(REMINDER, ''), FULL);
    if (!Array.isArray(content)) return [];
    return content.flatMap((b) => {
      if (b?.type === 'text') return keysIn(String(b.text).replace(REMINDER, ''), FULL);
      if (b?.type === 'tool_result') return keysIn(toolResultText(b.content), LIGHT);
      return [];
    });
  }
  if (rec.type === 'assistant' && Array.isArray(content)) {
    return content.flatMap((b) => {
      if (b?.type === 'text') return keysIn(b.text, FULL);
      if (b?.type === 'tool_use') return keysIn(JSON.stringify(b.input ?? {}), FULL);
      return []; // thinking and anything else never count
    });
  }
  return []; // attachments, system, api-request*, etc. are injected context
}

const isActivity = (r) => (r.type === 'user' || r.type === 'assistant') && r.timestamp && r.sessionId;
const branchKey = (b) => (String(b ?? '').match(KEY)?.[0] ?? '').toUpperCase() || null;
const round1 = (n) => Math.round(n * 10) / 10;

// One session's records for one local day → Session.
function summarizeDay(sessionId, recs) {
  recs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const keyCounts = {};
  const segments = [];
  let seg = null;
  let since = new Map(); // key -> { weight, firstIdx } since the current segment started

  recs.forEach((r, i) => {
    const mentions = r.mentions ?? mentionsIn(r);
    for (const { key, weight } of mentions) {
      keyCounts[key] = round1((keyCounts[key] ?? 0) + weight);
      const cur = since.get(key) ?? { weight: 0, firstIdx: i };
      cur.weight += weight;
      since.set(key, cur);
    }
    if (!seg) { seg = { key: null, startIdx: i, endIdx: i }; segments.push(seg); }
    seg.endIdx = i;
    if (!mentions.length) return;
    if (seg.key === null) {
      const [topKey, top] = [...since.entries()].sort((a, b) => b[1].weight - a[1].weight)[0];
      if (top.weight >= MIN_KEY_WEIGHT) seg.key = topKey;
      return;
    }
    // Switch when another key overtakes the current one; backdate to that key's first mention.
    const curWeight = since.get(seg.key)?.weight ?? 0;
    const [topKey, top] = [...since.entries()].sort((a, b) => b[1].weight - a[1].weight)[0];
    if (topKey !== seg.key && top.weight > curWeight && top.weight >= MIN_KEY_WEIGHT) {
      seg.endIdx = Math.max(seg.startIdx, top.firstIdx - 1);
      seg = { key: topKey, startIdx: top.firstIdx, endIdx: i };
      segments.push(seg);
      since = new Map([[topKey, { weight: top.weight, firstIdx: top.firstIdx }]]);
    }
  });

  // Active minutes: gaps ≤ 15 min, credited to the segment holding the later record.
  const minutesAt = recs.map((r, i) => {
    if (i === 0) return 0;
    const gap = Date.parse(r.timestamp) - Date.parse(recs[i - 1].timestamp);
    return gap > 0 && gap <= GAP_MS ? gap / 60000 : 0;
  });
  const fallback = () => {
    const counts = {};
    for (const r of recs) { const k = branchKey(r.gitBranch); if (k) counts[k] = (counts[k] ?? 0) + 1; }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const out = [];
  for (const s of segments) {
    const key = s.key ?? fallback();
    const activeMinutes = Math.round(minutesAt.slice(s.startIdx, s.endIdx + 1).reduce((a, b) => a + b, 0));
    const piece = { key, start: recs[s.startIdx].timestamp, end: recs[s.endIdx].timestamp, activeMinutes };
    const prev = out.at(-1);
    if (prev && prev.key === key) { prev.end = piece.end; prev.activeMinutes += activeMinutes; } else out.push(piece);
  }
  const branchCounts = {};
  for (const r of recs) if (r.gitBranch) branchCounts[r.gitBranch] = (branchCounts[r.gitBranch] ?? 0) + 1;
  return {
    sessionId,
    start: recs[0].timestamp,
    end: recs.at(-1).timestamp,
    activeMinutes: Math.round(minutesAt.reduce((a, b) => a + b, 0)),
    keyCounts,
    branch: Object.entries(branchCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    segments: out,
  };
}

// Records (raw or pre-reduced with `mentions`) → Map<day, Session[]>. Sidechains share the parent's sessionId.
export function summarizeSessions(records) {
  const groups = new Map(); // `${sessionId}\0${day}` -> recs
  for (const r of records) {
    if (!isActivity(r)) continue;
    const k = `${r.sessionId}\0${dayKey(r.timestamp)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const byDay = new Map();
  for (const [k, recs] of groups) {
    const [sessionId, day] = k.split('\0');
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(summarizeDay(sessionId, recs));
  }
  return byDay;
}

function jsonlFiles(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((name) => {
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { return []; }
    if (st.isDirectory()) return jsonlFiles(full);
    return name.endsWith('.jsonl') ? [full] : [];
  });
}

// Stream every transcript; keep only what summaries need, so huge tool results don't stay in memory.
export async function scanAll(dir) {
  const reduced = [];
  for (const file of jsonlFiles(dir)) {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!isActivity(rec)) continue;
      reduced.push({ type: rec.type, sessionId: rec.sessionId, timestamp: rec.timestamp, gitBranch: rec.gitBranch, mentions: mentionsIn(rec) });
    }
  }
  return summarizeSessions(reduced);
}

const dayFile = (timeDir, day) => path.join(timeDir, 'claude', `${day}.json`);

export function loadDay(timeDir, day) {
  try { return JSON.parse(readFileSync(dayFile(timeDir, day), 'utf8')).sessions ?? []; } catch { return []; }
}

// Merge today's view of each day into the dashboard's own copy. Never deletes a day or a session.
export async function snapshot(dir, timeDir) {
  if (!existsSync(dir)) throw new Error(`Claude transcripts not found at ${dir}`);
  const byDay = await scanAll(dir);
  mkdirSync(path.join(timeDir, 'claude'), { recursive: true });
  for (const [day, sessions] of byDay) {
    const merged = new Map(loadDay(timeDir, day).map((s) => [s.sessionId, s]));
    for (const s of sessions) merged.set(s.sessionId, s);
    const file = dayFile(timeDir, day);
    writeFileSync(`${file}.tmp`, JSON.stringify({ sessions: [...merged.values()] }, null, 1));
    renameSync(`${file}.tmp`, file);
  }
  return { days: byDay.size };
}
