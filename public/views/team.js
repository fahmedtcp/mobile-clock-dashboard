import { api, el, ext, sep, ticketChip, glyph, avatar, skeleton, empty } from '../ui.js';

const REFRESH_MS = 120000;
let root;
let queue = null;
let queueError = null;
let loadedAt = 0;
let shared = { prs: [], prsLoaded: false };

async function load(force = false) {
  if (!force && Date.now() - loadedAt < REFRESH_MS) return;
  loadedAt = Date.now();
  try { queue = await api('/api/reviews'); queueError = null; } catch (err) { queueError = err; }
  render();
}

const waitText = (days) => (days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`);

function reviewerRows() {
  if (queueError) return [el('li', {}, el('div', { class: 'banner error' }, queueError.message))];
  if (!queue) return skeleton(4);
  if (!queue.byReviewer.length) return [empty('check', 'Review queue is empty', 'Nobody has pending review requests.')];
  const max = Math.max(...queue.byReviewer.map((r) => r.count));
  return queue.byReviewer.map((reviewer) => reviewerRow(reviewer, max));
}

function reviewerRow({ login, count, oldestDays }, max) {
  const share = count / max;
  const load = el('div', {
    class: `loadbar ${share > 0.66 ? 'hot' : ''}`, role: 'img', 'aria-label': `${count} of ${max}`,
  },
    el('span', { style: `width:${Math.max(6, share * 100)}%` }));
  return el('li', {},
    el('div', { class: 'row' },
      avatar(login, 'lg'),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, login),
        el('div', { class: 'row-sub' },
          el('span', {}, `${count} PR${count === 1 ? '' : 's'} waiting`), sep(),
          el('span', { class: oldestDays > 2 ? 'overdue' : '' }, `oldest ${waitText(oldestDays)}`))),
      el('div', { class: 'row-trail' }, load, el('span', { class: 'wait-n' }, String(count)))));
}

function waitingRows() {
  if (!queue) return skeleton(3);
  if (!queue.prs.length) return [empty('check', 'Nothing waiting', 'No PRs are waiting on review.')];
  return queue.prs.map((pr) => el('li', {},
    el('div', { class: 'row' },
      avatar(pr.author),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(pr.url, pr.title)),
        el('div', { class: 'row-sub' },
          el('span', { class: 'num' }, `#${pr.number}`), sep(), el('span', {}, pr.author), sep(),
          el('span', {}, `waiting on ${pr.waitingOn.join(', ')}`))),
      el('div', { class: 'row-trail' },
        el('span', { class: 'avatar-stack' }, pr.waitingOn.slice(0, 4).map((login) => avatar(login))),
        el('span', { class: `chip ${pr.overdue ? 'orange' : ''}` }, `Waiting ${waitText(pr.waitingDays)}`)))));
}

function allPrRows() {
  if (!shared.prsLoaded) return skeleton(5);
  if (!shared.prs.length) return [empty('pr', 'No open pull requests', '', 'blue')];
  return shared.prs.map(openPrRow);
}

function openPrRow(pr) {
  const state = pr.isDraft ? el('span', { class: 'chip' }, 'Draft')
    : pr.approved ? el('span', { class: 'chip green' }, 'Approved') : null;
  return el('li', {},
    el('div', { class: 'row' },
      avatar(pr.author),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(pr.url, pr.title)),
        el('div', { class: 'row-sub' },
          el('span', { class: `ring ${pr.checks}`, title: `Checks: ${pr.checks}` }),
          el('span', { class: 'num' }, `#${pr.number}`), sep(), el('span', {}, pr.author), sep(),
          el('span', { class: 'mono', title: pr.headRefName }, pr.headRefName))),
      el('div', { class: 'row-trail' },
        ticketChip(pr.ticket, pr.ticketKey),
        pr.stale && el('span', { class: 'chip orange' }, 'Stale'),
        state)));
}

function sectionHead(look, title, hint) {
  return el('div', { class: 'section-head' },
    el('div', { class: 'section-title' }, glyph(look[0], look[1], 'sm'), el('h3', {}, title)),
    el('span', { class: 'hint' }, hint));
}

function insetList(rows, inset) {
  const list = el('ul', { class: 'group' }, rows);
  list.style.setProperty('--inset', inset);
  return list;
}

function render() {
  if (!root) return;
  root.replaceChildren(
    el('div', { class: 'page-head' }, el('div', {},
      el('div', { class: 'page-title' }, 'Team'),
      el('div', { class: 'page-sub' }, 'Who\'s waiting on whom'))),
    el('section', { class: 'block' },
      sectionHead(['team', 'orange'], 'Review Load', 'Pending review requests per person'),
      insetList(reviewerRows(), '64px')),
    el('section', { class: 'block' },
      sectionHead(['clock', 'pink'], 'Waiting on Review', 'Orange after 2 days'), insetList(waitingRows(), '52px')),
    el('section', { class: 'block' },
      sectionHead(['pr', 'blue'], 'All Open Pull Requests', `${shared.prs.length} open`),
      insetList(allPrRows(), '52px')),
  );
}

export default {
  id: 'team',
  title: 'Team',
  mount(container, ctx) {
    shared = ctx.shared;
    root = el('div', { class: 'view-inner' });
    container.append(root);
    render();
    load(true);
  },
  refresh: () => load(true),
  update(s) {
    shared = s;
    render();
    load();
  },
};
