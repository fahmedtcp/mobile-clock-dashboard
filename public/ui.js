// Shared DOM helpers for every view. All text goes through textContent/append, never innerHTML:
// PR titles, branch names, Jira summaries, and logs are untrusted.

export const $ = (id) => document.getElementById(id);

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'X-Dashboard': '1', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data, status: res.status });
  return data;
}

export const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) });
export const post = (path, body) => api(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

export const ext = (href, ...children) => el('a', { href, target: '_blank', rel: 'noopener' }, ...children);

export function showError(box, err) {
  box.hidden = !err;
  box.textContent = err ? err.message : '';
}

export function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(run) {
  const end = run.status === 'completed' ? Date.parse(run.updatedAt) : Date.now();
  const m = Math.max(0, Math.round((end - Date.parse(run.createdAt)) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// One vocabulary for a run or tracked build's state: [label, color, spinning?]
export function statusOf(r) {
  if (r.status !== 'completed') {
    if (r.retries && (r.status === 'queued' || r.status === 'requested')) return ['Retrying', 'orange', true];
    if (r.status === 'requested') return ['Starting', 'blue', true];
    if (r.status === 'in_progress') return ['Running', 'orange', true];
    return ['Queued', '', true];
  }
  switch (r.conclusion) {
    case 'success': return ['Succeeded', 'green', false];
    case 'failure': return ['Failed', 'red', false];
    case 'timed_out': return ['Timed Out', 'red', false];
    case 'startup_failure': return ['Startup Failure', 'red', false];
    case 'cancelled': return ['Cancelled', '', false];
    case 'skipped': return ['Skipped', '', false];
    default: return [r.conclusion || 'Done', '', false];
  }
}

export function statusChip(r) {
  const [label, color, spinning] = statusOf(r);
  return el('span', { class: `chip ${color}` }, spinning && el('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
}

const STATUS_COLORS = { 'To Do': '', Open: '', 'In Progress': 'blue', 'Dev Review': 'blue', 'QA Review': 'orange', 'Release Candidate': 'green', Done: 'green' };

export function ticketChip(ticket, key) {
  if (!ticket) return key ? el('span', { class: 'chip' }, key) : el('span', { class: 'chip', title: 'No TCPMOB key in branch or title' }, 'No Ticket');
  return ext(ticket.url, el('span', { class: `chip ${STATUS_COLORS[ticket.status] ?? ''}`, title: ticket.summary },
    `${ticket.key} · ${ticket.status}`));
}

// ---------- icons (hand-drawn 24px strokes, SF Symbols-like) ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
const PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9',
  release: 'M12 3 3 7.5 12 12l9-4.5L12 3ZM3 7.5V16.5L12 21l9-4.5V7.5M12 12v9',
  quality: 'M12 3a9 9 0 1 0 9 9M12 12l5-5M17 3h4v4',
  team: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a6 6 0 0 1 4 7',
  alert: 'M12 3 2 20h20L12 3ZM12 10v4M12 17.5v.01',
  hammer: 'm14 7 3-3 3 3-3 3M14 7 4 17l3 3 10-10M14 7l3 3',
  ticket: 'M3 8a2 2 0 0 0 0 4v0a2 2 0 0 0 0 4v2h18v-2a2 2 0 0 1 0-4 2 2 0 0 1 0-4V6H3v2ZM14 6v12',
  pr: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9v6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 15V8a3 3 0 0 0-3-3h-4M13 2l-2 3 2 3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM21 21l-5-5',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  check: 'M4 12.5 9 17.5 20 6.5',
  x: 'M6 6l12 12M18 6 6 18',
  chevron: 'M9 6l6 6-6 6',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM11 18h2',
  flake: 'M12 2v20M4.5 6.5l15 11M19.5 6.5l-15 11M9 4l3 2 3-2M9 20l3-2 3 2',
  calendar: 'M4 5h16v16H4zM4 10h16M9 3v4M15 3v4M8 14h2M14 14h2M8 17h2',
  leave: 'M3 20h18M5 20c0-6 3-10 7-10s7 4 7 10M12 10V5M9 6l3-3 3 3',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
  key: 'M15 7a3 3 0 1 1-3 3M14.5 9.5 21 3M18 6l2 2M5 21l7.5-7.5',
};

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.sparkle);
  svg.append(path);
  return svg;
}

// iOS Settings-style colored square with a white glyph.
export const glyph = (name, color = 'blue', size = '') => el('span', { class: `glyph g-${color} ${size}`, 'aria-hidden': 'true' }, icon(name));

// ---------- avatars ----------

const AVATAR_COLORS = ['#007aff', '#5856d6', '#af52de', '#ff2d55', '#30b0c7', '#34c759', '#ff9500'];
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

export function avatar(login, size = '') {
  const name = String(login ?? '?');
  const initials = name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
  const img = el('img', { src: `https://avatars.githubusercontent.com/${encodeURIComponent(name)}?s=72`, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.remove()); // keep the colored initials
  return el('span', { class: `avatar ${size}`, style: `background:${AVATAR_COLORS[hash(name) % AVATAR_COLORS.length]}`, title: name }, initials, img);
}

// ---------- loading + empty states ----------

export const skeleton = (n = 3) => Array.from({ length: n }, () =>
  el('li', { class: 'skeleton', 'aria-hidden': 'true' }, el('div', { class: 'sk title' }), el('div', { class: 'sk sub' })));

export const empty = (iconName, title, text = '', color = 'green') => el('li', { class: 'placeholder' },
  el('div', { class: 'empty' }, glyph(iconName, color), el('div', { class: 'empty-title' }, title), text && el('div', { class: 'muted' }, text)));

export const placeholder = (text) => el('li', { class: 'placeholder' }, text);
export const sep = () => el('span', { class: 'sep' });

// Promise-based sheet for every write action. Resolves true only when the user confirms.
// `onConfirm` (optional) runs while the sheet shows progress; a thrown error stays in the sheet.
export function confirmSheet({ title, body = [], confirmLabel = 'Confirm', danger = false, onConfirm = null, confirmDisabled = false, onReady = null }) {
  return new Promise((resolve) => {
    const error = el('div', { class: 'banner error', role: 'alert', hidden: true });
    const cancel = el('button', { type: 'button', class: 'btn' }, 'Cancel');
    const ok = el('button', { type: 'submit', class: `btn ${danger ? 'btn-danger-filled' : 'btn-filled'}`, disabled: confirmDisabled }, confirmLabel);
    const form = el('form', { method: 'dialog', class: 'sheet-form' },
      el('h3', {}, title), ...body, error, el('div', { class: 'sheet-actions' }, cancel, ok));
    const dialog = el('dialog', { class: 'sheet' }, form);
    let busy = false;
    let result = false;

    const finish = (value) => { result = value; dialog.close(); };
    cancel.addEventListener('click', () => { if (!busy) finish(false); });
    dialog.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
    dialog.addEventListener('click', (e) => { if (e.target === dialog && !busy) finish(false); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      if (!onConfirm) return finish(true);
      busy = true;
      ok.disabled = true; cancel.disabled = true;
      const label = ok.textContent;
      ok.textContent = 'Working…';
      try {
        await onConfirm(ok);
        busy = false;
        finish(true);
      } catch (err) {
        showError(error, err);
        busy = false;
        ok.disabled = false; cancel.disabled = false;
        ok.textContent = label;
        form.dispatchEvent(new Event('change')); // let the caller recompute a dynamic label
      }
    });
    document.body.append(dialog);
    onReady?.(ok, () => busy);
    dialog.showModal();
  });
}

export function toast(text, kind = 'ok') {
  const g = kind === 'bad' ? glyph('x', 'red') : glyph('check', 'green');
  const t = el('div', { class: `toast ${kind}`, role: 'status' }, g, el('span', {}, text));
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 3500);
  setTimeout(() => t.remove(), 4000);
}

export function section(id, title, look, ...headExtras) {
  const [iconName, color] = look ?? [];
  return el('section', { 'aria-labelledby': `${id}-h`, id: `${id}-section` },
    el('div', { class: 'section-head' },
      el('div', { class: 'section-title' }, iconName && glyph(iconName, color, 'sm'), el('h3', { id: `${id}-h` }, title)), ...headExtras),
    el('div', { class: 'banner error', role: 'alert', id: `${id}-error`, hidden: true }),
    el('ul', { class: 'group', id }));
}
