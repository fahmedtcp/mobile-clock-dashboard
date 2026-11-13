import {
  $, api, post, el, ext, ago, duration, statusOf, statusChip, ticketChip, placeholder, sep, showError, confirmSheet,
  toast, section, icon, glyph, avatar, skeleton, empty, sectionFreshness,
} from '../ui.js';
import { registerTicketActions, buildChip, loadLatestBuilds, ticketLink } from '../tickets-ui.js';
import { submitState, behindStale } from '../notify.js';
import { branchName, TICKET_KEY } from '../shared.js';

let ctx;
const local = {
  prTab: 'mine',
  alertScope: 'mine',
  alerts: [], alertsError: null, alertsAt: 0,
  tickets: [], ticketsError: null, ticketsAt: 0, ticketsLoaded: false,
  loadedAt: { alerts: 0, tickets: 0 }, // when each last loaded successfully (freshness labels)
  behind: new Map(),
  ai: new Map(),        // pr number -> { loading } | { summary, inlineCount } | { error }
  ts: { prResults: {} },
  lookup: null,
  openReasons: new Set(),
  workflows: new Set(),
};
const SLOW_MS = 120000; // alerts and my tickets refresh every 2 minutes
const POLL_MS = 60000; // the shared loop's idle pace (pollDelay in notify.js)
const FAILED_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'];

const plural = (count, word) => `${word}${count === 1 ? '' : 's'}`;
const isFinalFailure = (build) => build.status === 'completed' && FAILED_CONCLUSIONS.includes(build.conclusion);
const smallButton = (onclick, ...children) =>
  el('button', { class: 'btn btn-small', type: 'button', onclick }, ...children);
const linkButton = (href, label) => ext(href, el('span', { class: 'btn btn-small' }, label));

// ---------- data the shared loop doesn't cover ----------

function loadAlerts() {
  return api(`/api/alerts?scope=${local.alertScope}`).then(
    (alerts) => { local.alerts = alerts; local.alertsError = null; local.loadedAt.alerts = Date.now(); },
    (err) => { local.alertsError = err; },
  );
}

function loadTickets() {
  return api('/api/tickets/mine').then(
    (tickets) => {
      Object.assign(local, { tickets, ticketsError: null, ticketsLoaded: true });
      local.loadedAt.tickets = Date.now();
    },
    (err) => { local.ticketsError = err; local.ticketsLoaded = true; },
  );
}

async function loadSlow(force = false) {
  const now = Date.now();
  const jobs = [];
  if (force || now - local.alertsAt > SLOW_MS) {
    local.alertsAt = now;
    jobs.push(loadAlerts());
  }
  if (force || now - local.ticketsAt > SLOW_MS) {
    local.ticketsAt = now;
    jobs.push(loadTickets());
  }
  jobs.push(api('/api/ts').then((tsResult) => { local.ts = tsResult.status; }, () => {}));
  await Promise.all(jobs);
  render();
}

// The Jira banner already explains Jira outages; don't repeat them per section.
const jiraProblem = (err) => Boolean(err) && (err.status === 503 || ctx.shared.jiraOk === false);

// ---------- Today hero ----------

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const scrollTo = (id) => $(id)?.scrollIntoView({
  behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  block: 'start',
});

// One compact, tappable number with its own color. Tinted when it needs you, muted at zero, pulsing while live.
function metric(n, label, { onclick, look, alert = false, live = false }) {
  const state = n === '0' || n === '–' ? 'zero' : alert ? 'alert' : 'has';
  const className = `metric ${state} ${live ? 'live' : ''} g-${look[1]}`;
  return el('button', { type: 'button', class: className, onclick, 'aria-label': `${n} ${label}` },
    el('span', { class: 'metric-icon' }, icon(look[0])),
    el('span', { class: 'metric-in' }, el('b', {}, n), label));
}

// The single most useful next step for one of my own (non-draft) PRs, if any.
function nextStepForMyPr(pr) {
  if (pr.ticket?.status === 'Dev Review') {
    return {
      look: ['team', 'purple'], title: `Ask QA to test ${pr.ticket.key}`, sub: pr.ticket.summary,
      label: 'Request QA Review', run: () => requestQa(pr),
    };
  }
  if (pr.approved) {
    return {
      look: ['hammer', 'indigo'], title: `Build #${pr.number}`, sub: pr.title,
      label: 'Build', primary: true, run: () => openBuildSheet(pr),
    };
  }
  if (!pr.reviewRequestedLogins.length && pr.reviewDecision !== 'CHANGES_REQUESTED') {
    return {
      look: ['team', 'blue'], title: `Get a review for #${pr.number}`, sub: pr.title,
      label: 'Request Review', run: () => requestReview(pr),
    };
  }
  return null;
}

// Up Next: the few things that need you right now, each with the one button that does it.
function upNext() {
  const { shared } = ctx;
  const mine = shared.prs.filter((p) => p.author === shared.login && !p.isDraft);
  const items = mine.map(nextStepForMyPr).filter(Boolean);
  for (const pr of shared.prs.filter((p) => p.reviewRequestedLogins.includes(shared.login)).slice(0, 2)) {
    items.push({
      look: ['pr', 'blue'], title: `Review #${pr.number} for ${pr.author}`, sub: pr.title,
      label: 'Open', run: () => window.open(pr.url, '_blank', 'noopener'),
    });
  }
  const failed = shared.builds.filter(isFinalFailure);
  if (failed.length) {
    items.unshift({
      look: ['alert', 'red'], title: `${failed.length} ${plural(failed.length, 'build')} failed`,
      sub: failed[0].reason?.summary ?? 'See Triggered Builds for the reason',
      label: 'Show', run: () => scrollTo('builds-section'),
    });
  }
  const days = shared.timePending?.count ?? 0;
  if (days) {
    items.push({
      look: ['calendar', 'green'], title: `Confirm ${days} ${plural(days, 'day')} of hours`,
      sub: 'So nothing piles up for Tempo', label: 'Open Time', run: () => ctx.go('time'),
    });
  }
  return items.slice(0, 6);
}

function renderPageHead() {
  const first = (ctx.shared.displayName || '').split(' ')[0];
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('home-head').replaceChildren(el('div', {},
    el('div', { class: 'page-title' }, 'Today'),
    el('div', { class: 'page-sub' }, `${greeting()}${first ? `, ${first}` : ''} · ${date}`)));
}

function upNextRow(item) {
  const buttonClass = `btn btn-small ${item.primary ? 'btn-filled' : ''}`;
  return el('li', {},
    el('div', { class: 'row' },
      glyph(item.look[0], item.look[1]),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, item.title),
        item.sub && el('div', { class: 'row-sub' }, el('span', { class: 'clip' }, item.sub))),
      el('div', { class: 'row-trail' },
        el('button', { type: 'button', class: buttonClass, onclick: item.run }, item.label))));
}

function upNextList() {
  const next = upNext();
  const caughtUpText = ctx.shared.prsLoaded ? 'Nothing needs you right now.' : 'Loading…';
  const list = el('ul', { class: 'group upnext' }, next.length
    ? next.map(upNextRow)
    : [empty('check', 'You\'re all caught up', caughtUpText, 'green')]);
  list.style.setProperty('--inset', '56px');
  return list;
}

function heroMetrics() {
  const { shared } = ctx;
  const mine = shared.prs.filter((p) => p.author === shared.login);
  const active = shared.builds.filter((b) => b.status !== 'completed').length;
  const tsLast = local.ts.last;
  const countOrDash = (value, loaded) => (loaded ? String(value) : '–');
  const days = shared.timePending?.count;
  return el('div', { class: 'metrics', role: 'group', 'aria-label': 'Summary' },
    metric(countOrDash(mine.length, shared.prsLoaded), mine.length === 1 ? 'pull request' : 'pull requests',
      { onclick: () => scrollTo('prs-section'), look: ['pr', 'blue'] }),
    metric(String(active), 'building',
      { onclick: () => scrollTo('builds-section'), look: ['hammer', 'indigo'], live: active > 0 }),
    metric(String(local.alerts.length), 'flagged',
      { onclick: () => scrollTo('alerts-section'), look: ['alert', 'orange'], alert: true }),
    metric(countOrDash(local.tickets.length, local.ticketsLoaded), local.tickets.length === 1 ? 'ticket' : 'tickets',
      { onclick: () => scrollTo('tickets-section'), look: ['ticket', 'purple'] }),
    metric(tsLast ? tsLast.count.toLocaleString() : '–', 'TS errors',
      { onclick: () => ctx.go('quality'), look: ['chart', 'teal'] }),
    metric(String(days ?? '–'), days === 1 ? 'day to confirm' : 'days to confirm',
      { onclick: () => ctx.go('time'), look: ['calendar', 'green'], alert: true }));
}

function renderHero() {
  renderPageHead();
  const list = upNextList();
  $('hero').replaceChildren(
    heroMetrics(),
    el('div', { class: 'section-head' }, el('div', { class: 'section-title' }, el('h3', {}, 'Up Next'))),
    list);
}

// ---------- alerts ----------

function alertRow(alert) {
  return el('li', {},
    el('div', { class: 'row' },
      el('span', { class: 'alert-icon', 'aria-hidden': 'true' }, icon('alert')),
      el('div', { class: 'row-body' }, el('div', {}, alert.text)),
      el('div', { class: 'row-trail' }, linkButton(alert.url, 'Open'))));
}

function renderAlerts() {
  const sec = $('alerts-section');
  sec.hidden = !local.alerts.length && !local.alertsError;
  showError($('alerts-error'), jiraProblem(local.alertsError) ? null : local.alertsError);
  ctx.setBadge('home', local.alerts.length);
  $('alerts').replaceChildren(...local.alerts.map(alertRow));
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

async function createBug(build) {
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

async function installOnSim(build) {
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
    build.status !== 'completed' && el('div', { class: 'progress-line', 'aria-hidden': 'true' }),
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

function ticketRow(ticket) {
  return el('li', {},
    el('div', { class: 'row' },
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(ticket.url, ticket.summary)),
        el('div', { class: 'row-sub' },
          ticketLink(ticket.key), buildChip(ticket.key),
          ticket.fixVersions.length ? [sep(), el('span', {}, ticket.fixVersions.join(', '))] : null)),
      el('div', { class: 'row-trail' },
        ticketChip(ticket),
        ['To Do', 'Open'].includes(ticket.status) && smallButton(() => startTicket(ticket), 'Start'))));
}

function renderTickets() {
  const list = $('tickets');
  showError($('tickets-error'), jiraProblem(local.ticketsError) ? null : local.ticketsError);
  $('tickets-section').hidden = jiraProblem(local.ticketsError);
  if (!local.ticketsLoaded) return list.replaceChildren(...skeleton(3));
  if (!local.tickets.length) {
    return list.replaceChildren(empty('check', 'No active tickets', 'Nothing assigned to you is in progress.'));
  }
  list.replaceChildren(...local.tickets.map(ticketRow));
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

// onReady handler: keeps the confirm button's label and disabled state in step with the test switch.
function syncWithTestSwitch(testBox, liveLabel, isDisabled) {
  return (okBtn) => {
    const sync = () => {
      okBtn.textContent = testBox.checked ? 'Send Test' : liveLabel;
      okBtn.disabled = isDisabled(testBox.checked);
    };
    testBox.addEventListener('change', sync);
    sync();
  };
}

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

// A faithful preview of the Teams card.
function paintReviewPreview(preview, info, note, chosen) {
  const personClass = (person, i) => {
    if (!person.email) return 'tc-plain';
    return i === 0 && person.login === ctx.shared.login ? 'tc-me' : 'tc-at';
  };
  preview.replaceChildren(
    el('div', { class: 'tc-title' }, info.title),
    el('p', {}, 'Hey Team!'),
    el('p', {}, 'Ticket: ', ext(info.ticketUrl, info.key), el('br'), 'PR: ', ext(info.prUrl, `PR#${info.prNumber}`)),
    el('p', {}, 'is ready for Dev-Review, Kindly take a peak at your convenience.'),
    note.value.trim() && el('p', {}, note.value.trim()),
    el('p', {}, 'Thanks'),
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

// The note, mention checkboxes, and a preview that repaints as either changes.
function reviewMessageForm(info) {
  const note = el('textarea', {
    class: 'field', rows: 2, maxlength: 500, placeholder: 'Optional note, for example "Small one, mostly tests"',
    'aria-label': 'Note',
  });
  const people = mentionCheckboxes(info.people);
  const chosen = () => [...people.querySelectorAll('input:checked')]
    .map((input) => info.people.find((p) => p.login === input.value));
  const preview = teamsCard();
  const paint = () => paintReviewPreview(preview, info, note, chosen());
  note.addEventListener('input', paint);
  people.addEventListener('change', paint);
  paint();
  return { note, people, chosen, preview };
}

// Ask the team channel for a review, in the user's own message format. Preview first; nothing sends until confirmed.
async function requestReview(pr) {
  const info = await loadSheetInfo(`/api/prs/${pr.number}/review-request`);
  if (!info) return;
  const cooling = isCoolingDown(info);
  let sentTest = false;
  const test = testSwitch(info, 'Test chat not set up (TEAMS_TEST_WEBHOOK_URL)');
  const { note, people, chosen, preview } = reviewMessageForm(info);
  const ok = await confirmSheet({
    title: 'Request Review on Teams',
    body: info.configured
      ? [
          preview,
          el('div', {}, el('p', { class: 'list-label', 'aria-hidden': 'true' }, 'Mention'), people),
          el('label', { class: 'field-label' }, 'Note', note),
          test.row,
          el('p', { class: 'footnote' }, cooling
            ? cooldownNote(`#${pr.number}`, info.cooldownUntil)
            : 'Posts to your team channel through its Workflows webhook.'),
        ]
      : teamsSetupSteps(),
    confirmLabel: info.testConfigured ? 'Send Test' : 'Send to Teams',
    confirmDisabled: !info.configured || (cooling && !info.testConfigured),
    onReady: syncWithTestSwitch(test.box, 'Send to Teams', (testing) => !info.configured || (!testing && cooling)),
    onConfirm: async () => {
      sentTest = test.box.checked;
      await post(`/api/prs/${pr.number}/review-request`, {
        logins: chosen().map((p) => p.login), note: note.value, test: sentTest,
      });
    },
  });
  if (!ok) return;
  toast(sentTest
    ? 'Sent to your test chat. Open Request Review again and turn off the test switch to send to the team.'
    : `Review requested for #${pr.number}`);
}

function qaFootnote(key, info, cooling) {
  if (cooling) return cooldownNote(key, info.cooldownUntil);
  const { mention, name } = info.tag;
  return mention
    ? `Posts to the QA channel and @mentions ${name}. The ticket status doesn't change.`
    : `Posts to the QA channel. ${name} shows as bold text until its tag ID is added in Settings. `
      + 'The ticket status doesn\'t change.';
}

const qaPreview = (info) => teamsCard(
  el('div', { class: 'tc-title' }, info.title),
  el('p', {}, ext(info.ticketUrl, info.ticketUrl), ' is ready for PRE-QA. Builds are mentioned in the ticket.'),
  el('p', {}, info.tag.mention ? el('span', { class: 'tc-at' }, info.tag.name) : el('strong', {}, info.tag.name)));

// Tell QA the ticket is ready for PRE-QA, in the team's format. Separate from Send to QA for now.
async function requestQa(pr) {
  const key = pr.ticket.key;
  const info = await loadSheetInfo(`/api/tickets/${key}/qa-request`);
  if (!info) return;
  const cooling = isCoolingDown(info);
  let sentTest = false;
  const test = testSwitch(info, 'Test chat not set up');
  const preview = qaPreview(info);
  const ready = info.configured && info.ready;
  const ok = await confirmSheet({
    title: 'Request QA Review on Teams',
    body: [
      preview,
      !info.ready && el('p', { class: 'banner error' }, info.reason),
      info.configured
        ? test.row
        : el('p', { class: 'muted' }, 'The QA channel isn\'t set up. Add its webhook in Settings, under Teams.'),
      el('p', { class: 'footnote' }, qaFootnote(key, info, cooling)),
    ].filter(Boolean),
    confirmLabel: info.testConfigured ? 'Send Test' : 'Send to QA Channel',
    confirmDisabled: !info.ready || (!info.configured && !info.testConfigured),
    onReady: syncWithTestSwitch(test.box, 'Send to QA Channel',
      (testing) => !info.ready || (testing ? !info.testConfigured : !ready || cooling)),
    onConfirm: async () => {
      sentTest = test.box.checked;
      await post(`/api/tickets/${key}/qa-request`, { test: sentTest });
    },
  });
  if (!ok) return;
  toast(sentTest
    ? 'Sent to your test chat. Open Request QA Review again and turn off the test switch to send to QA.'
    : `QA review requested for ${key}`);
}

// ---------- build sheet ----------

function buildCheckboxes() {
  const boxes = ctx.shared.buildConfig.map((config) => {
    const [platform, ...rest] = config.label.split(' ');
    return el('label', { class: 'choice' },
      el('input', { type: 'checkbox', value: config.key, checked: config.defaultChecked !== false }),
      el('span', { class: 'choice-label' }, rest.join(' ')),
      el('span', { class: 'choice-platform' }, platform));
  });
  return el('fieldset', { class: 'choice-list' }, el('legend', { class: 'sr-only' }, 'Builds'), boxes);
}

// Uncheck builds that already started so a retry can't dispatch them twice.
function uncheckStarted(fieldset, startedKeys) {
  for (const key of startedKeys) {
    const box = fieldset.querySelector(`input[value="${key}"]`);
    if (box) box.checked = false;
  }
}

// onReady handler: the confirm button counts the checked builds and locks the list while sending.
function syncBuildButton(fieldset, checked) {
  return (okBtn, isBusy) => {
    const update = () => {
      const state = submitState(checked().length, isBusy());
      okBtn.textContent = state.label;
      okBtn.disabled = state.disabled;
      fieldset.disabled = isBusy();
    };
    okBtn.closest('form').addEventListener('change', update);
    update();
  };
}

async function openBuildSheet(pr) {
  const fieldset = buildCheckboxes();
  const checked = () => [...fieldset.querySelectorAll('input:checked')].map((i) => i.value);
  let made = [];
  const ok = await confirmSheet({
    title: `Build #${pr.number}`,
    body: [
      el('p', { class: 'sheet-title' }, pr.title),
      el('p', { class: 'mono pill-mono' }, pr.headRefName),
      el('div', {}, el('p', { class: 'list-label', 'aria-hidden': 'true' }, 'Dev builds'), fieldset),
      el('p', { class: 'footnote' },
        'Dev builds only. QA and InfoSec aren\'t notified. Network and runner failures are retried automatically.'),
    ],
    onReady: syncBuildButton(fieldset, checked),
    onConfirm: async () => {
      fieldset.disabled = true;
      try {
        made = await post(`/api/prs/${pr.number}/builds`, { keys: checked() });
      } catch (err) {
        uncheckStarted(fieldset, err.data?.started ?? []);
        fieldset.disabled = false;
        throw err;
      }
    },
  });
  if (!ok) return;
  ctx.shared.builds.push(...made);
  toast(`Started ${made.length} ${plural(made.length, 'build')}`, 'ok');
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

function aiBody(state) {
  if (!state) return null;
  if (state.loading) return el('p', { class: 'muted' }, 'Loading…');
  if (state.error) return el('p', { class: 'muted' }, state.error);
  if (!state.summary) return el('p', { class: 'muted' }, 'No AI review on this PR yet.');
  return [
    el('p', { class: 'muted' },
      `${state.inlineCount} inline ${plural(state.inlineCount, 'comment')} · ${ago(state.summary.createdAt)}`),
    el('pre', { class: 'ai-body' }, state.summary.body),
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
  const canQa = pr.ticket?.status === 'Dev Review';
  return el('div', { class: 'row-actions' },
    canQa && smallButton(() => sendToQa(pr), 'Send to QA'),
    canQa && smallButton(() => requestQa(pr), icon('team'), 'Request QA Review'),
    pr.author === ctx.shared.login && !pr.isDraft
      && smallButton(() => requestReview(pr), icon('team'), 'Request Review'),
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

// ---------- actions monitor ----------

function runsQuery() {
  const query = new URLSearchParams();
  if ($('f-workflow').value) query.set('workflow', $('f-workflow').value);
  if ($('f-branch').value.trim()) query.set('branch', $('f-branch').value.trim());
  if ($('f-mine').checked) query.set('mine', '1');
  return query.toString();
}

async function runAction(run, action) {
  const cancelling = action === 'cancel';
  const ok = await confirmSheet({
    title: cancelling ? 'Cancel Run' : 'Rerun Failed Jobs',
    body: [el('p', {}, `${run.workflowName} on `, el('span', { class: 'mono' }, run.headBranch))],
    confirmLabel: cancelling ? 'Cancel Run' : 'Rerun',
    danger: cancelling,
    onConfirm: () => post(`/api/runs/${run.databaseId}/${action}`),
  });
  if (ok) ctx.refresh();
}

// Adds workflows seen in any run so far, so the filter keeps options that the current filter hides.
function addWorkflowOptions(runs) {
  for (const run of runs) local.workflows.add(run.workflowName);
  const select = $('f-workflow');
  const known = new Set([...select.options].map((o) => o.textContent));
  for (const name of [...local.workflows].sort()) {
    if (!known.has(name)) select.append(el('option', { value: name }, name));
  }
}

function runRow(run) {
  return el('li', {},
    el('div', { class: 'row' },
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(run.url, run.workflowName)),
        el('div', { class: 'row-sub' },
          el('span', { class: 'mono', title: run.headBranch }, run.headBranch), sep(),
          el('span', {}, run.event.replaceAll('_', ' ')), sep(),
          el('span', {}, ago(run.createdAt)), sep(),
          el('span', { class: 'num' }, duration(run)))),
      el('div', { class: 'row-trail' },
        statusChip(run),
        run.conclusion === 'failure' && smallButton(() => runAction(run, 'rerun'), 'Rerun'),
        run.status !== 'completed' && el('button', {
          class: 'btn btn-small btn-danger', type: 'button', onclick: () => runAction(run, 'cancel'),
        }, 'Cancel'))));
}

function renderRuns() {
  const { shared } = ctx;
  showError($('runs-error'), ctx.errors?.runs);
  addWorkflowOptions(shared.runs);
  if (!shared.runsLoaded) return $('runs').replaceChildren(...skeleton(4));
  if (!shared.runs.length) {
    return $('runs').replaceChildren(empty('bolt', 'No runs', 'Nothing matches these filters.', 'gray'));
  }
  $('runs').replaceChildren(...shared.runs.map(runRow));
}

// ---------- view ----------

function render() {
  renderHero();
  renderAlerts();
  renderTriggered();
  renderTickets();
  renderPrs();
  renderRuns();
  renderFreshness();
  loadLatestBuilds([...local.tickets.map((t) => t.key), ...visiblePrs().map((pr) => pr.ticketKey)]);
}

// "Updated N min ago" per section. Jira being off is the banner's job, so it doesn't turn these red.
function renderFreshness() {
  const { shared } = ctx;
  const errors = ctx.errors ?? {};
  const jiraError = (err) => (jiraProblem(err) ? null : err);
  const reloadSlow = () => loadSlow(true);
  sectionFreshness('alerts', { at: local.loadedAt.alerts, intervalMs: SLOW_MS, error: jiraError(local.alertsError), onRefresh: reloadSlow });
  sectionFreshness('tickets', { at: local.loadedAt.tickets, intervalMs: SLOW_MS, error: jiraError(local.ticketsError), onRefresh: reloadSlow });
  sectionFreshness('builds', { at: shared.loadedAt.builds, intervalMs: POLL_MS, error: errors.prs, onRefresh: ctx.refresh });
  sectionFreshness('prs', { at: shared.loadedAt.prs, intervalMs: POLL_MS, error: errors.prs, onRefresh: ctx.refresh });
  sectionFreshness('runs', { at: shared.loadedAt.runs, intervalMs: POLL_MS, error: errors.runs, onRefresh: ctx.refresh });
}

function segmented(name, options, value, onChange) {
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

function runFilters() {
  let branchTimer;
  const applyFilters = () => ctx.setRunsQuery(runsQuery());
  return el('div', { class: 'filters' },
    el('select', { id: 'f-workflow', 'aria-label': 'Workflow', onchange: applyFilters },
      el('option', { value: '' }, 'All workflows')),
    el('input', {
      id: 'f-branch', type: 'search', placeholder: 'Branch', 'aria-label': 'Branch',
      autocomplete: 'off', spellcheck: 'false',
      oninput: () => { clearTimeout(branchTimer); branchTimer = setTimeout(applyFilters, 400); },
    }),
    el('label', { class: 'switch' },
      el('input', { type: 'checkbox', id: 'f-mine', role: 'switch', onchange: applyFilters }),
      el('span', {}, 'Mine')));
}

function homeSections() {
  const alertScope = segmented('Alert scope', [['mine', 'Mine'], ['team', 'Team']], local.alertScope,
    (scope) => { local.alertScope = scope; local.alertsAt = 0; loadSlow(); });
  const prFilter = segmented('Pull request filter', [['mine', 'Mine'], ['review', 'Review Requested']], local.prTab,
    (tab) => { local.prTab = tab; renderPrs(); });
  return [
    el('div', { class: 'page-head', id: 'home-head' }),
    el('section', { id: 'hero', class: 'hero', 'aria-label': 'Today' }),
    section('alerts', 'Needs Attention', ['alert', 'orange'], alertScope),
    section('builds', 'Triggered Builds', ['hammer', 'indigo'], el('span', { class: 'hint', id: 'retry-hint' })),
    section('tickets', 'My Tickets', ['ticket', 'purple']),
    section('prs', 'My Pull Requests', ['pr', 'blue'], prFilter),
    lookupSection(),
    section('runs', 'Actions', ['bolt', 'teal'], runFilters()),
  ];
}

// The ticket panel can open on any page, so its QA buttons are wired when this module loads, not when Home first shows.
registerTicketActions({ requestQa: (ticket) => requestQa({ ticket }), sendToQa: (ticket) => sendToQa({ ticket }) });

export default {
  id: 'home',
  title: 'Home',
  mount(container, appCtx) {
    ctx = appCtx;
    container.append(...homeSections());
    $('prs').classList.add('inset-avatar');
    $('builds').style.setProperty('--inset', '56px');
    $('alerts').style.setProperty('--inset', '52px');
    $('alerts-section').hidden = true;
    $('builds-section').hidden = true;
    render();
    loadSlow(true);
  },
  async refresh() { ctx.refresh(); await loadSlow(true); },
  update(shared, errors) {
    ctx.errors = errors;
    render();
    loadSlow();
  },
};
