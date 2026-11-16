// A small Markdown reader for the Claude review bot's GitHub comments: headings, lists (with task boxes), bold,
// italic, code, links, quotes, rules, and tables. It returns plain data; the page builds it with textContent only,
// so nothing in a comment can become markup. HTML tags are dropped to their words, and only http(s) links survive.

const HEADER = /^\*\*Claude finished .*? task in ([^*]+?)\*\*\s*[-—–]+\s*\[View job\]\((https:\/\/[^)\s]+)\)\s*\n?/;
const TAG = /<\/?[a-z][^>]*>/gi;

// The bot's first line ("Claude finished … in 1m 25s —— View job") becomes a duration and a link.
export function botHeader(text) {
  const match = String(text ?? '').match(HEADER);
  if (!match) return { header: null, rest: String(text ?? '') };
  return { header: { took: match[1].trim(), url: match[2] }, rest: text.slice(match[0].length).replace(/^\s*(?:(?:-{3,}|\*{3,})\s*\n)?\s*/, '') };
}

function pushText(out, value) {
  if (!value) return;
  const last = out.at(-1);
  if (last?.t === 'text') last.v += value; else out.push({ t: 'text', v: value });
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(\b_[^_\s][^_]*_\b)|(\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\))/;

export function parseInline(text) {
  const out = [];
  let rest = String(text ?? '').replace(TAG, '');
  while (rest) {
    const m = rest.match(INLINE);
    if (!m) { pushText(out, rest); break; }
    pushText(out, rest.slice(0, m.index));
    const [token] = m;
    if (m[1]) out.push({ t: 'code', v: token.slice(1, -1) });
    else if (m[2] || m[3]) out.push({ t: 'b', v: parseInline(token.slice(2, -2)) });
    else if (m[4] || m[5]) out.push({ t: 'i', v: parseInline(token.slice(1, -1)) });
    else {
      const [, label, href] = token.match(/^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)$/);
      if (/^https?:\/\//i.test(href)) out.push({ t: 'link', href, v: parseInline(label) });
      else parseInline(label).forEach((node) => (node.t === 'text' ? pushText(out, node.v) : out.push(node)));
    }
    rest = rest.slice(m.index + token.length);
  }
  return out;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const tableCells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => parseInline(cell.trim()));

export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', inlines: parseInline(para.join(' ')) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const stripped = line.replace(TAG, '').trim();
    if (!stripped) { flush(); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(stripped)) { flush(); blocks.push({ type: 'hr' }); continue; }
    const heading = stripped.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { flush(); blocks.push({ type: 'h', level: heading[1].length, inlines: parseInline(heading[2]) }); continue; }
    if (stripped.startsWith('>')) {
      flush();
      const quote = [];
      for (; i < lines.length && lines[i].trim().startsWith('>'); i++) quote.push(lines[i].trim().replace(/^>\s?/, ''));
      i--;
      blocks.push({ type: 'quote', inlines: parseInline(quote.join(' ')) });
      continue;
    }
    if (stripped.startsWith('|') && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] ?? '')) {
      flush();
      const rows = [tableCells(stripped)];
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(tableCells(lines[i]));
      i--;
      blocks.push({ type: 'table', rows });
      continue;
    }
    const item = line.match(LIST_ITEM);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const list = { type: 'list', ordered, items: [] };
      for (; i < lines.length; i++) {
        const m = lines[i].match(LIST_ITEM);
        if (!m) {
          // A wrapped line continues the previous item.
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && list.items.length) {
            const last = list.items.at(-1);
            last.inlines = parseInline(`${last.raw} ${lines[i].trim()}`);
            last.raw += ` ${lines[i].trim()}`;
            continue;
          }
          break;
        }
        list.items.push({
          depth: Math.floor(m[1].replace(/\t/g, '  ').length / 2),
          checked: m[3] === undefined ? null : m[3].toLowerCase() === 'x',
          raw: m[4], inlines: parseInline(m[4]),
        });
      }
      i--;
      list.items.forEach((it) => delete it.raw);
      blocks.push(list);
      continue;
    }
    para.push(stripped);
  }
  flush();
  return blocks;
}
