import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSettings } from '../lib/settings.js';

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'settings-')), 'settings.json');
const HOOK = 'https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=SECRETSIG9z';
const status = (fn) => { try { fn(); } catch (e) { return [e.status, e.message]; } return null; };

test('defaults: light theme, no dayHours, reminder 20:30 on, all 4 builds', () => {
  const r = createSettings({ file: null, env: {} }).resolved();
  assert.equal(r.theme, 'light');
  assert.equal(r.time.dayHours, null);
  assert.equal(r.time.reminderOn, true);
  assert.equal(r.time.reminderAt, '20:30');
  assert.deepEqual(r.builds.defaultChecked, ['mcAndroid', 'mkAndroid', 'mcIos', 'mkIos']);
  assert.equal(r.notifications, true);
  assert.equal(r.jira.baseUrl, '');
  assert.deepEqual(r.teams.always, []);
});

test('env fills in when settings are empty, and settings win over env', () => {
  const s = createSettings({ file: null, env: { JIRA_EMAIL: 'a@x.com', TIME_REMINDER: 'off' } });
  assert.equal(s.resolved().jira.email, 'a@x.com');
  assert.equal(s.publicView().jira.sources.email, 'env');
  assert.equal(s.resolved().time.reminderOn, false);
  s.update({ jira: { email: 'b@x.com' } });
  assert.equal(s.resolved().jira.email, 'b@x.com');
  assert.equal(s.publicView().jira.sources.email, 'settings');
});

test('null removes a stored value and env applies again', () => {
  const s = createSettings({ file: null, env: { TEMPO_TOKEN: 'envtoken1234' } });
  s.update({ tempo: { token: 'savedtoken9999' } });
  assert.equal(s.resolved().tempo.token, 'savedtoken9999');
  s.update({ tempo: { token: null } });
  assert.equal(s.resolved().tempo.token, 'envtoken1234');
  assert.deepEqual(s.publicView().tempo.token, { set: true, last4: '1234', source: 'env' });
});

test('public view never contains secret values', () => {
  const s = createSettings({ file: null, env: {} });
  s.update({ jira: { baseUrl: 'https://tcp.atlassian.net', email: 'me@tcpsoftware.com', token: 'SECRET123456' }, teams: { webhookUrl: HOOK } });
  const v = s.publicView();
  const json = JSON.stringify(v);
  assert.ok(!json.includes('SECRET1234'));
  assert.ok(!json.includes('SECRETSIG'));
  assert.ok(!json.includes('/workflows/abc'));
  assert.deepEqual(v.jira.token, { set: true, last4: '3456', source: 'settings' });
  assert.equal(v.teams.webhookUrl.host, 'prod-01.westus.logic.azure.com');
  assert.equal(v.teams.webhookUrl.set, true);
  assert.equal(v.jira.email, 'me@tcpsoftware.com');
  assert.deepEqual(v.configured, { jira: true, tempo: false, teams: true, teamsTest: false, teamsQa: false });
});

test('invalid patches throw 400 with exact messages', () => {
  const s = createSettings({ file: null, env: {} });
  const cases = [
    [{ jira: { baseUrl: 'http://evil.com' } }, 'Jira URL must look like https://yourcompany.atlassian.net.'],
    [{ jira: { email: 'nope' } }, 'Enter a valid email address.'],
    [{ jira: { token: 'has space' } }, 'That token doesn\'t look right. Paste it again without spaces.'],
    [{ tempo: { token: 'x'.repeat(501) } }, 'That token doesn\'t look right. Paste it again without spaces.'],
    [{ teams: { webhookUrl: 'https://evil.com/hook' } }, 'Use a Teams Workflows webhook address.'],
    [{ teams: { always: ['bad login!'] } }, 'Use GitHub logins, like octocat.'],
    [{ teams: { people: { x: 'not-an-email' } } }, 'Enter a valid email address.'],
    [{ theme: 'neon' }, 'Theme must be light, dark, or system.'],
    [{ time: { dayHours: 7.25 } }, 'Workday hours must be 4–10 in 0.5h steps.'],
    [{ time: { dayHours: 11 } }, 'Workday hours must be 4–10 in 0.5h steps.'],
    [{ time: { reminderAt: '25:00' } }, 'Use a time like 20:30.'],
    [{ time: { reminderOn: 'yes' } }, 'Expected on or off.'],
    [{ time: { mobileClockPath: '/nope/not/here' } }, 'That folder isn\'t a mobile-clock clone.'],
    [{ builds: { defaultChecked: ['mcIosSim'] } }, 'Pick from the 4 store builds.'],
    [{ notifications: 1 }, 'Expected on or off.'],
    [{ bogus: 1 }, 'Unknown setting: bogus.'],
    [{ jira: { nope: 1 } }, 'Unknown setting: jira.nope.'],
  ];
  for (const [patch, msg] of cases) assert.deepEqual(status(() => s.update(patch)), [400, msg], JSON.stringify(patch));
});

test('a valid clone path is accepted', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clone-'));
  writeFileSync(path.join(dir, '.git'), 'gitdir: x');
  const s = createSettings({ file: null, env: {} });
  s.update({ time: { mobileClockPath: dir, dayHours: 7.5 } });
  assert.equal(s.resolved().time.mobileClockPath, dir);
  assert.equal(s.resolved().time.dayHours, 7.5);
});

test('file is written 0600 and atomically, and reloads', () => {
  const file = tmpFile();
  const s = createSettings({ file, env: {} });
  s.update({ theme: 'dark', tempo: { token: 'abcdefgh1234' } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(path.dirname(file)), ['settings.json']);
  assert.equal(createSettings({ file, env: {} }).resolved().theme, 'dark');
});

test('corrupt file is moved aside', () => {
  const file = tmpFile();
  writeFileSync(file, '{bad');
  const s = createSettings({ file, env: {} });
  assert.equal(s.resolved().theme, 'light');
  const aside = readdirSync(path.dirname(file)).find((f) => f.startsWith('settings.json.corrupt-'));
  assert.ok(aside);
  assert.equal(readFileSync(path.join(path.dirname(file), aside), 'utf8'), '{bad');
});

test('TEAMS_ALWAYS and TEAMS_PEOPLE parse from env; initial seeds memory settings', () => {
  const s = createSettings({ file: null, env: { TEAMS_ALWAYS: 'a, b', TEAMS_PEOPLE: 'x=x@t.com,bad' }, initial: { time: { dayHours: 7 } } });
  assert.deepEqual(s.resolved().teams.always, ['a', 'b']);
  assert.deepEqual(s.resolved().teams.people, { x: 'x@t.com' });
  assert.equal(s.resolved().time.dayHours, 7);
});
