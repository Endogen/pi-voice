import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stateDir } from '../extension.mjs';

// Read private discovery records only. Never trust their URL field or delete
// records on transient network errors (another launcher may still need them).
export async function discoverConnections(directory = stateDir, { signal } = {}) {
  signal?.throwIfAborted();
  const endpoints = join(directory, 'endpoints');
  const names = (await readdir(endpoints).catch(() => [])).filter((name) => /^\d+\.json$/.test(name));
  const probe = async (name) => {
    try {
      signal?.throwIfAborted();
      const endpoint = JSON.parse(await readFile(join(endpoints, name), 'utf8'));
      if (endpoint.pid !== Number(name.slice(0, -5)) || !/^[a-f0-9]{64}$/.test(endpoint.token)) return;
      if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(endpoint.origin)) return;
      const origin = new URL(endpoint.origin);
      if (Number(origin.port) > 65535 || !origin.port) return;
      const response = await fetch(`${origin.origin}/api/state`, {
        headers: { Authorization: `Bearer ${endpoint.token}` }, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500),
      });
      if (!response.ok) return;
      const state = await response.json();
      if (state.pid !== endpoint.pid || typeof state.sessionId !== 'string' || !state.sessionId) return;
      return { pid: state.pid, sessionId: state.sessionId, cwd: typeof state.cwd === 'string' ? state.cwd : '', url: `${origin.origin}/#${endpoint.token}` };
    } catch {
      // A cancelled scan is incomplete: never return a partial list that might
      // hide another active session or incorrectly justify starting a new Pi.
      signal?.throwIfAborted();
      /* Stale PID, partially written record, or temporarily unavailable. */
    }
  };
  // A bridge caps connections at 24. Probing every stale record in parallel
  // can exhaust that cap, hide a live Pi and incorrectly trigger cold startup.
  // Keep capacity for the chat, other launchers and the bootstrap poller.
  const results = new Array(names.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, async () => {
    while (cursor < names.length) {
      const index = cursor++;
      results[index] = await probe(names[index]);
    }
  }));
  signal?.throwIfAborted();
  return results.filter(Boolean);
}

export function chooseConnection(connections) {
  if (connections.length > 1) throw new Error('Several Pi sessions are running. Close extra sessions in Termux, or use /voice in the desired session to open it in Chrome. Nothing was started or selected automatically.');
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
