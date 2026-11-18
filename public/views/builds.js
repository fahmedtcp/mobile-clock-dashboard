// Builds: whether an iOS build can start right now, what's waiting and running, and your build history.
import {
  $, api, post, el, ext, ago, sep, statusChip, showError, confirmSheet, toast, section, glyph, skeleton, empty, sectionFreshness,
} from '../ui.js';
import { openBuildSheet, createBug, installOnSim, segmented, bindContext } from './home.js';

const POLL_MS = 60000;
const FILTER_KEY = 'builds.filter';
const KEY_OF = { 'run-mc-ios.yml': 'mcIos', 'run-mk-ios.yml': 'mkIos', 'run-mc-android.yml': 'mcAndroid', 'run-mk-android.yml': 'mkAndroid' };
const FILTERS = {
  all: () => true,
  ios: (r) => r.file.includes('-ios'),
  android: (r) => r.file.includes('-android'),
  failed: (r) => r.conclusion !== 'success',
};

let ctx;
let container;
let filter = readFilter();
let wasBusy = new Map(); // slot file -> busy on the last update, for the "is free" toast

function readFilter() {
  try { return FILTERS[localStorage.getItem(FILTER_KEY)] ? localStorage.getItem(FILTER_KEY) : 'all'; } catch { return 'all'; }
}

const isShown = () => container && !container.hidden;
const smallButton = (onclick, label, extra = '') => el('button', { class: `btn btn-small ${extra}`, type: 'button', onclick }, label);
const linkButton = (href, label) => ext(href, el('span', { class: 'btn btn-small' }, label));
const ticket = (key, branch) => (key
  ? el('button', { type: 'button', class: 'chip-button', 'data-ticket-key': key }, el('span', { class: 'chip' }, key))
  : el('span', { class: 'mono' }, branch));
const minutes = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const sinceMs = (iso) => Date.now() - Date.parse(iso);
// A live elapsed time: the one-second ticker repaints every [data-since] node in place.
const elapsed = (iso) => el('span', { class: 'num', 'data-since': iso }, minutes(sinceMs(iso)));

// ---------- iOS slots ----------

function slotTrack(slot) {
  if (!slot.medianMs) return null;
  return el('div', { class: 'slot-progress' },
    el('div', { class: 'slot-track', 'aria-hidden': 'true' }, el('span', { 'data-track': slot.busy.startedAt, 'data-median': slot.medianMs })),
    el('span', { class: 'slot-left', 'data-left': slot.busy.startedAt, 'data-median': slot.medianMs }));
}

function slotRow(slot) {
  const { busy } = slot;
  const waiting = slot.waiting ? el('span', { class: 'slot-waiting' }, `${slot.waiting} waiting (yours)`) : null;
  return el('div', { class: `slot ${busy ? 'busy' : 'free'}` },
    el('div', { class: 'slot-top' },
      el('span', { class: 'slot-name' }, slot.label),
      el('span', { class: 'slot-state' }, el('span', { class: 'slot-dot', 'aria-hidden': 'true' }), busy ? 'Busy' : 'Free')),
    busy
      ? el('div', { class: 'slot-sub' }, ticket(busy.ticketKey, busy.branch), sep(),
        el('span', {}, busy.actor ?? 'Just started'), busy.startedAt && sep(), busy.startedAt && elapsed(busy.startedAt),
        waiting && sep(), waiting)
      : el('div', { class: 'slot-sub' }, el('span', { class: 'muted' }, 'You can start a build now.'), waiting && sep(), waiting),
    busy?.startedAt ? slotTrack(slot) : null);
}

// ---------- rows ----------

function cancelWaiting(item) {
  return confirmSheet({
    title: item.kind === 'retry' ? 'Stop Waiting to Retry' : 'Remove From Queue',
    body: [el('p', {}, `${item.label} for ${item.ticketKey ?? item.branch}`)],
    confirmLabel: item.kind === 'retry' ? 'Stop Retry' : 'Remove',
    danger: true,
    onConfirm: () => api(`/api/build-queue/${encodeURIComponent(item.id)}`, { method: 'DELETE' }),
  }).then((ok) => ok && ctx.refresh());
}

function waitingRow(item) {
  return el('li', {}, el('div', { class: 'row' },
    glyph('clock', 'orange'),
    el('div', { class: 'row-body' },
      el('div', { class: 'row-title' }, item.label),
      el('div', { class: 'row-sub' }, ticket(item.ticketKey, item.branch), sep(),
        el('span', {}, item.kind === 'retry' ? 'Waiting for iOS slot to retry' : `Queued ${ago(new Date(item.since).toISOString())}`))),
    el('div', { class: 'row-trail' }, smallButton(() => cancelWaiting(item), 'Cancel'))));
}

function cancelRun(run) {
  return confirmSheet({
    title: 'Cancel Build',
    body: [el('p', {}, `${run.label} on `, el('span', { class: 'mono' }, run.branch))],
    confirmLabel: 'Cancel Build',
    danger: true,
    onConfirm: () => post(`/api/runs/${run.runId}/cancel`),
  }).then((ok) => ok && ctx.refresh());
}

function runningRow(run) {
  const ios = run.file.includes('-ios');
  return el('li', {}, el('div', { class: 'row' },
    glyph(ios ? 'phone' : 'hammer', ios ? 'gray' : 'green'),
    el('div', { class: 'row-body' },
      el('div', { class: 'row-title' }, run.label),
      el('div', { class: 'row-sub' }, ticket(run.ticketKey, run.branch), sep(),
        el('span', {}, run.mine ? 'You' : run.actor), sep(), elapsed(run.startedAt ?? run.createdAt))),
    el('div', { class: 'row-trail' },
      statusChip(run), linkButton(run.url, 'Open'),
      run.mine && smallButton(() => cancelRun(run), 'Cancel', 'btn-danger'))),
  el('div', { class: 'progress-line', 'aria-hidden': 'true' }));
}

function rerun(run) {
  post(`/api/runs/${run.runId}/rerun`).then(() => { toast('Rerun started', 'ok'); ctx.refresh(); }, (err) => toast(err.message, 'bad'));
}

function buildAgain(run) {
  const pr = ctx.shared.prs.find((p) => p.headRefName === run.branch);
  return pr && smallButton(() => openBuildSheet(pr, [run.build?.key ?? KEY_OF[run.file]]), 'Build Again');
}

function historyRow(run) {
  const ios = run.file.includes('-ios');
  const { build } = run;
  const failed = run.conclusion !== 'success';
  const color = build?.classification?.kind === 'code' ? 'red' : build?.classification?.kind === 'infra' ? 'orange' : '';
  return el('li', {},
    el('div', { class: 'row' },
      glyph(ios ? 'phone' : 'hammer', ios ? 'gray' : 'green'),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, run.label),
        el('div', { class: 'row-sub' }, ticket(run.ticketKey, run.branch), run.ticketKey && sep(),
          run.ticketKey && el('span', { class: 'mono', title: run.branch }, run.branch), sep(),
          el('span', { class: 'num' }, minutes(run.durationMs)), sep(), el('span', {}, ago(run.createdAt)),
          build?.retries ? [sep(), el('span', {}, `${build.retries} auto-${build.retries === 1 ? 'retry' : 'retries'}`)] : null)),
      el('div', { class: 'row-trail' },
        build?.classification && failed && el('span', { class: `chip ${color}` }, build.classification.label),
        statusChip(run),
        linkButton(run.url, 'Open'),
        failed && run.conclusion !== 'cancelled' && smallButton(() => rerun(run), 'Rerun Failed'),
        failed && build && smallButton(() => createBug(build), 'Create Bug'),
        !failed && build?.key === 'mcIosSim' && smallButton(() => installOnSim(build), 'Install on Simulator'),
        buildAgain(run))),
    failed && build?.reason && el('details', { class: 'reason' },
      el('summary', {}, build.reason.step),
      build.reason.lines?.length ? el('pre', {}, build.reason.lines.join('\n')) : null));
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function historyItems(history) {
  const shown = history.filter(FILTERS[filter]);
  if (!shown.length) {
    return [empty('hammer', filter === 'all' ? 'No builds in the last 14 days.' : 'Nothing matches this filter.', '', 'gray')];
  }
  const out = [];
  let last = null;
  for (const run of shown) {
    const label = dayLabel(run.createdAt);
    if (label !== last) { out.push(el('li', { class: 'day-label' }, label)); last = label; }
    out.push(historyRow(run));
  }
  return out;
}

// ---------- render ----------

function weekLine(week) {
  const parts = [`${week.count} ${week.count === 1 ? 'build' : 'builds'}`, `${week.passed} passed`,
    `${week.retriesSaved} ${week.retriesSaved === 1 ? 'retry' : 'retries'} saved`];
  if (week.iosMedianMs) parts.push(`iOS median ${minutes(week.iosMedianMs)}`);
  return `This Week: ${parts.join(' · ')}`;
}

function announceFreedSlots(slots) {
  for (const slot of slots) {
    if (wasBusy.get(slot.file) && !slot.busy && isShown()) toast(`${slot.label} is free`, 'ok');
  }
  wasBusy = new Map(slots.map((s) => [s.file, Boolean(s.busy)]));
}

function render(shared, errors = {}) {
  const o = shared.overview;
  showError($('build-running-error'), errors.overview);
  if (!o) {
    $('builds-slots').replaceChildren(...skeleton(2));
    $('build-running').replaceChildren(...skeleton(2));
    $('build-history').replaceChildren(...skeleton(4));
    return;
  }
  announceFreedSlots(o.slots);
  $('builds-slots').replaceChildren(el('h3', { class: 'slot-heading' }, 'iOS Slots'), ...o.slots.map(slotRow));
  $('build-waiting-section').hidden = !o.waiting.length;
  $('build-waiting').replaceChildren(...o.waiting.map(waitingRow));
  $('build-running').replaceChildren(...(o.running.length ? o.running.map(runningRow) : [empty('check', 'No builds running.', '', 'gray')]));
  $('build-history').replaceChildren(...historyItems(o.history));
  $('builds-week').textContent = weekLine(o.week);
  sectionFreshness('build-running', { at: shared.loadedAt.overview, intervalMs: POLL_MS, error: errors.overview, onRefresh: ctx.refresh });
  tick();
}

// Elapsed times, progress tracks, and "time left" move every second without waiting for the next poll.
function tick() {
  if (!isShown()) return;
  for (const node of container.querySelectorAll('[data-since]')) node.textContent = minutes(sinceMs(node.dataset.since));
  for (const node of container.querySelectorAll('[data-track]')) {
    node.style.transform = `scaleX(${Math.min(1, sinceMs(node.dataset.track) / Number(node.dataset.median))})`;
  }
  for (const node of container.querySelectorAll('[data-left]')) {
    const left = Number(node.dataset.median) - sinceMs(node.dataset.left);
    node.textContent = left > 0 ? `~${Math.max(1, Math.round(left / 60000))} min left` : 'Running long';
  }
}

export default {
  id: 'builds',
  title: 'Builds',
  mount(node, appCtx) {
    ctx = appCtx;
    container = node;
    bindContext(appCtx); // the build sheet and bug actions live in home.js, which may not be mounted yet
    const filterControl = segmented('History filter', [['all', 'All'], ['ios', 'iOS'], ['android', 'Android'], ['failed', 'Failed']], filter, (value) => {
      filter = value;
      try { localStorage.setItem(FILTER_KEY, value); } catch { /* storage blocked */ }
      $('build-history').replaceChildren(...historyItems(ctx.shared.overview?.history ?? []));
    });
    node.append(
      el('div', { id: 'builds-slots', class: 'slot-card', role: 'status', 'aria-live': 'polite' }),
      section('build-waiting', 'Waiting to Start', ['clock', 'orange']),
      section('build-running', 'Running Now', ['bolt', 'orange']),
      section('build-history', 'Your History', ['hammer', 'indigo'], filterControl),
      el('p', { id: 'builds-week', class: 'footnote builds-week' }));
    $('build-waiting-section').hidden = true;
    render(ctx.shared, ctx.errors);
    setInterval(tick, 1000);
  },
  refresh: () => ctx.refresh(),
  update(shared, errors) { render(shared, errors); },
};
