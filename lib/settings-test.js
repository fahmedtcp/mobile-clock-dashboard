// Test Connection for the Settings page. Read-only checks against what the user typed (merged over saved
// values); candidates are validated like a save but never stored, and never echoed back in a message.
import { HttpError } from './http.js';
import { createJira, JiraError } from './jira.js';
import { createTempo } from './time/tempo.js';
import { validateSettingsPatch } from './settings.js';
import { validWebhookUrl } from './teams.js';
import { dayKey } from './time/days.js';

const SAFE_TEMPO = /^(Tempo |Can't reach Tempo)/; // our own fixed messages; anything else gets a generic one

const NOT_SIGNED_IN = { ok: false, message: 'Not signed in. Run gh auth login in Terminal.' };

const makeJira = (ctx, cfg) => (ctx.makeJira ?? createJira)(cfg);
const makeTempo = (ctx, cfg) => (ctx.makeTempo ?? createTempo)(cfg);

async function testGithub(ctx) {
  ctx.gh.clearCache?.(); // a sign-in check must ask GitHub now
  try {
    const login = (await ctx.gh.run(['api', 'user', '--jq', '.login'])).trim();
    return login ? { ok: true, message: `Signed in as ${login}.` } : NOT_SIGNED_IN;
  } catch {
    return NOT_SIGNED_IN;
  }
}

async function testJira(ctx, body) {
  const jira = makeJira(ctx, { ...ctx.settings.resolved().jira, ...body });
  if (!jira.configured) return { ok: false, message: 'Add your Jira URL, email, and token.' };
  try {
    return { ok: true, message: `Connected as ${(await jira.myself()).displayName}.` };
  } catch (err) {
    const message = err instanceof JiraError ? `Jira said: ${err.message}` : 'Couldn\'t connect to Jira.';
    return { ok: false, message };
  }
}

async function testTempo(ctx, body) {
  const current = ctx.settings.resolved();
  const jira = makeJira(ctx, current.jira);
  if (!jira.configured) {
    return { ok: false, message: 'Connect Jira first. Tempo uses your Jira account to find your worklogs.' };
  }
  const token = body.token ?? current.tempo.token;
  if (!token) return { ok: false, message: 'Add your Tempo token.' };
  try {
    const { accountId } = await jira.myself();
    const today = dayKey(new Date());
    await makeTempo(ctx, { token }).worklogs(accountId, today, today);
    return { ok: true, message: 'Connected.' };
  } catch (err) {
    return { ok: false, message: SAFE_TEMPO.test(err.message) ? err.message : 'Couldn\'t connect to Tempo.' };
  }
}

const teamsWebhook = (field) => async (ctx, body) => checkWebhook(body[field] ?? ctx.settings.resolved().teams[field]);

// service → [settings section the body is validated as, test]
const TESTS = {
  github: [null, testGithub],
  jira: ['jira', testJira],
  tempo: ['tempo', testTempo],
  teams: ['teams', teamsWebhook('webhookUrl')],
  teamsTest: ['teams', teamsWebhook('testWebhookUrl')],
  teamsQa: ['teams', teamsWebhook('qaWebhookUrl')],
};

async function handleTestConnection(ctx, service, req) {
  if (!Object.hasOwn(TESTS, service)) throw new HttpError(404, 'Unknown connection.');
  const [section, test] = TESTS[service];
  const body = (await ctx.readJson(req)) ?? {};
  if (section) {
    const error = validateSettingsPatch({ [section]: body });
    if (error) return { ok: false, message: error };
  }
  return test(ctx, body);
}

export function connectionRoutes(ctx) {
  return [
    ['POST', /^\/api\/settings\/test\/([^/]+)$/, (m, req) => handleTestConnection(ctx, m[1], req)],
  ];
}

function checkWebhook(url) {
  return validWebhookUrl(url)
    ? { ok: true, message: 'Looks right. To see a real message, use test mode in Request Review.' }
    : { ok: false, message: 'Use a Teams Workflows webhook address.' };
}
