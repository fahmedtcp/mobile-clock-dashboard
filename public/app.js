import { $, api, post, el, icon, glyph, toast, startFreshnessTicker } from './ui.js';
import { diffNotifications, pollDelay } from './notify.js';
import home from './views/home.js';
import builds from './views/builds.js';
import release from './views/release.js';
import quality from './views/quality.js';
import team from './views/team.js';
import time from './views/time.js';
import settings, { applyTheme } from './views/settings.js';
import { openPalette } from './palette.js';
import { enablePullToRefresh } from './pull.js';
import { openTicketPanel } from './tickets-ui.js';
import { watch as watchLocalJob } from './local-jobs.js';

const VIEWS = [home, builds, release, quality, team, time];
// Settings sits at the bottom of the sidebar, outside the 1–5 shortcuts.
const ALL = [...VIEWS, settings];
const LOOK = {
  home: ['home', 'blue'], builds: ['hammer', 'indigo'], release: ['release', 'purple'], quality: ['quality', 'teal'], team: ['team', 'orange'],
  time: ['calendar', 'green'], settings: ['gear', 'gray'],
};
const badges = {}; // view id -> count shown on the nav item

// Shared data every view can read; refreshed by one polling loop.
const shared = {
  loadedAt: { prs: 0, builds: 0, overview: 0 },
  login: '', buildConfig: [], prs: [], prsLoaded: false, ticketError: null, builds: [], overview: null,
  badges: [],
};
const errors = { prs: null, overview: null };
const mounted = new Map();

let current = 'home';
try { current = localStorage.getItem('view') || 'home'; } catch { /* storage blocked */ }
if (location.hash.length > 1) current = location.hash.slice(1); // deep link: #release, #quality, #team
if (!ALL.some((v) => v.id === current)) current = 'home';

// ---- navigation ----

// A view's attention count, as a sidebar count or a tab bar badge (by class).
function attentionCount(id, className) {
  if (!badges[id]) return null;
  return el('span', { class: className, 'aria-label': `${badges[id]} need attention` }, String(badges[id]));
}

function navButton(view, className, ...children) {
  return el('button', {
    type: 'button', class: className, 'aria-current': view.id === current ? 'page' : null, onclick: () => show(view.id),
  }, icon(LOOK[view.id][0]), ...children);
}

function renderNav() {
  // macOS-style: plain accent icons, gray counts; the tab bar keeps iOS red badges.
  const sidebarItem = (view, extra = '') => navButton(view, `nav-item ${extra}`,
    el('span', { class: 'nav-label' }, view.title), attentionCount(view.id, 'nav-count'));
  $('nav').replaceChildren(...VIEWS.map((view) => sidebarItem(view)), sidebarItem(settings, 'nav-settings'));
  $('tabbar').replaceChildren(...ALL.map((view) =>
    navButton(view, 'tab-item', el('span', {}, view.title), attentionCount(view.id, 'nav-badge'))));
}

function lookupTicket(key) {
  show('home');
  const input = $('lookup-input');
  if (input) { input.value = key; input.form.requestSubmit(); }
}

function saveTheme(theme) {
  applyTheme(theme);
  api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme }) })
    .then((saved) => { shared.settings = saved; })
    .catch(() => {});
}

const palette = () => openPalette({
  views: ALL.map((v, i) => ({
    id: v.id, title: v.title, icon: LOOK[v.id][0], key: v.id === 'settings' ? ',' : String(i + 1),
  })),
  shared,
  go: show,
  lookup: lookupTicket,
  openTicket: (key) => openTicketPanel(key),
  addTodo: (text) => post('/api/home/todos', { text }).then(({ todo }) => {
    toast(todo.key ? `To-do added on ${todo.key}` : 'To-do added', 'ok');
    window.dispatchEvent(new Event('home:todos-changed'));
  }, (err) => toast(err.message, 'bad')),
  setTheme: saveTheme,
});
$('palette-btn').addEventListener('click', palette);

function mountView(view) {
  const container = el('div', { class: 'view', id: `view-${view.id}` });
  $('views').append(container);
  view.mount(container, ctx);
  mounted.set(view.id, container);
}

function setViewVisible(node, visible) {
  node.hidden = !visible;
  if (!visible) return;
  node.classList.remove('entering');
  void node.offsetWidth; // force a reflow so the entering animation restarts
  node.classList.add('entering');
}

function show(id) {
  current = id;
  try { localStorage.setItem('view', id); } catch { /* storage blocked */ }
  history.replaceState(null, '', `#${id}`);
  for (const view of ALL) {
    if (!mounted.has(view.id) && view.id === id) mountView(view);
    if (mounted.has(view.id)) setViewVisible(mounted.get(view.id), view.id === id);
  }
  renderNav();
  window.scrollTo({ top: 0 });
  ALL.find((v) => v.id === id).update?.(shared, errors);
}

// ---- status strip + Jira banner ----

function renderStatus() {
  $('status-strip').replaceChildren(...shared.badges.map((badge) =>
    el(badge.url ? 'a' : 'span', {
      class: 'status-pill', href: badge.url, target: '_blank', rel: 'noopener',
      title: badge.conclusion ? `Latest run: ${badge.conclusion}` : 'No completed run',
    }, el('span', { class: `dot ${badge.color}`, 'aria-hidden': 'true' }), badge.label)));
}

async function checkJira() {
  try {
    const status = await api('/api/jira/status');
    const banner = $('jira-banner');
    banner.hidden = status.ok;
    if (!status.ok) {
      const message = status.configured
        ? `Jira error: ${status.error} `
        : 'Connect Jira to see tickets, releases, and time. ';
      banner.replaceChildren(
        glyph('ticket', status.configured ? 'red' : 'blue', 'sm'),
        el('span', {}, message),
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => show('settings') }, 'Open Settings'));
    }
    shared.jiraOk = status.ok;
    shared.displayName = status.name ?? '';
  } catch { /* the status strip shows server reachability */ }
}

// ---- polling + notifications ----

let timer;
let inFlight = false;
let lastSnapshot = null;

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
}

function notify(items) {
  const allowed = 'Notification' in window && Notification.permission === 'granted';
  if (!allowed || shared.settings?.notifications === false) return;
  for (const item of items) {
    const note = new Notification(item.title, { body: item.body });
    if (item.url) note.onclick = () => window.open(item.url, '_blank', 'noopener');
  }
}

async function loadIdentityOnce() {
  if (shared.login && shared.buildConfig.length) return;
  [{ login: shared.login }, shared.buildConfig] = await Promise.all([api('/api/me'), api('/api/builds-config')]);
}

const fetchPollData = () => Promise.allSettled([
  api('/api/prs'),
  api('/api/builds'),
  api('/api/builds/overview'),
  api('/api/status'),
  api('/api/time/pending'),
]);

function applyPollResults([prs, builds, overview, statusBadges, pending]) {
  errors.prs = prs.status === 'rejected' ? prs.reason : builds.status === 'rejected' ? builds.reason : null;
  errors.overview = overview.status === 'rejected' ? overview.reason : null;
  const now = Date.now(); // freshness: when each part of the poll last succeeded
  if (prs.status === 'fulfilled') shared.loadedAt.prs = now;
  if (builds.status === 'fulfilled') shared.loadedAt.builds = now;
  if (overview.status === 'fulfilled') shared.loadedAt.overview = now;
  if (prs.status === 'fulfilled') {
    Object.assign(shared, { prs: prs.value.prs, ticketError: prs.value.ticketError, prsLoaded: true });
  }
  if (builds.status === 'fulfilled') shared.builds = builds.value;
  if (overview.status === 'fulfilled') {
    shared.overview = overview.value;
    ctx.setBadge('builds', overview.value.running.filter((r) => r.mine).length + overview.value.waiting.length);
  }
  if (statusBadges.status === 'fulfilled') shared.badges = statusBadges.value;
  if (pending.status === 'fulfilled') { shared.timePending = pending.value; ctx.setBadge('time', pending.value.count); }
}

function notifyChanges() {
  const snapshot = { builds: shared.builds.map((b) => ({ ...b })), badges: shared.badges };
  notify(diffNotifications(lastSnapshot, snapshot));
  lastSnapshot = snapshot;
}

async function tick() {
  if (inFlight) return schedule(1000);
  inFlight = true;
  try {
    await loadIdentityOnce();
  } catch (err) {
    errors.prs = err;
  }
  const results = await fetchPollData();
  inFlight = false;

  try {
    applyPollResults(results);
    renderStatus();
    ALL.find((v) => v.id === current)?.update?.(shared, errors);
    notifyChanges();
  } finally {
    schedule(pollDelay(shared.builds, shared.overview?.running ?? [])); // a render error must never stop polling
  }
}

const ctx = {
  shared,
  setBadge(id, count) { if (badges[id] !== count) { badges[id] = count; renderNav(); } },
  go: (id) => show(id),
  refresh: () => schedule(0),
  // After a Settings save: new keys or defaults may change what every view shows.
  async settingsChanged(saved) {
    shared.settings = saved;
    shared.settingsVersion = (shared.settingsVersion ?? 0) + 1; // views that depend on settings reload on next show
    shared.buildConfig = [];
    await checkJira();
    schedule(0);
  },
};

// Keyboard: ⌘K opens the palette, 1–5 switch views, / jumps to the build lookup, t opens Time, "," opens Settings.
// Ignored while typing or with a sheet open.
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  const viewNumber = Number(e.key);
  if (viewNumber >= 1 && viewNumber <= VIEWS.length) { e.preventDefault(); show(VIEWS[viewNumber - 1].id); }
  if (e.key === '/') { e.preventDefault(); show('home'); $('home-more')?.setAttribute('open', ''); $('lookup-input')?.focus(); }
  if (e.key === 't') { e.preventDefault(); show('time'); }
  if (e.key === ',') { e.preventDefault(); show('settings'); }
});

document.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}, { once: true });

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id !== current && ALL.some((v) => v.id === id)) show(id);
});
// The server's saved theme wins over the copy in localStorage (for example after clearing site data).
api('/api/settings')
  .then((saved) => { shared.settings = saved; applyTheme(saved.theme); })
  .catch(() => { /* keep the local theme */ });
startFreshnessTicker();
watchLocalJob(); // a Run Tests / Update job still running shows its bar again after a reload
renderNav();
show(current);
checkJira();
tick();
enablePullToRefresh({
  content: $('views'),
  indicatorParent: $('main'),
  onRefresh: async () => {
    schedule(0);
    await ALL.find((v) => v.id === current)?.refresh?.();
  },
});
