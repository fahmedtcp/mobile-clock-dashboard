import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../lib/builds.js';

const r = (...lines) => ({ step: 's', lines });

test('timed_out and startup_failure are infra', () => {
  assert.deepEqual(classifyFailure('timed_out', null), { kind: 'infra', label: 'Timed out' });
  assert.deepEqual(classifyFailure('startup_failure', null), { kind: 'infra', label: 'Failed to start' });
});

test('network, runner, disk, and server errors are infra', () => {
  const cases = {
    'The Internet connection appears to be offline. (-1009)': 'Network issue',
    'connect ETIMEDOUT 10.0.0.1:443': 'Network issue',
    'read ECONNRESET': 'Network issue',
    'Could not resolve host: github.com': 'Network issue',
    'The runner has received a shutdown signal.': 'Runner lost',
    'The hosted runner lost communication with the server.': 'Runner lost',
    'No space left on device': 'Disk full',
    'Response status code does not indicate success: 503 (Service Unavailable).': 'Server error',
  };
  for (const [line, label] of Object.entries(cases)) assert.deepEqual(classifyFailure('failure', r(line)), { kind: 'infra', label }, line);
});

test('code lines are code', () => {
  const cases = {
    "src/a.ts(3,5): error TS2322: Type 'x'": 'TypeScript error',
    'Tests:       2 failed, 40 passed, 42 total': 'Test failures',
    'e: file:///app/src/Main.kt:12:3 Unresolved reference: foo': 'Compile error',
    '/Users/runner/work/x/App.swift:10:5: error: cannot find foo in scope': 'Compile error',
    '✖ 3 problems (3 errors, 0 warnings)': 'Lint errors',
  };
  for (const [line, label] of Object.entries(cases)) assert.deepEqual(classifyFailure('failure', r(line)), { kind: 'code', label }, line);
});

test('code wins over infra in the same reason', () => {
  assert.equal(classifyFailure('failure', r('read ECONNRESET', 'error TS2322: x')).kind, 'code');
});

test('anything else is unknown', () => {
  assert.deepEqual(classifyFailure('failure', r('fastlane finished with errors')), { kind: 'unknown', label: 'Unknown failure' });
  assert.deepEqual(classifyFailure('failure', null), { kind: 'unknown', label: 'Unknown failure' });
});
