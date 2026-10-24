import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const pidName = /^\d+\.json$/;
const loopback = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/;

// Read and validate one private discovery record. Never trust its URL field:
// the origin is checked to be loopback and the URL is rebuilt by callers.
export async function readEndpoint(directory, pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try {
    const endpoint = JSON.parse(await readFile(join(directory, 'endpoints', `${pid}.json`), 'utf8'));
    if (endpoint.pid !== pid || !/^[a-f0-9]{64}$/.test(endpoint.token)) return;
    if (!loopback.test(endpoint.origin)) return;
    const origin = new URL(endpoint.origin);
    if (Number(origin.port) > 65535 || !origin.port) return;
    return { pid, origin: origin.origin, token: endpoint.token };
  } catch { /* Missing, partially written or malformed. */ }
}

const text = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : '';

// Read private discovery records only, and never delete records on transient
// network errors (another launcher may still need them).
export async function discoverConnections(directory, { signal } = {}) {
  signal?.throwIfAborted();
  const names = (await readdir(join(directory, 'endpoints')).catch(() => [])).filter((name) => pidName.test(name));
  const probe = async (name) => {
    try {
      signal?.throwIfAborted();
      const endpoint = await readEndpoint(directory, Number(name.slice(0, -5)));
      if (!endpoint) return;
      // summary=1 skips message history; older bridges ignore it and still work.
      const response = await fetch(`${endpoint.origin}/api/state?summary=1`, {
        headers: { Authorization: `Bearer ${endpoint.token}` }, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500),
      });
      if (!response.ok) return;
      const state = await response.json();
      if (state.pid !== endpoint.pid || typeof state.sessionId !== 'string' || !state.sessionId) return;
      return {
        pid: state.pid, sessionId: state.sessionId, cwd: text(state.cwd, 4096), url: `${endpoint.origin}/#${endpoint.token}`,
        title: text(state.title) || text(state.sessionName), model: text(state.model), preview: text(state.preview),
        busy: Boolean(state.busy), pending: Boolean(state.pending), spawned: Boolean(state.spawned), spawnId: text(state.spawnId, 80),
      };
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
