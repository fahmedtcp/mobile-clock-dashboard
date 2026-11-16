// ⌘K command palette: jump to a view, open a pull request, look up a ticket's builds, or switch theme.
// Type to filter (every word must match), ↑↓ to move, Return to run, Esc to close.
import { el, icon } from './ui.js';
import { TICKET_KEY } from './shared.js';

let open = null; // the live dialog, so ⌘K twice doesn't stack two

function paletteDialog() {
  const input = el('input', {
    type: 'search', class: 'palette-input', placeholder: 'Search views, pull requests, or a ticket key',
    'aria-label': 'Command', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true',
    'aria-controls': 'palette-list',
  });
  const list = el('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
  const dialog = el('dialog', { class: 'palette', 'aria-label': 'Command palette' },
    el('div', { class: 'palette-field' }, icon('search'), input), list);
  return { input, list, dialog };
}

function commandItems({ views, shared, go, setTheme }) {
  return [
    ...views.map((v) => ({ group: 'Go to', icon: v.icon, title: v.title, hint: v.key, run: () => go(v.id) })),
    ...shared.prs.slice(0, 40).map((p) => ({
      group: 'Pull Requests', icon: 'pr', title: `#${p.number} ${p.title}`, hint: p.author,
      run: () => window.open(p.url, '_blank', 'noopener'),
    })),
    { group: 'Appearance', icon: 'moon', title: 'Use Dark Theme', run: () => setTheme('dark') },
    { group: 'Appearance', icon: 'moon', title: 'Use Light Theme', run: () => setTheme('light') },
    { group: 'Appearance', icon: 'moon', title: 'Match System Theme', run: () => setTheme('system') },
  ];
}

// Every typed word must appear in the item; a full ticket key also offers the build lookup first.
function matchingItems(text, options) {
  const query = text.trim().toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  const key = query.toUpperCase();
  const matchesAll = (it) => words.every((w) => `${it.title} ${it.hint ?? ''} ${it.group}`.toLowerCase().includes(w));
  const ticketItems = [
    { group: 'Ticket', icon: 'ticket', title: `Open ticket ${key}`, run: () => options.openTicket(key) },
    { group: 'Ticket', icon: 'search', title: `Which build has ${key}?`, run: () => options.lookup(key) },
  ];
  const todoText = text.trim().match(/^todo\s+(.+)$/i)?.[1];
  const todoItems = todoText && options.addTodo
    ? [{ group: 'To-Do', icon: 'check', title: `Add to-do: ${todoText}`, run: () => options.addTodo(todoText) }] : [];
  return [
    ...todoItems,
    ...(TICKET_KEY.test(key) ? ticketItems : []),
    ...commandItems(options).filter(matchesAll),
  ].slice(0, 12);
}

export function openPalette(options) {
  if (open) { open.querySelector('input').focus(); return; }
  const { input, list, dialog } = paletteDialog();
  let items = [];
  let active = 0;

  function filter() {
    items = matchingItems(input.value, options);
    active = 0;
    paint();
  }

  function itemRow(it, i) {
    return el('li', {
      id: `pal-${i}`, role: 'option', class: 'palette-item', 'aria-selected': String(i === active),
      onpointerdown: (e) => { e.preventDefault(); active = i; run(); },
      onpointermove: () => { if (active !== i) { active = i; paint(); } },
    },
    icon(it.icon),
    el('span', { class: 'palette-title' }, it.title),
    it.hint && el('span', { class: 'palette-hint' }, it.hint));
  }

  function paint() {
    let lastGroup = null;
    list.replaceChildren(...(items.length ? items.flatMap((it, i) => {
      const head = it.group !== lastGroup ? [el('li', { class: 'palette-group', role: 'presentation' }, it.group)] : [];
      lastGroup = it.group;
      return [...head, itemRow(it, i)];
    }) : [el('li', { class: 'palette-empty' }, 'No matches')]));
    input.setAttribute('aria-activedescendant', items.length ? `pal-${active}` : '');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function run() {
    const it = items[active];
    if (!it) return;
    dialog.close();
    it.run();
  }

  function onKeydown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
    if (e.key === 'Enter') { e.preventDefault(); run(); }
  }

  input.addEventListener('input', filter);
  input.addEventListener('keydown', onKeydown);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { dialog.remove(); open = null; });
  document.body.append(dialog);
  open = dialog;
  dialog.showModal();
  filter();
  input.focus();
}
