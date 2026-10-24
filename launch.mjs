#!/usr/bin/env node
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { stateDir, openBrowser } from './extension.mjs';
import { discoverConnections as discover } from './native/connection.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Pi Voice — speak to Pi from a home-screen app.

  pi-voice                 Open a running Pi; start a fresh Pi if none exists
  pi-voice --app           Open a running Pi; otherwise resume with pi -c
  pi-voice --new [pi args]  Start a new Pi session and open the app
  pi-voice --pin           Set up a SINGLE home-screen icon (choose Pi Voice)

The Termux:Widget home-screen launcher uses --app (no shell commands needed).
A Chrome-only shortcut cannot start a stopped Termux/Pi process.
If multiple Pi sessions are active, use /voice inside the desired session.`);
  process.exit(0);
}
if (args.includes('--pin')) {
  if (args.length !== 1) {
    console.error('Use pi-voice --pin by itself. It only sets up the home-screen icon.');
    process.exit(1);
  }
  try {
    const { installShortcut, openShortcutPicker } = await import('./install-shortcut.mjs');
    await installShortcut();
    await openShortcutPicker();
    console.log('Opened Android shortcut setup. Choose "Pi Voice", then confirm Add.');
    console.log('This creates a single microphone icon, not the large list widget.');
    console.log('After testing it, remove the old widget/Chrome-only home-screen icon.');
  } catch (error) {
    console.error(`Could not open shortcut setup: ${error.message}`);
    console.error('Check Termux:Widget is installed, then retry. No Pi process was started.');
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}
const appMode = args.includes('--app');
if (appMode && args.length !== 1) {
  console.error('Use pi-voice --app by itself, or --new [pi args] for a separate session.');
  process.exit(1);
}

// Returns false only when there is no running bridge. Ambiguity must never
// silently choose a conversation or start another Pi.
async function openExisting() {
  const live = await discover();
  if (live.length > 1) {
    console.error('Several Pi sessions are running. Use /voice inside the desired one:');
    for (const item of live) console.error(`  ${item.sessionId.slice(0, 8)}  ${item.cwd}`);
    process.exitCode = 1;
    return true;
  }
  if (!live.length) return false;
  console.log(`Opening Pi Voice for ${live[0].sessionId.slice(0, 8)} (${live[0].cwd}).`);
  try { await openBrowser(live[0].url); }
  catch { console.error(`Open this private link in Chrome: ${live[0].url}`); process.exitCode = 1; }
  return true;
}

if ((args.length === 0 || appMode) && await openExisting()) process.exit(process.exitCode || 0);

let command = 'pi';
let childArgs = ['--voice-open', ...args.filter((arg) => arg !== '--new')];
if (appMode) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, 'app-launch.lock');
  await (await open(lock, 'a', 0o600)).close();
  // Kernel-managed locking survives neither process death nor reboot: there is
  // no stale PID lock to strand the launcher. Hold it for this Pi's lifetime;
  // later taps open its discovered bridge without needing the lock at all.
  command = join(process.env.PREFIX || '/data/data/com.termux/files/usr', 'bin', 'flock');
  childArgs = ['-n', '-E', '75', lock, 'pi', '--voice-open', '-c'];
}
console.log(appMode ? 'Opening Pi Voice; resuming Pi if needed…' : 'Starting Pi with the voice app. Keep this Termux session running.');
const code = await new Promise((resolve) => {
  const child = spawn(command, childArgs, { stdio: 'inherit' });
  child.on('error', (error) => { console.error(`Could not start Pi: ${error.message}`); resolve(1); });
  child.on('exit', (exitCode) => resolve(exitCode ?? 1));
});
if (appMode && code === 75) {
  // A fast second tap can arrive before the first Pi has published its bridge.
  console.log('Pi Voice is already starting; waiting for its connection…');
  const deadline = Date.now() + 30000;
  let opened = false;
  while (Date.now() < deadline) {
    if (await openExisting()) { opened = true; break; }
    await delay(250);
  }
  if (!opened) {
    console.error('Pi Voice did not become ready. Open Termux to check the running session (it may have /voice stopped).');
    process.exitCode = 1;
  }
} else process.exitCode = code;
