import { api, post, el, ext, sep, ago, toast, glyph, icon, skeleton, empty, freshness } from '../ui.js';

const REFRESH_MS = 120000;
const SVG = 'http://www.w3.org/2000/svg';
const PHASES = { fetch: 'Fetching develop…', worktree: 'Preparing the checkout…', tsc: 'Running tsc…' };
let root;
let ts = null;
let tests = null;
let testsError = null;
let loadedAt = 0;
let fetchedAt = 0; // last successful load, for the freshness label
let pollTimer;

async function load(force = false) {
  if (!force && Date.now() - loadedAt < REFRESH_MS) return;
  loadedAt = Date.now();
  await Promise.all([
    api('/api/ts').then((result) => { ts = result; }, () => {}),
    api('/api/tests').then((result) => { tests = result; testsError = null; fetchedAt = Date.now(); }, (err) => { testsError = err; }),
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

const SPARK = { width: 360, height: 84, pad: 6 };

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

// Inline SVG line of error counts over time; no chart library.
function sparkline(history) {
  const { width, height } = SPARK;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`, class: 'spark', role: 'img',
    'aria-label': `TypeScript errors over ${history.length} run${history.length === 1 ? '' : 's'}`,
  });
  if (!history.length) return svg;
  const counts = history.map((e) => e.count);
  const { x, y } = sparkScale(counts);
  svg.append(sparkGradient());
  if (counts.length > 1) {
    const points = counts.map((c, i) => `${x(i)},${y(c)}`);
    svg.append(
      svgEl('polygon', {
        class: 'area', points: `${x(0)},${height} ${points.join(' ')} ${x(counts.length - 1)},${height}`,
      }),
      svgEl('polyline', { points: points.join(' ') }));
  }
  svg.append(svgEl('circle', { cx: x(counts.length - 1), cy: y(counts.at(-1)), r: 4.5 }));
  return svg;
}

// Maps run index and error count to SVG coordinates; a single run or a flat line sits at the right or middle.
function sparkScale(counts) {
  const { width, height, pad } = SPARK;
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const x = (i) => (counts.length === 1 ? width - pad : pad + (i * (width - pad * 2)) / (counts.length - 1));
  const y = (c) => (max === min ? height / 2 : height - pad - ((c - min) * (height - pad * 2)) / (max - min));
  return { x, y };
}

function sparkGradient() {
  const grad = svgEl('linearGradient', { id: 'sparkGrad', x1: 0, y1: 0, x2: 0, y2: 1 });
  for (const [offset, opacity] of [['0%', '.28'], ['100%', '0']]) {
    grad.append(svgEl('stop', { offset, 'stop-color': 'var(--blue)', 'stop-opacity': opacity }));
  }
  const defs = svgEl('defs');
  defs.append(grad);
  return defs;
}

function tsCard() {
  if (!ts) return el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Loading…'));
  const { status, history } = ts;
  return el('div', { class: 'card ts-card' },
    el('div', { class: 'ts-top' },
      el('div', { class: 'gauge-row' }, glyph('chart', 'teal', 'lg'), tsSummary(status.last, history.at(-2))),
      sparkline(history)),
    status.error && el('div', { class: 'banner error' }, status.error),
    el('div', { class: 'ts-actions' },
      status.running
        ? el('span', { class: 'chip orange' },
          el('span', { class: 'spinner', 'aria-hidden': 'true' }), PHASES[status.running.phase] ?? 'Running…')
        : el('span', { class: 'muted' },
          'Runs automatically once a day. A PR\'s change shows on Home with “TS check”.'),
      el('button', { class: 'btn btn-small', type: 'button', disabled: Boolean(status.running), onclick: runNow },
        icon('refresh'), 'Run Now')));
}

// The latest error count, its change since the previous run, and which commit it ran on.
function tsSummary(last, prev) {
  const delta = last && prev ? last.count - prev.count : null;
  const deltaText = delta === 0 ? 'No change' : `${delta > 0 ? '+' : ''}${delta} since last run`;
  return el('div', {},
    el('div', { class: 'stat-n big' }, last ? last.count.toLocaleString() : '—'),
    el('div', { class: 'stat-l' }, 'TypeScript errors on develop'),
    last && el('div', { class: 'row-sub' },
      delta !== null && el('span', { class: `delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}` }, deltaText),
      delta !== null && sep(),
      el('span', {}, `${last.sha.slice(0, 7)} · ${ago(last.at)}`)));
}

function testRows() {
  if (testsError && !tests) return [el('li', {}, el('div', { class: 'banner error' }, testsError.message))];
  if (!tests) return skeleton(4);
  return tests.suites.map(suiteRow);
}

function passColor(rate) {
  if (rate === null) return '';
  if (rate >= 0.9) return 'green';
  return rate >= 0.6 ? 'orange' : 'red';
}

function suiteRow(suite) {
  const pct = suite.rate === null ? '—' : `${Math.round(suite.rate * 100)}%`;
  const color = passColor(suite.rate);
  const stale = suite.latestAgeDays !== null && suite.latestAgeDays > 14;
  const lastRun = `last run ${suite.latestAgeDays === 0 ? 'today' : `${suite.latestAgeDays} days ago`}`;
  const strip = el('div', { class: 'runstrip', role: 'img', 'aria-label': `Last ${suite.recent.length} runs` },
    suite.recent.slice(-30).map((conclusion) => el('i', { class: conclusion, title: conclusion })));
  return el('li', {},
    el('div', { class: 'row' },
      glyph(suite.key === 'unit' ? 'check' : 'phone', color || 'gray'),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, suite.label),
        el('div', { class: 'row-sub' },
          el('span', {}, suite.total ? `${suite.passed} of ${suite.total} passed` : 'No completed runs'),
          suite.latest && [sep(), el('span', { class: stale ? 'overdue' : '' }, lastRun)])),
      el('div', { class: 'row-trail' },
        strip,
        el('span', { class: `pct ${color}` }, pct),
        suite.latest && ext(suite.latest.url, el('span', { class: 'btn btn-small' }, 'Latest')))));
}

function flakyRows() {
  if (!tests) return skeleton(2);
  if (!tests.flaky.length) {
    return [empty('check', 'No flaky runs', 'Nothing flipped between pass and fail in the last 100 runs.')];
  }
  return tests.flaky.map((flaky) => el('li', {},
    el('div', { class: 'row' },
      glyph('flake', 'indigo'),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-title' }, flaky.workflowName),
        el('div', { class: 'row-sub' },
          el('span', { class: 'mono' }, flaky.branch), sep(),
          el('span', { class: 'mono' }, flaky.headSha.slice(0, 7)))),
      el('div', { class: 'row-trail' },
        ext(flaky.failedUrl, el('span', { class: 'chip red' }, 'Failed Run')),
        ext(flaky.passedUrl, el('span', { class: 'chip green' }, 'Passed Run'))))));
}

function sectionHead(look, title, hint) {
  return el('div', { class: 'section-head' },
    el('div', { class: 'section-title' }, glyph(look[0], look[1], 'sm'), el('h3', {}, title)),
    hint && el('span', { class: 'hint' }, hint));
}

function insetList(rows) {
  const list = el('ul', { class: 'group' }, rows);
  list.style.setProperty('--inset', '56px');
  return list;
}

function render() {
  if (!root) return;
  root.replaceChildren(
    el('div', { class: 'page-head' }, el('div', {},
      el('div', { class: 'page-title' }, 'Quality'),
      el('div', { class: 'page-sub' }, 'Code health and test reliability on develop'),
      freshness({ at: fetchedAt, intervalMs: REFRESH_MS, error: tests ? testsError : null, onRefresh: () => load(true) }))),
    el('section', { class: 'block' },
      sectionHead(['chart', 'teal'], 'TypeScript Error Budget', 'Lower is better'), tsCard()),
    el('section', { class: 'block' },
      sectionHead(['check', 'green'], 'Test Health', 'Each bar is one run, oldest to newest'),
      insetList(testRows())),
    el('section', { class: 'block' },
      sectionHead(['flake', 'indigo'], 'Flaky Runs', 'Same commit both failed and passed'), insetList(flakyRows())),
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
  refresh: () => load(true),
  update() { load(); },
};
