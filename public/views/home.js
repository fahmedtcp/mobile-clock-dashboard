import { $, api, post, el, ext, ago, duration, statusOf, statusChip, ticketChip, placeholder, sep, showError, confirmSheet, toast, section, icon, glyph, avatar, skeleton, empty } from '../ui.js';
import { submitState, behindStale } from '../notify.js';
import { branchName, TICKET_KEY } from '../shared.js';

let ctx;
const local = {
  prTab: 'mine',
  alertScope: 'mine',
  alerts: [], alertsError: null, alertsAt: 0,
  tickets: [], ticketsError: null, ticketsAt: 0, ticketsLoaded: false,
  behind: new Map(),
  ai: new Map(),        // pr number -> { loading } | { summary, inlineCount } | { error }
  ts: { prResults: {} },
  lookup: null,
  openReasons: new Set(),
  workflows: new Set(),
};
const SLOW_MS = 120000; // alerts and my tickets refresh every 2 minutes

// ---------- data the shared loop doesn't cover ----------

async function loadSlow(force = false) {
  const now = Date.now();
  const jobs = [];
  if (force || now - local.alertsAt > SLOW_MS) {
    local.alertsAt = now;
    jobs.push(api(`/api/alerts?scope=${local.alertScope}`).then((a) => { local.alerts = a; local.alertsError = null; }, (e) => { local.alertsError = e; }));
  }
  if (force || now - local.ticketsAt > SLOW_MS) {
    local.ticketsAt = now;
    jobs.push(api('/api/tickets/mine').then((t) => { local.tickets = t; local.ticketsError = null; local.ticketsLoaded = true; }, (e) => { local.ticketsError = e; local.ticketsLoaded = true; }));
  }
  jobs.push(api('/api/ts').then((t) => { local.ts = t.status; }, () => {}));
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

function tile({ target, go, look, n, label, foot = '', tone = '' }) {
  return el('button', { type: 'button', class: 'tile', onclick: () => (go ? ctx.go(go) : $(target)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })) },
    el('div', { class: 'tile-top' }, glyph(look[0], look[1]), el('span', { class: 'chev' }, icon('chevron'))),
    el('div', {}, el('div', { class: 'tile-n' }, n), el('div', { class: 'tile-l' }, label)),
    el('div', { class: `tile-foot ${tone}` }, foot));
}

function renderHero() {
  const { shared } = ctx;
  const mine = shared.prs.filter((p) => p.author === shared.login);
  const approved = mine.filter((p) => p.approved).length;
  const reviewing = shared.prs.filter((p) => p.reviewRequestedLogins.includes(shared.login)).length;
  const active = shared.builds.filter((b) => b.status !== 'completed').length;
  const failed = shared.builds.filter((b) => b.status === 'completed' && ['failure', 'timed_out', 'startup_failure'].includes(b.conclusion)).length;
  const devReview = local.tickets.filter((t) => t.status === 'Dev Review').length;
  const tsLast = local.ts.last;
  const first = (shared.displayName || '').split(' ')[0];
  const n = (v, loaded) => (loaded ? String(v) : '–');

  $('hero').replaceChildren(
    el('div', {},
      el('div', { class: 'greeting' }, `${greeting()}${first ? `, ${first}` : ''}`),
      el('div', { class: 'greeting-sub' }, new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
        local.alerts.length ? ` · ${local.alerts.length} thing${local.alerts.length === 1 ? '' : 's'} need${local.alerts.length === 1 ? 's' : ''} attention` : ' · All clear')),
    el('div', { class: 'tiles' },
      tile({ target: 'prs-section', look: ['pr', 'blue'], n: n(mine.length, shared.prsLoaded), label: 'My Pull Requests', foot: approved ? `${approved} approved` : reviewing ? `${reviewing} to review` : '', tone: approved ? 'good' : '' }),
      tile({ target: 'builds-section', look: ['hammer', 'indigo'], n: String(active), label: 'Builds Running', foot: failed ? `${failed} failed` : shared.builds.length ? `${shared.builds.length} today` : 'None started', tone: failed ? 'warn' : '' }),
      tile({ target: 'alerts-section', look: ['alert', local.alerts.length ? 'orange' : 'green'], n: String(local.alerts.length), label: 'Needs Attention', foot: local.alerts.length ? 'Tap to review' : 'Nothing flagged', tone: local.alerts.length ? 'warn' : 'good' }),
      tile({ target: 'tickets-section', look: ['ticket', 'purple'], n: n(local.tickets.length, local.ticketsLoaded), label: 'My Tickets', foot: devReview ? `${devReview} in Dev Review` : '' }),
      tile({ target: 'runs-section', look: ['chart', 'teal'], n: tsLast ? tsLast.count.toLocaleString() : '–', label: 'TS Errors on develop', foot: tsLast ? ago(tsLast.at) : 'Not counted yet' }),
      tile({ go: 'time', look: ['calendar', shared.timePending?.count ? 'green' : 'gray'], n: String(shared.timePending?.count ?? '–'), label: 'Days to Confirm', foot: shared.timePending?.count ? 'Open Time' : 'All caught up', tone: shared.timePending?.count ? 'warn' : 'good' })));
}

// ---------- alerts ----------

function renderAlerts() {
  const sec = $('alerts-section');
  sec.hidden = !local.alerts.length && !local.alertsError;
  showError($('alerts-error'), jiraProblem(local.alertsError) ? null : local.alertsError);
  ctx.setBadge('home', local.alerts.length);
  $('alerts').replaceChildren(...local.alerts.map((a) => el('li', {},
    el('div', { class: 'row' },
      el('span', { class: 'alert-icon', 'aria-hidden': 'true' }, icon('alert')),
      el('div', { class: 'row-body' }, el('div', {}, a.text)),
      el('div', { class: 'row-trail' }, ext(a.url, el('span', { class: 'btn btn-small' }, 'Open')))))));
}

// ---------- triggered builds ----------

async function createBug(b) {
  const summary = el('input', { class: 'field', value: `CI build failure: ${b.label} on ${b.branch}`, maxlength: 255, required: true, 'aria-label': 'Summary' });
  const description = el('textarea', { class: 'field', rows: 8, 'aria-label': 'Description' });
  description.value = [
    `${b.label} failed for PR #${b.prNumber} on ${b.branch} after ${b.attempt ?? 1} attempt(s).`,
    `Failed step: ${b.reason?.step ?? 'unknown'}`,
    b.classification ? `Type: ${b.classification.label}` : null,
    `Run: ${b.url ?? 'n/a'}`,
    '```', ...(b.reason?.lines ?? []), '```',
  ].filter((l) => l !== null).join('\n');
  let created;
  const ok = await confirmSheet({
    title: 'Create Jira Bug',
    body: [
      el('p', { class: 'muted' }, 'Creates a Bug in TCPMOB, linked to the PR\'s ticket when it has one.'),
      el('label', { class: 'field-label' }, 'Summary', summary),
      el('label', { class: 'field-label' }, 'Description', description),
    ],
    confirmLabel: 'Create Bug',
    onConfirm: async () => { created = await post(`/api/builds/${b.id}/bug`, { summary: summary.value, description: description.value }); },
  });
  if (ok) toast(created.linkError ? `Created ${created.key}, but couldn't link it: ${created.linkError}` : `Created ${created.key}`, created.linkError ? 'bad' : 'ok');
}

async function installOnSim(b) {
  let sims = [];
  try { sims = await api('/api/simulators'); } catch (err) { return toast(err.message, 'bad'); }
  const select = el('select', { class: 'field', 'aria-label': 'Simulator' }, sims.map((s) => el('option', { value: s.udid }, `${s.name} · ${s.runtime}`)));
  const ok = await confirmSheet({
    title: 'Install on Simulator',
    body: sims.length
      ? [el('p', { class: 'muted' }, `Downloads the .app from run #${b.runId}, installs it, and launches it.`), el('label', { class: 'field-label' }, 'Simulator', select)]
      : [el('p', {}, 'No simulator is booted. Boot one in Xcode or with `xcrun simctl boot`, then try again.')],
    confirmLabel: 'Install',
    confirmDisabled: !sims.length,
    onConfirm: () => post(`/api/runs/${b.runId}/install`, { udid: select.value }),
  });
  if (ok) toast('Installed and launched', 'ok');
}

function renderTriggered() {
  const builds = [...ctx.shared.builds].sort((a, b) => b.triggeredAt - a.triggeredAt);
  $('builds-section').hidden = !builds.length;
  const max = builds[0]?.maxRetries;
  $('retry-hint').textContent = max ? `Network and runner failures retry up to ${max} times` : '';
  $('builds').replaceChildren(...builds.map((b) => {
    const finalFail = b.status === 'completed' && ['failure', 'timed_out', 'startup_failure'].includes(b.conclusion);
    const attempts = (b.maxRetries ?? 0) + 1;
    const cls = b.classification && el('span', { class: `chip ${b.classification.kind === 'code' ? 'red' : b.classification.kind === 'infra' ? 'orange' : ''}` },
      b.classification.kind === 'code' && b.status === 'completed' ? `${b.classification.label}, not retried` : b.classification.label);
    const reason = b.reason && el('details', {
      class: 'reason', open: local.openReasons.has(b.id),
      ontoggle: (e) => (e.target.open ? local.openReasons.add(b.id) : local.openReasons.delete(b.id)),
    }, el('summary', {}, b.reason.step), b.reason.lines.length ? el('pre', {}, b.reason.lines.join('\n')) : null);
    return el('li', {},
      el('div', { class: 'row' },
        glyph(b.label.startsWith('iOS') ? 'phone' : 'hammer', b.label.startsWith('iOS') ? 'gray' : 'green'),
        el('div', { class: 'row-body' },
          el('div', { class: 'row-title' }, b.label),
          el('div', { class: 'row-sub' }, el('span', { class: 'num' }, `#${b.prNumber}`), sep(), el('span', { class: 'mono' }, b.branch), sep(), el('span', {}, ago(new Date(b.triggeredAt).toISOString())))),
        el('div', { class: 'row-trail' },
          (b.attempt > 1 || b.retries) && el('span', { class: 'build-attempt' }, `Attempt ${b.attempt ?? 1} of ${attempts}`),
          cls, statusChip(b),
          finalFail && el('button', { class: 'btn btn-small', type: 'button', onclick: () => createBug(b) }, 'Create Jira Bug'),
          b.key === 'mcIosSim' && b.conclusion === 'success' && el('button', { class: 'btn btn-small', type: 'button', onclick: () => installOnSim(b) }, 'Install on Simulator'),
          b.url && ext(b.url, el('span', { class: 'btn btn-small' }, 'Logs')))),
      b.status !== 'completed' && el('div', { class: 'progress-line', 'aria-hidden': 'true' }),
      reason);
  }));
}

// ---------- my tickets ----------

async function startTicket(t) {
  const branch = branchName(t.key, t.summary);
  let started;
  const ok = await confirmSheet({
    title: `Start ${t.key}`,
    body: [
      el('p', {}, t.summary),
      el('p', { class: 'muted' }, 'Creates this branch on GitHub from the latest develop:'),
      el('p', { class: 'mono pill-mono' }, branch),
      el('p', { class: 'muted' }, t.assignee ? `Already assigned to ${t.assignee.name}; assignment won't change.` : 'Assigns the ticket to you. The ticket status doesn\'t change.'),
      el('p', { class: 'muted' }, `Then run: git fetch && git switch ${branch}`),
    ],
    confirmLabel: 'Create Branch',
    onConfirm: async () => { started = await post(`/api/tickets/${t.key}/start`); },
  });
  if (ok) { toast(started.existed ? `${branch} already existed${started.assigned ? '; assigned to you' : ''}` : `Created ${branch}`, 'ok'); loadSlow(true); }
}

function renderTickets() {
  const list = $('tickets');
  showError($('tickets-error'), jiraProblem(local.ticketsError) ? null : local.ticketsError);
  $('tickets-section').hidden = jiraProblem(local.ticketsError);
  if (!local.ticketsLoaded) return list.replaceChildren(...skeleton(3));
  if (!local.tickets.length) return list.replaceChildren(empty('check', 'No active tickets', 'Nothing assigned to you is in progress.'));
  list.replaceChildren(...local.tickets.map((t) => el('li', {},
    el('div', { class: 'row' },
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(t.url, t.summary)),
        el('div', { class: 'row-sub' }, el('span', { class: 'num' }, t.key), t.fixVersions.length ? [sep(), el('span', {}, t.fixVersions.join(', '))] : null)),
      el('div', { class: 'row-trail' },
        ticketChip(t),
        ['To Do', 'Open'].includes(t.status) && el('button', { class: 'btn btn-small', type: 'button', onclick: () => startTicket(t) }, 'Start'))))));
}

// ---------- pull requests ----------

const behindQueue = [];
let behindRunning = false;
async function drainBehind() {
  if (behindRunning) return;
  behindRunning = true;
  while (behindQueue.length) {
    const n = behindQueue.shift();
    try { local.behind.set(n, { ...(await api(`/api/prs/${n}/behind`)), at: Date.now() }); }
    catch { local.behind.set(n, { error: true, behind: 0, base: '', at: Date.now() }); }
  }
  behindRunning = false;
  renderPrs();
}
function requestBehind(n) {
  if (!behindStale(local.behind.get(n), Date.now())) return;
  local.behind.set(n, { loading: true });
  behindQueue.push(n);
  drainBehind();
}

async function mergeBase(pr, info) {
  const ok = await confirmSheet({
    title: `Update #${pr.number}`,
    body: [el('p', {}, `Merges ${info.base} into ${pr.headRefName}. This pushes a merge commit to the PR branch.`)],
    confirmLabel: 'Merge Base In',
    onConfirm: () => post(`/api/prs/${pr.number}/update-branch`),
  });
  if (ok) { local.behind.clear(); renderPrs(); toast('Branch updated', 'ok'); }
}

async function sendToQa(pr) {
  const t = pr.ticket;
  let builds = [];
  let lookupError = null;
  try { builds = (await api(`/api/lookup/${t.key}`)).jiraBuilds; } catch (err) { lookupError = err; }
  const latest = new Map();
  for (const b of builds) { const k = `${b.app} ${b.platform}`; if (!latest.has(k)) latest.set(k, b); }
  const ok = await confirmSheet({
    title: 'Send to QA',
    body: [
      el('p', {}, el('strong', {}, t.key), ` ${t.summary}`),
      el('p', { class: 'transition' }, el('span', { class: 'chip blue' }, t.status), ' → ', el('span', { class: 'chip orange' }, 'QA Review')),
      latest.size
        ? el('div', {}, el('p', { class: 'list-label' }, 'Latest builds on the ticket'), el('ul', { class: 'plain' }, [...latest.values()].map((b) => el('li', {}, `${b.app} ${b.platform} · build ${b.number}`))))
        : el('p', { class: 'muted' }, lookupError ? `Couldn't read builds: ${lookupError.message}` : 'No dev build has been posted to this ticket yet. Build it first.'),
      el('p', { class: 'muted' }, 'Only the status changes. No comment is posted.'),
    ],
    confirmLabel: 'Send to QA',
    confirmDisabled: !latest.size,
    onConfirm: () => post(`/api/tickets/${t.key}/qa`),
  });
  if (ok) { toast(`${t.key} moved to QA Review`, 'ok'); ctx.refresh(); }
}

// Ask the team channel for a review, in the user's own message format. Preview first; nothing sends until confirmed.
async function requestReview(pr) {
  let info;
  try { info = await api(`/api/prs/${pr.number}/review-request`); } catch (err) { return toast(err.message, 'bad'); }
  const cooling = info.cooldownUntil && info.cooldownUntil > Date.now();
  let sentTest = false;
  // Test mode: send to the user's own chat first (on by default when it's set up).
  const testBox = el('input', { type: 'checkbox', role: 'switch', checked: info.testConfigured, disabled: !info.testConfigured });
  const testRow = el('label', { class: 'switch test-switch', title: info.testConfigured ? '' : 'Add a test chat webhook in Settings to turn this on' }, testBox,
    el('span', {}, info.testConfigured ? 'Send to my test chat first' : 'Test chat not set up (TEAMS_TEST_WEBHOOK_URL)'));
  const note = el('textarea', { class: 'field', rows: 2, maxlength: 500, placeholder: 'Optional note, for example "Small one, mostly tests"', 'aria-label': 'Note' });
  const boxes = info.people.map((p) => el('label', { class: 'choice' },
    el('input', { type: 'checkbox', value: p.login, checked: p.selected }),
    el('span', { class: 'choice-label' }, p.name),
    el('span', { class: 'choice-platform', title: p.email ? p.email : 'No email found, so this shows as plain text. Add an email override in Settings to @mention.' }, p.email ? '@mention' : 'plain name')));
  const people = el('fieldset', { class: 'choice-list' }, el('legend', { class: 'sr-only' }, 'Mention'), boxes);
  const chosen = () => [...people.querySelectorAll('input:checked')].map((i) => info.people.find((p) => p.login === i.value));

  // A faithful preview of the Teams card.
  const preview = el('div', { class: 'teams-card', 'aria-label': 'Message preview' });
  const paint = () => preview.replaceChildren(
    el('div', { class: 'tc-title' }, info.title),
    el('p', {}, 'Hey Team!'),
    el('p', {}, 'Ticket: ', ext(info.ticketUrl, info.key), el('br'), 'PR: ', ext(info.prUrl, `PR#${info.prNumber}`)),
    el('p', {}, 'is ready for Dev-Review, Kindly take a peak at your convenience.'),
    note.value.trim() && el('p', {}, note.value.trim()),
    el('p', {}, 'Thanks'),
    el('p', { class: 'tc-people' }, chosen().map((p, i) => el('span', { class: p.email ? (i === 0 && p.login === ctx.shared.login ? 'tc-me' : 'tc-at') : 'tc-plain' }, p.name))));
  note.addEventListener('input', paint);
  people.addEventListener('change', paint);
  paint();

  const ok = await confirmSheet({
    title: 'Request Review on Teams',
    body: info.configured
      ? [
          preview,
          el('div', {}, el('p', { class: 'list-label', 'aria-hidden': 'true' }, 'Mention'), people),
          el('label', { class: 'field-label' }, 'Note', note),
          testRow,
          el('p', { class: 'footnote' }, cooling ? `Already sent for #${pr.number}. You can send again after ${new Date(info.cooldownUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'Posts to your team channel through its Workflows webhook.'),
        ]
      : [el('p', {}, 'Teams isn\'t set up yet.'), el('ol', { class: 'steps' },
          el('li', {}, 'In the Teams channel, open ••• → Workflows → "Post to a channel when a webhook request is received".'),
          el('li', {}, 'Copy the URL it gives you.'),
          el('li', {}, 'Paste it into Settings, under Teams.'))],
    confirmLabel: info.testConfigured ? 'Send Test' : 'Send to Teams',
    confirmDisabled: !info.configured || (cooling && !info.testConfigured),
    onReady: (okBtn) => {
      const sync = () => {
        okBtn.textContent = testBox.checked ? 'Send Test' : 'Send to Teams';
        okBtn.disabled = !info.configured || (!testBox.checked && cooling);
      };
      testBox.addEventListener('change', sync);
      sync();
    },
    onConfirm: async () => { sentTest = testBox.checked; await post(`/api/prs/${pr.number}/review-request`, { logins: chosen().map((p) => p.login), note: note.value, test: sentTest }); },
  });
  if (ok) toast(sentTest ? 'Sent to your test chat. Open Request Review again and turn off the test switch to send to the team.' : `Review requested for #${pr.number}`);
}

// Tell QA the ticket is ready for PRE-QA, in the team's format. Separate from Send to QA for now.
async function requestQa(pr) {
  const key = pr.ticket.key;
  let info;
  try { info = await api(`/api/tickets/${key}/qa-request`); } catch (err) { return toast(err.message, 'bad'); }
  const cooling = info.cooldownUntil && info.cooldownUntil > Date.now();
  let sentTest = false;
  const testBox = el('input', { type: 'checkbox', role: 'switch', checked: info.testConfigured, disabled: !info.testConfigured });
  const testRow = el('label', { class: 'switch test-switch', title: info.testConfigured ? '' : 'Add a test chat webhook in Settings to turn this on' }, testBox,
    el('span', {}, info.testConfigured ? 'Send to my test chat first' : 'Test chat not set up'));
  const preview = el('div', { class: 'teams-card', 'aria-label': 'Message preview' },
    el('div', { class: 'tc-title' }, info.title),
    el('p', {}, ext(info.ticketUrl, info.ticketUrl), ' is ready for PRE-QA. Builds are mentioned in the ticket.'),
    el('p', {}, info.tag.mention ? el('span', { class: 'tc-at' }, info.tag.name) : el('strong', {}, info.tag.name)));
  const ready = info.configured && info.ready;
  const ok = await confirmSheet({
    title: 'Request QA Review on Teams',
    body: [
      preview,
      !info.ready && el('p', { class: 'banner error' }, info.reason),
      info.configured ? testRow : el('p', { class: 'muted' }, 'The QA channel isn\'t set up. Add its webhook in Settings, under Teams.'),
      el('p', { class: 'footnote' }, cooling
        ? `Already sent for ${key}. You can send again after ${new Date(info.cooldownUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
        : info.tag.mention ? `Posts to the QA channel and @mentions ${info.tag.name}. The ticket status doesn't change.` : `Posts to the QA channel. ${info.tag.name} shows as bold text until its tag ID is added in Settings. The ticket status doesn't change.`),
    ].filter(Boolean),
    confirmLabel: info.testConfigured ? 'Send Test' : 'Send to QA Channel',
    confirmDisabled: !info.ready || (!info.configured && !info.testConfigured),
    onReady: (okBtn) => {
      const sync = () => {
        okBtn.textContent = testBox.checked ? 'Send Test' : 'Send to QA Channel';
        okBtn.disabled = !info.ready || (testBox.checked ? !info.testConfigured : !ready || cooling);
      };
      testBox.addEventListener('change', sync);
      sync();
    },
    onConfirm: async () => { sentTest = testBox.checked; await post(`/api/tickets/${key}/qa-request`, { test: sentTest }); },
  });
  if (ok) toast(sentTest ? 'Sent to your test chat. Open Request QA Review again and turn off the test switch to send to QA.' : `QA review requested for ${key}`);
}

async function openBuildSheet(pr) {
  const boxes = ctx.shared.buildConfig.map((b) => {
    const [platform, ...rest] = b.label.split(' ');
    return el('label', { class: 'choice' },
      el('input', { type: 'checkbox', value: b.key, checked: b.defaultChecked !== false }),
      el('span', { class: 'choice-label' }, rest.join(' ')),
      el('span', { class: 'choice-platform' }, platform));
  });
  const fieldset = el('fieldset', { class: 'choice-list' }, el('legend', { class: 'sr-only' }, 'Builds'), boxes);
  const checked = () => [...fieldset.querySelectorAll('input:checked')].map((i) => i.value);
  let made = [];
  const ok = await confirmSheet({
    title: `Build #${pr.number}`,
    body: [
      el('p', { class: 'sheet-title' }, pr.title),
      el('p', { class: 'mono pill-mono' }, pr.headRefName),
      el('div', {}, el('p', { class: 'list-label', 'aria-hidden': 'true' }, 'Dev builds'), fieldset),
      el('p', { class: 'footnote' }, 'Dev builds only. QA and InfoSec aren\'t notified. Network and runner failures are retried automatically.'),
    ],
    onReady: (okBtn, isBusy) => {
      const update = () => {
        const s = submitState(checked().length, isBusy());
        okBtn.textContent = s.label;
        okBtn.disabled = s.disabled;
        fieldset.disabled = isBusy();
      };
      okBtn.closest('form').addEventListener('change', update);
      update();
    },
    onConfirm: async () => {
      fieldset.disabled = true;
      try {
        made = await post(`/api/prs/${pr.number}/builds`, { keys: checked() });
      } catch (err) {
        // Uncheck builds that already started so a retry can't dispatch them twice.
        for (const key of err.data?.started ?? []) { const box = fieldset.querySelector(`input[value="${key}"]`); if (box) box.checked = false; }
        fieldset.disabled = false;
        throw err;
      }
    },
  });
  if (ok) { ctx.shared.builds.push(...made); toast(`Started ${made.length} build${made.length === 1 ? '' : 's'}`, 'ok'); ctx.refresh(); }
}

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
    const t = await api('/api/ts').catch(() => null);
    if (t) local.ts = t.status;
    renderPrs();
    if (t?.status.running) setTimeout(poll, 3000);
  };
  setTimeout(poll, 3000);
}

function tsNode(pr) {
  const r = local.ts.prResults?.[pr.number];
  const running = local.ts.running?.target === `pr-${pr.number}`;
  if (running) return el('span', { class: 'chip' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'TS check');
  if (r) {
    const d = r.delta;
    const color = d === null ? '' : d > 0 ? 'red' : d < 0 ? 'green' : '';
    return el('button', { class: `chip chip-btn ${color}`, type: 'button', title: `${r.count} errors at ${r.sha.slice(0, 7)}. Click to recheck.`, onclick: () => runTs(pr) },
      d === null ? `${r.count} TS errors` : `TS ${d > 0 ? '+' : ''}${d}`);
  }
  return el('button', { class: 'linkish', type: 'button', disabled: Boolean(local.ts.running), onclick: () => runTs(pr) }, 'TS check');
}

function aiNode(pr) {
  const state = local.ai.get(pr.number);
  let body = null;
  if (state?.loading) body = el('p', { class: 'muted' }, 'Loading…');
  else if (state?.error) body = el('p', { class: 'muted' }, state.error);
  else if (state) body = state.summary
    ? [el('p', { class: 'muted' }, `${state.inlineCount} inline comment${state.inlineCount === 1 ? '' : 's'} · ${ago(state.summary.createdAt)}`), el('pre', { class: 'ai-body' }, state.summary.body)]
    : el('p', { class: 'muted' }, 'No AI review on this PR yet.');
  return el('details', { class: 'ai', open: Boolean(state), ontoggle: (e) => toggleAi(pr, e.target) },
    el('summary', {}, el('span', { class: 'chev' }, icon('chevron')), icon('sparkle'), 'AI review'), body);
}

function miniBuilds(prNumber) {
  const builds = ctx.shared.builds.filter((b) => b.prNumber === prNumber);
  if (!builds.length) return null;
  const color = (b) => ({ green: 'success', red: 'failure', orange: 'pending', blue: 'pending' })[statusOf(b)[1]] ?? '';
  return el('span', { class: 'mini-builds', title: builds.map((b) => `${b.label}: ${statusOf(b)[0]}`).join('\n') }, builds.map((b) => el('span', { class: `dot ${color(b)}` })));
}

function renderPrs() {
  const { shared } = ctx;
  showError($('prs-error'), ctx.errors?.prs);
  const list = local.prTab === 'mine' ? shared.prs.filter((p) => p.author === shared.login) : shared.prs.filter((p) => p.reviewRequestedLogins.includes(shared.login));
  $('prs').setAttribute('aria-busy', String(!shared.prsLoaded));
  if (!shared.prsLoaded) return $('prs').replaceChildren(...(ctx.errors?.prs ? [placeholder('Pull requests unavailable.')] : skeleton(4)));
  if (!list.length) return $('prs').replaceChildren(local.prTab === 'mine' ? empty('pr', 'No open pull requests', 'Start a ticket to open a branch.', 'blue') : empty('check', 'Inbox zero', 'No reviews requested from you.'));
  $('prs').replaceChildren(...list.map((pr) => {
    requestBehind(pr.number);
    const info = local.behind.get(pr.number);
    const behind = info && !info.loading && info.behind > 0 && el('span', {}, sep(), ` ${info.behind} behind ${info.base} `,
      el('button', { class: 'linkish', type: 'button', onclick: () => mergeBase(pr, info) }, 'Update'));
    const canQa = pr.ticket?.status === 'Dev Review';
    return el('li', {},
      el('div', { class: 'row' },
        avatar(pr.author),
        el('div', { class: 'row-body' },
          el('div', { class: 'row-title' }, ext(pr.url, pr.title)),
          el('div', { class: 'row-sub' },
            el('span', { class: `ring ${pr.checks}`, title: `Checks: ${pr.checks}`, 'aria-label': `Checks: ${pr.checks}` }),
            el('span', { class: 'num' }, `#${pr.number}`), sep(), el('span', {}, pr.author), sep(),
            el('span', { class: 'mono', title: pr.headRefName }, pr.headRefName), behind, sep(), tsNode(pr), miniBuilds(pr.number)),
          el('div', { class: 'row-actions' },
          canQa && el('button', { class: 'btn btn-small', type: 'button', onclick: () => sendToQa(pr) }, 'Send to QA'),
          canQa && el('button', { class: 'btn btn-small', type: 'button', onclick: () => requestQa(pr) }, icon('team'), 'Request QA Review'),
          pr.author === shared.login && !pr.isDraft && el('button', { class: 'btn btn-small', type: 'button', onclick: () => requestReview(pr) }, icon('team'), 'Request Review'),
          pr.approved && el('button', { class: 'btn btn-filled btn-small', type: 'button', onclick: () => openBuildSheet(pr) }, 'Build'))),
        el('div', { class: 'row-trail' },
          ticketChip(pr.ticket, pr.ticketKey),
          pr.stale && el('span', { class: 'chip orange' }, 'Stale'),
          pr.isDraft ? el('span', { class: 'chip' }, 'Draft') : pr.approved ? el('span', { class: 'chip green' }, 'Approved') : pr.reviewDecision === 'CHANGES_REQUESTED' ? el('span', { class: 'chip red' }, 'Changes Requested') : null)),
      aiNode(pr));
  }));
}

// ---------- which build has my fix ----------

async function runLookup(e) {
  e.preventDefault();
  const key = $('lookup-input').value.trim().toUpperCase();
  if (!TICKET_KEY.test(key)) { local.lookup = { error: 'Enter a ticket key like TCPMOB-1482.' }; return renderLookup(); }
  local.lookup = { loading: true, key };
  renderLookup();
  try { local.lookup = { key, ...(await api(`/api/lookup/${key}`)) }; } catch (err) { local.lookup = { key, error: err.message }; }
  renderLookup();
}

function renderLookup() {
  const out = $('lookup-result');
  const l = local.lookup;
  if (!l) return out.replaceChildren();
  if (l.loading) return out.replaceChildren(el('p', { class: 'muted' }, `Looking up ${l.key}…`));
  if (l.error) return out.replaceChildren(el('div', { class: 'banner error' }, l.error));
  const yes = (v, a, b) => (v === null ? el('span', { class: 'chip' }, b) : v ? el('span', { class: 'chip green' }, a) : el('span', { class: 'chip orange' }, b));
  out.replaceChildren(
    el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('div', { class: 'row-body' }, el('div', { class: 'row-title' }, ext(l.ticket.url, `${l.ticket.key} ${l.ticket.summary}`))),
        el('div', { class: 'row-trail' }, ticketChip(l.ticket))),
      el('div', { class: 'facts' },
        el('span', {}, 'PR ', l.pr ? ext(l.pr.url, `#${l.pr.number}`) : 'none found'),
        yes(l.mergedToDevelop, 'Merged to develop', 'Not merged to develop'),
        yes(l.onReleaseBranch, 'On release branch', l.onReleaseBranch === null ? 'Release branch not cut' : 'Not on release branch')),
      el('p', { class: 'list-label' }, 'Builds posted to the ticket'),
      l.jiraBuilds.length
        ? el('div', { class: 'build-pills' }, l.jiraBuilds.map((b) => el('div', { class: 'build-pill' },
          el('span', { class: 'bl' }, `${b.app} · ${b.platform}`), el('span', { class: 'bn' }, `#${b.number}`), el('span', { class: 'bl' }, ago(b.created)))))
        : el('p', { class: 'muted' }, 'None yet.'),
      l.runs.length ? [el('p', { class: 'list-label' }, 'Successful dispatch runs on its branch'),
        el('ul', { class: 'plain' }, l.runs.slice(0, 8).map((r) => el('li', {}, ext(r.url, r.workflowName), ` · ${ago(r.createdAt)}`)))] : null));
}

// ---------- actions monitor ----------

function runsQuery() {
  const q = new URLSearchParams();
  if ($('f-workflow').value) q.set('workflow', $('f-workflow').value);
  if ($('f-branch').value.trim()) q.set('branch', $('f-branch').value.trim());
  if ($('f-mine').checked) q.set('mine', '1');
  return q.toString();
}

async function runAction(r, action) {
  const ok = await confirmSheet({
    title: action === 'cancel' ? 'Cancel Run' : 'Rerun Failed Jobs',
    body: [el('p', {}, `${r.workflowName} on `, el('span', { class: 'mono' }, r.headBranch))],
    confirmLabel: action === 'cancel' ? 'Cancel Run' : 'Rerun',
    danger: action === 'cancel',
    onConfirm: () => post(`/api/runs/${r.databaseId}/${action}`),
  });
  if (ok) ctx.refresh();
}

function renderRuns() {
  const { shared } = ctx;
  showError($('runs-error'), ctx.errors?.runs);
  for (const r of shared.runs) local.workflows.add(r.workflowName);
  const select = $('f-workflow');
  const known = new Set([...select.options].map((o) => o.textContent));
  for (const w of [...local.workflows].sort()) if (!known.has(w)) select.append(el('option', { value: w }, w));
  if (!shared.runsLoaded) return $('runs').replaceChildren(...skeleton(4));
  if (!shared.runs.length) return $('runs').replaceChildren(empty('bolt', 'No runs', 'Nothing matches these filters.', 'gray'));
  $('runs').replaceChildren(...shared.runs.map((r) => el('li', {},
    el('div', { class: 'row' },
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(r.url, r.workflowName)),
        el('div', { class: 'row-sub' }, el('span', { class: 'mono', title: r.headBranch }, r.headBranch), sep(), el('span', {}, r.event.replaceAll('_', ' ')), sep(), el('span', {}, ago(r.createdAt)), sep(), el('span', { class: 'num' }, duration(r)))),
      el('div', { class: 'row-trail' },
        statusChip(r),
        r.conclusion === 'failure' && el('button', { class: 'btn btn-small', type: 'button', onclick: () => runAction(r, 'rerun') }, 'Rerun'),
        r.status !== 'completed' && el('button', { class: 'btn btn-small btn-danger', type: 'button', onclick: () => runAction(r, 'cancel') }, 'Cancel'))))));
}

// ---------- view ----------

function render() {
  renderHero();
  renderAlerts();
  renderTriggered();
  renderTickets();
  renderPrs();
  renderRuns();
}

function segmented(name, options, value, onChange) {
  return el('div', { class: 'segmented', role: 'tablist', 'aria-label': name }, options.map(([v, label]) =>
    el('button', { role: 'tab', type: 'button', 'aria-selected': String(v === value), onclick: (e) => {
      for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-selected', String(b === e.currentTarget));
      onChange(v);
    } }, label)));
}

export default {
  id: 'home',
  title: 'Home',
  mount(container, appCtx) {
    ctx = appCtx;
    let branchTimer;
    container.append(
      el('section', { id: 'hero', class: 'hero', 'aria-label': 'Today' }),
      section('alerts', 'Needs Attention', ['alert', 'orange'], segmented('Alert scope', [['mine', 'Mine'], ['team', 'Team']], local.alertScope, (v) => { local.alertScope = v; local.alertsAt = 0; loadSlow(); })),
      section('builds', 'Triggered Builds', ['hammer', 'indigo'], el('span', { class: 'hint', id: 'retry-hint' })),
      section('tickets', 'My Tickets', ['ticket', 'purple']),
      section('prs', 'My Pull Requests', ['pr', 'blue'], segmented('Pull request filter', [['mine', 'Mine'], ['review', 'Review Requested']], local.prTab, (v) => { local.prTab = v; renderPrs(); })),
      el('section', { 'aria-labelledby': 'lookup-h' },
        el('div', { class: 'section-head' }, el('div', { class: 'section-title' }, glyph('search', 'pink', 'sm'), el('h3', { id: 'lookup-h' }, 'Which Build Has My Fix?')), el('span', { class: 'hint' }, el('kbd', {}, '/'), ' to jump here')),
        el('form', { class: 'lookup', onsubmit: runLookup },
          el('span', { class: 'search-icon' }, icon('search')),
          el('input', { id: 'lookup-input', type: 'search', class: 'field', placeholder: 'TCPMOB-1482', 'aria-label': 'Ticket key', autocomplete: 'off', spellcheck: 'false' }),
          el('button', { class: 'btn btn-filled', type: 'submit' }, 'Look Up')),
        el('div', { id: 'lookup-result' })),
      section('runs', 'Actions', ['bolt', 'teal'], el('div', { class: 'filters' },
        el('select', { id: 'f-workflow', 'aria-label': 'Workflow', onchange: () => ctx.setRunsQuery(runsQuery()) }, el('option', { value: '' }, 'All workflows')),
        el('input', { id: 'f-branch', type: 'search', placeholder: 'Branch', 'aria-label': 'Branch', autocomplete: 'off', spellcheck: 'false',
          oninput: () => { clearTimeout(branchTimer); branchTimer = setTimeout(() => ctx.setRunsQuery(runsQuery()), 400); } }),
        el('label', { class: 'switch' }, el('input', { type: 'checkbox', id: 'f-mine', role: 'switch', onchange: () => ctx.setRunsQuery(runsQuery()) }), el('span', {}, 'Mine')))),
    );
    $('prs').classList.add('inset-avatar');
    $('builds').style.setProperty('--inset', '56px');
    $('alerts').style.setProperty('--inset', '52px');
    $('alerts-section').hidden = true;
    $('builds-section').hidden = true;
    render();
    loadSlow(true);
  },
  update(shared, errors) {
    ctx.errors = errors;
    render();
    loadSlow();
  },
};
