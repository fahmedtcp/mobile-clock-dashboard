export class JiraError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
  }
}

const NOT_CONFIGURED = "Jira isn't connected. Add your Jira URL, email, and token in Settings.";
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

export function createJira({ baseUrl, email, token, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const configured = Boolean(baseUrl && email && token);
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const enc = encodeURIComponent;

  async function request(method, path, body, attempt = 0) {
    if (!configured) throw new JiraError(503, NOT_CONFIGURED);
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new JiraError(502, `Can't reach Jira: ${err.message}`);
    }
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get('Retry-After')) * 1000 || 1000, MAX_RETRY_WAIT_MS);
      await sleep(wait);
      return request(method, path, body, 1);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new JiraError(res.status, res.status === 429 ? 'Jira is rate limiting requests. Try again shortly.' : errorMessage(data, res.status));
    return data;
  }

  return {
    configured,
    myself: () => request('GET', '/rest/api/3/myself'),
    async search(jql, fields, max = 100) {
      const issues = [];
      let nextPageToken;
      do {
        const page = await request('POST', '/rest/api/3/search/jql', { jql, fields, maxResults: Math.min(max, 100), ...(nextPageToken ? { nextPageToken } : {}) });
        issues.push(...(page?.issues ?? []));
        nextPageToken = page?.nextPageToken;
      } while (nextPageToken && issues.length < max);
      return issues.slice(0, max);
    },
    getIssue: (key, fields) => request('GET', `/rest/api/3/issue/${enc(key)}?fields=${enc(fields.join(','))}`),
    async comments(key) {
      const data = await request('GET', `/rest/api/3/issue/${enc(key)}/comment?maxResults=100&orderBy=-created`);
      return (data?.comments ?? []).map((c) => ({ author: c.author?.displayName ?? '', authorId: c.author?.accountId ?? null, created: c.created, text: adfText(c.body).trim() }));
    },
    async changelog(key) {
      const out = [];
      for (let startAt = 0; ; ) {
        const page = await request('GET', `/rest/api/3/issue/${enc(key)}/changelog?startAt=${startAt}&maxResults=100`);
        const values = page?.values ?? [];
        out.push(...values);
        if (page?.isLast !== false || !values.length) break;
        startAt += values.length;
      }
      return out;
    },
    async transitions(key) {
      return (await request('GET', `/rest/api/3/issue/${enc(key)}/transitions`))?.transitions ?? [];
    },
    transition: (key, id) => request('POST', `/rest/api/3/issue/${enc(key)}/transitions`, { transition: { id } }),
    assign: (key, accountId) => request('PUT', `/rest/api/3/issue/${enc(key)}/assignee`, { accountId }),
    createIssue: (fields) => request('POST', '/rest/api/3/issue', { fields }),
    link: (type, inwardKey, outwardKey) => request('POST', '/rest/api/3/issueLink', { type: { name: type }, inwardIssue: { key: inwardKey }, outwardIssue: { key: outwardKey } }),
    async issueTypes(projectKey) {
      const data = await request('GET', `/rest/api/3/issue/createmeta/${enc(projectKey)}/issuetypes`);
      return (data?.issueTypes ?? data?.values ?? []).map((t) => t.name);
    },
    userSearch: (query) => request('GET', `/rest/api/3/user/search?query=${enc(query)}&maxResults=10`).then((r) => r ?? []),
    versions: (projectKey) => request('GET', `/rest/api/3/project/${enc(projectKey)}/versions`),
  };
}
