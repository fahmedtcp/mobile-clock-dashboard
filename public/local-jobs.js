// Run Tests and Update from Develop on the user's own mobile-clock folder: a confirm sheet before anything runs,
// a status bar while it runs (on every page), and a results sheet when it ends. Pushing always asks first.
import { api, post, el, confirmSheet, toast } from './ui.js';

const POLL_MS = 1500;
const LABEL = { tests: 'Run Tests', update: 'Update from Develop' };
let bar = null;
let pollTimer = null;
let shownJobId = null; // the finished job whose sheet was already shown
let outputOpen = true; // the live output shows by default; Hide Output collapses it

const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function statusLines(s, kind) {
  const what = kind === 'tests' ? 'Runs npm run test-cov (the full suite with coverage).'
    : 'Fetches from GitHub, fast-forwards your local develop, then merges develop into the branch. Nothing is pushed until you confirm.';
  return [
    el('p', {}, what),
    el('p', { class: 'mono pill-mono' }, s.repo),
    el('p', { class: 'muted' }, `Checked out now: ${s.current || '(detached)'}`),
    el('p', { class: 'muted' }, `Ticket branch: ${s.branch}${s.onlyOnGitHub ? ' (only on GitHub; a local copy is made)' : ''}`),
    s.dirty ? el('p', { class: 'banner error' }, `You have ${s.dirty} uncommitted ${s.dirty === 1 ? 'change' : 'changes'}. Commit or stash them first; the dashboard never touches uncommitted work.`) : null,
    !s.dirty && s.needsSwitch ? el('p', { class: 'footnote' }, `This switches your folder to ${s.branch}.`) : null,
  ];
}

export async function runLocal(kind, key) {
  let s;
  try { s = await api(`/api/local/${encodeURIComponent(key)}/status`); } catch (err) { toast(err.message, 'bad'); return; }
  if (s.job && ['running', 'stopping'].includes(s.job.state)) { toast('Another job is already running.', 'bad'); return; }
  const ok = await confirmSheet({
    title: `${LABEL[kind]}: ${key}`,
    body: statusLines(s, kind),
    confirmLabel: s.needsSwitch ? `Switch and ${LABEL[kind]}` : LABEL[kind],
    confirmDisabled: s.dirty > 0,
    onConfirm: () => post(`/api/local/${encodeURIComponent(key)}/${kind}`, { switch: s.needsSwitch }),
  });
  if (ok) watch();
}

function outputBox(text) {
  const pre = el('pre', { class: 'job-tail', tabindex: '0', 'aria-label': 'Test output' }, text || 'Waiting for output…');
  requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; }); // follow the newest lines
  return pre;
}

function paintBar(job) {
  bar ??= document.body.appendChild(el('div', { class: 'job-wrap' }));
  const panel = job.kind === 'tests' && outputOpen ? outputBox(job.output) : null;
  const toggle = job.kind === 'tests' ? el('button', {
    type: 'button', class: 'btn btn-small', 'aria-expanded': String(outputOpen),
    onclick: () => { outputOpen = !outputOpen; paintBar(job); },
  }, outputOpen ? 'Hide Output' : 'Show Output') : null;
  const stop = job.kind === 'tests' && job.state === 'running'
    ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => post('/api/local/job/stop').catch((e) => toast(e.message, 'bad')) }, 'Stop') : null;
  const line = el('div', { class: 'job-bar', role: 'status' }, el('span', { class: 'job-spin', 'aria-hidden': 'true' }),
    el('span', {}, el('b', {}, `${LABEL[job.kind]} · ${job.key}`), ` · ${job.state === 'stopping' ? 'Stopping…' : job.step ?? 'Working…'} · ${mmss(job.elapsedMs)}`),
    toggle, stop);
  bar.replaceChildren(...[panel, line].filter(Boolean)); // replaceChildren would print a null as text
}

const pct = (n) => (n == null ? '–' : `${n}%`);

// The sheet for a job that just ended; afterwards (and after any push) the page refreshes behind counts and PRs.
async function finished(job) {
  bar?.remove(); bar = null;
  if (shownJobId === job.id) return;
  shownJobId = job.id;
  try { await showResult(job); } finally { window.dispatchEvent(new Event('local:job-finished')); }
}

async function showResult(job) {
  if (job.kind === 'tests') {
    if (job.state === 'stopped') { toast('Tests stopped.'); return; }
    const r = job.result ?? {};
    const t = r.tests ?? {};
    await confirmSheet({
      title: job.state === 'passed' ? `Tests passed · ${job.key}` : job.state === 'error' ? `Couldn't run tests · ${job.key}` : `Tests failed · ${job.key}`,
      body: job.state === 'error' ? [el('p', { class: 'banner error' }, r.error)] : [
        el('p', {}, `${t.passed ?? 0} passed · ${t.failed ?? 0} failed · ${t.skipped ?? 0} skipped · ${t.total ?? 0} total · ${mmss(job.elapsedMs)}`),
        r.coverage && el('p', { class: 'muted' },
          `Coverage: statements ${pct(r.coverage.statements)} · branches ${pct(r.coverage.branches)} · functions ${pct(r.coverage.functions)} · lines ${pct(r.coverage.lines)}`),
        r.failing?.length ? el('div', {}, el('p', { class: 'list-label' }, 'Failing'), el('ul', { class: 'job-list' }, r.failing.slice(0, 30).map((n) => el('li', {}, n)))) : null,
        job.output ? el('details', { class: 'job-output', open: !r.tests }, el('summary', {}, 'Output'), outputBox(job.output)) : null,
      ],
      confirmLabel: 'Done',
    });
    return;
  }
  if (job.state === 'conflict') {
    await confirmSheet({
      title: `Conflicts merging develop · ${job.key}`,
      body: [el('p', {}, 'The merge was undone, so your branch is exactly as it was. Nothing was pushed. Resolve these by hand:'),
        el('ul', { class: 'job-list mono' }, job.result.conflicts.map((f) => el('li', {}, f)))],
      confirmLabel: 'Done',
    });
  } else if (job.state === 'needs-push') {
    const n = job.result.ahead;
    const pushed = await confirmSheet({
      title: `Push ${job.branch}?`,
      body: [el('p', {}, `Develop merged with no conflicts. Push ${n} ${n === 1 ? 'commit' : 'commits'} to origin/${job.branch}?`),
        el('p', { class: 'footnote' }, 'A normal push, never forced. If you say no, the merge stays on your Mac.')],
      confirmLabel: 'Push',
      onConfirm: () => post('/api/local/job/push'),
    });
    toast(pushed ? `Pushed ${job.branch}` : 'Not pushed. The merge is on your Mac.', pushed ? 'ok' : 'bad');
  } else if (job.state === 'up-to-date') {
    toast(`${job.branch} already has everything from develop.`);
  } else if (job.state === 'error') {
    toast(job.result?.error ?? 'Update failed.', 'bad');
  }
}

// Poll while a job runs; show its sheet once when it ends. Also called on page load, so a running job reappears.
export async function watch() {
  clearTimeout(pollTimer);
  let job;
  try { job = await api('/api/local/job'); } catch { return; }
  if (!job) return;
  if (['running', 'stopping'].includes(job.state)) {
    paintBar(job);
    pollTimer = setTimeout(watch, POLL_MS);
    return;
  }
  if (bar) await finished(job); // only jobs watched while running get a sheet, not old ones on reload
  else shownJobId = job.id;
}
