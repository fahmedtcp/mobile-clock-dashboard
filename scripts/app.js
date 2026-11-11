// Run the dashboard like a Mac app: a LaunchAgent starts the server at login and restarts it if it stops.
//   npm run install-app     start at login (and now), then open it so you can install it as an app
//   npm run uninstall-app   stop it and remove the login item
//   npm run app-status      is it running?
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LABEL = 'com.tcpsoftware.mobile-clock-dashboard';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4317;
const URL_ = `http://localhost:${PORT}`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// launchd gives jobs a bare PATH; keep the user's own folders so gh, git, and node are found.
export function jobPath(envPath, exists = existsSync) {
  const dirs = String(envPath ?? '').split(':').filter((d) => d && path.isAbsolute(d) && exists(d));
  return [...new Set([...dirs, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
}

export function launchAgentPlist({ label = LABEL, node, server, cwd, envPath, log }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(node)}</string><string>${esc(server)}</string></array>
  <key>WorkingDirectory</key><string>${esc(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NO_OPEN</key><string>1</string>
    <key>PATH</key><string>${esc(envPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`;
}

const run = (file, args) => new Promise((resolve) => execFile(file, args, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr })));
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = () => `gui/${process.getuid()}`;

async function waitForServer(ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) {
    try { if ((await fetch(`${URL_}/api/settings`)).ok) return true; } catch { /* not up yet */ }
  }
  return false;
}

async function install() {
  if (process.platform !== 'darwin') { console.error('install-app is for macOS. On other systems, run npm start.'); process.exit(1); }
  const log = path.join(ROOT, 'data', 'logs', 'server.log');
  mkdirSync(path.dirname(log), { recursive: true });
  mkdirSync(path.dirname(plistPath()), { recursive: true });
  writeFileSync(plistPath(), launchAgentPlist({ node: process.execPath, server: path.join(ROOT, 'server.js'), cwd: ROOT, envPath: jobPath(process.env.PATH), log }));
  await run('launchctl', ['bootout', `${domain()}/${LABEL}`]); // replace an older copy; fine if there's none
  // A copy started with npm start still holds the port: the login copy would see it, exit, and not come back.
  await new Promise((r) => setTimeout(r, 600)); // let a just-stopped login copy release the port
  if (await waitForServer(800)) {
    console.error(`Another copy is already running at ${URL_}. Stop it first (press Ctrl+C in the Terminal where you ran npm start), then run npm run install-app again.`);
    process.exit(1);
  }
  const boot = await run('launchctl', ['bootstrap', domain(), plistPath()]);
  if (!boot.ok) { console.error(`Couldn't start it: ${boot.stderr.trim()}`); process.exit(1); }
  if (!(await waitForServer())) {
    console.error(`It didn't come up. See ${log}`);
    process.exit(1);
  }
  console.log(`Mobile Clock is running at ${URL_} and starts every time you log in.

Install it as an app (one time):
  Chrome:  ⋮ menu → Cast, save, and share → Install page as app…  (or the install icon in the address bar)
  Edge:    ⋯ menu → Apps → Install this site as an app
  Safari:  File → Add to Dock

Logs: ${log}
To remove: npm run uninstall-app`);
  await run('open', [URL_]);
}

async function uninstall() {
  await run('launchctl', ['bootout', `${domain()}/${LABEL}`]);
  if (existsSync(plistPath())) unlinkSync(plistPath());
  console.log('Removed. The dashboard no longer starts at login. You can still run npm start.');
  console.log('To remove the app window too, open it and use its menu to uninstall, or drag it from Applications (Chrome Apps) to the Trash.');
}

async function status() {
  const r = await run('launchctl', ['print', `${domain()}/${LABEL}`]);
  if (!r.ok) { console.log('Not installed. Run npm run install-app.'); return; }
  const pid = r.stdout.match(/\bpid = (\d+)/)?.[1];
  console.log(pid ? `Running (pid ${pid}) at ${URL_}` : 'Installed, but not running right now. It restarts within a few seconds if it stopped.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = { install, uninstall, status }[process.argv[2]];
  if (!cmd) { console.error('Usage: node scripts/app.js install | uninstall | status'); process.exit(1); }
  cmd();
}
