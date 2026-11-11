import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchAgentPlist, jobPath, LABEL } from '../scripts/app.js';
import { request } from './helpers.js';
import { createServer } from '../server.js';

test('the LaunchAgent plist runs node on server.js at login, with no browser, and escapes paths', () => {
  const xml = launchAgentPlist({ node: '/opt/n/node', server: '/Users/a&b/dash/server.js', cwd: '/Users/a&b/dash', envPath: '/opt/homebrew/bin:/usr/bin', log: '/Users/a&b/dash/data/logs/server.log' });
  assert.match(xml, new RegExp(`<string>${LABEL}</string>`));
  assert.match(xml, /<string>\/opt\/n\/node<\/string><string>\/Users\/a&amp;b\/dash\/server\.js<\/string>/);
  assert.match(xml, /<key>NO_OPEN<\/key><string>1<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(!xml.includes('a&b'), 'raw & would break the plist');
  if (process.platform === 'darwin') {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'plist-')), 'x.plist');
    writeFileSync(file, xml);
    assert.match(execFileSync('plutil', ['-lint', file]).toString(), /OK/);
  }
});

test('jobPath keeps the user\'s existing absolute folders and adds the usual ones', () => {
  const p = jobPath('/opt/homebrew/bin:relative/bin::/nope', (d) => d !== '/nope').split(':');
  assert.equal(p[0], '/opt/homebrew/bin');
  assert.ok(!p.includes('relative/bin') && !p.includes('/nope') && !p.includes(''));
  assert.ok(p.includes('/usr/bin'));
  assert.equal(new Set(p).size, p.length);
});

test('the manifest and icons are served with the right types, so the browser offers Install', async () => {
  const server = createServer({ gh: { json: async () => [], run: async () => '' }, tracker: { list: () => [] }, behind: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const req = request(server.address().port);
  const m = await req('GET', '/manifest.webmanifest');
  assert.equal(m.status, 200);
  assert.match(m.headers['content-type'], /application\/manifest\+json/);
  const manifest = m.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  for (const icon of manifest.icons) {
    const r = await req('GET', `/${icon.src}`);
    assert.equal(r.status, 200, icon.src);
    assert.equal(r.headers['content-type'], icon.type);
  }
  assert.match(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), /<link rel="manifest" href="manifest\.webmanifest">/);
  server.close();
});
