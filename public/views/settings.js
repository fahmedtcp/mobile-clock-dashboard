// Settings: each person's own connections and preferences, saved on their Mac by the server.
// Saved keys come back masked (last 4 only); typed keys live only in this page until Save.
import { api, put, post, el, glyph, icon, toast } from '../ui.js';

let root;
let ctx;
let view = null;       // masked settings from the server
let error = null;
let builds = [];       // [{ key, label }] for the 4 store builds
let openRow = null;    // which connection row is expanded
const drafts = {};     // row -> { field: typed value | null (remove) }
const results = {};    // row -> { ok, message } from Test Connection
const busy = new Set();
const helpOpen = new Set(); // rows whose ⓘ help is showing

// Step-by-step help behind each ⓘ. Plain text only; links are separate so they open in a new tab.
const HELP = {
  github: { steps: [
    'Install the GitHub CLI: in Terminal, run brew install gh.',
    'Run gh auth login, choose GitHub.com, then sign in with your browser.',
    'Make sure your account can see the tcp-software organization, then press Check Again.',
  ] },
  jira: { steps: [
    'Jira URL: the address you use for Jira, for example https://timeclockplus.atlassian.net.',
    'Email: the email you sign in to Jira with.',
    'API token: open the Atlassian link below, choose Create API token, name it (for example "Mobile dashboard"), and copy it. Atlassian shows it only once.',
    'Paste all three here, press Test Connection, then Save.',
  ], link: ['Atlassian API tokens', 'https://id.atlassian.com/manage-profile/security/api-tokens'] },
  tempo: { steps: [
    'Connect Jira first. Tempo finds your worklogs through your Jira account.',
    'In Jira, open Apps, then Tempo, then Settings (the gear).',
    'Under Data Access, choose API Integration, then New Token.',
    'Give it access to view and manage worklogs, create it, and copy the token. Tempo shows it only once.',
    'Paste it here, press Test Connection, then Save.',
  ] },
  teams: { steps: [
    'Review channel: in Teams, open the channel, choose ••• next to its name, then Workflows.',
    'Pick "Post to a channel when a webhook request is received," name it, and confirm the team and channel.',
    'Choose Add workflow, then copy the URL it shows. Paste it under Review channel webhook.',
    'Test chat (optional): open the Workflows app and pick "Send webhook alerts to a chat."',
    'Set Post as to Flow bot, Post in to Chat with Flow bot, and the recipient to yourself. A chat with only yourself doesn\'t work.',
    'Copy that URL and paste it under Test chat webhook. Request Review and Request QA Review can then send to you first.',
    'QA channel: repeat the first three steps in the QA channel and paste that URL under QA channel webhook.',
    'QA tag: the Teams tag to notify, for example MobileHardware_QA. Without its ID it shows as bold text.',
    'QA tag ID: in Teams, open ••• next to the team, choose Get link to team, and copy the groupId value. In Graph Explorer, run GET https://graph.microsoft.com/v1.0/teams/{groupId}/tags, and copy the id of the tag. Send a test first to check the @mention works.',
  ], link: ['Graph Explorer', 'https://developer.microsoft.com/graph/graph-explorer'] },
  workday: { steps: [
    'How many hours you log in Tempo on a normal workday.',
    'Suggestions always add up to this, minus any leave.',
    'Days you already saved keep the hours they were saved with, so changing this never rewrites the past.',
  ] },
  reminder: { steps: [
    'A Mac notification at this time on workdays you haven\'t confirmed.',
    'It only works while the dashboard is running.',
    'If nothing appears, open System Settings, then Notifications, and allow notifications for Script Editor.',
  ] },
  folder: { steps: [
    'The folder where you cloned tcp-software/mobile-clock.',
    'To find it, open Terminal, go to the clone with cd, and run pwd. Paste the path it prints.',
    'It\'s used for your commits in Time and for the TypeScript error count. The dashboard never changes your branch or files.',
  ] },
  always: { steps: [
    'GitHub logins to @mention on every review request, separated by commas.',
    'A login is the name in someone\'s GitHub profile address: github.com/login.',
  ] },
  never: { steps: [
    'GitHub logins to leave out, even when GitHub still lists them as reviewers.',
    'Use this for people who left the team or don\'t review.',
  ] },
  people: { steps: [
    'Teams needs an email to @mention someone. The dashboard finds it in Jira by name.',
    'If someone shows as "plain name" in Request Review, add a line like login=name@tcpsoftware.com.',
  ] },
  builds: { steps: [
    'The builds already checked when you open Build on an approved PR.',
    'You can still change them each time. The simulator build is never checked by default.',
  ] },
  notifications: { steps: [
    'Desktop alerts when a build you started finishes or fails, or when a status badge turns red.',
    'The first time, click anywhere on the dashboard and allow notifications when your browser asks.',
  ] },
};

function infoButton(id, title) {
  const open = helpOpen.has(id);
  return el('button', {
    type: 'button', class: 'info-btn', 'aria-expanded': String(open), 'aria-controls': `help-${id}`,
    'aria-label': `About ${title}`, title: `About ${title}`,
    onclick: () => { if (open) helpOpen.delete(id); else helpOpen.add(id); render(); },
  }, 'i');
}

function helpPanel(id) {
  if (!helpOpen.has(id)) return null;
  const h = HELP[id];
  return el('div', { class: 'help', id: `help-${id}`, role: 'note' },
    el('ol', {}, h.steps.map((t) => el('li', {}, t))),
    h.link && el('a', { href: h.link[1], target: '_blank', rel: 'noopener' }, h.link[0], ' ↗'));
}

export function applyTheme(theme) {
  const t = ['light', 'dark', 'system'].includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch { /* storage blocked */ }
}

async function load() {
  try {
    [view, builds] = await Promise.all([api('/api/settings'), api('/api/builds-config')]);
    builds = builds.filter((b) => b.key !== 'mcIosSim');
    error = null;
  } catch (err) { error = err; }
  render();
  if (!results.github) test('github');
}

async function save(patch, { row = null, quiet = false } = {}) {
  try {
    view = await put('/api/settings', patch);
    if (row) { delete drafts[row]; openRow = null; }
    ctx.settingsChanged(view);
    if (!quiet) toast('Saved');
    render();
    return true;
  } catch (err) {
    toast(err.message, 'bad');
    return false;
  }
}

async function test(row) {
  busy.add(row);
  render();
  const service = { github: 'github', jira: 'jira', tempo: 'tempo', teams: 'teams', teamsTest: 'teamsTest' }[row];
  try { results[row] = await post(`/api/settings/test/${service}`, cleanDraft(row)); }
  catch (err) { results[row] = { ok: false, message: err.message }; }
  busy.delete(row);
  render();
}

// Only typed fields go to the server; untouched ones fall back to what's saved.
const cleanDraft = (row) => Object.fromEntries(Object.entries(drafts[row] ?? {}).filter(([, v]) => v !== undefined && v !== ''));

// ---------- building blocks ----------

const pill = (ok, text) => el('span', { class: `chip ${ok ? 'green' : 'orange'}` }, text);
const fromEnv = (source) => (source === 'env' ? el('span', { class: 'chip gray' }, 'From .env') : null);

function rowShell(title, sub, look, trail, body = null, help = null) {
  return el('li', {},
    el('div', { class: 'row' }, glyph(look[0], look[1]),
      el('div', { class: 'row-body' }, el('div', { class: 'row-title' }, title, help && infoButton(help, title)), sub && el('div', { class: 'row-sub' }, sub)),
      el('div', { class: 'row-trail' }, ...[trail].flat().filter(Boolean))),
    help && helpPanel(help),
    body);
}

function textField(row, name, label, value, { type = 'text', placeholder = '' } = {}) {
  const input = el('input', { class: 'field', type, value: drafts[row]?.[name] ?? value ?? '', placeholder, autocomplete: 'off', spellcheck: 'false' });
  input.addEventListener('input', () => { (drafts[row] ??= {})[name] = input.value.trim(); });
  return el('label', { class: 'field-label' }, label, input);
}

// A key field: saved keys show as ••••last4 with Replace and Remove; typing replaces.
function secretField(row, name, label, info) {
  const replacing = drafts[row]?.[name] !== undefined && drafts[row][name] !== null;
  const removing = drafts[row]?.[name] === null;
  if (info?.set && !replacing) {
    return el('div', { class: 'field-label' }, label,
      el('div', { class: 'secret-row' },
        el('span', { class: 'secret-mask' }, removing ? 'Will be removed when you save' : `••••${info.last4}${info.host ? ` · ${info.host}` : ''}`),
        fromEnv(info.source),
        !removing && el('button', { type: 'button', class: 'btn btn-small', onclick: () => { (drafts[row] ??= {})[name] = ''; render(); } }, 'Replace'),
        info.source === 'settings' && !removing && el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: () => { (drafts[row] ??= {})[name] = null; render(); } }, 'Remove'),
        removing && el('button', { type: 'button', class: 'btn btn-small', onclick: () => { delete drafts[row][name]; render(); } }, 'Undo')));
  }
  return textField(row, name, label, '', { type: 'password', placeholder: name.toLowerCase().includes('url') ? 'https://…' : 'Paste here' });
}

function editor(row, section, fields) {
  const result = results[row];
  return el('div', { class: 'conn-edit' },
    ...fields,
    result && el('p', { class: `conn-result ${result.ok ? 'ok' : 'bad'}`, role: 'status' }, result.message),
    el('div', { class: 'sheet-actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => { delete drafts[row]; delete results[row]; openRow = null; render(); } }, 'Cancel'),
      el('button', { type: 'button', class: 'btn', disabled: busy.has(row), onclick: () => test(row) }, busy.has(row) ? 'Testing…' : 'Test Connection'),
      el('button', { type: 'button', class: 'btn btn-filled', onclick: () => {
        const patch = Object.fromEntries(Object.entries(drafts[row] ?? {}).filter(([, v]) => v !== undefined && v !== ''));
        if (!Object.keys(patch).length) { openRow = null; render(); return; }
        save({ [section]: patch }, { row });
      } }, 'Save')));
}

const editBtn = (row) => el('button', { type: 'button', class: 'btn btn-small', onclick: () => { openRow = openRow === row ? null : row; render(); } }, openRow === row ? 'Close' : 'Edit');

// ---------- sections ----------

function connections() {
  const v = view;
  const gh = results.github;
  const jiraSub = v.configured.jira ? `${v.jira.email} · token ••••${v.jira.token.last4}` : 'Not set up';
  const teamsSub = [v.teams.webhookUrl.set && 'Review channel', v.teams.qaWebhookUrl.set && 'QA channel', v.teams.testWebhookUrl.set && 'test chat'].filter(Boolean).join(' · ') || 'Not set up';
  return group('Connections', [
    rowShell('GitHub', gh ? gh.message : 'Checking…', ['branch', 'gray'],
      [gh && pill(gh.ok, gh.ok ? 'Connected' : 'Not Signed In'), el('button', { type: 'button', class: 'btn btn-small', disabled: busy.has('github'), onclick: () => test('github') }, 'Check Again')], null, 'github'),
    rowShell('Jira', jiraSub, ['ticket', 'blue'], [pill(v.configured.jira, v.configured.jira ? 'Set Up' : 'Add Token'), editBtn('jira')],
      openRow === 'jira' && editor('jira', 'jira', [
        textField('jira', 'baseUrl', 'Jira URL', v.jira.baseUrl, { placeholder: 'https://yourcompany.atlassian.net' }),
        textField('jira', 'email', 'Email', v.jira.email, { type: 'email', placeholder: 'you@tcpsoftware.com' }),
        secretField('jira', 'token', 'API token', v.jira.token),
      ]), 'jira'),
    rowShell('Tempo', v.configured.tempo ? `Token ••••${v.tempo.token.last4}` : 'Not set up', ['clock', 'indigo'], [pill(v.configured.tempo, v.configured.tempo ? 'Set Up' : 'Add Token'), editBtn('tempo')],
      openRow === 'tempo' && editor('tempo', 'tempo', [
        secretField('tempo', 'token', 'API token', v.tempo.token),
      ]), 'tempo'),
    rowShell('Teams', teamsSub, ['team', 'purple'], [pill(v.configured.teams, v.configured.teams ? 'Set Up' : 'Add Webhook'), editBtn('teams')],
      openRow === 'teams' && editor('teams', 'teams', [
        secretField('teams', 'webhookUrl', 'Review channel webhook', v.teams.webhookUrl),
        secretField('teams', 'qaWebhookUrl', 'QA channel webhook', v.teams.qaWebhookUrl),
        textField('teams', 'qaTagName', 'QA tag', v.teams.qaTagName, { placeholder: 'MobileHardware_QA' }),
        textField('teams', 'qaTagId', 'QA tag ID (optional, for a real @mention)', v.teams.qaTagId, { placeholder: 'Leave empty to show the tag as bold text' }),
        secretField('teams', 'testWebhookUrl', 'Test chat webhook', v.teams.testWebhookUrl),
      ]), 'teams'),
  ]);
}

function appearance() {
  const seg = el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Theme' }, [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']].map(([t, label]) =>
    el('button', { type: 'button', role: 'tab', 'aria-selected': String(view.theme === t), onclick: () => { applyTheme(t); view.theme = t; render(); save({ theme: t }, { quiet: true }); } }, label)));
  return group('Appearance', [rowShell('Theme', 'System follows your Mac', ['moon', 'indigo'], seg)]);
}

function timeTracking() {
  const t = view.time;
  const hours = el('select', { class: 'field compact', 'aria-label': 'Workday hours' },
    t.dayHours == null && el('option', { value: '' }, 'Not set'),
    Array.from({ length: 13 }, (_, i) => 4 + i * 0.5).map((h) => el('option', { value: String(h), selected: t.dayHours === h }, `${h}h`)));
  hours.addEventListener('change', () => hours.value && save({ time: { dayHours: Number(hours.value) } }));
  const on = el('input', { type: 'checkbox', role: 'switch', checked: t.reminderOn, 'aria-label': 'Evening reminder' });
  on.addEventListener('change', () => save({ time: { reminderOn: on.checked } }));
  const at = el('input', { class: 'field compact', type: 'time', value: t.reminderAt, disabled: !t.reminderOn, 'aria-label': 'Reminder time' });
  at.addEventListener('change', () => at.value && save({ time: { reminderAt: at.value } }));
  const folder = el('input', { class: 'field', type: 'text', value: t.mobileClockPath, spellcheck: 'false', 'aria-label': 'mobile-clock folder' });
  folder.addEventListener('change', () => save({ time: { mobileClockPath: folder.value.trim() } }));
  return group('Time Tracking', [
    rowShell('Workday', t.dayHours == null ? 'Set this to turn on time tracking' : 'Changes apply to days you haven\'t saved yet', ['calendar', 'green'], hours, null, 'workday'),
    rowShell('Evening Reminder', 'Only on workdays you haven\'t confirmed', ['clock', 'orange'], [at, el('label', { class: 'switch' }, on)], null, 'reminder'),
    rowShell('mobile-clock Folder', 'Your local clone, used for commits and the TypeScript count', ['branch', 'teal'], fromEnv(t.sources.mobileClockPath), el('div', { class: 'conn-edit' }, folder), 'folder'),
  ]);
}

function reviewRequests() {
  const t = view.teams;
  const list = (name, value, label) => {
    const input = el('input', { class: 'field', type: 'text', value: value.join(', '), placeholder: 'GitHub logins, separated by commas', spellcheck: 'false', 'aria-label': label });
    input.addEventListener('change', () => save({ teams: { [name]: input.value.split(',').map((x) => x.trim()).filter(Boolean) } }));
    return input;
  };
  const people = el('textarea', { class: 'field', rows: '3', spellcheck: 'false', placeholder: 'githublogin=name@tcpsoftware.com, one per line', 'aria-label': 'Email overrides' });
  people.value = Object.entries(t.people).map(([k, v]) => `${k}=${v}`).join('\n');
  people.addEventListener('change', () => {
    const map = Object.fromEntries(people.value.split('\n').map((l) => l.split('=').map((x) => x.trim())).filter(([k, v]) => k && v));
    save({ teams: { people: map } });
  });
  return group('Review Requests', [
    rowShell('Always Tag', 'Added to every review request', ['team', 'blue'], fromEnv(t.sources.always), el('div', { class: 'conn-edit' }, list('always', t.always, 'Always tag')), 'always'),
    rowShell('Never Tag', 'For people who left or don\'t review', ['x', 'red'], fromEnv(t.sources.never), el('div', { class: 'conn-edit' }, list('never', t.never, 'Never tag')), 'never'),
    rowShell('Email Overrides', 'For people whose Jira profile hides their email', ['team', 'gray'], fromEnv(t.sources.people), el('div', { class: 'conn-edit' }, people), 'people'),
  ]);
}

function buildsAndNotifications() {
  const checked = new Set(view.builds.defaultChecked);
  const boxes = el('div', { class: 'build-defaults' }, builds.map((b) => {
    const box = el('input', { type: 'checkbox', checked: checked.has(b.key) });
    box.addEventListener('change', () => {
      if (box.checked) checked.add(b.key); else checked.delete(b.key);
      save({ builds: { defaultChecked: builds.map((x) => x.key).filter((k) => checked.has(k)) } });
    });
    return el('label', { class: 'choice-inline' }, box, b.label);
  }));
  const notes = el('input', { type: 'checkbox', role: 'switch', checked: view.notifications, 'aria-label': 'Desktop notifications' });
  notes.addEventListener('change', () => save({ notifications: notes.checked }));
  return group('Builds and Notifications', [
    rowShell('Builds Checked by Default', 'In the Build sheet for approved PRs', ['hammer', 'orange'], null, el('div', { class: 'conn-edit' }, boxes), 'builds'),
    rowShell('Desktop Notifications', 'When a build you started finishes, or a status badge turns red', ['bolt', 'pink'], el('label', { class: 'switch' }, notes), null, 'notifications'),
  ]);
}

function group(title, rows) {
  const list = el('ul', { class: 'group' }, rows);
  list.style.setProperty('--inset', '56px');
  return el('section', { class: 'block' }, el('h3', { class: 'group-title' }, title), list);
}

function render() {
  if (!root) return;
  const head = el('div', { class: 'page-head' }, el('div', {},
    el('div', { class: 'page-title' }, 'Settings'),
    el('div', { class: 'page-sub' }, 'Saved on this Mac only. Keys go only to the service they belong to.')));
  if (error) { root.replaceChildren(head, el('div', { class: 'banner error' }, error.message)); return; }
  if (!view) { root.replaceChildren(head); return; }
  root.replaceChildren(head, connections(), appearance(), timeTracking(), reviewRequests(), buildsAndNotifications());
}

export default {
  id: 'settings',
  title: 'Settings',
  mount(container, appCtx) {
    ctx = appCtx;
    root = el('div', { class: 'view-inner settings' });
    container.append(root);
    load();
  },
  update() { /* settings load on mount and after each save */ },
};
