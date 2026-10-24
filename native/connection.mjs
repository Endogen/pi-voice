import { discoverConnections as discover } from '../discovery.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { stateDir } from '../extension.mjs';

export function discoverConnections(directory = stateDir, options) {
  return discover(directory, options);
}

// Sessions started from the app's New button run in parallel with the primary
// Pi and are reachable through its in-app switcher: they are never ambiguous.
export function chooseConnection(all) {
  const primary = all.filter((connection) => !connection.spawned);
  const connections = primary.length ? primary : all.slice(0, 1);
  if (connections.length > 1) throw new Error('Several Pi sessions you started yourself are running. Quit the extra ones in Termux, then open Pi Voice Native again. Nothing was started or selected automatically.');
  return connections[0];
}

export async function waitForConnection({ directory = stateDir, timeout = 30000, interval = 250 } = {}) {
  const signal = AbortSignal.timeout(timeout);
  try {
    for (;;) {
      const connection = chooseConnection(await discoverConnections(directory, { signal }));
      if (connection) return connection;
      await delay(interval, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  throw new Error('Pi did not become ready. Check Termux permission, allow-external-apps=true, and battery restrictions. If the native Pi is already running, attach with: tmux -L pi-voice-native attach -t pi-voice');
}
