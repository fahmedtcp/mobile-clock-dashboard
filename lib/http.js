// Shared HTTP helpers for server.js and feature route modules.
const MAX_BODY = 10 * 1024;

// A handler can return raw(headers, body) to send something other than JSON (downloads).
export const RAW = Symbol('raw');
export const raw = (headers, body) => ({ [RAW]: true, headers, body });

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text) ?? {}); } catch { reject(new HttpError(400, 'Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

export function id(value) {
  if (!/^\d+$/.test(value)) throw new HttpError(400, 'Expected a numeric id.');
  return Number(value);
}
