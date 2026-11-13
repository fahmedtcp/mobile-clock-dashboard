import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rubberband, createPullTracker, PULL_THRESHOLD } from '../public/pull.js';

test('rubberband moves about half as far as the pull, then resists more the further it goes', () => {
  assert.equal(rubberband(0), 0);
  const startSlope = rubberband(1);
  assert.ok(startSlope > 0.5 && startSlope < 0.56, `starts near Apple's 0.55 (${startSlope})`);
  assert.ok(rubberband(400) / 400 < rubberband(40) / 40, 'long pulls are damped harder than short ones');
  assert.ok(rubberband(400) < 140, 'never travels past the stretch limit');
  assert.ok(rubberband(300) < rubberband(400), 'it still moves, never hard-stops');
});

test('a pull past the threshold refreshes on release', () => {
  const pull = createPullTracker();
  pull.move(PULL_THRESHOLD + 30);
  assert.equal(pull.progress(), 1);
  assert.equal(pull.release(), 'refresh');
});

test('a short pull springs back without refreshing', () => {
  const pull = createPullTracker();
  pull.move(PULL_THRESHOLD / 2);
  assert.equal(pull.progress(), 0.5);
  assert.equal(pull.release(), 'cancel');
  assert.equal(pull.distance(), 0);
});

test('pulling back up cancels; the distance never goes below zero', () => {
  const pull = createPullTracker();
  pull.move(80);
  pull.move(-200);
  assert.equal(pull.distance(), 0);
  assert.equal(pull.release(), 'cancel');
});

test('a mouse-wheel notch alone never counts as a pull', () => {
  const pull = createPullTracker();
  pull.wheel(-120);
  assert.equal(pull.distance(), 0, 'one big step is a mouse wheel, not a trackpad pull');
  for (let i = 0; i < 12; i++) pull.wheel(-12);
  assert.ok(pull.distance() >= PULL_THRESHOLD, 'smooth trackpad deltas add up');
});
