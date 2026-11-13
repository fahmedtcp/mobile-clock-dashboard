// Since You Last Looked / Since Last Shift: what other people did on my tickets and PRs.
import { quoteOf } from './work.js';

const MAX_ITEMS = 20;
const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'Someone';

function nameFor(people, { accountId, login, displayName }) {
  const person = people.find((p) => (accountId && p.accountId === accountId) || (login && p.github === login));
  return firstName(person?.name ?? displayName ?? login);
}

export function feedItems(input, { sinceMs }) {
  const { me, people } = input;
  const items = [];
  for (const [key, histories] of input.changelogs) {
    for (const h of histories) {
      if (h.author?.accountId === me.accountId) continue;
      for (const item of (h.items ?? []).filter((i) => i.field === 'status')) {
        items.push({ at: h.created, who: nameFor(people, { accountId: h.author?.accountId, displayName: h.author?.displayName }),
          kind: 'status', key, pr: null, text: `moved ${key} to ${item.toString}`, quote: null });
      }
    }
  }
  for (const [key, comments] of input.comments) {
    for (const c of comments.filter((x) => x.authorId !== me.accountId)) {
      items.push({ at: c.created, who: nameFor(people, { accountId: c.authorId, displayName: c.author }),
        kind: 'comment', key, pr: null, text: `commented on ${key}`, quote: quoteOf(c.text) });
    }
  }
  for (const pr of input.prs) {
    for (const review of (pr.reviews ?? []).filter((r) => r.by !== me.login)) {
      const who = nameFor(people, { login: review.by });
      if (review.state === 'APPROVED') {
        items.push({ at: review.at, who, kind: 'approved', key: null, pr: pr.number, text: `approved #${pr.number}`, quote: null });
      } else if (review.state === 'CHANGES_REQUESTED') {
        items.push({ at: review.at, who, kind: 'review', key: null, pr: pr.number, text: `asked for changes on #${pr.number}`, quote: quoteOf(review.body) });
      }
    }
  }
  return items.filter((i) => Date.parse(i.at) >= sinceMs)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_ITEMS);
}
