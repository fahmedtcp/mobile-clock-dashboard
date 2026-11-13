import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { createTeams } from '../lib/teams.js';
import { request } from './helpers.js';

const openPr = {
  number: 9, title: 't', url: 'u', author: { login: 'me' },
  headRefName: 'x', isDraft: false, state: 'OPEN', reviewRequests: [],
};

test('without a webhook, preview says so and send returns 503 without calling out', async () => {
  const gh = { async json() { return openPr; }, async run() { return 'me\n'; } };
  const server = createServer({
    gh, tracker: { list: () => [] }, behind: {},
    teams: createTeams({ webhookUrl: '' }),
    teamsTest: createTeams({ webhookUrl: '', label: 'test chat' }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const req = (...a) => request(server.address().port)(...a);

  assert.equal((await req('GET', '/api/prs/9/review-request')).json().configured, false);
  const testSend = await req('POST', '/api/prs/9/review-request', { logins: [], test: true });
  assert.equal(testSend.status, 503);
  assert.match(testSend.json().error, /test chat webhook in Settings/);
  const realSend = await req('POST', '/api/prs/9/review-request', { logins: [] });
  assert.equal(realSend.status, 503);
  assert.match(realSend.json().error, /review channel webhook in Settings/);
  server.close();
});
