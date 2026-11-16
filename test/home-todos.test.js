process.env.TZ = 'Asia/Karachi';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTodo, todoView, migrateNote, todoReminder } from '../lib/home/todos.js';
import { shiftState } from '../public/shared.js';

const cfg = { start: '13:00', end: '22:00', wrapMinutes: 40 };
const at = (iso) => new Date(iso);
const todo = (o) => ({ id: 't1', text: 'x', key: null, createdAt: at('2026-11-17T21:30:00+05:00').getTime(), doneAt: null, ...o });

test('a ticket key or a leading number links the ticket', () => {
  assert.deepEqual(parseTodo('Repro BadgeScan on TCPMOB-1772 kiosk'), { text: 'Repro BadgeScan on TCPMOB-1772 kiosk', key: 'TCPMOB-1772' });
  assert.deepEqual(parseTodo('1772 repro on kiosk'), { text: 'repro on kiosk', key: 'TCPMOB-1772' });
  assert.deepEqual(parseTodo('  ask Hamza about spacing  '), { text: 'ask Hamza about spacing', key: null });
  assert.deepEqual(parseTodo('tcpmob-12 lower case'), { text: 'tcpmob-12 lower case', key: 'TCPMOB-12' });
  assert.equal(parseTodo('   '), null);
  assert.equal(parseTodo('x'.repeat(201)), null);
});

test('open items carry over with "from <weekday>" once older than the last shift; done items leave the next day', () => {
  const now = at('2026-11-18T13:05:00+05:00'); // Wednesday
  const shift = shiftState(now, cfg);
  const todos = [
    todo({ id: 'last-night', createdAt: at('2026-11-17T21:30:00+05:00').getTime() }),
    todo({ id: 'monday', createdAt: at('2026-11-16T20:00:00+05:00').getTime() }),
    todo({ id: 'done-today', doneAt: at('2026-11-18T13:01:00+05:00').getTime() }),
    todo({ id: 'done-yesterday', doneAt: at('2026-11-17T20:00:00+05:00').getTime() }),
  ];
  const view = todoView(todos, { now, shift });
  assert.deepEqual(view.map((t) => [t.id, t.done, t.from]), [
    ['monday', false, 'Monday'], ['last-night', false, null], ['done-today', true, null],
  ]);
});

test('a saved note becomes to-dos, one per line', () => {
  const store = new Map([['note', { text: 'Start with TCPMOB-1772\n\nAsk Hamza', savedAt: '2026-11-17T21:00:00Z' }]]);
  const api = { get: (k) => store.get(k), save: (k, v) => store.set(k, v) };
  migrateNote(api, () => 'id', 1000);
  assert.deepEqual(store.get('todos').map((t) => [t.text, t.key]), [['Start with TCPMOB-1772', 'TCPMOB-1772'], ['Ask Hamza', null]]);
  assert.equal(store.get('note'), null);
  migrateNote(api, () => 'id', 1000);
  assert.equal(store.get('todos').length, 2, 'runs once');
});

test('the shift-start reminder: weekdays, during the shift, once a day, only with open items', () => {
  const open = [todo({ text: 'Ask Hamza about spacing' }), todo({ id: 't2', text: 'Repro BadgeScan', key: 'TCPMOB-1772' })];
  const remind = (iso, o = {}) => todoReminder({ now: at(iso), shift: shiftState(at(iso), cfg), todos: open, lastSentOn: null, on: true, ...o });
  assert.deepEqual(remind('2026-11-18T13:00:00+05:00'), {
    day: '2026-11-18', title: '2 to-dos from last night', body: 'Ask Hamza about spacing · TCPMOB-1772 Repro BadgeScan',
  });
  assert.equal(remind('2026-11-18T12:59:00+05:00'), null, 'before the shift');
  assert.equal(remind('2026-11-18T22:30:00+05:00'), null, 'after the shift');
  assert.equal(remind('2026-11-21T14:00:00+05:00'), null, 'Saturday');
  assert.equal(remind('2026-11-18T14:00:00+05:00', { lastSentOn: '2026-11-18' }), null, 'already sent today');
  assert.equal(remind('2026-11-18T14:00:00+05:00', { on: false }), null, 'notifications off');
  assert.equal(remind('2026-11-18T14:00:00+05:00', { todos: [] }), null, 'nothing open');
  assert.equal(remind('2026-11-18T14:00:00+05:00', { todos: [open[0]] }).title, '1 to-do from last night');
});
