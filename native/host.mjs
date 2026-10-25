import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chooseConnection, discoverConnections } from './connection.mjs';
import { stateDir } from '../extension.mjs';
import { stoppedRecords } from '../running.mjs';

const exec = promisify(execFile);

// Resume the conversation the app last had open, in its own folder, if Pi
// stopped (phone off, Android killed Termux). Otherwise continue the most
// recent session in the home folder. Parallel sessions are restored from the app.
export async function launchPlan({ directory = stateDir, cwd = homedir(), args, isAlive } = {}) {
  if (args) return { cwd, args, stale: [] };
  const stale = (await stoppedRecords(directory, isAlive ? { isAlive } : undefined)).filter((record) => !record.spawned);
  const resume = stale[0];
  return { cwd: resume?.cwd || cwd, args: resume ? ['--session', resume.sessionFile] : ['-c'], stale };
}

// host.sh holds the SAME kernel lock as the existing launcher. This process is
// kept registered as a Termux background task for the entire PTY's lifetime;
// detaching tmux and immediately exiting would leave an untracked orphan.
export async function runNativeHost({ directory = stateDir, socket = 'pi-voice-native', session = 'pi-voice', cwd = homedir(), pi = join(homedir(), '.pi/agent/bin/pi'), args, env = process.env, interval = 5000 } = {}) {
  const existing = chooseConnection(await discoverConnections(directory));
  if (existing) return { reused: true };
  const tmux = join(process.env.PREFIX || '/data/data/com.termux/files/usr', 'bin/tmux');
  const command = async (...args) => exec(tmux, ['-L', socket, ...args], { env, timeout: 10000 });
  // Recover a surviving native PTY; never spawn a duplicate just because its
  // bridge is temporarily stopped or still starting up.
  let present = await command('has-session', '-t', `=${session}`).then(() => true, () => false);
  if (!present) {
    const plan = await launchPlan({ directory, cwd, args });
    await command('new-session', '-d', '-s', session, '-x', '100', '-y', '36', '-c', plan.cwd, pi, ...plan.args);
    // Do not discard any recovery records here: the pane may exit before Pi
    // starts. stoppedRecords retires only duplicates of a live replacement;
    // other stopped conversations remain available under Restore.
  }
  do {
    await delay(interval);
    present = await command('has-session', '-t', `=${session}`).then(() => true, () => false);
  } while (present);
  return { reused: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runNativeHost(); }
  catch { process.stderr.write('Pi Voice background host could not start. Check tmux and the managed Pi installation.\n'); process.exitCode = 1; }
}
