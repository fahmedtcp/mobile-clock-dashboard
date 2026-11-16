import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, botHeader } from '../public/markdown.js';

const SAMPLE = `**Claude finished @fahmedtcp's task in 1m 25s** —— [View job](https://github.com/tcp-software/mobile-clock/actions/runs/43842059017)

---
### PR Review: TCPMOB-1764 – Deep link with an invalid namespace or company ID

- [x] Read the PR diff and \`.ai/project-instructions.md\`
- [ ] Post summary

Looks **good** overall.
1. First
2. Second

\`\`\`ts
const a = <b>1</b>;
\`\`\`
> Note this
| File | Issue |
|---|---|
| a.ts | **bad** |`;

test('the bot header becomes a duration and a job link', () => {
  const { header, rest } = botHeader(SAMPLE);
  assert.deepEqual(header, { took: '1m 25s', url: 'https://github.com/tcp-software/mobile-clock/actions/runs/43842059017' });
  assert.ok(rest.startsWith('### PR Review'), 'the rule under the header goes too');
  assert.deepEqual(botHeader('plain text'), { header: null, rest: 'plain text' });
});

test('blocks: headings, rules, task and numbered lists, paragraphs, code, quotes, tables', () => {
  const blocks = parseMarkdown(botHeader(SAMPLE).rest);
  assert.deepEqual(blocks.map((b) => b.type), ['h', 'list', 'p', 'list', 'code', 'quote', 'table']);
  assert.equal(blocks[0].level, 3);
  assert.deepEqual(blocks[1].items.map((i) => i.checked), [true, false]);
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[4].text, 'const a = <b>1</b>;');
  assert.deepEqual(blocks[6].rows.length, 2);
  assert.deepEqual(blocks[6].rows[1][1], [{ t: 'b', v: [{ t: 'text', v: 'bad' }] }]);
});

test('inline: bold, italic, code, and only http(s) links', () => {
  assert.deepEqual(parseInline('a **b** _c_ `d` [e](https://x.y) [f](javascript:alert(1))'), [
    { t: 'text', v: 'a ' }, { t: 'b', v: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' ' }, { t: 'i', v: [{ t: 'text', v: 'c' }] },
    { t: 'text', v: ' ' }, { t: 'code', v: 'd' }, { t: 'text', v: ' ' }, { t: 'link', href: 'https://x.y', v: [{ t: 'text', v: 'e' }] },
    { t: 'text', v: ' f' },
  ]);
});

test('HTML in the text is dropped to its words, never kept as markup', () => {
  const blocks = parseMarkdown('<details><summary>Inline notes</summary>\n\nSee <b>this</b>\n</details>');
  const text = JSON.stringify(blocks);
  assert.ok(!text.includes('<'), text);
  assert.ok(text.includes('Inline notes'));
  assert.ok(text.includes('See this'));
});
