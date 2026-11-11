import { REPO, STATUS } from '../config.js';

const RUN_FIELDS = 'databaseId,workflowName,headBranch,event,status,conclusion,createdAt,updatedAt,url,displayTitle';
const RED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);

export function listRuns(gh, { workflow, branch, user } = {}) {
  const args = ['run', 'list', '-R', REPO, '-L', '50'];
  if (workflow) args.push('-w', workflow);
  if (branch) args.push('-b', branch);
  if (user) args.push('-u', user);
  return gh.json([...args, '--json', RUN_FIELDS]);
}

export async function rerunFailed(gh, id) {
  await gh.run(['run', 'rerun', String(id), '--failed', '-R', REPO]);
}

export async function cancelRun(gh, id) {
  await gh.run(['run', 'cancel', String(id), '-R', REPO]);
}

export function badgeColor(run) {
  if (!run || run.status !== 'completed') return 'grey';
  if (run.conclusion === 'success') return 'green';
  return RED.has(run.conclusion) ? 'red' : 'grey';
}

export function statusStrip(gh) {
  return Promise.all(STATUS.map(async ({ key, label, file, branch }) => {
    const args = ['run', 'list', '-R', REPO, '-w', file, '-L', '1'];
    if (branch) args.push('-b', branch);
    const [run] = await gh.json([...args, '--json', 'status,conclusion,url']);
    return { key, label, color: badgeColor(run ?? null), url: run?.url ?? null, conclusion: run?.conclusion || null };
  }));
}

let login = null;
export async function getLogin(gh) {
  login ??= (await gh.run(['api', 'user', '--jq', '.login'])).trim();
  return login;
}
