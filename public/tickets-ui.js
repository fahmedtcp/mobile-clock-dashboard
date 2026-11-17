// Ticket side panel, ticket links, and "last build" chips.
// Any element with data-ticket-key opens the panel (one delegated listener), so views just mark their keys.
// Jira text is shown with textContent only: a description or comment can never become markup.
import { api, el, ext, icon, ago } from './ui.js';
import { TICKET_KEY } from './shared.js';
import { runLocal } from './local-jobs.js';

const BATCH = 50;
const BUILD_TTL_MS = 10 * 60 * 1000; // matches the server cache
const builds = new Map(); // key -> { build: LatestBuild | null, at }
const loading = new Set();
const knownBuild = (key) => {
  const hit = builds.get(key);
  return hit && Date.now() - hit.at <= BUILD_TTL_MS ? hit : null;
};
let panel = null;         // { aside, body, trigger, key }
let actions = {};         // { requestQa(ticket), sendToQa(ticket) }, registered by Home

export const registerTicketActions = (handlers) => { actions = handlers; };

export function ticketLink(key, label = key) {
  return el('button', { type: 'button', class: 'ticket-link', 'data-ticket-key': key, title: `Show ${key}` }, label);
}

// ---------- last build chips ----------

const targetName = (build) => `${build.platform} ${build.app === 'Mobile Kiosk' ? 'MK' : 'MC'}`;

function filledChip(key, build) {
  return el('button', { type: 'button', class: 'build-chip', 'data-ticket-key': key,
    title: `Build ${build.number} · ${build.app} ${build.platform} · ${build.destination}` },
  '▲ Build ', el('b', {}, build.number), ` · ${targetName(build)} · ${ago(build.created)}`);
}

// A chip if the build is known; otherwise an empty slot that fills when loadLatestBuilds finishes.
export function buildChip(key) {
  if (!TICKET_KEY.test(key ?? '')) return null;
  const hit = knownBuild(key);
  if (hit) return hit.build && filledChip(key, hit.build);
  return el('span', { class: 'build-slot', 'data-build-slot': key });
}

function fillSlots() {
  for (const slot of document.querySelectorAll('[data-build-slot]')) {
    const key = slot.dataset.buildSlot;
    const hit = knownBuild(key);
    if (!hit) continue;
    const { build } = hit;
    if (build) slot.replaceWith(filledChip(key, build)); else slot.remove();
  }
}

export async function loadLatestBuilds(keys) {
  const missing = [...new Set(keys)].filter((key) => TICKET_KEY.test(key ?? '') && !knownBuild(key) && !loading.has(key));
  missing.forEach((key) => loading.add(key));
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    try {
      const found = await api(`/api/builds/latest?keys=${batch.join(',')}`);
      for (const key of batch) builds.set(key, { build: found[key] ?? null, at: Date.now() });
    } catch { /* chips are extra: leave the slots empty, try again next render */ }
    batch.forEach((key) => loading.delete(key));
  }
  fillSlots();
}

// ---------- the panel ----------

const card = (label, ...children) => el('div', { class: 'tp-card' }, el('div', { class: 'tp-label' }, label), ...children);

function chipsRow(data) {
  const { ticket, hours } = data;
  return el('div', { class: 'tp-chips' },
    el('span', { class: 'chip blue' }, ticket.status),
    ticket.assignee && el('span', { class: 'chip' }, ticket.assignee),
    ...ticket.fixVersions.map((name) => el('span', { class: 'chip' }, name)),
    hours && el('span', { class: 'chip' }, `${hours.hours}h logged this month`));
}

function buildsCard(list) {
  if (!list.length) return card('LAST BUILD', el('p', { class: 'muted' }, 'No dev build posted to this ticket yet.'));
  const [latest, ...others] = list;
  return card('LAST BUILD',
    el('div', { class: 'tp-build' }, el('div', { class: 'tp-build-n' }, latest.number),
      el('div', { class: 'tp-build-m' }, el('b', {}, `${latest.app} ${latest.platform}`), ` · ${latest.destination}`,
        el('br'), ago(latest.created))),
    others.length > 0 && el('div', { class: 'tp-others' }, others.map((b) =>
      el('div', {}, el('span', {}, `${b.app} ${b.platform} · ${b.destination}`), el('span', {}, `${b.number} · ${ago(b.created)}`)))));
}

function prsCard(prs) {
  if (!prs.length) return null;
  const state = (pr) => (pr.state === 'MERGED' ? 'Merged' : pr.reviewDecision === 'APPROVED' ? 'Approved' : pr.state === 'OPEN' ? 'Open' : 'Closed');
  return card(prs.length === 1 ? 'PULL REQUEST' : 'PULL REQUESTS', prs.map((pr) =>
    el('div', { class: 'tp-pr' }, ext(pr.url, el('b', {}, `#${pr.number}`), ` ${pr.title}`), el('span', { class: 'chip' }, state(pr)))));
}

function commentsCard(comments) {
  if (!comments.length) return null;
  return card('RECENT COMMENTS', comments.map((c) => el('div', { class: 'tp-comment' },
    el('b', {}, c.author), el('span', { class: 'muted' }, ` · ${ago(c.created)}`), el('div', {}, c.text))));
}

function actionsRow(data) {
  const ticket = { key: data.ticket.key, summary: data.ticket.summary, status: data.ticket.status };
  return el('div', { class: 'tp-actions' },
    ext(data.ticket.url, el('span', { class: 'btn btn-small btn-filled' }, 'Open in Jira')),
    data.canSendToQa && actions.requestQa
      && el('button', { type: 'button', class: 'btn btn-small', onclick: () => actions.requestQa(ticket) }, icon('team'), 'Request QA Review'),
    data.canSendToQa && actions.sendToQa
      && el('button', { type: 'button', class: 'btn btn-small', onclick: () => actions.sendToQa(ticket) }, 'Send to QA'),
    el('button', { type: 'button', class: 'btn btn-small', onclick: () => { closeTicketPanel(); runLocal('update', ticket.key); } }, 'Update from Develop'),
    el('button', { type: 'button', class: 'btn btn-small', onclick: () => { closeTicketPanel(); runLocal('tests', ticket.key); } }, 'Run Tests'),
    ticket.status === 'In Progress' && actions.requestPrReview
      && el('button', { type: 'button', class: 'btn btn-small', onclick: () => { closeTicketPanel(); actions.requestPrReview(ticket); } },
        icon('team'), 'Request PR Review'));
}

function panelContent(data) {
  return [
    el('div', { class: 'tp-head' },
      el('div', {}, el('div', { class: 'tp-key' }, [data.ticket.key, data.ticket.type].filter(Boolean).join(' · ')),
        el('h3', { class: 'tp-title', id: 'tp-title' }, data.ticket.summary)),
      closeButton()),
    chipsRow(data),
    buildsCard(data.builds),
    prsCard(data.prs),
    data.description && card('DESCRIPTION', el('p', { class: 'tp-desc' }, data.description)),
    commentsCard(data.comments),
    actionsRow(data),
  ].filter(Boolean);
}

const closeButton = () => el('button', { type: 'button', class: 'tp-close', 'aria-label': 'Close ticket details', onclick: closeTicketPanel }, icon('x'));

function ensurePanel() {
  if (panel) return panel;
  const body = el('div', { class: 'tp-body' });
  const aside = el('aside', { class: 'ticket-panel', role: 'complementary', 'aria-label': 'Ticket details' }, body);
  document.body.append(aside);
  requestAnimationFrame(() => aside.classList.add('open'));
  panel = { aside, body };
  return panel;
}

export async function openTicketPanel(key, trigger = document.activeElement) {
  const { body } = ensurePanel();
  Object.assign(panel, { key, trigger });
  body.replaceChildren(el('div', { class: 'tp-head' }, el('div', { class: 'tp-key' }, key), closeButton()),
    el('div', { class: 'tp-card' }, el('div', { class: 'sk title' }), el('div', { class: 'sk sub' })));
  body.querySelector('.tp-close').focus({ preventScroll: true });
  try {
    const data = await api(`/api/tickets/${encodeURIComponent(key)}/panel`);
    if (panel?.key === key) {
      body.replaceChildren(...panelContent(data));
      body.querySelector('.tp-close').focus({ preventScroll: true });
    }
  } catch (err) {
    if (panel?.key === key) {
      body.replaceChildren(el('div', { class: 'tp-head' }, el('div', { class: 'tp-key' }, key), closeButton()),
        el('div', { class: 'banner error' }, `Couldn't load ${key}: ${err.message}`));
    }
  }
}

export function closeTicketPanel() {
  if (!panel) return;
  const { aside, trigger } = panel;
  panel = null;
  aside.classList.remove('open');
  setTimeout(() => aside.remove(), 400);
  // The trigger may have been re-rendered away; fall back to the page so focus never lands on the removed panel.
  (trigger?.isConnected ? trigger : document.querySelector('main'))?.focus?.({ preventScroll: true });
}

document.addEventListener('click', (e) => {
  const target = e.target.closest?.('[data-ticket-key]');
  if (!target) return;
  e.preventDefault();
  openTicketPanel(target.dataset.ticketKey, target);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panel && !document.querySelector('dialog[open]')) closeTicketPanel();
});

