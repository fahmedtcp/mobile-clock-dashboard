import { api, el, ext, sep, placeholder, ticketChip, toast, glyph, icon, avatar, skeleton, empty } from '../ui.js';

const SVG = 'http://www.w3.org/2000/svg';

const REFRESH_MS = 120000;
let root;
let data = null;
let error = null;
let loadedAt = 0;
let loading = false;

async function load(force = false) {
  if (loading || (!force && Date.now() - loadedAt < REFRESH_MS)) return;
  loading = true;
  render();
  try { data = await api('/api/release'); error = null; } catch (err) { error = err; }
  loadedAt = Date.now();
  loading = false;
  render();
}

function prChip(pr) {
  if (!pr) return el('span', { class: 'chip' }, 'No PR found');
  const color = pr.state === 'MERGED' ? 'green' : pr.state === 'OPEN' ? 'blue' : '';
  return ext(pr.url, el('span', { class: `chip ${color}` }, `#${pr.number} · ${pr.state === 'MERGED' ? 'Merged' : 'Open'}`));
}

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// Activity-ring style progress: merged / total.
function ring(done, total) {
  const r = 52, c = 2 * Math.PI * r;
  const frac = total ? done / total : 0;
  const svg = svgEl('svg', { viewBox: '0 0 132 132', 'aria-hidden': 'true' });
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', { id: 'ringGrad', x1: '0', y1: '0', x2: '1', y2: '1' });
  grad.append(svgEl('stop', { offset: '0%', 'stop-color': '#34c759' }), svgEl('stop', { offset: '100%', 'stop-color': '#30b0c7' }));
  defs.append(grad);
  svg.append(defs,
    svgEl('circle', { class: 'track', cx: 66, cy: 66, r }),
    svgEl('circle', { class: 'val', cx: 66, cy: 66, r, 'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - frac) }));
  return el('div', { class: 'ring-progress', role: 'img', 'aria-label': `${done} of ${total} tickets merged` }, svg,
    el('div', { class: 'ring-center' }, el('div', { class: 'n' }, `${Math.round(frac * 100)}%`), el('div', { class: 'l' }, 'Merged')));
}

function stackBar(parts) {
  const total = parts.reduce((a, p) => a + p.n, 0) || 1;
  return [
    el('div', { class: 'stack-bar', role: 'img', 'aria-label': parts.map((p) => `${p.n} ${p.label}`).join(', ') },
      parts.filter((p) => p.n).map((p) => el('span', { style: `flex-grow:${p.n / total};background:${p.color}`, title: `${p.n} ${p.label}` }))),
    el('div', { class: 'legend' }, parts.map((p) => el('span', {}, el('i', { style: `background:${p.color}` }), `${p.n} ${p.label}`))),
  ];
}

function ticketRows(tickets, { mismatch = false } = {}) {
  if (!tickets.length) return [empty('check', 'Nothing here')];
  return tickets.map((t) => el('li', {},
    el('div', { class: 'row' },
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(t.url, t.summary)),
        el('div', { class: 'row-sub' }, el('span', { class: 'num' }, t.key), sep(), el('span', {}, t.issueType), t.assignee ? [sep(), el('span', {}, t.assignee.name)] : null)),
      el('div', { class: 'row-trail' },
        mismatch && t.mismatch && el('span', { class: 'chip red', title: 'Marked finished in Jira, but no merged PR was found under this key' }, 'Check Status'),
        ticketChip(t), prChip(t.pr)))));
}

function prRows(prs) {
  if (!prs.length) return [empty('check', 'Nothing here')];
  return prs.map((p) => el('li', {},
    el('div', { class: 'row' },
      avatar(p.author),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, ext(p.url, p.title)),
        el('div', { class: 'row-sub' }, el('span', { class: 'num' }, `#${p.number}`), sep(), el('span', {}, p.author), sep(), el('span', {}, `merged ${p.mergedAt.slice(0, 10)}`))),
      el('div', { class: 'row-trail' }, el('span', { class: 'chip' }, p.ticketKey ?? 'No Ticket')))));
}

function block(title, hint, rows, { collapsed = false, look = null } = {}) {
  const list = el('ul', { class: 'group' }, rows);
  const head = (tag, cls) => el(tag, { class: cls }, el('div', { class: 'section-title' }, look && glyph(look[0], look[1], 'sm'), el('h3', {}, title)), el('span', { class: 'hint' }, hint));
  if (collapsed) return el('details', { class: 'block' }, head('summary', 'section-head'), list);
  return el('section', { class: 'block' }, head('div', 'section-head'), list);
}

async function copyNotes(text, pre) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Release notes copied');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Notes selected. Press ⌘C to copy.');
  }
}

function pageHead() {
  return el('div', { class: 'page-head' },
    el('div', {}, el('div', { class: 'page-title' }, 'Release'), el('div', { class: 'page-sub' }, 'What\'s in the next version, and what isn\'t yet')),
    el('button', { class: 'btn btn-small', type: 'button', disabled: loading, onclick: () => load(true) }, icon('refresh'), loading ? 'Refreshing…' : 'Refresh'));
}

function stat(n, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-n' }, String(n)), el('div', { class: 'stat-l' }, label));
}

function render() {
  if (!root) return;
  if (error) {
    root.replaceChildren(pageHead(), el('div', { class: 'banner error', role: 'alert' }, error.message));
    return;
  }
  if (!data) {
    root.replaceChildren(pageHead(), el('ul', { class: 'group' }, skeleton(5)));
    return;
  }
  if (!data.release) {
    root.replaceChildren(pageHead(), el('ul', { class: 'group' }, empty('release', 'No upcoming release', 'No unreleased "Mobile NN" fix version found in Jira.', 'purple')));
    return;
  }
  const r = data.release;
  const l = data.lists;
  const daysLeft = r.releaseDate ? Math.ceil((Date.parse(`${r.releaseDate}T23:59:59`) - Date.now()) / 864e5) : null;
  const openPr = l.notMerged.filter((t) => t.pr);
  const noPr = l.notMerged.filter((t) => !t.pr);
  const pre = el('pre', { class: 'notes' }, data.notes);

  const merged = l.inVersion.length - l.notMerged.length;
  root.replaceChildren(
    pageHead(),
    el('div', { class: 'card release-hero' },
      ring(merged, l.inVersion.length),
      el('div', { class: 'release-meta' },
        el('div', { class: 'release-title' },
          el('div', { class: 'release-name' }, r.name),
          r.branchExists ? ext(`https://github.com/tcp-software/mobile-clock/tree/${r.branch}`, el('span', { class: 'chip green' }, icon('branch'), r.branch)) : el('span', { class: 'chip' }, icon('branch'), 'Branch not cut')),
        el('div', { class: 'row-sub' },
          daysLeft !== null
            ? el('span', { class: `countdown ${daysLeft < 0 ? 'overdue' : ''}` }, el('span', { class: 'n' }, String(Math.abs(daysLeft))), daysLeft < 0 ? 'days late' : 'days left')
            : el('span', {}, 'No release date'),
          r.releaseDate && [sep(), el('span', {}, `ships ${new Date(`${r.releaseDate}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)],
          r.lastCut && [sep(), el('span', {}, `work since ${r.lastCut}`)]),
        stackBar([
          { n: merged, label: 'merged', color: 'var(--green-vivid)' },
          { n: openPr.length, label: 'PR open', color: 'var(--blue)' },
          { n: noPr.length, label: 'no PR found', color: 'var(--gray)' },
        ]),
        el('div', { class: 'legend' }, el('span', {}, icon('alert'), ` ${l.unplanned.length} unplanned merge${l.unplanned.length === 1 ? '' : 's'} since the last cut`)))),
    block('PR Open', 'In the version, PR not merged to develop yet', ticketRows(openPr), { look: ['pr', 'blue'] }),
    block('No PR Found', 'No PR uses this key. The work may have merged under another ticket or an epic branch.', ticketRows(noPr, { mismatch: true }), { look: ['search', 'gray'] }),
    block('Unplanned', `Merged to develop since ${r.lastCut ?? 'the last cut'}, not in ${r.name}`, prRows(l.unplanned), { look: ['alert', 'orange'] }),
    r.branchExists ? block('Cherry-Pick Candidates', `In ${r.name}, merged after the cut, not on ${r.branch}`, prRows(l.cherryPicks), { look: ['branch', 'pink'] }) : null,
    block(`All of ${r.name}`, `${l.inVersion.length} tickets · click to expand`, ticketRows(l.inVersion), { collapsed: true, look: ['ticket', 'purple'] }),
    el('section', { class: 'block' },
      el('div', { class: 'section-head' }, el('div', { class: 'section-title' }, glyph('copy', 'indigo', 'sm'), el('h3', {}, 'Release Notes')),
        el('button', { class: 'btn btn-small', type: 'button', onclick: () => copyNotes(data.notes, pre) }, icon('copy'), 'Copy')),
      el('div', { class: 'card' }, pre)),
  );
}

export default {
  id: 'release',
  title: 'Release',
  mount(container) {
    root = el('div', { class: 'view-inner' });
    container.append(root);
    load(true);
  },
  update() { load(); },
};
