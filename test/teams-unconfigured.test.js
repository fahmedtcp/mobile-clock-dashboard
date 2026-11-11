import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { createTeams } from '../lib/teams.js';
import { request } from './helpers.js';

test('without a webhook, preview says so and send returns 503 without calling out', async () => {
  const gh = { async json() { return { number: 9, title: 't', url: 'u', author: { login: 'me' }, headRefName: 'x', isDraft: false, state: 'OPEN', reviewRequests: [] }; }, async run() { return 'me\n'; } };
  const server = createServer({ gh, tracker: { list: () => [] }, behind: {}, teams: createTeams({ webhookUrl: '' }), teamsTest: createTeams({ webhookUrl: '', label: 'test chat' }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (...a) => request(port)(...a);
  assert.equal((await req('GET', '/api/prs/9/review-request')).json().configured, false);
  const t = await req('POST', '/api/prs/9/review-request', { logins: [], test: true });
  assert.equal(t.status, 503);
  assert.match(t.json().error, /test chat webhook in Settings/);
  const s = await req('POST', '/api/prs/9/review-request', { logins: [] });
  assert.equal(s.status, 503);
  assert.match(s.json().error, /review channel webhook in Settings/);
  server.close();
});
