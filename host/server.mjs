import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createApiServer, readJSON, fail } from '../transport.mjs';
import { stateDir, loadToken, protocolVersion, validId } from '../config.mjs';
import { openRegistry } from './registry.mjs';
import { atomicJSON } from '../storage.mjs';
import { createLauncher } from './launcher.mjs';
import { createWorkerClient } from './worker-client.mjs';
import { createSessionManager } from './session-manager.mjs';

const workerRoutes = new Set(['GET /api/activity', 'GET /api/models', 'POST /api/model', 'POST /api/thinking', 'POST /api/compact', 'POST /api/prompt', 'POST /api/abort', 'POST /api/awake', 'POST /api/listen', 'POST /api/listen/cancel']);

export async function createHost({ directory = stateDir, port = 8865, interval = 1500, launcher = createLauncher(), managerOptions = {} } = {}) {
  const token = await loadToken(directory);
  const registry = await openRegistry(directory);
  const client = createWorkerClient(directory, token);
  const manager = createSessionManager({ directory, registry, launcher, client, ...managerOptions });
  const instanceId = randomUUID();
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  let startupError;
  let stopping = false;
  let timer;
  let finish;
  let publish;
  const published = new Promise((resolve) => { publish = resolve; });
  const closed = new Promise((resolve) => { finish = resolve; });
  const server = await createApiServer({ token, port: registry.data.port || port, fallbackPorts: !registry.data.port && port !== 0, serveAssets: true,
    async handle({ req, res, path, send }) {
      if (!await published) throw fail(503, 'Pi Voice could not initialize its storage.');
      const handle = req.headers['x-pi-voice-session'];
      if (handle !== undefined && !validId(handle)) throw fail(400, 'Invalid session handle.');
      if (req.method === 'GET' && path === '/api/health') {
        send(200, { role: 'host', protocolVersion, pid: process.pid, instanceId }); return;
      }
      if (req.method === 'GET' && path === '/api/sessions') {
        send(200, { ...await manager.snapshot(), protocolVersion, startupError }); return;
      }
      if (req.method === 'GET' && path === '/api/state') {
        const selected = handle || registry.data.selected;
        let entry;
        try { if (selected) entry = await manager.target(selected); }
        catch (error) { if (handle || error.status !== 410) throw error; }
        if (!entry) {
          send(200, { empty: true, title: 'Pi Voice', messages: [], voiceVersion: version,
            sessionId: '', selected, status: selected ? registry.data.entries[selected]?.status : 'empty', error: startupError });
        } else {
          const state = await client.request(entry, 'state');
          send(200, { ...state, handle: entry.handle, instanceId: entry.instanceId });
        }
        return;
      }
      if (req.method === 'POST' && path.startsWith('/api/session/')) {
        const body = await readJSON(req);
        if (!body || typeof body !== 'object') throw fail(400, 'Expected an action.');
        switch (path) {
          case '/api/session/spawn': send(202, await manager.spawn(body.id, handle)); return;
          case '/api/session/select':
            if (body.handle !== null && !validId(body.handle)) throw fail(400, 'A valid session handle is required.');
            send(200, await manager.select(body.handle)); return;
          case '/api/session/restore': send(202, await manager.restore(body.id, body.handle)); return;
          case '/api/session/forget': send(200, await manager.forget(body.handle)); return;
          case '/api/session/close': send(202, await manager.close(handle, body)); return;
          default: throw fail(404, 'Unknown session action.');
        }
      }
      if (req.method === 'POST' && path === '/api/host/stop') {
        await manager.prepareStop();
        send(202, { ok: true }); setImmediate(() => { void stop(); }); return;
      }
      if (workerRoutes.has(`${req.method} ${path}`)) {
        if (!handle) throw fail(400, 'Select a session before sending commands.');
        const entry = await manager.target(handle);
        if (req.headers['x-pi-voice-instance'] !== entry.instanceId) throw fail(409, 'Pi restarted. Review the conversation before retrying.');
        await client.forward(entry, req, res); return;
      }
      throw fail(404, 'Not found.');
    },
  });
  async function stop() {
    if (stopping) return closed;
    stopping = true;
    clearTimeout(timer);
    await server.close();
    await ready.catch(() => {});
    await manager.reconcile().catch(() => {});
    await rm(join(directory, 'host-endpoint.json'), { force: true });
    finish();
  }
  try {
    registry.data.port = Number(new URL(server.origin).port);
    await registry.save();
    await atomicJSON(join(directory, 'host-endpoint.json'), { role: 'host', protocolVersion, pid: process.pid, instanceId, origin: server.origin });
  } catch (error) { publish(false); await server.close(); throw error; }
  const ready = manager.initialize().catch((error) => { startupError = error.message; });
  publish(true); // Port and endpoint are durable; initialization is first in the manager queue.
  async function tick() {
    await manager.reconcile().catch((error) => { startupError = error.message; });
    if (!stopping) timer = setTimeout(tick, interval);
  }
  void ready.then(() => { if (!stopping) timer = setTimeout(tick, interval); });
  return { origin: server.origin, url: server.url, manager, ready, closed, close: stop };
}
