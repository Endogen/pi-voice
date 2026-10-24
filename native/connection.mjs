import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stateDir } from '../extension.mjs';

// Read private discovery records only. Never trust their URL field or delete
// records on transient network errors (another launcher may still need them).
export async function discoverConnections(directory = stateDir) {
  const endpoints = join(directory, 'endpoints');
  const names = await readdir(endpoints).catch(() => []);
  const results = await Promise.all(names.filter((name) => /^\d+\.json$/.test(name)).map(async (name) => {
    try {
      const endpoint = JSON.parse(await readFile(join(endpoints, name), 'utf8'));
      if (endpoint.pid !== Number(name.slice(0, -5)) || !/^[a-f0-9]{64}$/.test(endpoint.token)) return;
      if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(endpoint.origin)) return;
      const origin = new URL(endpoint.origin);
      if (Number(origin.port) > 65535 || !origin.port) return;
      const response = await fetch(`${origin.origin}/api/state`, {
        headers: { Authorization: `Bearer ${endpoint.token}` }, redirect: 'error', signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return;
      const state = await response.json();
      if (state.pid !== endpoint.pid || typeof state.sessionId !== 'string' || !state.sessionId) return;
      return { pid: state.pid, sessionId: state.sessionId, url: `${origin.origin}/#${endpoint.token}` };
    } catch { /* Stale PID, partially written record, or temporarily unavailable. */ }
  }));
  return results.filter(Boolean);
}

export function chooseConnection(connections) {
  if (connections.length > 1) throw new Error('Several Pi sessions are running. Close extra sessions in Termux, or use /voice in the desired session to open it in Chrome. Nothing was started or selected automatically.');
  return connections[0];
}

export async function waitForConnection({ directory = stateDir, timeout = 30000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    const connection = chooseConnection(await discoverConnections(directory));
    if (connection) return connection;
    await delay(interval);
  } while (Date.now() < deadline);
  throw new Error('Pi did not become ready. Check Termux permission, allow-external-apps=true, and battery restrictions. If the native Pi is already running, attach with: tmux -L pi-voice-native attach -t pi-voice');
}
