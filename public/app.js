import { $, api, el, icon, glyph } from './ui.js';
import { diffNotifications, pollDelay } from './notify.js';
import home from './views/home.js';
import release from './views/release.js';
import quality from './views/quality.js';
import team from './views/team.js';
import time from './views/time.js';
import settings, { applyTheme } from './views/settings.js';

const VIEWS = [home, release, quality, team, time];
// Settings sits at the bottom of the sidebar, outside the 1–5 shortcuts.
const ALL = [...VIEWS, settings];
const LOOK = { home: ['home', 'blue'], release: ['release', 'purple'], quality: ['quality', 'teal'], team: ['team', 'orange'], time: ['calendar', 'green'], settings: ['gear', 'gray'] };
const badges = {}; // view id -> count shown on the nav item

// Shared data every view can read; refreshed by one polling loop.
const shared = { login: '', buildConfig: [], prs: [], prsLoaded: false, ticketError: null, builds: [], runs: [], runsLoaded: false, badges: [], runsQuery: '' };
const errors = { prs: null, runs: null };
const mounted = new Map();

let current = 'home';
try { current = localStorage.getItem('view') || 'home'; } catch { /* storage blocked */ }
if (location.hash.length > 1) current = location.hash.slice(1); // deep link: #release, #quality, #team
if (!ALL.some((v) => v.id === current)) current = 'home';

// ---- navigation ----

function renderNav() {
  const badge = (id) => (badges[id] ? el('span', { class: 'nav-badge', 'aria-label': `${badges[id]} need attention` }, String(badges[id])) : null);
  $('nav').replaceChildren(
    ...VIEWS.map((v, i) => el('button', { type: 'button', class: 'nav-item', 'aria-current': v.id === current ? 'page' : null, onclick: () => show(v.id) },
      glyph(LOOK[v.id][0], LOOK[v.id][1]), el('span', { class: 'nav-label' }, v.title), badge(v.id) ?? el('kbd', {}, String(i + 1)))),
    el('button', { type: 'button', class: 'nav-item nav-settings', 'aria-current': current === 'settings' ? 'page' : null, onclick: () => show('settings') },
      glyph('gear', 'gray'), el('span', { class: 'nav-label' }, 'Settings'), el('kbd', {}, ',')),
    el('div', { class: 'sidebar-foot' }, el('span', { class: 'kbd-hint' }, el('kbd', {}, '1'), '–', el('kbd', {}, String(VIEWS.length)), ' switch views'), el('span', { class: 'kbd-hint' }, el('kbd', {}, '/'), ' find a build'), el('span', { class: 'kbd-hint' }, el('kbd', {}, 't'), ' confirm hours')));
  $('tabbar').replaceChildren(...ALL.map((v) => el('button', { type: 'button', class: 'tab-item', 'aria-current': v.id === current ? 'page' : null, onclick: () => show(v.id) },
    icon(LOOK[v.id][0]), el('span', {}, v.title), badge(v.id))));
}

function show(id) {
  current = id;
  try { localStorage.setItem('view', id); } catch { /* storage blocked */ }
  history.replaceState(null, '', `#${id}`);
  for (const v of ALL) {
    if (!mounted.has(v.id) && v.id === id) {
      const container = el('div', { class: 'view', id: `view-${v.id}` });
      $('views').append(container);
      v.mount(container, ctx);
      mounted.set(v.id, container);
    }
    if (mounted.has(v.id)) {
      const node = mounted.get(v.id);
      node.hidden = v.id !== id;
      if (v.id === id) { node.classList.remove('entering'); void node.offsetWidth; node.classList.add('entering'); }
    }
  }
  renderNav();
  window.scrollTo({ top: 0 });
  ALL.find((v) => v.id === id).update?.(shared, errors);
}

// ---- status strip + Jira banner ----

function renderStatus() {
  $('status-strip').replaceChildren(...shared.badges.map((b) =>
    el(b.url ? 'a' : 'span', {
      class: 'status-pill', href: b.url, target: '_blank', rel: 'noopener',
      title: b.conclusion ? `Latest run: ${b.conclusion}` : 'No completed run',
    }, el('span', { class: `dot ${b.color}`, 'aria-hidden': 'true' }), b.label)));
}

async function checkJira() {
  try {
    const s = await api('/api/jira/status');
    const banner = $('jira-banner');
    banner.hidden = s.ok;
    if (!s.ok) {
      banner.replaceChildren(glyph('ticket', s.configured ? 'red' : 'blue', 'sm'), el('span', {}, s.configured ? `Jira error: ${s.error} ` : 'Connect Jira to see tickets, releases, and time. '),
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => show('settings') }, 'Open Settings'));
    }
    shared.jiraOk = s.ok;
    shared.displayName = s.name ?? '';
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
  if (!('Notification' in window) || Notification.permission !== 'granted' || shared.settings?.notifications === false) return;
  for (const n of items) {
    const note = new Notification(n.title, { body: n.body });
    if (n.url) note.onclick = () => window.open(n.url, '_blank', 'noopener');
  }
}

async function tick() {
  if (inFlight) return schedule(1000);
  inFlight = true;
  try {
    if (!shared.login || !shared.buildConfig.length) {
      [{ login: shared.login }, shared.buildConfig] = await Promise.all([api('/api/me'), api('/api/builds-config')]);
    }
  } catch (err) {
    errors.prs = err;
  }
  const [prs, builds, runs, badges, pending] = await Promise.allSettled([
    api('/api/prs'), api('/api/builds'), api(`/api/runs?${shared.runsQuery}`), api('/api/status'), api('/api/time/pending'),
  ]);
  inFlight = false;

  try {
    errors.prs = prs.status === 'rejected' ? prs.reason : builds.status === 'rejected' ? builds.reason : null;
    errors.runs = runs.status === 'rejected' ? runs.reason : null;
    if (prs.status === 'fulfilled') Object.assign(shared, { prs: prs.value.prs, ticketError: prs.value.ticketError, prsLoaded: true });
    if (builds.status === 'fulfilled') shared.builds = builds.value;
    if (runs.status === 'fulfilled') Object.assign(shared, { runs: runs.value, runsLoaded: true });
    if (badges.status === 'fulfilled') shared.badges = badges.value;
    if (pending.status === 'fulfilled') { shared.timePending = pending.value; ctx.setBadge('time', pending.value.count); }

    renderStatus();
    ALL.find((v) => v.id === current)?.update?.(shared, errors);

    const snapshot = { builds: shared.builds.map((b) => ({ ...b })), badges: shared.badges };
    notify(diffNotifications(lastSnapshot, snapshot));
    lastSnapshot = snapshot;
  } finally {
    schedule(pollDelay(shared.builds, shared.runs)); // a render error must never stop polling
  }
}

const ctx = {
  shared,
  setBadge(id, n) { if (badges[id] !== n) { badges[id] = n; renderNav(); } },
  go: (id) => show(id),
  refresh: () => schedule(0),
  setRunsQuery(q) { shared.runsQuery = q; schedule(0); },
  // After a Settings save: new keys or defaults may change what every view shows.
  async settingsChanged(v) {
    shared.settings = v;
    shared.settingsVersion = (shared.settingsVersion ?? 0) + 1; // views that depend on settings reload on next show
    shared.buildConfig = [];
    await checkJira();
    schedule(0);
  },
};

// Keyboard: 1–4 switch views, / jumps to the build lookup. Ignored while typing or with a sheet open.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  const n = Number(e.key);
  if (n >= 1 && n <= VIEWS.length) { e.preventDefault(); show(VIEWS[n - 1].id); }
  if (e.key === '/') { e.preventDefault(); show('home'); $('lookup-input')?.focus(); }
  if (e.key === 't') { e.preventDefault(); show('time'); }
  if (e.key === ',') { e.preventDefault(); show('settings'); }
});

document.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}, { once: true });

window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id !== current && ALL.some((v) => v.id === id)) show(id); });
// The server's saved theme wins over the copy in localStorage (for example after clearing site data).
api('/api/settings').then((v) => { shared.settings = v; applyTheme(v.theme); }).catch(() => { /* keep the local theme */ });
renderNav();
show(current);
checkJira();
tick();
