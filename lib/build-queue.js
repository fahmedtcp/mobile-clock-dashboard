// "Start When Free": iOS builds waiting for their TestFlight slot, started by the background loop once it's free.
// Shares one first-in, first-out line per slot with failed iOS builds waiting to retry.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILDS, DATA_DIR } from '../config.js';
import { HttpError } from './http.js';
import { getPr } from './prs.js';
import { notify } from './time/reminder.js';
import { BuildRequestError, save } from './builds.js';
import { IOS_SLOTS, slotBusy, ticketKeyOf } from './build-slots.js';

const EXPIRE_MS = 8 * 3600e3;
const SLOT_KEYS = ['mcIos', 'mkIos'];

function load(file) {
  if (!file) return [];
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(saved) ? saved : [];
  } catch { return []; }
}

const label = (e) => IOS_SLOTS[BUILDS[e.key].file];
const ref = (e) => ticketKeyOf(e.branch) ?? e.branch;

export function createQueue({ tracker, file = null, now = Date.now, notify }) {
  let entries = load(file);
  let seq = 0;
  const persist = () => save(file, entries);
  const remove = (id) => { entries = entries.filter((e) => e.id !== id); persist(); };

  function add({ prNumber, key, branch }) {
    if (!SLOT_KEYS.includes(key)) throw new BuildRequestError('Only iOS TestFlight builds can wait for a free slot.', 400);
    const entry = { id: `q${now()}-${++seq}`, prNumber, key, branch, queuedAt: now() };
    entries.push(entry);
    persist();
    return entry;
  }

  function cancel(id) {
    if (!entries.some((e) => e.id === id)) return false;
    remove(id);
    return true;
  }

  async function startEntry(entry) {
    remove(entry.id); // before starting, so a crash or a second pass can never start it twice
    try {
      await tracker.trigger(entry.prNumber, [entry.key]);
      notify({ title: 'Build Started', body: `${label(entry)} build started for ${ref(entry)}` });
    } catch (err) {
      const lostSlotRace = err.status === 409 && err.conflicts
        && Object.values(err.conflicts).flat().every((c) => c.rule === 'ios-slot');
      if (err instanceof BuildRequestError && !lostSlotRace) {
        notify({ title: 'Build Dropped', body: `${label(entry)} for ${ref(entry)}: ${err.message}` });
        return;
      }
      // Someone took the slot first, or GitHub couldn't be reached: nothing started, so keep its place in line.
      if (!lostSlotRace) console.error('Queued build failed to start, will try again:', err.message);
      entries.push(entry);
      persist();
    }
  }

  async function tickOnce() {
    for (const e of entries.filter((x) => now() - x.queuedAt >= EXPIRE_MS)) {
      remove(e.id);
      notify({ title: 'Build Expired', body: `${label(e)} build for ${ref(e)} expired` });
    }
    const retries = tracker.waitingRetries();
    if (!entries.length && !retries.length) return;
    const active = await tracker.activeSnapshot();
    for (const slotFile of Object.keys(IOS_SLOTS)) {
      const line = [
        ...retries.filter((b) => b.file === slotFile).map((b) => ({ at: b.waitingSince, run: () => tracker.resumeRetry(b) })),
        ...entries.filter((e) => BUILDS[e.key].file === slotFile).map((e) => ({ at: e.queuedAt, run: () => startEntry(e) })),
      ].sort((a, b) => a.at - b.at);
      if (!line.length || slotBusy({ file: slotFile, active, tracked: tracker.list(), now: now() })) continue;
      await line[0].run();
    }
  }

  // Ticks can overlap when GitHub is slow; one pass at a time so a slot never starts two builds.
  let inFlight = null;
  function tick() {
    inFlight ??= tickOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { add, cancel, tick, list: () => entries };
}

// ---------- routes ----------

export function routes(ctx) {
  ctx.queue ??= createQueue({
    tracker: ctx.tracker,
    file: ctx.queueFile === undefined ? path.join(DATA_DIR, 'build-queue.json') : ctx.queueFile,
    notify: ctx.notify ?? ((n) => { notify(n).catch((err) => console.error('Build notification failed:', err.message)); }),
  });
  return [
    ['GET', /^\/api\/build-queue$/, () => ({ entries: ctx.queue.list(), retries: ctx.tracker.waitingRetries() })],
    ['POST', /^\/api\/build-queue$/, async (m, req) => {
      const { prNumber, key } = (await ctx.readJson(req)) ?? {};
      if (!SLOT_KEYS.includes(key)) throw new BuildRequestError('Only iOS TestFlight builds can wait for a free slot.', 400);
      const pr = await getPr(ctx.gh, ctx.id(String(prNumber)));
      return ctx.queue.add({ prNumber: pr.number, key, branch: pr.headRefName });
    }],
    ['DELETE', /^\/api\/build-queue\/([\w-]{1,64})$/, (m) => {
      if (ctx.queue.cancel(m[1]) || ctx.tracker.cancelWait(m[1])) return { ok: true };
      throw new HttpError(404, 'That build isn\'t waiting anymore.');
    }],
  ];
}
