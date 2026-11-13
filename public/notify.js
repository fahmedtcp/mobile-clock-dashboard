// Pure helpers shared by the page and the Node tests: no DOM or browser APIs here.

const plural = (count, word, pluralWord = `${word}s`) => (count === 1 ? word : pluralWord);

function buildNotification(build) {
  const retries = build.retries ?? 0;
  const retried = retries ? ` after ${retries} automatic ${plural(retries, 'retry', 'retries')}` : '';
  if (build.conclusion === 'success') {
    return { title: `${build.label} succeeded`, body: `PR #${build.prNumber} build passed${retried}.`, url: build.url };
  }
  if (build.reason) {
    const attempts = build.attempt ?? 1;
    const lastLine = build.reason.lines.at(-1);
    return {
      title: `${build.label} failed after ${attempts} ${plural(attempts, 'attempt')}`,
      body: [`PR #${build.prNumber} · ${build.reason.step}`, lastLine].filter(Boolean).join('\n'),
      url: build.url,
    };
  }
  const outcome = build.conclusion ?? 'finished';
  return { title: `${build.label} ${outcome}`, body: `PR #${build.prNumber}: ${outcome}${retried}.`, url: build.url };
}

export function diffNotifications(prev, next) {
  if (!prev) return [];
  const notifications = [];
  const prevBuilds = new Map(prev.builds.map((b) => [b.id, b]));
  for (const build of next.builds) {
    if (build.status !== 'completed' || prevBuilds.get(build.id)?.status === 'completed') continue;
    notifications.push(buildNotification(build));
  }
  const prevBadges = new Map(prev.badges.map((badge) => [badge.key, badge]));
  for (const badge of next.badges) {
    if (badge.color !== 'red' || prevBadges.get(badge.key)?.color === 'red') continue;
    notifications.push({ title: `${badge.label} is failing`, body: 'The latest run failed.', url: badge.url });
  }
  return notifications;
}

const ACTIVE = new Set(['requested', 'queued', 'in_progress', 'waiting', 'pending']);

export function pollDelay(builds, runs) {
  return [...builds, ...runs].some((item) => ACTIVE.has(item.status)) ? 15000 : 60000;
}

export function submitState(checked, inFlight) {
  if (inFlight) return { disabled: true, label: 'Triggering...' };
  return { disabled: checked === 0, label: `Trigger ${checked} ${plural(checked, 'build')}` };
}

const BEHIND_TTL_MS = 300000; // matches the server cache in config.js

export function behindStale(entry, now) {
  if (!entry) return true;
  if (entry.loading) return false;
  return now - entry.at > BEHIND_TTL_MS;
}
