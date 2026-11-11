import { api, post, el, ext, sep, placeholder, ago, toast, glyph, icon, skeleton, empty } from '../ui.js';

const REFRESH_MS = 120000;
const SVG = 'http://www.w3.org/2000/svg';
const PHASES = { fetch: 'Fetching develop…', worktree: 'Preparing the checkout…', tsc: 'Running tsc…' };
let root;
let ts = null;
let tests = null;
let testsError = null;
let loadedAt = 0;
let pollTimer;

async function load(force = false) {
  if (!force && Date.now() - loadedAt < REFRESH_MS) return;
  loadedAt = Date.now();
  await Promise.all([
    api('/api/ts').then((d) => { ts = d; }, () => {}),
    api('/api/tests').then((d) => { tests = d; testsError = null; }, (e) => { testsError = e; }),
  ]);
  render();
  if (ts?.status.running) pollTs();
}

function pollTs() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try { ts = await api('/api/ts'); } catch { return; }
    render();
    if (ts.status.running) pollTs();
  }, 3000);
}

async function runNow() {
  try { await post('/api/ts/run'); ts = await api('/api/ts'); } catch (err) { return toast(err.message, 'bad'); }
  render();
  pollTs();
}

// Inline SVG line of error counts over time; no chart library.
function sparkline(history) {
  const w = 360, h = 84, pad = 6;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `TypeScript errors over ${history.length} run${history.length === 1 ? '' : 's'}`);
  if (!history.length) return svg;
  const counts = history.map((e) => e.count);
  const min = Math.min(...counts), max = Math.max(...counts);
  const x = (i) => (history.length === 1 ? w - pad : pad + (i * (w - pad * 2)) / (history.length - 1));
  const y = (c) => (max === min ? h / 2 : h - pad - ((c - min) * (h - pad * 2)) / (max - min));
  const defs = document.createElementNS(SVG, 'defs');
  const grad = document.createElementNS(SVG, 'linearGradient');
  for (const [k, v] of Object.entries({ id: 'sparkGrad', x1: 0, y1: 0, x2: 0, y2: 1 })) grad.setAttribute(k, v);
  for (const [off, op] of [['0%', '.28'], ['100%', '0']]) {
    const stop = document.createElementNS(SVG, 'stop');
    stop.setAttribute('offset', off); stop.setAttribute('stop-color', 'var(--blue)'); stop.setAttribute('stop-opacity', op);
    grad.append(stop);
  }
  defs.append(grad);
  svg.append(defs);
  if (history.length > 1) {
    const pts = counts.map((c, i) => `${x(i)},${y(c)}`);
    const area = document.createElementNS(SVG, 'polygon');
    area.setAttribute('class', 'area');
    area.setAttribute('points', `${x(0)},${h} ${pts.join(' ')} ${x(counts.length - 1)},${h}`);
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('points', pts.join(' '));
    svg.append(area, line);
  }
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('cx', x(counts.length - 1));
  dot.setAttribute('cy', y(counts.at(-1)));
  dot.setAttribute('r', 4.5);
  svg.append(dot);
  return svg;
}

function tsCard() {
  if (!ts) return el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Loading…'));
  const { status, history } = ts;
  const last = status.last;
  const prev = history.at(-2);
  const delta = last && prev ? last.count - prev.count : null;
  return el('div', { class: 'card ts-card' },
    el('div', { class: 'ts-top' },
      el('div', { class: 'gauge-row' }, glyph('chart', 'teal', 'lg'), el('div', {},
        el('div', { class: 'stat-n big' }, last ? last.count.toLocaleString() : '—'),
        el('div', { class: 'stat-l' }, 'TypeScript errors on develop'),
        last && el('div', { class: 'row-sub' },
          delta !== null && el('span', { class: `delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}` }, delta === 0 ? 'No change' : `${delta > 0 ? '+' : ''}${delta} since last run`),
          delta !== null && sep(),
          el('span', {}, `${last.sha.slice(0, 7)} · ${ago(last.at)}`)))),
      sparkline(history)),
    status.error && el('div', { class: 'banner error' }, status.error),
    el('div', { class: 'ts-actions' },
      status.running
        ? el('span', { class: 'chip orange' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), PHASES[status.running.phase] ?? 'Running…')
        : el('span', { class: 'muted' }, 'Runs automatically once a day. A PR\'s change shows on Home with “TS check”.'),
      el('button', { class: 'btn btn-small', type: 'button', disabled: Boolean(status.running), onclick: runNow }, icon('refresh'), 'Run Now')));
}

function testRows() {
  if (testsError) return [el('li', {}, el('div', { class: 'banner error' }, testsError.message))];
  if (!tests) return skeleton(4);
  return tests.suites.map((s) => {
    const pct = s.rate === null ? '—' : `${Math.round(s.rate * 100)}%`;
    const color = s.rate === null ? '' : s.rate >= 0.9 ? 'green' : s.rate >= 0.6 ? 'orange' : 'red';
    const stale = s.latestAgeDays !== null && s.latestAgeDays > 14;
    const strip = el('div', { class: 'runstrip', role: 'img', 'aria-label': `Last ${s.recent.length} runs` }, s.recent.slice(-30).map((c) => el('i', { class: c, title: c })));
    return el('li', {},
      el('div', { class: 'row' },
        glyph(s.key === 'unit' ? 'check' : 'phone', color === 'green' ? 'green' : color === 'red' ? 'red' : color === 'orange' ? 'orange' : 'gray'),
        el('div', { class: 'row-body' },
          el('div', { class: 'row-title' }, s.label),
          el('div', { class: 'row-sub' },
            el('span', {}, s.total ? `${s.passed} of ${s.total} passed` : 'No completed runs'),
            s.latest && [sep(), el('span', { class: stale ? 'overdue' : '' }, `last run ${s.latestAgeDays === 0 ? 'today' : `${s.latestAgeDays} days ago`}`)])),
        el('div', { class: 'row-trail' },
          strip,
          el('span', { class: `pct ${color}` }, pct),
          s.latest && ext(s.latest.url, el('span', { class: 'btn btn-small' }, 'Latest')))));
  });
}

function flakyRows() {
  if (!tests) return skeleton(2);
  if (!tests.flaky.length) return [empty('check', 'No flaky runs', 'Nothing flipped between pass and fail in the last 100 runs.')];
  return tests.flaky.map((f) => el('li', {},
    el('div', { class: 'row' },
      glyph('flake', 'indigo'),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, f.workflowName),
        el('div', { class: 'row-sub' }, el('span', { class: 'mono' }, f.branch), sep(), el('span', { class: 'mono' }, f.headSha.slice(0, 7)))),
      el('div', { class: 'row-trail' },
        ext(f.failedUrl, el('span', { class: 'chip red' }, 'Failed Run')),
        ext(f.passedUrl, el('span', { class: 'chip green' }, 'Passed Run'))))));
}

function render() {
  if (!root) return;
  const head = (look, title, hint) => el('div', { class: 'section-head' }, el('div', { class: 'section-title' }, glyph(look[0], look[1], 'sm'), el('h3', {}, title)), hint && el('span', { class: 'hint' }, hint));
  const list = (rows) => { const ul = el('ul', { class: 'group' }, rows); ul.style.setProperty('--inset', '56px'); return ul; };
  root.replaceChildren(
    el('div', { class: 'page-head' }, el('div', {}, el('div', { class: 'page-title' }, 'Quality'), el('div', { class: 'page-sub' }, 'Code health and test reliability on develop'))),
    el('section', { class: 'block' }, head(['chart', 'teal'], 'TypeScript Error Budget', 'Lower is better'), tsCard()),
    el('section', { class: 'block' }, head(['check', 'green'], 'Test Health', 'Each bar is one run, oldest to newest'), list(testRows())),
    el('section', { class: 'block' }, head(['flake', 'indigo'], 'Flaky Runs', 'Same commit both failed and passed'), list(flakyRows())),
  );
}

export default {
  id: 'quality',
  title: 'Quality',
  mount(container) {
    root = el('div', { class: 'view-inner' });
    container.append(root);
    render();
    load(true);
  },
  update() { load(); },
};
