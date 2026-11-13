// Settings: each person's own connections and preferences, saved on their Mac by the server.
// Saved keys come back masked (last 4 only); typed keys live only in this page until Save.
import { api, put, post, el, glyph, toast } from '../ui.js';

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

// Rows that have a Test Connection endpoint, by the service name the server expects.
const TEST_SERVICES = { github: 'github', jira: 'jira', tempo: 'tempo', teams: 'teams', teamsTest: 'teamsTest' };

// Step-by-step help behind each ⓘ. Plain text only; links are separate so they open in a new tab.
const HELP = {
  github: {
    steps: [
      'Install the GitHub CLI: in Terminal, run brew install gh.',
      'Run gh auth login, choose GitHub.com, then sign in with your browser.',
      'Make sure your account can see the tcp-software organization, then press Check Again.',
    ],
  },
  jira: {
    steps: [
      'Jira URL: the address you use for Jira, for example https://timeclockplus.atlassian.net.',
      'Email: the email you sign in to Jira with.',
      'API token: open the Atlassian link below, choose Create API token, name it (for example "Mobile dashboard"), '
        + 'and copy it. Atlassian shows it only once.',
      'Paste all three here, press Test Connection, then Save.',
    ],
    link: ['Atlassian API tokens', 'https://id.atlassian.com/manage-profile/security/api-tokens'],
  },
  tempo: {
    steps: [
      'Connect Jira first. Tempo finds your worklogs through your Jira account.',
      'In Jira, open Apps, then Tempo, then Settings (the gear).',
      'Under Data Access, choose API Integration, then New Token.',
      'Give it access to view and manage worklogs, create it, and copy the token. Tempo shows it only once.',
      'Paste it here, press Test Connection, then Save.',
    ],
  },
  teams: {
    steps: [
      'Review channel: in Teams, open the channel, choose ••• next to its name, then Workflows.',
      'Pick "Post to a channel when a webhook request is received," name it, and confirm the team and channel.',
      'Choose Add workflow, then copy the URL it shows. Paste it under Review channel webhook.',
      'Test chat (optional): open the Workflows app and pick "Send webhook alerts to a chat."',
      'Set Post as to Flow bot, Post in to Chat with Flow bot, and the recipient to yourself. '
        + 'A chat with only yourself doesn\'t work.',
      'Copy that URL and paste it under Test chat webhook. '
        + 'Request Review and Request QA Review can then send to you first.',
      'QA channel: repeat the first three steps in the QA channel and paste that URL under QA channel webhook.',
      'QA tag: the Teams tag to notify, for example MobileHardware_QA. Without its ID it shows as bold text.',
      'QA tag ID: in Teams, open ••• next to the team, choose Get link to team, and copy the groupId value. '
        + 'In Graph Explorer, run GET https://graph.microsoft.com/v1.0/teams/{groupId}/tags, '
        + 'and copy the id of the tag. '
        + 'Send a test first to check the @mention works.',
    ],
    link: ['Graph Explorer', 'https://developer.microsoft.com/graph/graph-explorer'],
  },
  workday: {
    steps: [
      'How many hours you log in Tempo on a normal workday.',
      'Suggestions always add up to this, minus any leave.',
      'Days you already saved keep the hours they were saved with, so changing this never rewrites the past.',
    ],
  },
  reminder: {
    steps: [
      'A Mac notification at this time on workdays you haven\'t confirmed.',
      'It only works while the dashboard is running.',
      'If nothing appears, open System Settings, then Notifications, and allow notifications for Script Editor.',
    ],
  },
  folder: {
    steps: [
      'The folder where you cloned tcp-software/mobile-clock.',
      'To find it, open Terminal, go to the clone with cd, and run pwd. Paste the path it prints.',
      'It\'s used for your commits in Time and for the TypeScript error count. '
        + 'The dashboard never changes your branch or files.',
    ],
  },
  always: {
    steps: [
      'GitHub logins to @mention on every review request, separated by commas.',
      'A login is the name in someone\'s GitHub profile address: github.com/login.',
    ],
  },
  never: {
    steps: [
      'GitHub logins to leave out, even when GitHub still lists them as reviewers.',
      'Use this for people who left the team or don\'t review.',
    ],
  },
  people: {
    steps: [
      'Teams needs an email to @mention someone. The dashboard finds it in Jira by name.',
      'If someone shows as "plain name" in Request Review, add a line like login=name@tcpsoftware.com.',
    ],
  },
  builds: {
    steps: [
      'The builds already checked when you open Build on an approved PR.',
      'You can still change them each time. The simulator build is never checked by default.',
    ],
  },
  notifications: {
    steps: [
      'Desktop alerts when a build you started finishes or fails, or when a status badge turns red.',
      'The first time, click anywhere on the dashboard and allow notifications when your browser asks.',
    ],
  },
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
  const help = HELP[id];
  return el('div', { class: 'help', id: `help-${id}`, role: 'note' },
    el('ol', {}, help.steps.map((step) => el('li', {}, step))),
    help.link && el('a', { href: help.link[1], target: '_blank', rel: 'noopener' }, help.link[0], ' ↗'));
}

export function applyTheme(theme) {
  const valid = ['light', 'dark', 'system'].includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = valid;
  try { localStorage.setItem('theme', valid); } catch { /* storage blocked */ }
}

async function load() {
  try {
    [view, builds] = await Promise.all([api('/api/settings'), api('/api/builds-config')]);
    builds = builds.filter((b) => b.key !== 'mcIosSim');
    error = null;
  } catch (err) { error = err; }
  render();
  if (!results.github) testConnection('github');
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

async function testConnection(row) {
  busy.add(row);
  render();
  try { results[row] = await post(`/api/settings/test/${TEST_SERVICES[row]}`, cleanDraft(row)); }
  catch (err) { results[row] = { ok: false, message: err.message }; }
  busy.delete(row);
  render();
}

// Only typed fields go to the server; untouched ones fall back to what's saved.
const cleanDraft = (row) =>
  Object.fromEntries(Object.entries(drafts[row] ?? {}).filter(([, v]) => v !== undefined && v !== ''));

const setDraft = (row, name, value) => { (drafts[row] ??= {})[name] = value; };

function saveDraft(row, section) {
  const patch = cleanDraft(row);
  if (!Object.keys(patch).length) { openRow = null; render(); return; }
  save({ [section]: patch }, { row });
}

function closeEditor(row) {
  delete drafts[row];
  delete results[row];
  openRow = null;
  render();
}

// ---------- building blocks ----------

const pill = (ok, text) => el('span', { class: `chip ${ok ? 'green' : 'orange'}` }, text);
const fromEnv = (source) => (source === 'env' ? el('span', { class: 'chip gray' }, 'From .env') : null);
const smallButton = (label, onclick, extraClass = '') =>
  el('button', { type: 'button', class: `btn btn-small${extraClass}`, onclick }, label);

function rowShell({ title, sub, look, trail, body = null, help = null }) {
  return el('li', {},
    el('div', { class: 'row' }, glyph(look[0], look[1]),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, title, help && infoButton(help, title)),
        sub && el('div', { class: 'row-sub' }, sub)),
      el('div', { class: 'row-trail' }, ...[trail].flat().filter(Boolean))),
    help && helpPanel(help),
    body);
}

function textField(row, name, { label, value, type = 'text', placeholder = '' }) {
  const input = el('input', {
    class: 'field', type, value: drafts[row]?.[name] ?? value ?? '', placeholder,
    autocomplete: 'off', spellcheck: 'false',
  });
  input.addEventListener('input', () => setDraft(row, name, input.value.trim()));
  return el('label', { class: 'field-label' }, label, input);
}

// A key field: saved keys show as ••••last4 with Replace and Remove; typing replaces.
function secretField(row, name, { label, saved }) {
  const replacing = drafts[row]?.[name] !== undefined && drafts[row][name] !== null;
  if (saved?.set && !replacing) return savedSecret(row, name, { label, saved });
  const placeholder = name.toLowerCase().includes('url') ? 'https://…' : 'Paste here';
  return textField(row, name, { label, value: '', type: 'password', placeholder });
}

function savedSecret(row, name, { label, saved }) {
  const removing = drafts[row]?.[name] === null;
  const hostNote = saved.host ? ` · ${saved.host}` : '';
  const mask = removing ? 'Will be removed when you save' : `••••${saved.last4}${hostNote}`;
  return el('div', { class: 'field-label' }, label,
    el('div', { class: 'secret-row' },
      el('span', { class: 'secret-mask' }, mask),
      fromEnv(saved.source),
      !removing && smallButton('Replace', () => { setDraft(row, name, ''); render(); }),
      saved.source === 'settings' && !removing
        && smallButton('Remove', () => { setDraft(row, name, null); render(); }, ' btn-danger'),
      removing && smallButton('Undo', () => { delete drafts[row][name]; render(); })));
}

function editor(row, section, fields) {
  const result = results[row];
  return el('div', { class: 'conn-edit' },
    ...fields,
    result && el('p', { class: `conn-result ${result.ok ? 'ok' : 'bad'}`, role: 'status' }, result.message),
    el('div', { class: 'sheet-actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => closeEditor(row) }, 'Cancel'),
      el('button', { type: 'button', class: 'btn', disabled: busy.has(row), onclick: () => testConnection(row) },
        busy.has(row) ? 'Testing…' : 'Test Connection'),
      el('button', { type: 'button', class: 'btn btn-filled', onclick: () => saveDraft(row, section) }, 'Save')));
}

function toggleRow(row) {
  openRow = openRow === row ? null : row;
  render();
}

const editBtn = (row) => smallButton(openRow === row ? 'Close' : 'Edit', () => toggleRow(row));

// The pill and Edit button of a connection row; the editor shows only while the row is open.
const connectionTrail = (row, ok, missing) => [pill(ok, ok ? 'Set Up' : missing), editBtn(row)];
const connectionEditor = (row, fields) => openRow === row && editor(row, row, fields());

// ---------- sections ----------

function connections() {
  return group('Connections', [githubRow(), jiraRow(), tempoRow(), teamsRow()]);
}

function githubRow() {
  const result = results.github;
  const checkAgain = el('button', {
    type: 'button', class: 'btn btn-small', disabled: busy.has('github'), onclick: () => testConnection('github'),
  }, 'Check Again');
  return rowShell({
    title: 'GitHub', sub: result ? result.message : 'Checking…', look: ['branch', 'gray'], help: 'github',
    trail: [result && pill(result.ok, result.ok ? 'Connected' : 'Not Signed In'), checkAgain],
  });
}

function jiraRow() {
  const { jira, configured } = view;
  return rowShell({
    title: 'Jira', look: ['ticket', 'blue'], help: 'jira',
    sub: configured.jira ? `${jira.email} · token ••••${jira.token.last4}` : 'Not set up',
    trail: connectionTrail('jira', configured.jira, 'Add Token'),
    body: connectionEditor('jira', () => [
      textField('jira', 'baseUrl', {
        label: 'Jira URL', value: jira.baseUrl, placeholder: 'https://yourcompany.atlassian.net',
      }),
      textField('jira', 'email', {
        label: 'Email', value: jira.email, type: 'email', placeholder: 'you@tcpsoftware.com',
      }),
      secretField('jira', 'token', { label: 'API token', saved: jira.token }),
    ]),
  });
}

function tempoRow() {
  const { tempo, configured } = view;
  return rowShell({
    title: 'Tempo', look: ['clock', 'indigo'], help: 'tempo',
    sub: configured.tempo ? `Token ••••${tempo.token.last4}` : 'Not set up',
    trail: connectionTrail('tempo', configured.tempo, 'Add Token'),
    body: connectionEditor('tempo', () => [secretField('tempo', 'token', { label: 'API token', saved: tempo.token })]),
  });
}

function teamsRow() {
  const { teams, configured } = view;
  const targets = [
    teams.webhookUrl.set && 'Review channel',
    teams.qaWebhookUrl.set && 'QA channel',
    teams.testWebhookUrl.set && 'test chat',
  ];
  return rowShell({
    title: 'Teams', look: ['team', 'purple'], help: 'teams',
    sub: targets.filter(Boolean).join(' · ') || 'Not set up',
    trail: connectionTrail('teams', configured.teams, 'Add Webhook'),
    body: connectionEditor('teams', () => [
      secretField('teams', 'webhookUrl', { label: 'Review channel webhook', saved: teams.webhookUrl }),
      secretField('teams', 'qaWebhookUrl', { label: 'QA channel webhook', saved: teams.qaWebhookUrl }),
      textField('teams', 'qaTagName', { label: 'QA tag', value: teams.qaTagName, placeholder: 'MobileHardware_QA' }),
      textField('teams', 'qaTagId', {
        label: 'QA tag ID (optional, for a real @mention)', value: teams.qaTagId,
        placeholder: 'Leave empty to show the tag as bold text',
      }),
      secretField('teams', 'testWebhookUrl', { label: 'Test chat webhook', saved: teams.testWebhookUrl }),
    ]),
  });
}

function appearance() {
  const choose = (theme) => { applyTheme(theme); view.theme = theme; render(); save({ theme }, { quiet: true }); };
  const themes = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']];
  const themeButton = ([theme, label]) => el('button', {
    type: 'button', role: 'tab', 'aria-selected': String(view.theme === theme), onclick: () => choose(theme),
  }, label);
  const seg = el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Theme' }, themes.map(themeButton));
  return group('Appearance', [
    rowShell({ title: 'Theme', sub: 'System follows your Mac', look: ['moon', 'indigo'], trail: seg }),
  ]);
}

// An input that saves `toPatch(input)` on change, skipping the save when it returns undefined.
function onChangeSave(input, toPatch) {
  input.addEventListener('change', () => { const patch = toPatch(input); if (patch) save(patch); });
  return input;
}

function timeTracking() {
  return group('Time Tracking', [workdayRow(view.time), reminderRow(view.time), folderRow(view.time)]);
}

function workdayRow(time) {
  const hourChoices = Array.from({ length: 13 }, (_, i) => 4 + i * 0.5);
  const hours = onChangeSave(el('select', { class: 'field compact', 'aria-label': 'Workday hours' },
    time.dayHours == null && el('option', { value: '' }, 'Not set'),
    hourChoices.map((h) => el('option', { value: String(h), selected: time.dayHours === h }, `${h}h`))),
  (input) => input.value && { time: { dayHours: Number(input.value) } });
  return rowShell({
    title: 'Workday', look: ['calendar', 'green'], trail: hours, help: 'workday',
    sub: time.dayHours == null ? 'Set this to turn on time tracking' : 'Changes apply to days you haven\'t saved yet',
  });
}

function reminderRow(time) {
  const reminderOn = onChangeSave(
    el('input', { type: 'checkbox', role: 'switch', checked: time.reminderOn, 'aria-label': 'Evening reminder' }),
    (input) => ({ time: { reminderOn: input.checked } }));
  const reminderAt = onChangeSave(el('input', {
    class: 'field compact', type: 'time', value: time.reminderAt, disabled: !time.reminderOn,
    'aria-label': 'Reminder time',
  }), (input) => input.value && { time: { reminderAt: input.value } });
  return rowShell({
    title: 'Evening Reminder', sub: 'Only on workdays you haven\'t confirmed', look: ['clock', 'orange'],
    trail: [reminderAt, el('label', { class: 'switch' }, reminderOn)], help: 'reminder',
  });
}

function folderRow(time) {
  const folder = onChangeSave(el('input', {
    class: 'field', type: 'text', value: time.mobileClockPath, spellcheck: 'false', 'aria-label': 'mobile-clock folder',
  }), (input) => ({ time: { mobileClockPath: input.value.trim() } }));
  return rowShell({
    title: 'mobile-clock Folder', sub: 'Your local clone, used for commits and the TypeScript count',
    look: ['branch', 'teal'], trail: fromEnv(time.sources.mobileClockPath),
    body: el('div', { class: 'conn-edit' }, folder), help: 'folder',
  });
}

function loginsInput(name, logins, label) {
  return onChangeSave(el('input', {
    class: 'field', type: 'text', value: logins.join(', '), placeholder: 'GitHub logins, separated by commas',
    spellcheck: 'false', 'aria-label': label,
  }), (input) => ({ teams: { [name]: input.value.split(',').map((x) => x.trim()).filter(Boolean) } }));
}

// One `login=email` per line; lines missing either side are dropped.
function parsePeople(text) {
  const pairs = text.split('\n').map((line) => line.split('=').map((x) => x.trim()));
  return Object.fromEntries(pairs.filter(([login, email]) => login && email));
}

function reviewRequests() {
  const teams = view.teams;
  const people = el('textarea', {
    class: 'field', rows: '3', spellcheck: 'false', placeholder: 'githublogin=name@tcpsoftware.com, one per line',
    'aria-label': 'Email overrides',
  });
  people.value = Object.entries(teams.people).map(([login, email]) => `${login}=${email}`).join('\n');
  onChangeSave(people, (input) => ({ teams: { people: parsePeople(input.value) } }));
  const editBox = (input) => el('div', { class: 'conn-edit' }, input);
  return group('Review Requests', [
    rowShell({
      title: 'Always Tag', sub: 'Added to every review request', look: ['team', 'blue'], help: 'always',
      trail: fromEnv(teams.sources.always), body: editBox(loginsInput('always', teams.always, 'Always tag')),
    }),
    rowShell({
      title: 'Never Tag', sub: 'For people who left or don\'t review', look: ['x', 'red'], help: 'never',
      trail: fromEnv(teams.sources.never), body: editBox(loginsInput('never', teams.never, 'Never tag')),
    }),
    rowShell({
      title: 'Email Overrides', sub: 'For people whose Jira profile hides their email', look: ['team', 'gray'],
      help: 'people',
      trail: fromEnv(teams.sources.people), body: editBox(people),
    }),
  ]);
}

function buildsAndNotifications() {
  const checked = new Set(view.builds.defaultChecked);
  const boxes = el('div', { class: 'build-defaults' }, builds.map((build) => {
    const box = onChangeSave(el('input', { type: 'checkbox', checked: checked.has(build.key) }), (input) => {
      if (input.checked) checked.add(build.key); else checked.delete(build.key);
      return { builds: { defaultChecked: builds.map((b) => b.key).filter((k) => checked.has(k)) } };
    });
    return el('label', { class: 'choice-inline' }, box, build.label);
  }));
  const notifications = onChangeSave(
    el('input', {
      type: 'checkbox', role: 'switch', checked: view.notifications, 'aria-label': 'Desktop notifications',
    }),
    (input) => ({ notifications: input.checked }));
  return group('Builds and Notifications', [
    rowShell({
      title: 'Builds Checked by Default', sub: 'In the Build sheet for approved PRs', look: ['hammer', 'orange'],
      trail: null, body: el('div', { class: 'conn-edit' }, boxes), help: 'builds',
    }),
    rowShell({
      title: 'Desktop Notifications', sub: 'When a build you started finishes, or a status badge turns red',
      look: ['bolt', 'pink'], trail: el('label', { class: 'switch' }, notifications), help: 'notifications',
    }),
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
  refresh: () => load(),
  update() { /* settings load on mount and after each save */ },
};
