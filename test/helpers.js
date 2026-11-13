import http from 'node:http';

const DEFAULT_HEADERS = { 'X-Dashboard': '1' };

function sendRequest({ port, method, urlPath, body, headers }) {
  return new Promise((resolve, reject) => {
    const options = {
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', ...headers },
    };
    const outgoing = http.request(options, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: text, json: () => JSON.parse(text),
      }));
    });
    outgoing.on('error', reject);
    if (body !== undefined) outgoing.write(JSON.stringify(body));
    outgoing.end();
  });
}

// JSON request to a test server on 127.0.0.1. Sends X-Dashboard by default; pass headers = {} to omit it.
export const request = (port) => (method, urlPath, body, headers = DEFAULT_HEADERS) =>
  sendRequest({ port, method, urlPath, body, headers });
