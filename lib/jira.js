export class JiraError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
  }
}

const NOT_CONFIGURED = "Jira isn't connected. Add your Jira URL, email, and token in Settings.";
const RATE_LIMITED = 'Jira is rate limiting requests. Try again shortly.';
const MAX_RETRY_WAIT_MS = 10000;

// Atlassian Document Format → plain text (comments come back as ADF).
function adfText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  const inner = (node.content ?? []).map(adfText).join('');
  return node.type === 'paragraph' || node.type === 'heading' ? `${inner}\n` : inner;
}

function errorMessage(body, status) {
  if (status === 401) return 'Jira rejected the token. Check your Jira email and token in Settings.';
  const parts = [...(body?.errorMessages ?? []), ...Object.values(body?.errors ?? {})];
  return parts.length ? parts.join('; ') : `Jira request failed (${status})`;
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function toComment(comment) {
  return {
    author: comment.author?.displayName ?? '',
    authorId: comment.author?.accountId ?? null,
    created: comment.created,
    text: adfText(comment.body).trim(),
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

export function createJira({ baseUrl, email, token, fetch = globalThis.fetch, sleep = defaultSleep }) {
  const configured = Boolean(baseUrl && email && token);
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');

  async function send(method, path, body) {
    const headers = { Authorization: auth, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(base + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new JiraError(502, `Can't reach Jira: ${err.message}`);
    }
  }

  async function request(method, path, body, attempt = 0) {
    if (!configured) throw new JiraError(503, NOT_CONFIGURED);
    const res = await send(method, path, body);
    if (res.status === 429 && attempt === 0) {
      await sleep(Math.min(Number(res.headers.get('Retry-After')) * 1000 || 1000, MAX_RETRY_WAIT_MS));
      return request(method, path, body, 1);
    }
    const data = parseJson(await res.text());
    if (!res.ok) {
      throw new JiraError(res.status, res.status === 429 ? RATE_LIMITED : errorMessage(data, res.status));
    }
    return data;
  }

  async function search(jql, fields, max = 100) {
    const issues = [];
    let nextPageToken;
    do {
      const page = await request('POST', '/rest/api/3/search/jql',
        { jql, fields, maxResults: Math.min(max, 100), ...(nextPageToken ? { nextPageToken } : {}) });
      issues.push(...(page?.issues ?? []));
      nextPageToken = page?.nextPageToken;
    } while (nextPageToken && issues.length < max);
    return issues.slice(0, max);
  }

  async function comments(key) {
    const data = await request('GET', `/rest/api/3/issue/${enc(key)}/comment?maxResults=100&orderBy=-created`);
    return (data?.comments ?? []).map(toComment);
  }

  async function changelog(key) {
    const out = [];
    for (let startAt = 0; ; ) {
      const page = await request('GET', `/rest/api/3/issue/${enc(key)}/changelog?startAt=${startAt}&maxResults=100`);
      const values = page?.values ?? [];
      out.push(...values);
      if (page?.isLast !== false || !values.length) break;
      startAt += values.length;
    }
    return out;
  }

  async function issueTypes(projectKey) {
    const data = await request('GET', `/rest/api/3/issue/createmeta/${enc(projectKey)}/issuetypes`);
    return (data?.issueTypes ?? data?.values ?? []).map((t) => t.name);
  }

  const issuePath = (key) => `/rest/api/3/issue/${enc(key)}`;

  return {
    configured,
    myself: () => request('GET', '/rest/api/3/myself'),
    search,
    getIssue: (key, fields) => request('GET', `${issuePath(key)}?fields=${enc(fields.join(','))}`),
    comments,
    changelog,
    transitions: async (key) => (await request('GET', `${issuePath(key)}/transitions`))?.transitions ?? [],
    transition: (key, id) => request('POST', `${issuePath(key)}/transitions`, { transition: { id } }),
    assign: (key, accountId) => request('PUT', `${issuePath(key)}/assignee`, { accountId }),
    createIssue: (fields) => request('POST', '/rest/api/3/issue', { fields }),
    link: (type, inwardKey, outwardKey) => request('POST', '/rest/api/3/issueLink',
      { type: { name: type }, inwardIssue: { key: inwardKey }, outwardIssue: { key: outwardKey } }),
    issueTypes,
    userSearch: (query) => request('GET', `/rest/api/3/user/search?query=${enc(query)}&maxResults=10`)
      .then((users) => users ?? []),
    versions: (projectKey) => request('GET', `/rest/api/3/project/${enc(projectKey)}/versions`),
  };
}
