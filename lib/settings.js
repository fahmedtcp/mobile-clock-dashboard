// Per-person settings in data/settings.json (0600, gitignored). Each field resolves as
// Settings value → .env value → default. Secrets never leave this module unmasked except via resolved()/raw(),
// which only server code uses; the browser gets publicView().
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './http.js';
import { validWebhookUrl, parseLogins, parsePeopleMap, REVIEW_TEMPLATE, QA_TEMPLATE } from './teams.js';
import { isStep } from './time/store.js';

export const STORE_BUILDS = ['mcAndroid', 'mkAndroid', 'mcIos', 'mkIos'];
const TOKEN_MSG = 'That token doesn\'t look right. Paste it again without spaces.';
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

const errorUnless = (ok, text) => (ok ? null : text);
const bool = (v) => errorUnless(typeof v === 'boolean', 'Expected on or off.');
const token = (v) => errorUnless(
  typeof v === 'string' && v.length >= 8 && v.length <= 500 && !/\s/.test(v),
  TOKEN_MSG,
);
const webhook = (v) => errorUnless(validWebhookUrl(v), 'Use a Teams Workflows webhook address.');
const LOGINS_MSG = 'Use GitHub logins, like octocat.';
const logins = (v) => errorUnless(Array.isArray(v) && v.every((x) => LOGIN.test(String(x))), LOGINS_MSG);

const checkJiraUrl = (v) => errorUnless(
  typeof v === 'string' && /^https:\/\/[a-z0-9-]+\.atlassian\.net\/?$/.test(v),
  'Jira URL must look like https://yourcompany.atlassian.net.',
);
const checkEmail = (v) => errorUnless(typeof v === 'string' && EMAIL.test(v), 'Enter a valid email address.');
const checkTagName = (v) => errorUnless(
  typeof v === 'string' && /^[\w .-]{1,60}$/.test(v),
  'Use the tag name exactly as Teams shows it.',
);
const checkTagId = (v) => errorUnless(
  typeof v === 'string' && /^[A-Za-z0-9+/=:._-]{0,200}$/.test(v),
  'Paste the tag ID exactly, with no spaces.',
);

function checkPeople(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Enter a valid email address.';
  for (const [login, email] of Object.entries(v)) {
    if (!LOGIN.test(login)) return LOGINS_MSG;
    if (!EMAIL.test(String(email))) return 'Enter a valid email address.';
  }
  return null;
}

const checkTheme = (v) => errorUnless(['light', 'dark', 'system'].includes(v), 'Theme must be light, dark, or system.');
const checkDayHours = (v) => errorUnless(isStep(v) && v >= 4 && v <= 10, 'Workday hours must be 4–10 in 0.5h steps.');
const checkReminderAt = (v) => errorUnless(TIME_OF_DAY.test(String(v)), 'Use a time like 20:30.');
const checkClonePath = (v, { exists }) => errorUnless(
  typeof v === 'string' && path.isAbsolute(v) && exists(path.join(v, '.git')),
  'That folder isn\'t a mobile-clock clone.',
);
const checkStoreBuilds = (v) => errorUnless(
  Array.isArray(v) && v.every((k) => STORE_BUILDS.includes(k)),
  'Pick from the 4 store builds.',
);

const checkTemplate = (v) => errorUnless(typeof v === 'string' && v.trim().length > 0 && v.length <= 2000,
  'Keep the message between 1 and 2,000 characters.');
const checkWrap = (v) => errorUnless(Number.isInteger(v) && v >= 15 && v <= 120, 'Wrap-up must be 15–120 minutes.');
const TEAMMATE_MSG = 'Each teammate needs a name, a GitHub login, and a Jira email.';
const validTeammate = (p) => isObj(p) && typeof p.name === 'string' && p.name.trim().length > 0 && p.name.length <= 60
  && LOGIN.test(String(p.github)) && EMAIL.test(String(p.jiraEmail)) && typeof p.qa === 'boolean';
function checkTeam(v) {
  if (!Array.isArray(v) || !v.every(validTeammate)) return TEAMMATE_MSG;
  return errorUnless(v.length <= 20, 'Up to 20 teammates.');
}
const SHIFT_ORDER_MSG = 'Shift must end after it starts, on the same day.';

// path → { env, parse(envValue) → value|undefined, def, secret, check(value, deps) → message|null }
const FIELDS = {
  'jira.baseUrl': { env: 'JIRA_BASE_URL', def: '', check: checkJiraUrl },
  'jira.email': { env: 'JIRA_EMAIL', def: '', check: checkEmail },
  'jira.token': { env: 'JIRA_TOKEN', def: '', secret: true, check: token },
  'tempo.token': { env: 'TEMPO_TOKEN', def: '', secret: true, check: token },
  'teams.webhookUrl': { env: 'TEAMS_WEBHOOK_URL', def: '', secret: true, webhook: true, check: webhook },
  'teams.testWebhookUrl': { env: 'TEAMS_TEST_WEBHOOK_URL', def: '', secret: true, webhook: true, check: webhook },
  'teams.qaWebhookUrl': { env: 'TEAMS_QA_WEBHOOK_URL', def: '', secret: true, webhook: true, check: webhook },
  'teams.qaTagName': { def: 'MobileHardware_QA', check: checkTagName },
  'teams.qaTagId': { def: '', check: checkTagId },
  'teams.reviewTemplate': { def: REVIEW_TEMPLATE, check: checkTemplate },
  'teams.qaTemplate': { def: QA_TEMPLATE, check: checkTemplate },
  'teams.always': { env: 'TEAMS_ALWAYS', parse: parseLogins, def: [], check: logins },
  'teams.never': { env: 'TEAMS_NEVER', parse: parseLogins, def: [], check: logins },
  'teams.people': {
    env: 'TEAMS_PEOPLE', parse: (s) => Object.fromEntries(parsePeopleMap(s)), def: {}, check: checkPeople,
  },
  theme: { def: 'light', check: checkTheme },
  'time.dayHours': { def: null, check: checkDayHours },
  'time.reminderOn': { env: 'TIME_REMINDER', parse: (s) => s !== 'off', def: true, check: bool },
  'time.reminderAt': {
    env: 'TIME_REMINDER', parse: (s) => (TIME_OF_DAY.test(s) ? s : undefined), def: '20:30', check: checkReminderAt,
  },
  'time.mobileClockPath': {
    env: 'MOBILE_CLOCK_PATH', def: path.join(os.homedir(), 'Downloads/GitHub/mobile-clock'), check: checkClonePath,
  },
  'builds.defaultChecked': { def: STORE_BUILDS, check: checkStoreBuilds },
  notifications: { def: true, check: bool },
  'shift.start': { def: '13:00', check: checkReminderAt },
  'shift.end': { def: '22:00', check: checkReminderAt },
  'shift.wrapMinutes': { def: 40, check: checkWrap },
  'calendar.on': { def: false, check: bool },
  'team.people': { def: [], check: checkTeam },
};

const getIn = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
function setIn(obj, p, v, { remove = false } = {}) {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
  if (remove && v === null) delete o[keys.at(-1)]; else o[keys.at(-1)] = v;
}
const isGroup = (p) => Object.keys(FIELDS).some((f) => f.startsWith(`${p}.`));

// { jira: { email } } → [['jira.email', value]]; unknown paths are kept so validation can name them.
const flatten = (patch, prefix = '') => Object.entries(patch ?? {}).flatMap(([key, value]) => {
  const p = prefix ? `${prefix}.${key}` : key;
  if (Object.hasOwn(FIELDS, p)) return [[p, value]];
  return isObj(value) && isGroup(p) ? flatten(value, p) : [[p, value]];
});

// Returns an error message, or null when the patch is valid. `null` values mean "remove".
export function validateSettingsPatch(patch, { exists = existsSync } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Expected settings as an object.';
  for (const [p, v] of flatten(patch)) {
    const f = Object.hasOwn(FIELDS, p) ? FIELDS[p] : null;
    if (!f) return `Unknown setting: ${p}.`;
    if (v === null) continue;
    const msg = f.check(v, { exists });
    if (msg) return msg;
  }
  return null;
}

// Short values would be shown nearly whole, so they get no hint at all.
const last4 = (s) => (String(s).length >= 8 ? String(s).slice(-4) : null);
const hostOf = (s) => { try { return new URL(s).hostname; } catch { return ''; } };

// Never overwrite settings we can't read: keep the bytes beside it and start fresh.
function loadFile(file, initial) {
  if (!file || !existsSync(file)) return structuredClone(initial);
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObj(saved)) throw new Error('not an object');
    return saved;
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`;
    renameSync(file, aside);
    console.error(`Settings file was unreadable; kept it at ${aside}`);
    return {};
  }
}

function writeFile(file, data) {
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// Never echoes a secret: only whether it's set, its last 4 characters, and (for webhooks) the host.
function maskSecret(field, { value, source }) {
  const set = Boolean(value);
  const masked = { set, last4: set ? last4(value) : null, source: set ? source : null };
  return field.webhook ? { ...masked, host: set ? hostOf(value) : null } : masked;
}

function configuredServices(current) {
  return {
    jira: Boolean(current.jira.baseUrl && current.jira.email && current.jira.token),
    tempo: Boolean(current.tempo.token),
    teams: Boolean(current.teams.webhookUrl),
    teamsTest: Boolean(current.teams.testWebhookUrl),
    teamsQa: Boolean(current.teams.qaWebhookUrl),
  };
}

export function createSettings({ file, env = process.env, initial = {}, exists = existsSync }) {
  const data = loadFile(file, initial);

  const fromEnv = (f) => {
    const envValue = f.env ? env[f.env] : undefined;
    if (envValue === undefined || envValue === '') return undefined;
    return f.parse ? f.parse(envValue) : envValue;
  };

  const field = (p) => {
    const f = FIELDS[p];
    const saved = getIn(data, p);
    // A hand-edited value of the wrong shape is ignored, not trusted. The folder check is skipped on load,
    // so a moved clone keeps its saved path (and the user sees the error where they fix it).
    const savedIsValid = saved !== undefined && saved !== null && !f.check(saved, { exists: () => true });
    if (savedIsValid) return { value: saved, source: 'settings' };
    const fromEnvValue = fromEnv(f);
    if (fromEnvValue !== undefined) return { value: fromEnvValue, source: 'env' };
    return { value: structuredClone(f.def), source: 'default' };
  };

  function resolved() {
    const out = {};
    for (const p of Object.keys(FIELDS)) setIn(out, p, field(p).value);
    return out;
  }

  function publicView() {
    const out = {};
    for (const [p, f] of Object.entries(FIELDS)) {
      const resolvedField = field(p);
      if (f.secret) {
        setIn(out, p, maskSecret(f, resolvedField));
        continue;
      }
      setIn(out, p, resolvedField.value);
      const [group, name] = p.includes('.') ? p.split('.') : [null, p];
      const holder = group ? (out[group] ??= {}) : out;
      setIn(holder, `sources.${name}`, resolvedField.source);
    }
    out.configured = configuredServices(resolved());
    return out;
  }

  return {
    raw: () => structuredClone(data),
    resolved,
    publicView,
    update(patch) {
      const error = validateSettingsPatch(patch, { exists });
      if (error) throw new HttpError(400, error);
      const shift = { ...resolved().shift, ...Object.fromEntries(Object.entries(patch.shift ?? {}).filter(([, v]) => v != null)) };
      if (shift.end <= shift.start) throw new HttpError(400, SHIFT_ORDER_MSG);
      for (const [p, v] of flatten(patch)) setIn(data, p, v, { remove: true });
      writeFile(file, data);
      return publicView();
    },
  };
}
