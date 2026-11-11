import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, currentRelease, releaseLists, releaseNotes } from '../lib/release.js';

test('parseVersion', () => {
  assert.equal(parseVersion('Mobile 46'), 46);
  assert.equal(parseVersion('Web 46'), null);
  assert.equal(parseVersion('Mobile 46 hotfix'), null);
});

test('currentRelease picks lowest unreleased Mobile NN and maps branches', () => {
  const r = currentRelease([{ name: 'Mobile 45', released: true }, { name: 'Mobile 47', released: false }, { name: 'Mobile 46', released: false, releaseDate: '2026-11-30' }, { name: 'Mobile 44', released: false, archived: true }],
    ['release/1.43.x', 'release/1.45.x', 'develop']);
  assert.deepEqual(r, { name: 'Mobile 46', nn: 46, releaseDate: '2026-11-30', branch: 'release/1.46.x', branchExists: false, lastCut: 'release/1.45.x' });
});

test('currentRelease marks an existing branch and returns null with no versions', () => {
  assert.equal(currentRelease([{ name: 'Mobile 46', released: false }], ['release/1.46.x', 'release/1.45.x']).branchExists, true);
  assert.equal(currentRelease([], []), null);
});

const t = (key, status, issueType = 'Bug', summary = 'S') => ({ key, status, issueType, summary, url: `j/${key}` });
const pr = (number, ticketKey, state, oid = `sha${number}`) => ({ number, ticketKey, state, url: `p/${number}`, mergeCommit: { oid } });

test('releaseLists: inVersion with PR state, notMerged flags finished mismatch, unplanned excludes fix keys', () => {
  const tickets = [t('TCPMOB-1', 'Release Candidate'), t('TCPMOB-2', 'Dev Review'), t('TCPMOB-3', 'Done')];
  const prsByKey = new Map([['TCPMOB-1', pr(10, 'TCPMOB-1', 'MERGED')], ['TCPMOB-2', pr(11, 'TCPMOB-2', 'OPEN')]]);
  const mergedSinceCut = [pr(10, 'TCPMOB-1', 'MERGED'), pr(12, 'TCPMOB-9', 'MERGED'), pr(13, null, 'MERGED')];
  const l = releaseLists({ tickets, prsByKey, mergedSinceCut, onBranch: null, fixKeys: new Set(['TCPMOB-1', 'TCPMOB-2', 'TCPMOB-3']) });
  assert.deepEqual(l.inVersion.map((x) => [x.key, x.pr?.state ?? null]), [['TCPMOB-1', 'MERGED'], ['TCPMOB-2', 'OPEN'], ['TCPMOB-3', null]]);
  assert.deepEqual(l.notMerged.map((x) => [x.key, x.mismatch]), [['TCPMOB-2', false], ['TCPMOB-3', true]]);
  assert.deepEqual(l.unplanned.map((x) => x.number), [12, 13]);
  assert.deepEqual(l.cherryPicks, []);
});

test('releaseLists: cherryPicks are fix-version merges not on the branch', () => {
  const mergedSinceCut = [pr(10, 'TCPMOB-1', 'MERGED'), pr(11, 'TCPMOB-2', 'MERGED'), pr(12, 'TCPMOB-9', 'MERGED')];
  const l = releaseLists({ tickets: [], prsByKey: new Map(), mergedSinceCut, onBranch: new Set(['sha10']), fixKeys: new Set(['TCPMOB-1', 'TCPMOB-2']) });
  assert.deepEqual(l.cherryPicks.map((x) => x.number), [11]);
});

test('releaseNotes groups and sorts', () => {
  assert.equal(releaseNotes([t('TCPMOB-10', 'Open', 'Story', 'B'), t('TCPMOB-9', 'Open', 'Bug', 'A'), t('TCPMOB-2', 'Open', 'Bug', 'C'), t('TCPMOB-4', 'Open', 'Epic', 'E')], 'Mobile 46'),
    'Mobile 46\n\nFixes\n- TCPMOB-2 C\n- TCPMOB-9 A\n\nImprovements\n- TCPMOB-10 B\n\nOther\n- TCPMOB-4 E\n');
  assert.equal(releaseNotes([], 'Mobile 46'), 'Mobile 46\n');
});
