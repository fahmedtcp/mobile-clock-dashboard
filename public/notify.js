// Pure helpers shared by the page and the Node tests: no DOM or browser APIs here.

function buildNotification(b) {
  const retries = b.retries ?? 0;
  const retried = retries ? ` after ${retries} automatic ${retries === 1 ? 'retry' : 'retries'}` : '';
  if (b.conclusion === 'success') {
    return { title: `${b.label} succeeded`, body: `PR #${b.prNumber} build passed${retried}.`, url: b.url };
  }
  if (b.reason) {
    const attempts = b.attempt ?? 1;
    const last = b.reason.lines.at(-1);
    return {
      title: `${b.label} failed after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
      body: [`PR #${b.prNumber} · ${b.reason.step}`, last].filter(Boolean).join('\n'),
      url: b.url,
    };
  }
  return { title: `${b.label} ${b.conclusion ?? 'finished'}`, body: `PR #${b.prNumber}: ${b.conclusion ?? 'finished'}${retried}.`, url: b.url };
}

export function diffNotifications(prev, next) {
  if (!prev) return [];
  const out = [];
  const prevBuilds = new Map(prev.builds.map((b) => [b.id, b]));
  for (const b of next.builds) {
    if (b.status !== 'completed' || prevBuilds.get(b.id)?.status === 'completed') continue;
    out.push(buildNotification(b));
  }
  const prevBadges = new Map(prev.badges.map((x) => [x.key, x]));
  for (const x of next.badges) {
    if (x.color !== 'red' || prevBadges.get(x.key)?.color === 'red') continue;
    out.push({ title: `${x.label} is failing`, body: 'The latest run failed.', url: x.url });
  }
  return out;
}

const ACTIVE = new Set(['requested', 'queued', 'in_progress', 'waiting', 'pending']);

export function pollDelay(builds, runs) {
  return [...builds, ...runs].some((r) => ACTIVE.has(r.status)) ? 15000 : 60000;
}

export function submitState(checked, inFlight) {
  if (inFlight) return { disabled: true, label: 'Triggering...' };
  return { disabled: checked === 0, label: `Trigger ${checked} build${checked === 1 ? '' : 's'}` };
}

const BEHIND_TTL_MS = 300000; // matches the server cache in config.js

export function behindStale(entry, now) {
  if (!entry) return true;
  if (entry.loading) return false;
  return now - entry.at > BEHIND_TTL_MS;
}
