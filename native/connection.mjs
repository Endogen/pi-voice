import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stateDir, protocolVersion, validId } from '../config.mjs';

/** Discover only the independent host. Workers are never app connections. */
export async function discoverHost(directory = stateDir, { signal } = {}) {
  try {
    const endpoint = JSON.parse(await readFile(join(directory, 'host-endpoint.json'), 'utf8'));
    const token = (await readFile(join(directory, 'token'), 'utf8')).trim();
    if (endpoint.role !== 'host' || endpoint.protocolVersion !== protocolVersion || !validId(endpoint.instanceId)
      || !Number.isSafeInteger(endpoint.pid) || endpoint.pid < 1 || !/^[a-f0-9]{64}$/.test(token)
      || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(endpoint.origin)) return;
    const origin = new URL(endpoint.origin);
    if (!origin.port || Number(origin.port) > 65535) return;
    const response = await fetch(`${origin.origin}/api/health`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500) });
    if (!response.ok) return;
    const state = await response.json();
    if (state.role !== 'host' || state.protocolVersion !== protocolVersion || state.pid !== endpoint.pid || state.instanceId !== endpoint.instanceId) return;
    return { url: `${origin.origin}/#${token}` };
  } catch { signal?.throwIfAborted(); }
}

export async function waitForConnection({ directory = stateDir, timeout = 30000, interval = 250 } = {}) {
  const signal = AbortSignal.timeout(timeout);
  try {
    for (;;) {
      const connection = await discoverHost(directory, { signal });
      if (connection) return connection;
      await delay(interval, undefined, { signal });
    }
  } catch (error) { if (!signal.aborted) throw error; }
  throw new Error('Pi Voice host did not become ready. Check Termux permission, tmux, and the host startup log.');
}
