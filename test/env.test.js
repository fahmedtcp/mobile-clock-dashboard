import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv, loadEnv } from '../lib/env.js';

test('parseEnv handles quotes, comments, blank lines, = in values', () => {
  assert.deepEqual(parseEnv('# c\nJIRA_TOKEN="ab=c"\n\nJIRA_EMAIL=me@x.com\nX=\'q\'\nexport Y=1\n'),
    { JIRA_TOKEN: 'ab=c', JIRA_EMAIL: 'me@x.com', X: 'q', Y: '1' });
});

test('loadEnv sets only unset keys and ignores a missing file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'env-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, 'DASH_TEST_A=fromfile\nDASH_TEST_B=fromfile\n');
  process.env.DASH_TEST_B = 'preset';
  loadEnv(file);
  assert.equal(process.env.DASH_TEST_A, 'fromfile');
  assert.equal(process.env.DASH_TEST_B, 'preset');
  loadEnv(path.join(dir, 'missing.env'));
  delete process.env.DASH_TEST_A; delete process.env.DASH_TEST_B;
});
