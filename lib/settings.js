// Per-person settings in data/settings.json (0600, gitignored). Each field resolves as
// Settings value → .env value → default. Secrets never leave this module unmasked except via resolved()/raw(),
// which only server code uses; the browser gets publicView().
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './http.js';
import { validWebhookUrl, parseLogins, parsePeopleMap } from './teams.js';
import { isStep } from './time/store.js';

export const STORE_BUILDS = ['mcAndroid', 'mkAndroid', 'mcIos', 'mkIos'];
const TOKEN_MSG = 'That token doesn\'t look right. Paste it again without spaces.';
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const bool = (v) => (typeof v === 'boolean' ? null : 'Expected on or off.');
const token = (v) => (typeof v === 'string' && v.length >= 8 && v.length <= 500 && !/\s/.test(v) ? null : TOKEN_MSG);
const webhook = (v) => (validWebhookUrl(v) ? null : 'Use a Teams Workflows webhook address.');
const logins = (v) => (Array.isArray(v) && v.every((x) => LOGIN.test(String(x))) ? null : 'Use GitHub logins, like octocat.');

// path → { env, parse(envValue) → value|undefined, def, secret, check(value, deps) → message|null }
const FIELDS = {
  'jira.baseUrl': { env: 'JIRA_BASE_URL', def: '', check: (v) => (typeof v === 'string' && /^https:\/\/[a-z0-9-]+\.atlassian\.net\/?$/.test(v) ? null : 'Jira URL must look like https://yourcompany.atlassian.net.') },
  'jira.email': { env: 'JIRA_EMAIL', def: '', check: (v) => (typeof v === 'string' && EMAIL.test(v) ? null : 'Enter a valid email address.') },
  'jira.token': { env: 'JIRA_TOKEN', def: '', secret: true, check: token },
  'tempo.token': { env: 'TEMPO_TOKEN', def: '', secret: true, check: token },
  'teams.webhookUrl': { env: 'TEAMS_WEBHOOK_URL', def: '', secret: true, webhook: true, check: webhook },
  'teams.testWebhookUrl': { env: 'TEAMS_TEST_WEBHOOK_URL', def: '', secret: true, webhook: true, check: webhook },
  'teams.qaWebhookUrl': { env: 'TEAMS_QA_WEBHOOK_URL', def: '', secret: true, webhook: true, check: webhook },
  'teams.qaTagName': { def: 'MobileHardware_QA', check: (v) => (typeof v === 'string' && /^[\w .-]{1,60}$/.test(v) ? null : 'Use the tag name exactly as Teams shows it.') },
  'teams.qaTagId': { def: '', check: (v) => (typeof v === 'string' && /^[A-Za-z0-9+/=:._-]{0,200}$/.test(v) ? null : 'Paste the tag ID exactly, with no spaces.') },
  'teams.always': { env: 'TEAMS_ALWAYS', parse: parseLogins, def: [], check: logins },
  'teams.never': { env: 'TEAMS_NEVER', parse: parseLogins, def: [], check: logins },
  'teams.people': {
    env: 'TEAMS_PEOPLE', parse: (s) => Object.fromEntries(parsePeopleMap(s)), def: {},
    check: (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Enter a valid email address.';
      for (const [k, e] of Object.entries(v)) { if (!LOGIN.test(k)) return 'Use GitHub logins, like octocat.'; if (!EMAIL.test(String(e))) return 'Enter a valid email address.'; }
      return null;
    },
  },
  theme: { def: 'light', check: (v) => (['light', 'dark', 'system'].includes(v) ? null : 'Theme must be light, dark, or system.') },
  'time.dayHours': { def: null, check: (v) => (isStep(v) && v >= 4 && v <= 10 ? null : 'Workday hours must be 4–10 in 0.5h steps.') },
  'time.reminderOn': { env: 'TIME_REMINDER', parse: (s) => s !== 'off', def: true, check: bool },
  'time.reminderAt': { env: 'TIME_REMINDER', parse: (s) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : undefined), def: '20:30', check: (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? null : 'Use a time like 20:30.') },
  'time.mobileClockPath': {
    env: 'MOBILE_CLOCK_PATH', def: path.join(os.homedir(), 'Downloads/GitHub/mobile-clock'),
    check: (v, { exists }) => (typeof v === 'string' && path.isAbsolute(v) && exists(path.join(v, '.git')) ? null : 'That folder isn\'t a mobile-clock clone.'),
  },
  'builds.defaultChecked': { def: STORE_BUILDS, check: (v) => (Array.isArray(v) && v.every((k) => STORE_BUILDS.includes(k)) ? null : 'Pick from the 4 store builds.') },
  notifications: { def: true, check: bool },
};

const getIn = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
function setIn(obj, p, v, { remove = false } = {}) {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
  if (remove && v === null) delete o[keys.at(-1)]; else o[keys.at(-1)] = v;
}
const flatten = (patch, prefix = '') => Object.entries(patch ?? {}).flatMap(([k, v]) => {
  const p = prefix ? `${prefix}.${k}` : k;
  return Object.hasOwn(FIELDS, p) ? [[p, v]] : v && typeof v === 'object' && !Array.isArray(v) && Object.keys(FIELDS).some((f) => f.startsWith(`${p}.`)) ? flatten(v, p) : [[p, v]];
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

export function createSettings({ file, env = process.env, initial = {}, exists = existsSync }) {
  let data = structuredClone(initial);
  if (file && existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObj(data)) throw new Error('not an object');
    } catch {
      // Never overwrite settings we can't read: keep the bytes beside it and start fresh.
      const aside = `${file}.corrupt-${Date.now()}`;
      renameSync(file, aside);
      console.error(`Settings file was unreadable; kept it at ${aside}`);
      data = {};
    }
  }

  const fromEnv = (f) => {
    const raw = f.env ? env[f.env] : undefined;
    if (raw === undefined || raw === '') return undefined;
    return f.parse ? f.parse(raw) : raw;
  };
  const field = (p) => {
    const f = FIELDS[p];
    const saved = getIn(data, p);
    // A hand-edited value of the wrong shape is ignored, not trusted. The folder check is skipped on load,
    // so a moved clone keeps its saved path (and the user sees the error where they fix it).
    if (saved !== undefined && saved !== null && !f.check(saved, { exists: () => true })) return { value: saved, source: 'settings' };
    const e = fromEnv(f);
    if (e !== undefined) return { value: e, source: 'env' };
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
      const { value, source } = field(p);
      const [group, name] = p.includes('.') ? p.split('.') : [null, p];
      if (f.secret) {
        const set = Boolean(value);
        setIn(out, p, { set, last4: set ? last4(value) : null, source: set ? source : null, ...(f.webhook ? { host: set ? hostOf(value) : null } : {}) });
      } else {
        setIn(out, p, value);
      }
      const holder = group ? (out[group] ??= {}) : out;
      if (!f.secret) setIn(holder, `sources.${name}`, source);
    }
    const r = resolved();
    out.configured = {
      jira: Boolean(r.jira.baseUrl && r.jira.email && r.jira.token),
      tempo: Boolean(r.tempo.token),
      teams: Boolean(r.teams.webhookUrl),
      teamsTest: Boolean(r.teams.testWebhookUrl),
      teamsQa: Boolean(r.teams.qaWebhookUrl),
    };
    return out;
  }

  function save() {
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  return {
    raw: () => structuredClone(data),
    resolved,
    publicView,
    update(patch) {
      const error = validateSettingsPatch(patch, { exists });
      if (error) throw new HttpError(400, error);
      for (const [p, v] of flatten(patch)) setIn(data, p, v, { remove: true });
      save();
      return publicView();
    },
  };
}
