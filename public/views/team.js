import { api, el, ext, sep, placeholder, ticketChip, glyph, avatar, skeleton, empty } from '../ui.js';

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

const waitText = (d) => (d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'}`);

function reviewerRows() {
  if (queueError) return [el('li', {}, el('div', { class: 'banner error' }, queueError.message))];
  if (!queue) return skeleton(4);
  if (!queue.byReviewer.length) return [empty('check', 'Review queue is empty', 'Nobody has pending review requests.')];
  const max = Math.max(...queue.byReviewer.map((r) => r.count));
  return queue.byReviewer.map((r) => el('li', {},
    el('div', { class: 'row' },
      avatar(r.login, 'lg'),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, r.login),
        el('div', { class: 'row-sub' }, el('span', {}, `${r.count} PR${r.count === 1 ? '' : 's'} waiting`), sep(), el('span', { class: r.oldestDays > 2 ? 'overdue' : '' }, `oldest ${waitText(r.oldestDays)}`))),
      el('div', { class: 'row-trail' },
        el('div', { class: `loadbar ${r.count / max > 0.66 ? 'hot' : ''}`, role: 'img', 'aria-label': `${r.count} of ${max}` }, el('span', { style: `width:${Math.max(6, (r.count / max) * 100)}%` })),
        el('span', { class: 'wait-n' }, String(r.count))))));
}

function waitingRows() {
  if (!queue) return skeleton(3);
  if (!queue.prs.length) return [empty('check', 'Nothing waiting', 'No PRs are waiting on review.')];
  return queue.prs.map((p) => el('li', {},
    el('div', { class: 'row' },
      avatar(p.author),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(p.url, p.title)),
        el('div', { class: 'row-sub' }, el('span', { class: 'num' }, `#${p.number}`), sep(), el('span', {}, p.author), sep(), el('span', {}, `waiting on ${p.waitingOn.join(', ')}`))),
      el('div', { class: 'row-trail' },
        el('span', { class: 'avatar-stack' }, p.waitingOn.slice(0, 4).map((l) => avatar(l))),
        el('span', { class: `chip ${p.overdue ? 'orange' : ''}` }, `Waiting ${waitText(p.waitingDays)}`)))));
}

function allPrRows() {
  if (!shared.prsLoaded) return skeleton(5);
  if (!shared.prs.length) return [empty('pr', 'No open pull requests', '', 'blue')];
  return shared.prs.map((pr) => el('li', {},
    el('div', { class: 'row' },
      avatar(pr.author),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(pr.url, pr.title)),
        el('div', { class: 'row-sub' }, el('span', { class: `ring ${pr.checks}`, title: `Checks: ${pr.checks}` }), el('span', { class: 'num' }, `#${pr.number}`), sep(), el('span', {}, pr.author), sep(), el('span', { class: 'mono', title: pr.headRefName }, pr.headRefName))),
      el('div', { class: 'row-trail' },
        ticketChip(pr.ticket, pr.ticketKey),
        pr.stale && el('span', { class: 'chip orange' }, 'Stale'),
        pr.isDraft ? el('span', { class: 'chip' }, 'Draft') : pr.approved ? el('span', { class: 'chip green' }, 'Approved') : null))));
}

function render() {
  if (!root) return;
  const head = (look, title, hint) => el('div', { class: 'section-head' }, el('div', { class: 'section-title' }, glyph(look[0], look[1], 'sm'), el('h3', {}, title)), el('span', { class: 'hint' }, hint));
  const list = (rows, inset) => { const ul = el('ul', { class: 'group' }, rows); ul.style.setProperty('--inset', inset); return ul; };
  root.replaceChildren(
    el('div', { class: 'page-head' }, el('div', {}, el('div', { class: 'page-title' }, 'Team'), el('div', { class: 'page-sub' }, 'Who\'s waiting on whom'))),
    el('section', { class: 'block' }, head(['team', 'orange'], 'Review Load', 'Pending review requests per person'), list(reviewerRows(), '64px')),
    el('section', { class: 'block' }, head(['clock', 'pink'], 'Waiting on Review', 'Orange after 2 days'), list(waitingRows(), '52px')),
    el('section', { class: 'block' }, head(['pr', 'blue'], 'All Open Pull Requests', `${shared.prs.length} open`), list(allPrRows(), '52px')),
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
  update(s) {
    shared = s;
    render();
    load();
  },
};
