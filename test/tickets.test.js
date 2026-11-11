import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketKey, keysJql, toTicket, createTicketCache, parseBuildComments, branchName } from '../lib/tickets.js';

test('ticketKey reads branch first, then title, uppercased', () => {
  assert.equal(ticketKey('tcpmob-1482-sub-management', 'x'), 'TCPMOB-1482');
  assert.equal(ticketKey('fix/thing', 'TCPMOB-33: notes'), 'TCPMOB-33');
  assert.equal(ticketKey('detox-poc', 'Detox POC'), null);
  assert.equal(ticketKey(undefined, null), null);
});

test('keysJql drops anything that is not a plain key (no JQL injection)', () => {
  assert.equal(keysJql(['TCPMOB-1', 'TCPMOB-2" OR project = HR', 'tcpmob-3', 'TCPMOB-1']), 'key in (TCPMOB-1, TCPMOB-3)');
  assert.equal(keysJql(['nope']), null);
  assert.equal(keysJql([]), null);
});

test('toTicket maps Jira fields', () => {
  const t = toTicket({ key: 'TCPMOB-1', fields: { summary: 'S', status: { name: 'Dev Review', statusCategory: { key: 'indeterminate' } }, assignee: { accountId: 'a', displayName: 'F' }, fixVersions: [{ name: 'Mobile 46' }], issuetype: { name: 'Bug' } } }, 'https://x.atlassian.net');
  assert.deepEqual(t, { key: 'TCPMOB-1', url: 'https://x.atlassian.net/browse/TCPMOB-1', summary: 'S', status: 'Dev Review', statusCategory: 'indeterminate', assignee: { accountId: 'a', name: 'F' }, fixVersions: ['Mobile 46'], issueType: 'Bug' });
  assert.equal(toTicket({ key: 'TCPMOB-2', fields: {} }, 'u').assignee, null);
});

test('ticket cache: one search for misses, reuse within 60s, refetch after', async () => {
  const jqls = []; let t = 0;
  const jira = { search: async (jql) => { jqls.push(jql); return [{ key: 'TCPMOB-1', fields: { status: { name: 'Open' } } }]; } };
  const cache = createTicketCache(jira, 'u', () => t);
  const m = await cache.get(['TCPMOB-1', 'TCPMOB-2']);
  assert.equal(m.get('TCPMOB-1').status, 'Open');
  assert.equal(m.has('TCPMOB-2'), false);
  await cache.get(['TCPMOB-1', 'TCPMOB-2']);
  assert.deepEqual(jqls, ['key in (TCPMOB-1, TCPMOB-2)']);
  t = 60001;
  await cache.get(['TCPMOB-1']);
  assert.equal(jqls.length, 2);
});

test('parseBuildComments reads all four workflow comment texts', () => {
  const c = (text) => ({ author: 'Foad Ahmed', created: '2026-11-06T12:00:00Z', text });
  assert.deepEqual(parseBuildComments([
    c('fahmedtcp pushed build number 4521 for MobileClock IOS to testflight '),
    c('fahmedtcp pushed build number 4522 for Mobile Kiosk IOS to testflight'),
    c('fahmedtcp pushed build number 30117 for Mobile Clock Android to firebase distribution '),
    c('fahmedtcp pushed build number 30118 for Mobile Kiosk Android to firebase distribution '),
    c('looks good'),
  ]).map((b) => [b.app, b.platform, b.number, b.user]), [
    ['MobileClock', 'iOS', '4521', 'fahmedtcp'], ['Mobile Kiosk', 'iOS', '4522', 'fahmedtcp'],
    ['MobileClock', 'Android', '30117', 'fahmedtcp'], ['Mobile Kiosk', 'Android', '30118', 'fahmedtcp'],
  ]);
});

test('branchName: kebab, ascii, ≤100 chars, valid ref', () => {
  assert.equal(branchName('TCPMOB-1482', 'Sub Management 2.0 | Day View: "Load more" button…'), 'TCPMOB-1482-sub-management-2-0-day-view-load-more-button');
  const long = branchName('TCPMOB-1', 'é😀 '.repeat(20) + 'a'.repeat(300) + '..');
  assert.ok(long.length <= 100 && /^TCPMOB-\d+(-[a-z0-9]+)*$/.test(long), long);
  assert.equal(branchName('TCPMOB-9', '!!!'), 'TCPMOB-9');
  assert.equal(branchName('TCPMOB-7', 'Café résumé'), 'TCPMOB-7-cafe-resume');
});

test('parseBuildComments accepts comments with no username (empty pusher on manual runs)', () => {
  const out = parseBuildComments([{ author: 'Jira Bot', created: 'c', text: 'pushed build number 1760 for Mobile Kiosk Android to firebase distribution' }]);
  assert.deepEqual(out.map((b) => [b.app, b.platform, b.number, b.user]), [['Mobile Kiosk', 'Android', '1760', null]]);
});
