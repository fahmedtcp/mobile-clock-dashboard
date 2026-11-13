// Tempo v4 client (read the user's worklogs, create new ones) plus pure helpers.
// The dashboard never updates or deletes Tempo worklogs. The token never appears in errors.
import { TEMPO } from '../../config.js';
import { parseDay } from './days.js';

export const round2 = (n) => Math.round(n * 100) / 100;

const TIMEOUT_MS = 15000;    // a hung call must not hold a day's send lock
const MAX_RETRY_WAIT_MS = 10000;
const tempoError = (message, status) => Object.assign(new Error(message), { status });
const unexpected = () => tempoError('Tempo sent an unexpected response. Try again, or check Tempo directly.', 502);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryWaitMs = (res) => Math.min(Number(res.headers?.get?.('Retry-After')) * 1000 || 1000, MAX_RETRY_WAIT_MS);

// Error messages are fixed text: nothing from the request (and so never the token) goes into them.
function checkStatus(res) {
  if (res.status === 401 || res.status === 403) {
    throw tempoError('Tempo rejected the token. Check your Tempo token in Settings.', 502);
  }
  if (!res.ok) throw tempoError(`Tempo returned ${res.status}.`, 502);
}

async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

const toWorklog = (w) => ({
  tempoId: w.tempoWorklogId,
  issueId: String(w.issue?.id ?? ''),
  date: w.startDate,
  hours: round2((w.timeSpentSeconds ?? 0) / 3600),
});

export function createTempo({ token, baseUrl = TEMPO.baseUrl, fetch = globalThis.fetch, sleep = defaultSleep }) {
  const configured = Boolean(token);
  const base = String(baseUrl).replace(/\/+$/, '');

  async function send(method, url, body) {
    try {
      return await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw tempoError('Can\'t reach Tempo.', 502);
    }
  }

  async function request(method, url, body, attempt = 0) {
    if (!configured) throw tempoError('Tempo isn\'t set up. Add your Tempo token in Settings.', 503);
    // The token only ever goes to the Tempo API itself.
    if (!url.startsWith(`${base}/`)) throw unexpected();
    const res = await send(method, url, body);
    // A 429 means nothing was created, so one retry is safe even for a POST.
    if (res.status === 429 && attempt === 0) {
      await sleep(retryWaitMs(res));
      return request(method, url, body, 1);
    }
    checkStatus(res);
    return readJson(res);
  }

  async function worklogs(accountId, from, to) {
    const out = [];
    const seen = new Set();
    let url = `${base}/worklogs/user/${encodeURIComponent(accountId)}?from=${from}&to=${to}&limit=1000`;
    while (url) {
      if (seen.has(url)) throw unexpected();
      seen.add(url);
      const page = await request('GET', url);
      // Anything but a worklog page must fail loudly: reading it as "nothing in Tempo" could double log.
      if (!Array.isArray(page?.results)) throw unexpected();
      out.push(...page.results.map(toWorklog));
      url = page.metadata?.next || null;
    }
    return out;
  }

  async function create(payload) {
    const created = await request('POST', `${base}/worklogs`, payload);
    if (!created?.tempoWorklogId) throw unexpected();
  }

  return { configured, worklogs, create };
}

// date -> [{ key, hours }], same key on the same day summed. Unknown issue ids show as '#<id>'.
export function tempoByDay(worklogs, keyById) {
  const days = new Map();
  for (const w of worklogs) {
    const key = keyById.get(w.issueId) ?? `#${w.issueId}`;
    if (!days.has(w.date)) days.set(w.date, new Map());
    const hoursByKey = days.get(w.date);
    hoursByKey.set(key, round2((hoursByKey.get(key) ?? 0) + w.hours));
  }
  const entriesOf = (hoursByKey) => [...hoursByKey].map(([key, hours]) => ({ key, hours }));
  return new Map([...days].map(([date, hoursByKey]) => [date, entriesOf(hoursByKey)]));
}

// The ticket's status at the end of a local day, from Jira changelog histories.
export function statusAtEndOfDay(histories, currentStatus, day) {
  const changes = histories
    .flatMap((h) => (h.items ?? []).filter((i) => i.field === 'status')
      .map((i) => ({ at: Date.parse(h.created), from: i.fromString, to: i.toString })))
    .sort((a, b) => a.at - b.at);
  if (!changes.length) return currentStatus;
  const end = parseDay(day).getTime() + 864e5 - 1;
  const last = changes.filter((c) => c.at <= end).pop();
  return last ? last.to : changes[0].from;
}

export function toPayload({ issueId, hours, date, description, accountId }) {
  return {
    issueId: Number(issueId),
    timeSpentSeconds: Math.round(hours * 3600),
    startDate: date,
    startTime: TEMPO.startTime,
    authorAccountId: accountId,
    description,
  };
}
