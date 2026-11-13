// Evidence → weights → hours. The pure allocator lives in public/shared.js so the page rebalances the same way.
import { TIME_WEIGHTS as W } from '../../config.js';
import { allocate, rebalance } from '../../public/shared.js';

export { allocate, rebalance };

// signals for one day → Map<key, { weight, evidence }>. Only keys in `known` (the user's real tickets) count.
export function dayWeights({ inProgress, commits, claude, activity, github = [] }, known) {
  const evidence = new Map();
  const evidenceFor = (key) => {
    if (!evidence.has(key)) {
      evidence.set(key, { commits: 0, claudeMinutes: 0, inProgress: false, activity: 0, builds: 0, reviews: 0 });
    }
    return evidence.get(key);
  };
  for (const key of inProgress) evidenceFor(key).inProgress = true;
  for (const commit of commits) if (commit.key) evidenceFor(commit.key).commits += 1;
  for (const session of claude) {
    for (const seg of session.segments ?? []) if (seg.key) evidenceFor(seg.key).claudeMinutes += seg.activeMinutes;
  }
  for (const [key, n] of activity) evidenceFor(key).activity += n;
  for (const event of github) if (event.key) evidenceFor(event.key)[event.kind === 'build' ? 'builds' : 'reviews'] += 1;

  const out = new Map();
  for (const [key, e] of evidence) {
    if (!known.has(key)) continue;
    const weight = (e.inProgress ? W.inProgress : 0)
      + Math.min(e.commits * W.commit, W.commitCap)
      + Math.min((e.claudeMinutes / 30) * W.claudePer30, W.claudeCap)
      + Math.min(e.activity * W.activity, W.activityCap)
      + Math.min(e.builds * W.build, W.buildCap)
      + Math.min(e.reviews * W.review, W.reviewCap);
    if (weight > 0) out.set(key, { weight, evidence: e });
  }
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function minutes(total) {
  const hours = Math.floor(total / 60), rest = Math.round(total % 60);
  return hours ? `${hours}h${rest ? ` ${rest}m` : ''}` : `${rest}m`;
}

export function evidenceText(e) {
  const parts = [];
  if (e.commits) parts.push(plural(e.commits, 'commit'));
  if (e.claudeMinutes >= 1) parts.push(`${minutes(e.claudeMinutes)} in Claude`);
  if (e.inProgress) parts.push('In Progress');
  if (e.activity) parts.push(plural(e.activity, 'Jira update'));
  if (e.builds) parts.push(plural(e.builds, 'build'));
  if (e.reviews) parts.push(plural(e.reviews, 'PR review'));
  return parts.join(' · ') || 'Added by you';
}
