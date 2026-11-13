import { readFileSync } from 'node:fs';

// Minimal .env parser: KEY=value, optional `export `, optional single/double quotes, # comments.
export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!assignment) continue;
    out[assignment[1]] = unquote(assignment[2].trim());
  }
  return out;
}

function unquote(value) {
  const quote = value[0];
  const quoted = (quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2;
  return quoted ? value.slice(1, -1) : value;
}

// Variables already set in the shell win over the file.
export function loadEnv(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
