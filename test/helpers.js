import http from 'node:http';

// JSON request to a test server on 127.0.0.1. Sends X-Dashboard by default; pass headers = {} to omit it.
export const request = (port) => (method, p, body, headers = { 'X-Dashboard': '1' }) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', ...headers } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d, json: () => JSON.parse(d) }));
  });
  r.on('error', reject);
  if (body !== undefined) r.write(JSON.stringify(body));
  r.end();
});
