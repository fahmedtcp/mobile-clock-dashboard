// Everything the Builds tab shows: iOS slots, waiting builds, running builds (everyone), and your build history.
import { BUILDS } from '../config.js';
import { BUILD_FILES, IOS_SLOTS, recentRuns, isActive, slotBusy, ticketKeyOf } from './build-slots.js';

const LABELS = { ...IOS_SLOTS, 'run-mc-android.yml': 'Android MobileClock', 'run-mk-android.yml': 'Android MobileKiosk' };
const HISTORY_DAYS = 14;
const MEDIAN_OF = 20;

export function median(numbers) {
  if (!numbers.length) return null;
  const s = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const durationMs = (r) => Date.parse(r.updatedAt) - Date.parse(r.startedAt);
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function mondayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export async function buildOverview({ gh, tracker, queue, login, now = Date.now }) {
  const at = now();
  const since = localDay(at - HISTORY_DAYS * 864e5);
  const [recent, mine] = await Promise.all([
    Promise.all(BUILD_FILES.map((f) => recentRuns(gh, f))),
    Promise.all(BUILD_FILES.map((f) => recentRuns(gh, f, { actor: login, since, perPage: 100 }))),
  ]);
  const tracked = tracker.list();
  const active = Object.fromEntries(BUILD_FILES.map((f, i) => [f, recent[i].filter(isActive)]));
  const successMs = (runs) => runs.filter((r) => r.conclusion === 'success').slice(0, MEDIAN_OF).map(durationMs);

  const waiting = [
    ...queue.list().map((e) => ({ id: e.id, kind: 'queue', key: e.key, prNumber: e.prNumber, branch: e.branch, since: e.queuedAt })),
    ...tracker.waitingRetries().map((b) => ({ id: b.id, kind: 'retry', key: b.key, prNumber: b.prNumber, branch: b.branch, since: b.waitingSince })),
  ].map((w) => ({ ...w, label: LABELS[BUILDS[w.key].file], ticketKey: ticketKeyOf(w.branch) })).sort((a, b) => a.since - b.since);

  const slots = Object.keys(IOS_SLOTS).map((file) => ({
    file,
    label: IOS_SLOTS[file],
    busy: slotBusy({ file, active, tracked, now: at }),
    medianMs: median(successMs(recent[BUILD_FILES.indexOf(file)])),
    waiting: waiting.filter((w) => BUILDS[w.key].file === file).length,
  }));

  const decorate = (r) => ({ ...r, label: LABELS[r.file], ticketKey: ticketKeyOf(r.branch) });
  const running = BUILD_FILES.flatMap((f) => active[f]).map((r) => ({ ...decorate(r), mine: r.actor === login }));
  const byRun = new Map(tracked.filter((b) => b.runId).map((b) => [b.runId, b]));
  const history = mine.flat().filter((r) => r.status === 'completed')
    .map((r) => ({ ...decorate(r), durationMs: durationMs(r), build: byRun.get(r.runId) ?? null }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const weekFrom = mondayStart(at);
  const week = history.filter((r) => Date.parse(r.createdAt) >= weekFrom);
  return {
    slots,
    waiting,
    running,
    history,
    week: {
      count: week.length,
      passed: week.filter((r) => r.conclusion === 'success').length,
      retriesSaved: tracked.filter((b) => b.conclusion === 'success' && b.retries > 0 && b.triggeredAt >= weekFrom).length,
      iosMedianMs: median(week.filter((r) => IOS_SLOTS[r.file] && r.conclusion === 'success').map((r) => r.durationMs)),
    },
  };
}
