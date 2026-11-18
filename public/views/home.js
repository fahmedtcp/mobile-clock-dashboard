import {
  $, api, post, el, ext, ago, duration, statusOf, statusChip, ticketChip, placeholder, sep, showError, confirmSheet,
  toast, section, icon, glyph, avatar, skeleton, empty, sectionFreshness,
} from '../ui.js';
import { registerTicketActions, buildChip, loadLatestBuilds, openTicketPanel } from '../tickets-ui.js';
import {
  heroCard, shiftLine, nowOf, workCard, feedCard, waitingCard, todayCard, planCard, standupCard, wrapCard, todoCard,
} from './home-cards.js';
import { submitState, behindStale } from '../notify.js';
import { branchName, TICKET_KEY, shiftState } from '../shared.js';
import { parseMarkdown, botHeader } from '../markdown.js';
import { runLocal } from '../local-jobs.js';

let ctx;
// Other views (Builds) reuse the build sheet and bug actions here before Home has ever been shown.
export function bindContext(appCtx) { ctx ??= appCtx; }
const local = {
  prTab: 'mine',
  home: null, homeError: null, homeAt: 0, // /api/home: hero, My Work, feed, shift cards
  seenTimer: null,
  behind: new Map(),
  ai: new Map(),        // pr number -> { loading } | { summary, inlineCount } | { error }
  ts: { prResults: {} },
  lookup: null,
  openReasons: new Set(),
};
const SLOW_MS = 60000; // /api/home refreshes every minute (the server caches it for 30 s)
const SHIFT_TICK_MS = 30000;
const SEEN_AFTER_MS = 5000; // the feed counts as read once it has been on screen this long
const POLL_MS = 60000; // the shared loop's idle pace (pollDelay in notify.js)
const FAILED_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'];

const plural = (count, word) => `${word}${count === 1 ? '' : 's'}`;
const isFinalFailure = (build) => build.status === 'completed' && FAILED_CONCLUSIONS.includes(build.conclusion);
const smallButton = (onclick, ...children) =>
  el('button', { class: 'btn btn-small', type: 'button', onclick }, ...children);
const linkButton = (href, label) => ext(href, el('span', { class: 'btn btn-small' }, label));

// ---------- data the shared loop doesn't cover ----------

function loadHome(fresh) {
  return api(`/api/home${fresh ? '?fresh=1' : ''}`).then(
    (home) => { local.home = { ...home, fetchedAt: Date.now() }; local.homeError = null; },
    (err) => { local.homeError = err; },
  );
}

async function loadSlow(force = false) {
  const now = Date.now();
  const jobs = [];
  if (force || now - local.homeAt > SLOW_MS) {
    local.homeAt = now;
    jobs.push(loadHome(force));
  }
  jobs.push(api('/api/ts').then((tsResult) => { local.ts = tsResult.status; }, () => {}));
  await Promise.all(jobs);
  render();
}

// ---------- shift-aware cards ----------

// Every button on the new cards sends one of these; the sheets below do the real work.
function act(action) {
  const prByNumber = (n) => ctx.shared.prs.find((p) => p.number === n);
  switch (action.kind) {
    case 'open-url': window.open(action.url, '_blank', 'noopener'); break;
    case 'open-ticket': openTicketPanel(action.key); break;
    case 'request-pr-review': requestPrReview(action.key); break;
    case 'send-to-qa': {
      const row = local.home?.work.find((r) => r.key === action.key);
      sendToQa({ ticket: { key: action.key, summary: row?.summary ?? '', status: 'Dev Review' } });
      break;
    }
    case 'request-qa': {
      const row = local.home?.work.find((r) => r.key === action.key);
      requestQa({ ticket: { key: action.key, summary: row?.summary ?? '', status: 'Dev Review' } });
      break;
    }
    case 'build': {
      const pr = prByNumber(action.pr);
      if (pr) openBuildSheet(pr, action.keys); else toast(`#${action.pr} isn't in your open pull requests.`, 'bad');
      break;
    }
    case 'update-branch': {
      const pr = prByNumber(action.pr);
      if (pr) mergeBase(pr, { base: pr.baseRefName });
      break;
    }
    case 'start': {
      const row = local.home?.work.find((r) => r.key === action.key);
      startTicket({ key: action.key, summary: row?.summary ?? '', assignee: null });
      break;
    }
    case 'rerun': post(`/api/runs/${action.runId}/rerun`).then(() => { toast('Rerun started', 'ok'); ctx.refresh(); }, (err) => toast(err.message, 'bad')); break;
    case 'scroll': document.getElementById(action.target === 'builds' ? 'builds-section' : `hc-${action.target}`)?.scrollIntoView({ block: 'start' }); break;
    case 'go': ctx.go(action.view); break;
    case 'copy':
      navigator.clipboard.writeText(action.text).then(
        () => toast(action.done ?? 'Copied. Run it in your terminal.', 'ok'),
        () => toast("Couldn't copy. Select the text instead.", 'bad'));
      break;
    default: break;
  }
}

async function markSeen() {
  clearTimeout(local.seenTimer);
  await post('/api/home/seen').catch(() => {});
  await loadHome(true);
  render();
}

// To-dos change on the server, then Home reloads; the add box keeps focus for the next one.
async function changeTodos(request, { refocus = false } = {}) {
  try {
    await request();
    local.refocusTodo = refocus;
    await loadHome(true);
    render();
  } catch (err) {
    toast(err.message, 'bad');
  }
}
const todoHandlers = {
  add: (text) => changeTodos(() => post('/api/home/todos', { text }), { refocus: true }),
  toggle: (todo) => changeTodos(() => api(`/api/home/todos/${todo.id}`, { method: 'PATCH', body: JSON.stringify({ done: !todo.done }) })),
  remove: (todo) => changeTodos(() => api(`/api/home/todos/${todo.id}`, { method: 'DELETE' })),
};
// ⌘K "todo …" adds from anywhere.
window.addEventListener('home:todos-changed', () => loadSlow(true));
// After a local job, behind counts and PR state may have changed.
window.addEventListener('local:job-finished', () => { local.behind.clear(); ctx?.refresh(); loadSlow(true); });

// Every 30 s: move the shift line; when the moment changes (start → mid → wrap), reload the cards.
function tickShift() {
  const home = local.home;
  if (!home) return;
  if (shiftState(nowOf(home), home.shift).moment !== home.shift.moment) { loadSlow(true); return; }
  const line = shiftLine(home.shift, home.meetings, nowOf(home));
  if (line) document.querySelector('.hero-card .shiftline')?.replaceWith(line);
}

function renderHome() {
  // Never rebuild the cards under someone typing a to-do; the next render catches up.
  if (document.activeElement?.classList.contains('todo-input') && document.activeElement.value) return;
  const root = $('home-cards');
  const { home } = local;
  if (!home) {
    root.replaceChildren(local.homeError
      ? el('div', { class: 'banner error', role: 'alert' }, `Couldn't load Home: ${local.homeError.message}`)
      : el('div', { class: 'hero-card' }, ...skeleton(3)));
    return;
  }
  const { moment } = home.shift;
  const since = Date.parse(home.shift.prevShiftEnd);
  const sinceShift = home.feed.filter((item) => Date.parse(item.at) > since);
  const cards = [heroCard(home, act)];
  if (moment === 'start') {
    cards.push(todoCard(home.todos, { title: 'From Last Night', handlers: todoHandlers }),
      el('div', { class: 'hc-grid' },
        feedCard(sinceShift, { id: 'feed', title: 'Since Last Shift', emptyText: 'Nothing changed since your last shift.' }),
        home.calendar === 'ok' ? todayCard(home.shift, home.meetings) : null),
      planCard(home.plan, act));
  }
  cards.push(workCard(home.work, act, home.errors.jira));
  if (moment === 'mid') {
    cards.push(el('div', { class: 'hc-grid' },
      feedCard(home.feed, { id: 'feed', title: 'Since You Last Looked', onMarkRead: markSeen, emptyText: 'Nothing new on your tickets or PRs.' }),
      standupCard(home.standup, act)),
    waitingCard(home.waiting, act),
    home.todos.some((t) => !t.done) ? todoCard(home.todos, { title: 'To-Dos', handlers: todoHandlers }) : null);
  }
  if (moment === 'wrap') {
    cards.push(el('div', { class: 'hc-grid' },
      wrapCard(home.wrap, act),
      todoCard(home.todos, { title: 'For Tomorrow', trail: 'Reminds you at shift start', alwaysShow: true, handlers: todoHandlers })));
  }
  root.replaceChildren(...cards.filter(Boolean));
  if (local.refocusTodo) { local.refocusTodo = false; root.querySelector('.todo-input')?.focus(); }
  ctx.setBadge('home', home.work.filter((r) => r.tone === 'bad').length);
  if (moment === 'mid' && home.feed.some((i) => i.unread)) {
    clearTimeout(local.seenTimer);
    local.seenTimer = setTimeout(() => { if (document.visibilityState === 'visible' && $('hc-feed')) post('/api/home/seen').catch(() => {}); }, SEEN_AFTER_MS);
  }
}

// ---------- triggered builds ----------

function bugDescription(build) {
  return [
    `${build.label} failed for PR #${build.prNumber} on ${build.branch} after ${build.attempt ?? 1} attempt(s).`,
    `Failed step: ${build.reason?.step ?? 'unknown'}`,
    build.classification ? `Type: ${build.classification.label}` : null,
    `Run: ${build.url ?? 'n/a'}`,
    '```', ...(build.reason?.lines ?? []), '```',
  ].filter((line) => line !== null).join('\n');
}

export async function createBug(build) {
  const summary = el('input', {
    class: 'field', value: `CI build failure: ${build.label} on ${build.branch}`, maxlength: 255, required: true,
    'aria-label': 'Summary',
  });
  const description = el('textarea', { class: 'field', rows: 8, 'aria-label': 'Description' });
  description.value = bugDescription(build);
  let created;
  const ok = await confirmSheet({
    title: 'Create Jira Bug',
    body: [
      el('p', { class: 'muted' }, 'Creates a Bug in TCPMOB, linked to the PR\'s ticket when it has one.'),
      el('label', { class: 'field-label' }, 'Summary', summary),
      el('label', { class: 'field-label' }, 'Description', description),
    ],
    confirmLabel: 'Create Bug',
    onConfirm: async () => {
      created = await post(`/api/builds/${build.id}/bug`, { summary: summary.value, description: description.value });
    },
  });
  if (!ok) return;
  if (created.linkError) toast(`Created ${created.key}, but couldn't link it: ${created.linkError}`, 'bad');
  else toast(`Created ${created.key}`, 'ok');
}

export async function installOnSim(build) {
  let sims = [];
  try { sims = await api('/api/simulators'); } catch (err) { return toast(err.message, 'bad'); }
  const select = el('select', { class: 'field', 'aria-label': 'Simulator' },
    sims.map((sim) => el('option', { value: sim.udid }, `${sim.name} · ${sim.runtime}`)));
  const ok = await confirmSheet({
    title: 'Install on Simulator',
    body: sims.length
      ? [
          el('p', { class: 'muted' }, `Downloads the .app from run #${build.runId}, installs it, and launches it.`),
          el('label', { class: 'field-label' }, 'Simulator', select),
        ]
      : [el('p', {}, 'No simulator is booted. Boot one in Xcode or with `xcrun simctl boot`, then try again.')],
    confirmLabel: 'Install',
    confirmDisabled: !sims.length,
    onConfirm: () => post(`/api/runs/${build.runId}/install`, { udid: select.value }),
  });
  if (ok) toast('Installed and launched', 'ok');
}

function classificationChip(build) {
  const { kind, label } = build.classification;
  const color = kind === 'code' ? 'red' : kind === 'infra' ? 'orange' : '';
  return el('span', { class: `chip ${color}` },
    kind === 'code' && build.status === 'completed' ? `${label}, not retried` : label);
}

// Remembers which failure reasons are expanded so a re-render doesn't collapse them.
function reasonDetails(build) {
  return el('details', {
    class: 'reason', open: local.openReasons.has(build.id),
    ontoggle: (e) => (e.target.open ? local.openReasons.add(build.id) : local.openReasons.delete(build.id)),
  },
    el('summary', {}, build.reason.step),
    build.reason.lines.length ? el('pre', {}, build.reason.lines.join('\n')) : null);
}

function triggeredBuildTrail(build) {
  const attempts = (build.maxRetries ?? 0) + 1;
  const canInstall = build.key === 'mcIosSim' && build.conclusion === 'success';
  return el('div', { class: 'row-trail' },
    (build.attempt > 1 || build.retries)
      && el('span', { class: 'build-attempt' }, `Attempt ${build.attempt ?? 1} of ${attempts}`),
    build.classification && classificationChip(build),
    statusChip(build),
    isFinalFailure(build) && smallButton(() => createBug(build), 'Create Jira Bug'),
    canInstall && smallButton(() => installOnSim(build), 'Install on Simulator'),
    build.url && linkButton(build.url, 'Logs'));
}

function triggeredBuildRow(build) {
  const isIos = build.label.startsWith('iOS');
  const triggeredAgo = ago(new Date(build.triggeredAt).toISOString());
  return el('li', {},
    el('div', { class: 'row' },
      glyph(isIos ? 'phone' : 'hammer', isIos ? 'gray' : 'green'),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, build.label),
        el('div', { class: 'row-sub' },
          el('span', { class: 'num' }, `#${build.prNumber}`), sep(),
          el('span', { class: 'mono' }, build.branch), sep(),
          el('span', {}, triggeredAgo))),
      triggeredBuildTrail(build)),
    !['completed', 'waiting-slot'].includes(build.status) && el('div', { class: 'progress-line', 'aria-hidden': 'true' }),
    build.reason && reasonDetails(build));
}

function renderTriggered() {
  const builds = [...ctx.shared.builds].sort((a, b) => b.triggeredAt - a.triggeredAt);
  $('builds-section').hidden = !builds.length;
  const max = builds[0]?.maxRetries;
  $('retry-hint').textContent = max ? `Network and runner failures retry up to ${max} times` : '';
  $('builds').replaceChildren(...builds.map(triggeredBuildRow));
}

// ---------- my tickets ----------

async function startTicket(ticket) {
  const branch = branchName(ticket.key, ticket.summary);
  const assignmentNote = ticket.assignee
    ? `Already assigned to ${ticket.assignee.name}; assignment won't change.`
    : 'Assigns the ticket to you. The ticket status doesn\'t change.';
  let started;
  const ok = await confirmSheet({
    title: `Start ${ticket.key}`,
    body: [
      el('p', {}, ticket.summary),
      el('p', { class: 'muted' }, 'Creates this branch on GitHub from the latest develop:'),
      el('p', { class: 'mono pill-mono' }, branch),
      el('p', { class: 'muted' }, assignmentNote),
      el('p', { class: 'muted' }, `Then run: git fetch && git switch ${branch}`),
    ],
    confirmLabel: 'Create Branch',
    onConfirm: async () => { started = await post(`/api/tickets/${ticket.key}/start`); },
  });
  if (!ok) return;
  const assignedNote = started.assigned ? '; assigned to you' : '';
  toast(started.existed ? `${branch} already existed${assignedNote}` : `Created ${branch}`, 'ok');
  loadSlow(true);
}

// ---------- pull requests ----------

const behindQueue = [];
let behindRunning = false;

async function drainBehind() {
  if (behindRunning) return;
  behindRunning = true;
  while (behindQueue.length) {
    const prNumber = behindQueue.shift();
    try { local.behind.set(prNumber, { ...(await api(`/api/prs/${prNumber}/behind`)), at: Date.now() }); }
    catch { local.behind.set(prNumber, { error: true, behind: 0, base: '', at: Date.now() }); }
  }
  behindRunning = false;
  renderPrs();
}

function requestBehind(prNumber) {
  if (!behindStale(local.behind.get(prNumber), Date.now())) return;
  local.behind.set(prNumber, { loading: true });
  behindQueue.push(prNumber);
  drainBehind();
}

async function mergeBase(pr, behindInfo) {
  const ok = await confirmSheet({
    title: `Update #${pr.number}`,
    body: [
      el('p', {}, `Merges ${behindInfo.base} into ${pr.headRefName}. This pushes a merge commit to the PR branch.`),
    ],
    confirmLabel: 'Merge Base In',
    onConfirm: () => post(`/api/prs/${pr.number}/update-branch`),
  });
  if (ok) { local.behind.clear(); renderPrs(); toast('Branch updated', 'ok'); }
}

// Newest build per app + platform; the lookup lists builds newest first.
function latestBuildPerTarget(builds) {
  const latest = new Map();
  for (const build of builds) {
    const target = `${build.app} ${build.platform}`;
    if (!latest.has(target)) latest.set(target, build);
  }
  return latest;
}

function ticketBuildsBlock(latest, lookupError) {
  if (latest.size) {
    return el('div', {},
      el('p', { class: 'list-label' }, 'Latest builds on the ticket'),
      el('ul', { class: 'plain' },
        [...latest.values()].map((b) => el('li', {}, `${b.app} ${b.platform} · build ${b.number}`))));
  }
  return el('p', { class: 'muted' }, lookupError
    ? `Couldn't read builds: ${lookupError.message}`
    : 'No dev build has been posted to this ticket yet. Build it first.');
}

async function sendToQa(pr) {
  const ticket = pr.ticket;
  let builds = [];
  let lookupError = null;
  try { builds = (await api(`/api/lookup/${ticket.key}`)).jiraBuilds; } catch (err) { lookupError = err; }
  const latest = latestBuildPerTarget(builds);
  const ok = await confirmSheet({
    title: 'Send to QA',
    body: [
      el('p', {}, el('strong', {}, ticket.key), ` ${ticket.summary}`),
      el('p', { class: 'transition' },
        el('span', { class: 'chip blue' }, ticket.status), ' → ', el('span', { class: 'chip orange' }, 'QA Review')),
      ticketBuildsBlock(latest, lookupError),
      el('p', { class: 'muted' }, 'Only the status changes. No comment is posted.'),
    ],
    confirmLabel: 'Send to QA',
    confirmDisabled: !latest.size,
    onConfirm: () => post(`/api/tickets/${ticket.key}/qa`),
  });
  if (ok) { toast(`${ticket.key} moved to QA Review`, 'ok'); ctx?.refresh(); }
}

// ---------- Teams sheets (Request Review, Request QA Review) ----------

// GET a sheet's details; on failure shows a toast and returns null.
async function loadSheetInfo(path) {
  try { return await api(path); } catch (err) { toast(err.message, 'bad'); return null; }
}

const isCoolingDown = (info) => info.cooldownUntil && info.cooldownUntil > Date.now();

function cooldownNote(subject, until) {
  const time = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Already sent for ${subject}. You can send again after ${time}.`;
}

// Test mode: send to the user's own chat first (on by default when it's set up).
function testSwitch(info, notSetUpText) {
  const box = el('input', {
    type: 'checkbox', role: 'switch', checked: info.testConfigured, disabled: !info.testConfigured,
  });
  const row = el('label', {
    class: 'switch test-switch',
    title: info.testConfigured ? '' : 'Add a test chat webhook in Settings to turn this on',
  }, box, el('span', {}, info.testConfigured ? 'Send to my test chat first' : notSetUpText));
  return { box, row };
}

// onReady handler: keeps the send button's label and disabled state in step with the test switch,
// the Send Anyway box, and the message text. `watch` lists other inputs that change the answer.
function syncSendButton({ testBox, liveLabel, isDisabled, anyway = null, watch = [] }) {
  return (okBtn) => {
    const sync = () => {
      const testing = testBox.checked;
      okBtn.textContent = testing ? 'Send Test' : anyway?.checked ? 'Send Again' : liveLabel;
      okBtn.disabled = isDisabled(testing);
    };
    for (const node of [testBox, anyway, ...watch].filter(Boolean)) {
      node.addEventListener('change', sync);
      node.addEventListener('input', sync);
    }
    sync();
  };
}

// Inside the resend timer: an unchecked "Send Anyway" box, so an accidental second send stays blocked.
const anywayBox = () => el('input', { type: 'checkbox' });
const anywayRow = (box) => el('label', { class: 'switch send-anyway' }, box, el('span', {}, 'Send Anyway'));

// The message text: pre-filled with the team wording, editable, with Reset to Default.
const TEXT_MAX = 2000;
const TEXT_COUNT_FROM = 1800;
function messageEditor(defaultText, onChange) {
  const area = el('textarea', { class: 'field msg-text', rows: 8, maxlength: TEXT_MAX, 'aria-label': 'Message' });
  area.value = defaultText;
  const count = el('span', { class: 'footnote msg-count', 'aria-live': 'polite' });
  const reset = el('button', { type: 'button', class: 'linkish', onclick: () => {
    area.focus();
    area.select();
    // insertText keeps the browser's undo history, so Cmd+Z brings the edited text back
    if (!document.execCommand('insertText', false, defaultText)) area.value = defaultText;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  } }, 'Reset to Default');
  const paint = () => {
    const n = area.value.length;
    count.textContent = n > TEXT_COUNT_FROM ? `${n.toLocaleString()}/2,000` : '';
    onChange();
  };
  area.addEventListener('input', paint);
  return { area, node: el('div', { class: 'msg-editor' }, area, el('div', { class: 'msg-tools' }, reset, count)), paint };
}

const messageBlocks = (text) => parseMarkdown(text).map(mdBlock);
const blankText = (area) => !area.value.trim();

const teamsCard = (...children) => el('div', { class: 'teams-card', 'aria-label': 'Message preview' }, ...children);

function mentionCheckboxes(people) {
  const boxes = people.map((person) => el('label', { class: 'choice' },
    el('input', { type: 'checkbox', value: person.login, checked: person.selected }),
    el('span', { class: 'choice-label' }, person.name),
    el('span', {
      class: 'choice-platform',
      title: person.email
        ? person.email
        : 'No email found, so this shows as plain text. Add an email override in Settings to @mention.',
    }, person.email ? '@mention' : 'plain name')));
  return el('fieldset', { class: 'choice-list' }, el('legend', { class: 'sr-only' }, 'Mention'), boxes);
}

// A faithful preview of the Teams card: fixed title, the message text, then the mentions.
function paintReviewPreview(preview, info, text, chosen) {
  const personClass = (person, i) => {
    if (!person.email) return 'tc-plain';
    return i === 0 && person.login === ctx.shared.login ? 'tc-me' : 'tc-at';
  };
  preview.replaceChildren(
    el('div', { class: 'tc-title' }, info.title),
    ...messageBlocks(text),
    el('p', { class: 'tc-people' },
      chosen.map((person, i) => el('span', { class: personClass(person, i) }, person.name))));
}

const teamsSetupSteps = () => [
  el('p', {}, 'Teams isn\'t set up yet.'),
  el('ol', { class: 'steps' },
    el('li', {},
      'In the Teams channel, open ••• → Workflows → "Post to a channel when a webhook request is received".'),
    el('li', {}, 'Copy the URL it gives you.'),
    el('li', {}, 'Paste it into Settings, under Teams.')),
];

// "+ Add person": mention someone just for this message by GitHub login. Nothing is saved.
const ADD_MAX = 5;
function addPersonRow(info, people, added) {
  const input = el('input', {
    class: 'field', type: 'text', placeholder: 'GitHub login, like abdulqadir-tcp', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Add a person by GitHub login',
  });
  const status = el('span', { class: 'footnote add-person-status', role: 'status' });
  const add = async () => {
    const login = input.value.trim().replace(/^@/, '');
    if (!login) return;
    if (info.people.some((p) => p.login.toLowerCase() === login.toLowerCase())) { status.textContent = `${login} is already in the list.`; return; }
    if (added.size >= ADD_MAX) { status.textContent = `Up to ${ADD_MAX} extra people per message.`; return; }
    status.textContent = 'Looking up…';
    try {
      const person = await api(`/api/people/${encodeURIComponent(login)}`);
      info.people.push({ ...person, selected: true });
      added.add(person.login);
      people.append(mentionCheckboxes([{ ...person, selected: true }]).querySelector('label'));
      people.dispatchEvent(new Event('change', { bubbles: true }));
      status.textContent = person.email ? `Added ${person.name}.` : `Added ${person.name} as a plain name (no email found).`;
      input.value = '';
    } catch (err) {
      status.textContent = err.message;
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }); // never sends the sheet
  return el('div', { class: 'add-person' },
    el('div', { class: 'add-person-row' }, input, el('button', { type: 'button', class: 'btn btn-small', onclick: add }, '+ Add Person')),
    status);
}

function reviewMessageForm(info) {
  const people = mentionCheckboxes(info.people);
  const chosen = () => [...people.querySelectorAll('input:checked')]
    .map((input) => info.people.find((p) => p.login === input.value));
  const preview = teamsCard();
  const editor = messageEditor(info.defaultText, () => paintReviewPreview(preview, info, editor.area.value, chosen()));
  people.addEventListener('change', editor.paint);
  editor.paint();
  return { editor, people, chosen, preview };
}

// Ask the team channel for a review, in the user's own message format. Preview first; nothing sends until confirmed.
async function requestReview(pr) {
  const info = await loadSheetInfo(`/api/prs/${pr.number}/review-request`);
  if (!info) return;
  const cooling = isCoolingDown(info);
  let sentTest = false;
  const test = testSwitch(info, 'Test chat not set up (TEAMS_TEST_WEBHOOK_URL)');
  const { editor, people, chosen, preview } = reviewMessageForm(info);
  const anyway = cooling ? anywayBox() : null;
  const added = new Set();
  const ok = await confirmSheet({
    title: 'Request Review on Teams',
    body: info.configured
      ? [
          el('div', { class: 'msg-split' }, el('label', { class: 'field-label' }, 'Message', editor.node), preview),
          el('div', {}, el('p', { class: 'list-label', 'aria-hidden': 'true' }, 'Mention'), people, addPersonRow(info, people, added)),
          test.row,
          el('p', { class: 'footnote' }, cooling
            ? cooldownNote(`#${pr.number}`, info.cooldownUntil)
            : 'Posts to your team channel through its Workflows webhook.'),
          anyway && anywayRow(anyway),
        ]
      : teamsSetupSteps(),
    confirmLabel: info.testConfigured ? 'Send Test' : 'Send to Teams',
    confirmDisabled: !info.configured,
    onReady: syncSendButton({
      testBox: test.box, liveLabel: 'Send to Teams', anyway, watch: [editor.area],
      isDisabled: (testing) => !info.configured || blankText(editor.area) || (!testing && cooling && !anyway.checked),
    }),
    onConfirm: async () => {
      sentTest = test.box.checked;
      await post(`/api/prs/${pr.number}/review-request`, {
        logins: chosen().map((p) => p.login), text: editor.area.value, test: sentTest, added: [...added],
        force: Boolean(!sentTest && anyway?.checked),
      });
    },
  });
  if (!ok) return;
  toast(sentTest
    ? 'Sent to your test chat. Open Request Review again and turn off the test switch to send to the team.'
    : `Review requested for #${pr.number}`);
}

// ---------- Request PR Review: create the PR if needed, move the ticket to Dev Review, then ask on Teams ----------

const PLACEHOLDER = /\[fill in[^\]]*\]/i;

function reviewerBoxes(reviewers) {
  return el('fieldset', { class: 'choice-list' }, el('legend', { class: 'sr-only' }, 'Reviewers'),
    reviewers.length ? reviewers.map((r) => el('label', { class: 'choice' },
      el('input', { type: 'checkbox', value: r.login, checked: r.selected }),
      el('span', { class: 'choice-label' }, r.name),
      el('span', { class: 'choice-platform' }, r.login)))
      : el('p', { class: 'muted' }, 'Add teammates in Settings → Shift and Team to pick reviewers here.'));
}

// Write and Preview tabs over one textarea; Preview uses the same safe Markdown as the AI review.
function bodyEditor(text) {
  const area = el('textarea', { class: 'field mono pr-body', rows: 14, spellcheck: 'true', 'aria-label': 'Description' });
  area.value = text;
  const preview = el('div', { class: 'ai-body md pr-preview', hidden: true });
  const tab = (label, show) => el('button', { type: 'button', role: 'tab', 'aria-selected': String(!show), onclick: (e) => {
    preview.hidden = !show;
    area.hidden = show;
    if (show) preview.replaceChildren(...parseMarkdown(area.value).map(mdBlock));
    for (const b of e.target.parentElement.children) b.setAttribute('aria-selected', String(b === e.target));
  } }, label);
  const tabs = el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Description view' }, tab('Write', false), tab('Preview', true));
  return { node: el('div', { class: 'pr-editor' }, tabs, area, preview), area };
}

async function createPrSheet(draft) {
  const title = el('input', { class: 'field', type: 'text', maxlength: 256, value: draft.title, 'aria-label': 'Title',
    onkeydown: (e) => { if (e.key === 'Enter') e.preventDefault(); } }); // Return never posts by accident
  const label = el('select', { class: 'field compact', 'aria-label': 'Label' },
    draft.labels.map((l) => el('option', { value: l, selected: l === draft.label }, l)));
  const reviewers = reviewerBoxes(draft.reviewers);
  const body = bodyEditor(draft.body);
  const hint = el('p', { class: 'footnote' });
  let created = null;
  const ok = await confirmSheet({
    title: 'Create a Pull Request',
    body: [
      el('p', { class: 'muted' }, `No PR exists for ${draft.key} yet. Check every detail; nothing is posted until you press Create PR.`),
      el('label', { class: 'field-label' }, 'Title', title),
      el('div', { class: 'pr-grid' },
        el('div', {}, el('p', { class: 'list-label' }, 'Into'), el('p', { class: 'mono pill-mono' }, draft.base)),
        el('div', {}, el('p', { class: 'list-label' }, 'From'), el('p', { class: 'mono pill-mono' }, draft.head))),
      el('div', { class: 'pr-grid' },
        el('label', { class: 'field-label' }, 'Label', label),
        el('div', {}, el('p', { class: 'list-label' }, 'Assignee'), el('p', {}, 'You'))),
      el('div', {}, el('p', { class: 'list-label' }, 'Reviewers'), reviewers),
      el('div', {}, el('p', { class: 'list-label' }, 'Description'), body.node),
      hint,
    ],
    confirmLabel: 'Create PR',
    onReady: (okBtn, isBusy) => {
      const sync = () => {
        const missing = PLACEHOLDER.test(body.area.value);
        okBtn.disabled = isBusy() || missing || !title.value.trim();
        hint.textContent = missing ? 'Fill in or delete every [fill in: …] in the description to create the PR.' : '';
      };
      body.area.addEventListener('input', sync);
      title.addEventListener('input', sync);
      okBtn.closest('form').addEventListener('change', sync);
      sync();
    },
    onConfirm: async () => {
      created = await post(`/api/tickets/${draft.key}/pr`, {
        title: title.value, body: body.area.value, head: draft.head, label: label.value,
        reviewers: [...reviewers.querySelectorAll('input:checked')].map((i) => i.value),
      });
    },
  });
  return ok ? created : null;
}

async function requestPrReview(key) {
  let draft;
  try { draft = await api(`/api/tickets/${key}/pr-draft`); } catch (err) { toast(err.message, 'bad'); return; }
  let pr = draft.existing;
  if (!pr) {
    pr = await createPrSheet(draft);
    if (!pr) return;
    toast(`Created PR #${pr.number}`, 'ok');
  }
  if (draft.status !== 'Dev Review') {
    const moved = await confirmSheet({
      title: `Move ${key} to Dev Review`,
      body: [el('p', {}, `PR #${pr.number} is ready. Move the ticket from ${draft.status || 'its current status'} to Dev Review in Jira?`)],
      confirmLabel: 'Move to Dev Review',
      onConfirm: () => post(`/api/tickets/${key}/dev-review`),
    });
    if (moved) toast(`${key} moved to Dev Review`, 'ok');
  }
  await requestReview({ number: pr.number });
  ctx.refresh();
  loadSlow(true);
}

function qaFootnote(key, info, cooling) {
  if (cooling) return cooldownNote(key, info.cooldownUntil);
  const { mention, name } = info.tag;
  return mention
    ? `Posts to the QA channel and @mentions ${name}. The ticket status doesn't change.`
    : `Posts to the QA channel. ${name} shows as bold text until its tag ID is added in Settings. `
      + 'The ticket status doesn\'t change.';
}

function paintQaPreview(preview, info, text) {
  preview.replaceChildren(
    el('div', { class: 'tc-title' }, info.title),
    ...messageBlocks(text),
    el('p', {}, info.tag.mention ? el('span', { class: 'tc-at' }, info.tag.name) : el('strong', {}, info.tag.name)));
}

// Tell QA the ticket is ready for PRE-QA, in the team's format. Separate from Send to QA for now.
async function requestQa(pr) {
  const key = pr.ticket.key;
  const info = await loadSheetInfo(`/api/tickets/${key}/qa-request`);
  if (!info) return;
  const cooling = isCoolingDown(info);
  let sentTest = false;
  const test = testSwitch(info, 'Test chat not set up');
  const preview = teamsCard();
  const editor = messageEditor(info.defaultText, () => paintQaPreview(preview, info, editor.area.value));
  editor.paint();
  const anyway = cooling ? anywayBox() : null;
  const ready = info.configured && info.ready;
  const ok = await confirmSheet({
    title: 'Request QA Review on Teams',
    body: [
      el('div', { class: 'msg-split' }, el('label', { class: 'field-label' }, 'Message', editor.node), preview),
      !info.ready && el('p', { class: 'banner error' }, info.reason),
      info.configured
        ? test.row
        : el('p', { class: 'muted' }, 'The QA channel isn\'t set up. Add its webhook in Settings, under Teams.'),
      el('p', { class: 'footnote' }, qaFootnote(key, info, cooling)),
      anyway && anywayRow(anyway),
    ].filter(Boolean),
    confirmLabel: info.testConfigured ? 'Send Test' : 'Send to QA Channel',
    confirmDisabled: !info.ready || (!info.configured && !info.testConfigured),
    onReady: syncSendButton({
      testBox: test.box, liveLabel: 'Send to QA Channel', anyway, watch: [editor.area],
      isDisabled: (testing) => !info.ready || blankText(editor.area)
        || (testing ? !info.testConfigured : !ready || (cooling && !anyway.checked)),
    }),
    onConfirm: async () => {
      sentTest = test.box.checked;
      await post(`/api/tickets/${key}/qa-request`, { test: sentTest, text: editor.area.value, force: Boolean(!sentTest && anyway?.checked) });
    },
  });
  if (!ok) return;
  toast(sentTest
    ? 'Sent to your test chat. Open Request QA Review again and turn off the test switch to send to QA.'
    : `QA review requested for ${key}`);
}

// ---------- build sheet ----------

// Each build is a row: its checkbox, then room for a conflict warning right under it (filled by paintConflicts).
function buildCheckboxes(preselect = null) {
  const rows = ctx.shared.buildConfig.map((config) => {
    const [platform, ...rest] = config.label.split(' ');
    return el('div', { class: 'choice-row', 'data-key': config.key },
      el('label', { class: 'choice' },
        el('input', { type: 'checkbox', value: config.key, checked: preselect ? preselect.includes(config.key) : config.defaultChecked !== false }),
        el('span', { class: 'choice-label' }, rest.join(' ')),
        el('span', { class: 'choice-platform' }, platform)),
      el('div', { class: 'build-warn', hidden: true }));
  });
  return el('fieldset', { class: 'choice-list' }, el('legend', { class: 'sr-only' }, 'Builds'), rows);
}

// Uncheck builds that already started so a retry can't dispatch them twice.
function uncheckStarted(fieldset, startedKeys) {
  for (const key of startedKeys) {
    const box = fieldset.querySelector(`input[value="${key}"]`);
    if (box) box.checked = false;
  }
}

const minutesSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)) : null);

function conflictText(label, c) {
  const mins = minutesSince(c.startedAt);
  const took = mins === null ? '' : ` (${mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} hr ${mins % 60} min`})`;
  if (c.rule === 'same-branch') return `${label} is already building this branch${took}.`;
  return `${label} is already building ${c.ticketKey ?? c.branch} for ${c.actor ?? 'someone'}${took}. A second iOS build fails on TestFlight.`;
}

// Build sheet state: what's checked, what's queued to start when its iOS slot frees up, and what clashes.
function buildSheetState(fieldset) {
  const state = { conflicts: {}, queued: new Set(), warned: new Set() };
  const box = (key) => fieldset.querySelector(`input[value="${key}"]`);
  const checked = () => [...fieldset.querySelectorAll('input:checked')].map((i) => i.value);
  state.startKeys = () => checked().filter((k) => !state.queued.has(k));
  state.queueKeys = () => checked().filter((k) => state.queued.has(k));
  state.force = () => state.startKeys().filter((k) => state.conflicts[k]?.length);
  state.counts = () => ({ start: state.startKeys().length, queue: state.queueKeys().length });
  const changed = () => fieldset.closest('form')?.dispatchEvent(new Event('change'));

  // A box that first shows a conflict starts unchecked; re-checking it means "start anyway".
  state.paint = (conflicts) => {
    Object.assign(state.conflicts, conflicts);
    for (const row of fieldset.querySelectorAll('.choice-row')) {
      const { key } = row.dataset;
      const list = state.conflicts[key] ?? [];
      const warn = row.querySelector('.build-warn');
      if (!list.length) { warn.hidden = true; warn.replaceChildren(); continue; }
      if (!state.warned.has(key)) { state.warned.add(key); box(key).checked = false; state.queued.delete(key); }
      const label = ctx.shared.buildConfig.find((b) => b.key === key)?.label ?? key;
      const slot = list.find((c) => c.rule === 'ios-slot') && !list.some((c) => c.rule === 'same-branch');
      const queueBtn = slot && el('button', {
        type: 'button', class: 'btn btn-small', 'aria-pressed': String(state.queued.has(key)),
        onclick: () => {
          if (state.queued.has(key)) state.queued.delete(key);
          else { state.queued.add(key); box(key).checked = true; }
          state.paint({});
          changed();
        },
      }, state.queued.has(key) ? 'Will Start When Free' : 'Start When Free');
      warn.replaceChildren(...[el('span', {}, conflictText(label, list[0])), queueBtn].filter(Boolean)); // a null would print as text
      warn.hidden = false;
    }
  };
  fieldset.addEventListener('change', (e) => {
    if (e.target.matches('input') && !e.target.checked && state.queued.delete(e.target.value)) state.paint({});
  });
  return state;
}

// onReady handler: the confirm button says what will start and what will queue, and locks the list while sending.
function syncBuildButton(fieldset, counts) {
  return (okBtn, isBusy) => {
    const update = () => {
      const state = submitState(counts(), isBusy());
      okBtn.textContent = state.label;
      okBtn.disabled = state.disabled;
      fieldset.disabled = isBusy();
    };
    okBtn.closest('form').addEventListener('change', update);
    update();
  };
}

export async function openBuildSheet(pr, preselect = null) {
  const fieldset = buildCheckboxes(preselect);
  const sheet = buildSheetState(fieldset);
  const checking = el('p', { class: 'footnote build-check', role: 'status' }, 'Checking for running builds…');
  api(`/api/prs/${pr.number}/build-check`).then(({ conflicts }) => {
    sheet.paint(conflicts);
    checking.textContent = Object.values(conflicts).some((l) => l.length) ? '' : 'No running builds in the way.';
    fieldset.closest('form')?.dispatchEvent(new Event('change'));
  }, () => { checking.textContent = 'Couldn\'t check for running builds. You can still start them.'; });
  let made = [];
  let queued = 0;
  const ok = await confirmSheet({
    title: `Build #${pr.number}`,
    body: [
      el('p', { class: 'sheet-title' }, pr.title),
      el('p', { class: 'mono pill-mono' }, pr.headRefName),
      el('div', {}, el('p', { class: 'list-label', 'aria-hidden': 'true' }, 'Dev builds'), fieldset),
      checking,
      el('p', { class: 'footnote' },
        'Dev builds only. QA and InfoSec aren\'t notified. Network and runner failures are retried automatically.'),
    ],
    onReady: syncBuildButton(fieldset, sheet.counts),
    onConfirm: async () => {
      fieldset.disabled = true;
      const startKeys = sheet.startKeys();
      const queueKeys = sheet.queueKeys();
      try {
        if (startKeys.length) {
          made = await post(`/api/prs/${pr.number}/builds`, { keys: startKeys, force: sheet.force() });
          uncheckStarted(fieldset, startKeys); // a failed queue step below must not start them again
        }
        for (const key of queueKeys) {
          await post('/api/build-queue', { prNumber: pr.number, key });
          queued += 1;
        }
      } catch (err) {
        if (err.data?.conflicts) sheet.paint(err.data.conflicts); // started since the sheet opened
        uncheckStarted(fieldset, err.data?.started ?? []);
        fieldset.disabled = false;
        throw err;
      }
    },
  });
  if (!ok) return;
  ctx.shared.builds.push(...made);
  const startedText = made.length ? `Started ${made.length} ${plural(made.length, 'build')}` : '';
  toast(startedText && queued ? `${startedText}, queued ${queued}`
    : queued ? `Queued ${queued} ${plural(queued, 'build')}. You'll get a notification when it starts.` : startedText, 'ok');
  ctx.refresh();
}

// ---------- pull request rows ----------

async function toggleAi(pr, details) {
  if (!details.open || local.ai.has(pr.number)) return;
  local.ai.set(pr.number, { loading: true });
  renderPrs();
  try { local.ai.set(pr.number, await api(`/api/prs/${pr.number}/ai-review`)); }
  catch (err) { local.ai.set(pr.number, { error: err.message }); }
  renderPrs();
}

async function runTs(pr) {
  try { local.ts = await post(`/api/prs/${pr.number}/ts`); } catch (err) { return toast(err.message, 'bad'); }
  renderPrs();
  const poll = async () => {
    const tsResult = await api('/api/ts').catch(() => null);
    if (tsResult) local.ts = tsResult.status;
    renderPrs();
    if (tsResult?.status.running) setTimeout(poll, 3000);
  };
  setTimeout(poll, 3000);
}

function tsResultChip(pr, result) {
  const delta = result.delta;
  const color = delta === null ? '' : delta > 0 ? 'red' : delta < 0 ? 'green' : '';
  return el('button', {
    class: `chip chip-btn ${color}`, type: 'button',
    title: `${result.count} errors at ${result.sha.slice(0, 7)}. Click to recheck.`, onclick: () => runTs(pr),
  }, delta === null ? `${result.count} TS errors` : `TS ${delta > 0 ? '+' : ''}${delta}`);
}

function tsNode(pr) {
  const result = local.ts.prResults?.[pr.number];
  const running = local.ts.running?.target === `pr-${pr.number}`;
  if (running) {
    return el('span', { class: 'chip' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'TS check');
  }
  if (result) return tsResultChip(pr, result);
  return el('button', {
    class: 'linkish', type: 'button', disabled: Boolean(local.ts.running), onclick: () => runTs(pr),
  }, 'TS check');
}

// Markdown from the review bot, built node by node with textContent (see markdown.js).
function mdInline(nodes) {
  return nodes.map((n) => {
    if (n.t === 'text') return n.v;
    if (n.t === 'code') return el('code', {}, n.v);
    if (n.t === 'b') return el('strong', {}, mdInline(n.v));
    if (n.t === 'i') return el('em', {}, mdInline(n.v));
    return ext(n.href, ...mdInline(n.v));
  });
}

function mdBlock(block) {
  switch (block.type) {
    case 'h': return el(`h${Math.min(6, block.level + 2)}`, { class: 'md-h' }, mdInline(block.inlines));
    case 'hr': return el('hr', {});
    case 'code': return el('pre', { class: 'md-code' }, el('code', {}, block.text));
    case 'quote': return el('blockquote', {}, mdInline(block.inlines));
    case 'table': return el('div', { class: 'md-table' }, el('table', {},
      el('thead', {}, el('tr', {}, block.rows[0].map((cell) => el('th', {}, mdInline(cell))))),
      el('tbody', {}, block.rows.slice(1).map((row) => el('tr', {}, row.map((cell) => el('td', {}, mdInline(cell))))))));
    case 'list': return el(block.ordered ? 'ol' : 'ul', { class: 'md-list' }, block.items.map((item) => el('li', {
      class: item.checked === null ? '' : `task ${item.checked ? 'done' : ''}`, style: item.depth ? `margin-left:${item.depth * 16}px` : null,
    }, item.checked === null ? null : el('span', { class: 'md-box', 'aria-label': item.checked ? 'Done' : 'Not done' }, item.checked ? '✓' : ''),
    el('span', {}, mdInline(item.inlines)))));
    default: return el('p', {}, mdInline(block.inlines));
  }
}

function aiBody(state) {
  if (!state) return null;
  if (state.loading) return el('p', { class: 'muted' }, 'Loading…');
  if (state.error) return el('p', { class: 'muted' }, state.error);
  if (!state.summary) return el('p', { class: 'muted' }, 'No AI review on this PR yet.');
  const { header, rest } = botHeader(state.summary.body);
  return [
    el('p', { class: 'muted ai-meta' },
      `${state.inlineCount} inline ${plural(state.inlineCount, 'comment')} · ${ago(state.summary.createdAt)}`,
      header && ` · took ${header.took} · `, header && ext(header.url, 'View job')),
    el('div', { class: 'ai-body md' }, parseMarkdown(rest).map(mdBlock)),
  ];
}

function aiNode(pr) {
  const state = local.ai.get(pr.number);
  return el('details', { class: 'ai', open: Boolean(state), ontoggle: (e) => toggleAi(pr, e.target) },
    el('summary', {}, el('span', { class: 'chev' }, icon('chevron')), icon('sparkle'), 'AI review'), aiBody(state));
}

const MINI_BUILD_DOT = { green: 'success', red: 'failure', orange: 'pending', blue: 'pending' };

function miniBuilds(prNumber) {
  const builds = ctx.shared.builds.filter((b) => b.prNumber === prNumber);
  if (!builds.length) return null;
  const title = builds.map((b) => `${b.label}: ${statusOf(b)[0]}`).join('\n');
  return el('span', { class: 'mini-builds', title },
    builds.map((b) => el('span', { class: `dot ${MINI_BUILD_DOT[statusOf(b)[1]] ?? ''}` })));
}

const checksRing = (pr) => el('span', {
  class: `ring ${pr.checks}`, title: `Checks: ${pr.checks}`, 'aria-label': `Checks: ${pr.checks}`,
});

function behindNote(pr) {
  const behindInfo = local.behind.get(pr.number);
  return behindInfo && !behindInfo.loading && behindInfo.behind > 0 && el('span', {},
    sep(), ` ${behindInfo.behind} behind ${behindInfo.base} `,
    el('button', { class: 'linkish', type: 'button', onclick: () => mergeBase(pr, behindInfo) }, 'Update'));
}

function prActions(pr) {
  const canQa = pr.ticket?.status === 'Dev Review' && pr.approved; // QA waits for GitHub's Approved, like Build
  return el('div', { class: 'row-actions' },
    canQa && smallButton(() => sendToQa(pr), 'Send to QA'),
    canQa && smallButton(() => requestQa(pr), icon('team'), 'Request QA Review'),
    pr.author === ctx.shared.login && !pr.isDraft
      && smallButton(() => (pr.ticketKey ? requestPrReview(pr.ticketKey) : requestReview(pr)), icon('team'), 'Request PR Review'),
    pr.author === ctx.shared.login && pr.ticketKey && smallButton(() => runLocal('update', pr.ticketKey), 'Update from Develop'),
    pr.author === ctx.shared.login && pr.ticketKey && smallButton(() => runLocal('tests', pr.ticketKey), 'Run Tests'),
    pr.approved && el('button', {
      class: 'btn btn-filled btn-small', type: 'button', onclick: () => openBuildSheet(pr),
    }, 'Build'));
}

function reviewStateChip(pr) {
  if (pr.isDraft) return el('span', { class: 'chip' }, 'Draft');
  if (pr.approved) return el('span', { class: 'chip green' }, 'Approved');
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return el('span', { class: 'chip red' }, 'Changes Requested');
  return null;
}

function prRow(pr) {
  requestBehind(pr.number);
  const behind = behindNote(pr);
  return el('li', {},
    el('div', { class: 'row' },
      avatar(pr.author),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(pr.url, pr.title)),
        el('div', { class: 'row-sub' },
          checksRing(pr),
          el('span', { class: 'num' }, `#${pr.number}`), sep(), el('span', {}, pr.author), sep(),
          el('span', { class: 'mono', title: pr.headRefName }, pr.headRefName), behind, sep(),
          tsNode(pr), miniBuilds(pr.number)),
        prActions(pr)),
      el('div', { class: 'row-trail' },
        pr.ticketKey && buildChip(pr.ticketKey),
        ticketChip(pr.ticket, pr.ticketKey),
        pr.stale && el('span', { class: 'chip orange' }, 'Stale'),
        reviewStateChip(pr))),
    aiNode(pr));
}

function visiblePrs() {
  const { shared } = ctx;
  return local.prTab === 'mine'
    ? shared.prs.filter((p) => p.author === shared.login)
    : shared.prs.filter((p) => p.reviewRequestedLogins.includes(shared.login));
}

function renderPrs() {
  const { shared } = ctx;
  const listEl = $('prs');
  showError($('prs-error'), ctx.errors?.prs);
  const list = visiblePrs();
  listEl.setAttribute('aria-busy', String(!shared.prsLoaded));
  if (!shared.prsLoaded) {
    return listEl.replaceChildren(...(ctx.errors?.prs ? [placeholder('Pull requests unavailable.')] : skeleton(4)));
  }
  if (!list.length) {
    return listEl.replaceChildren(local.prTab === 'mine'
      ? empty('pr', 'No open pull requests', 'Start a ticket to open a branch.', 'blue')
      : empty('check', 'Inbox zero', 'No reviews requested from you.'));
  }
  listEl.replaceChildren(...list.map(prRow));
}

// ---------- which build has my fix ----------

async function runLookup(e) {
  e.preventDefault();
  const key = $('lookup-input').value.trim().toUpperCase();
  if (!TICKET_KEY.test(key)) {
    local.lookup = { error: 'Enter a ticket key like TCPMOB-1482.' };
    return renderLookup();
  }
  local.lookup = { loading: true, key };
  renderLookup();
  try {
    local.lookup = { key, ...(await api(`/api/lookup/${key}`)) };
  } catch (err) {
    local.lookup = { key, error: err.message };
  }
  renderLookup();
}

// Green when true, orange when false, gray when unknown (null).
function factChip(value, yesLabel, noLabel) {
  if (value === null) return el('span', { class: 'chip' }, noLabel);
  return value ? el('span', { class: 'chip green' }, yesLabel) : el('span', { class: 'chip orange' }, noLabel);
}

function lookupBuildPills(jiraBuilds) {
  if (!jiraBuilds.length) return el('p', { class: 'muted' }, 'None yet.');
  return el('div', { class: 'build-pills' }, jiraBuilds.map((b) => el('div', { class: 'build-pill' },
    el('span', { class: 'bl' }, `${b.app} · ${b.platform}`),
    el('span', { class: 'bn' }, `#${b.number}`),
    el('span', { class: 'bl' }, ago(b.created)))));
}

function lookupRuns(runs) {
  if (!runs.length) return null;
  return [
    el('p', { class: 'list-label' }, 'Successful dispatch runs on its branch'),
    el('ul', { class: 'plain' },
      runs.slice(0, 8).map((r) => el('li', {}, ext(r.url, r.workflowName), ` · ${ago(r.createdAt)}`))),
  ];
}

function lookupCard(result) {
  const releaseNo = result.onReleaseBranch === null ? 'Release branch not cut' : 'Not on release branch';
  return el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(result.ticket.url, `${result.ticket.key} ${result.ticket.summary}`))),
      el('div', { class: 'row-trail' }, ticketChip(result.ticket))),
    el('div', { class: 'facts' },
      el('span', {}, 'PR ', result.pr ? ext(result.pr.url, `#${result.pr.number}`) : 'none found'),
      factChip(result.mergedToDevelop, 'Merged to develop', 'Not merged to develop'),
      factChip(result.onReleaseBranch, 'On release branch', releaseNo)),
    el('p', { class: 'list-label' }, 'Builds posted to the ticket'),
    lookupBuildPills(result.jiraBuilds),
    lookupRuns(result.runs));
}

function renderLookup() {
  const out = $('lookup-result');
  const lookup = local.lookup;
  if (!lookup) return out.replaceChildren();
  if (lookup.loading) return out.replaceChildren(el('p', { class: 'muted' }, `Looking up ${lookup.key}…`));
  if (lookup.error) return out.replaceChildren(el('div', { class: 'banner error' }, lookup.error));
  out.replaceChildren(lookupCard(lookup));
}

// ---------- view ----------

function render() {
  renderHome();
  renderTriggered();
  renderPrs();
  renderFreshness();
  loadLatestBuilds(visiblePrs().map((pr) => pr.ticketKey));
}

// "Updated N min ago" per section. Jira being off is the banner's job, so it doesn't turn these red.
function renderFreshness() {
  const { shared } = ctx;
  const errors = ctx.errors ?? {};
  sectionFreshness('builds', { at: shared.loadedAt.builds, intervalMs: POLL_MS, error: errors.prs, onRefresh: ctx.refresh });
  sectionFreshness('prs', { at: shared.loadedAt.prs, intervalMs: POLL_MS, error: errors.prs, onRefresh: ctx.refresh });
}

export function segmented(name, options, value, onChange) {
  const select = (e, optionValue) => {
    for (const tab of e.currentTarget.parentElement.children) {
      tab.setAttribute('aria-selected', String(tab === e.currentTarget));
    }
    onChange(optionValue);
  };
  return el('div', { class: 'segmented', role: 'tablist', 'aria-label': name }, options.map(([optionValue, label]) =>
    el('button', {
      role: 'tab', type: 'button', 'aria-selected': String(optionValue === value),
      onclick: (e) => select(e, optionValue),
    }, label)));
}

function lookupSection() {
  return el('section', { 'aria-labelledby': 'lookup-h' },
    el('div', { class: 'section-head' },
      el('div', { class: 'section-title' },
        glyph('search', 'pink', 'sm'),
        el('h3', { id: 'lookup-h' }, 'Which Build Has My Fix?')),
      el('span', { class: 'hint' }, el('kbd', {}, '/'), ' to jump here')),
    el('form', { class: 'lookup', onsubmit: runLookup },
      el('span', { class: 'search-icon' }, icon('search')),
      el('input', {
        id: 'lookup-input', type: 'search', class: 'field', placeholder: 'TCPMOB-1482', 'aria-label': 'Ticket key',
        autocomplete: 'off', spellcheck: 'false',
      }),
      el('button', { class: 'btn btn-filled', type: 'submit' }, 'Look Up')),
    el('div', { id: 'lookup-result' }));
}

function homeSections() {
  const prFilter = segmented('Pull request filter', [['mine', 'Mine'], ['review', 'Review Requested']], local.prTab,
    (tab) => { local.prTab = tab; renderPrs(); });
  return [
    el('div', { id: 'home-cards', class: 'home-cards' }),
    section('builds', 'Triggered Builds', ['hammer', 'indigo'], el('span', { class: 'hint', id: 'retry-hint' })),
    el('details', { class: 'more', id: 'home-more' },
      el('summary', {}, 'More: Pull Requests and Build Lookup'),
      section('prs', 'Pull Requests', ['pr', 'blue'], prFilter),
      lookupSection()),
  ];
}

// The ticket panel can open on any page, so its QA buttons are wired when this module loads, not when Home first shows.
registerTicketActions({
  requestQa: (ticket) => requestQa({ ticket }), sendToQa: (ticket) => sendToQa({ ticket }), requestPrReview: (ticket) => requestPrReview(ticket.key),
});

export default {
  id: 'home',
  title: 'Home',
  mount(container, appCtx) {
    ctx = appCtx;
    container.append(...homeSections());
    $('prs').classList.add('inset-avatar');
    $('builds').style.setProperty('--inset', '56px');
    $('builds-section').hidden = true;
    render();
    loadSlow(); // the server's 30-second copy; Refresh and pull-to-refresh force a rebuild
    setInterval(tickShift, SHIFT_TICK_MS);
  },
  async refresh() { ctx.refresh(); await loadSlow(true); },
  update(shared, errors) {
    ctx.errors = errors;
    render();
    loadSlow();
  },
};
