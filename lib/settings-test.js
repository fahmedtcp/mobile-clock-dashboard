// Test Connection for the Settings page. Read-only checks against what the user typed (merged over saved
// values); candidates are validated like a save but never stored, and never echoed back in a message.
import { HttpError } from './http.js';
import { createJira, JiraError } from './jira.js';
import { createTempo } from './time/tempo.js';
import { validateSettingsPatch } from './settings.js';
import { validWebhookUrl } from './teams.js';
import { dayKey } from './time/days.js';

const SAFE_TEMPO = /^(Tempo |Can't reach Tempo)/; // our own fixed messages; anything else gets a generic one

export function connectionRoutes(ctx) {
  const makeJira = (cfg) => (ctx.makeJira ?? createJira)(cfg);
  const makeTempo = (cfg) => (ctx.makeTempo ?? createTempo)(cfg);

  const tests = {
    async github() {
      try {
        const login = (await ctx.gh.run(['api', 'user', '--jq', '.login'])).trim();
        return login ? { ok: true, message: `Signed in as ${login}.` } : { ok: false, message: 'Not signed in. Run gh auth login in Terminal.' };
      } catch {
        return { ok: false, message: 'Not signed in. Run gh auth login in Terminal.' };
      }
    },
    async jira(body) {
      const jira = makeJira({ ...ctx.settings.resolved().jira, ...body });
      if (!jira.configured) return { ok: false, message: 'Add your Jira URL, email, and token.' };
      try {
        return { ok: true, message: `Connected as ${(await jira.myself()).displayName}.` };
      } catch (err) {
        return { ok: false, message: err instanceof JiraError ? `Jira said: ${err.message}` : 'Couldn\'t connect to Jira.' };
      }
    },
    async tempo(body) {
      const r = ctx.settings.resolved();
      const jira = makeJira(r.jira);
      if (!jira.configured) return { ok: false, message: 'Connect Jira first. Tempo uses your Jira account to find your worklogs.' };
      const token = body.token ?? r.tempo.token;
      if (!token) return { ok: false, message: 'Add your Tempo token.' };
      try {
        const { accountId } = await jira.myself();
        const today = dayKey(new Date());
        await makeTempo({ token }).worklogs(accountId, today, today);
        return { ok: true, message: 'Connected.' };
      } catch (err) {
        return { ok: false, message: SAFE_TEMPO.test(err.message) ? err.message : 'Couldn\'t connect to Tempo.' };
      }
    },
    async teams(body) { return webhook(body.webhookUrl ?? ctx.settings.resolved().teams.webhookUrl); },
    async teamsTest(body) { return webhook(body.testWebhookUrl ?? ctx.settings.resolved().teams.testWebhookUrl); },
    async teamsQa(body) { return webhook(body.qaWebhookUrl ?? ctx.settings.resolved().teams.qaWebhookUrl); },
  };
  const section = { github: null, jira: 'jira', tempo: 'tempo', teams: 'teams', teamsTest: 'teams', teamsQa: 'teams' };

  return [
    ['POST', /^\/api\/settings\/test\/([^/]+)$/, async (m, req) => {
      const service = m[1];
      if (!Object.hasOwn(tests, service)) throw new HttpError(404, 'Unknown connection.');
      const body = (await ctx.readJson(req)) ?? {};
      if (section[service]) {
        const error = validateSettingsPatch({ [section[service]]: body });
        if (error) return { ok: false, message: error };
      }
      return tests[service](body);
    }],
  ];
}

function webhook(url) {
  return validWebhookUrl(url)
    ? { ok: true, message: 'Looks right. To see a real message, use test mode in Request Review.' }
    : { ok: false, message: 'Use a Teams Workflows webhook address.' };
}
