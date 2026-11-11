import { readFileSync } from 'node:fs';

// Minimal .env parser: KEY=value, optional `export `, optional single/double quotes, # comments.
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

export function loadEnv(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  for (const [k, v] of Object.entries(parseEnv(text))) if (process.env[k] === undefined) process.env[k] = v;
}
