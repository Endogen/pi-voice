import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHost } from '../host/server.mjs';
import { discoverHost } from '../native/connection.mjs';
import { openRegistry } from '../host/registry.mjs';

async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-voice-host-'));
  const directory = join(root, 'voice');
  const processes = new Map();
  const all = [];
  const launcher = {
    async present(entry) { const p = processes.get(entry.handle); return Boolean(p && p.child.exitCode === null && !p.child.signalCode); },
    async launch(entry) {
      if (await this.present(entry)) return;
      const child = spawn(process.execPath, [new URL('./fixtures/host-worker.mjs', import.meta.url).pathname], {
        env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_VOICE_RPC: '1', PI_VOICE_MANAGED_ID: entry.handle,
          PI_VOICE_INSTANCE_ID: entry.instanceId, PI_VOICE_OPERATION_ID: entry.operationId,
          ...(entry.sessionFile ? { TEST_SESSION_ID: entry.sessionId, TEST_SESSION_FILE: entry.sessionFile } : {}) },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      const p = { child, progress: 0, error: '' }; processes.set(entry.handle, p); all.push(p);
      child.stderr.on('data', (chunk) => { p.error += chunk; });
      child.on('message', (message) => { if (message.progress) p.progress = message.progress; });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Worker not ready: ${p.error}`)), 10000);
        child.once('error', reject);
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`Worker exited: ${p.error}`)); });
        child.on('message', (message) => { if (message.ready) { clearTimeout(timer); resolve(); } });
      });
    },
  };
  let host;
  t.after(async () => {
    await host?.close();
    await Promise.all(all.map(({ child }) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.once('exit', resolve); child.kill('SIGTERM');
    })));
    await rm(root, { recursive: true, force: true });
  });
  const start = async () => { host = await createHost({ directory, port: 0, launcher, interval: 30, managerOptions: { cwd: root } }); await host.ready; return host; };
  await start();
  const token = (await readFile(join(directory, 'token'), 'utf8')).trim();
  const request = async (path, body, session) => {
    const response = await fetch(`${host.origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(session ? { 'X-Pi-Voice-Session': session.handle, 'X-Pi-Voice-Instance': session.instanceId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { directory, root, processes, launcher, start, get host() { return host; }, request,
    list: async () => (await request('sessions')).data,
    ready: async (handle) => until(async () => (await request('sessions')).data.sessions.find((e) => (!handle || e.handle === handle) && e.status === 'ready'), 'worker readiness'),
  };
}

test('closing the FIRST worker preserves the host origin and another process’s running task; last close stays empty', async (t) => {
  const h = await fixture(t);
  const first = await h.ready();
  const origin = h.host.origin;
  const operation = randomUUID();
  const spawn = await h.request('session/spawn', { id: operation }, first);
  assert.equal(spawn.status, 202);
  const second = await h.ready(spawn.data.handle);
  assert.notEqual(first.pid, second.pid, 'Workers really are separate processes');
  assert.equal((await h.request('prompt', { id: randomUUID(), sessionId: second.sessionId, text: 'Keep working' }, second)).status, 200);
  await until(() => h.processes.get(second.handle).progress > 2, 'second worker doing work');
  const before = h.processes.get(second.handle).progress;
  assert.equal((await h.request('session/close', { sessionId: first.sessionId, instanceId: first.instanceId }, first)).status, 202);
  await until(async () => !(await h.list()).sessions.some((e) => e.handle === first.handle), 'first process exit');
  assert.equal(h.processes.get(first.handle).child.exitCode, 0);
  assert.equal(h.host.origin, origin);
  assert.equal((await discoverHost(h.directory)).url, h.host.url);
  await until(() => h.processes.get(second.handle).progress > before + 3, 'uninterrupted work after first exit');
  const working = await h.request('state', undefined, second);
  assert.equal(working.data.busy, true);
  assert.equal(working.data.pid, second.pid);
  h.processes.get(second.handle).child.send('finish');
  await until(async () => (await h.request('state', undefined, second)).data.messages.some((m) => m.text.startsWith('Completed')), 'second worker finishes');
  assert.equal((await h.request('session/close', { sessionId: second.sessionId, instanceId: second.instanceId }, second)).status, 202);
  await until(async () => (await h.list()).sessions.length === 0, 'last worker exit');
  assert.equal((await h.request('state')).data.empty, true);
  assert.deepEqual((await h.list()).stopped, [], 'Intentional closures are not offered for restore');
  await h.host.close(); await h.start();
  assert.equal(h.host.origin, origin);
  assert.equal((await h.list()).sessions.length, 0, 'Restart does not resurrect closed sessions');
  const third = await h.request('session/spawn', { id: randomUUID() });
  assert.equal((await h.ready(third.data.handle)).capabilities.close, true);
  assert.equal(h.host.origin, origin);
});

test('host restart reattaches surviving processes; retries do not duplicate launches; stale instances cannot act', async (t) => {
  const h = await fixture(t);
  const first = await h.ready();
  const id = randomUUID();
  const responses = await Promise.all(Array.from({ length: 4 }, () => h.request('session/spawn', { id }, first)));
  assert.ok(responses.every((r) => r.status === 202 && r.data.handle === responses[0].data.handle));
  const second = await h.ready(responses[0].data.handle);
  assert.equal(h.processes.size, 2);
  assert.equal((await h.request('session/select', { handle: second.handle })).status, 200);
  await h.host.close(); await h.start();
  assert.equal((await h.request('state')).data.pid, second.pid);
  assert.equal(h.processes.size, 2);
  assert.equal((await h.request('session/spawn', { id }, first)).data.handle, second.handle);
  assert.equal((await h.request('session/spawn', { id })).status, 409, 'ID cannot change operation meaning');
  assert.equal((await h.request('prompt', { id: randomUUID(), sessionId: second.sessionId, text: 'stale' }, { ...second, instanceId: 'stale-instance' })).status, 409);
  assert.equal((await h.request('session/close', { sessionId: 'stale-conversation', instanceId: second.instanceId }, second)).status, 409);
  assert.equal((await h.request('host/stop', {})).status, 409);
});

test('host owns assets and security boundary; workers expose no app or lifecycle manager', async (t) => {
  const h = await fixture(t);
  const first = await h.ready();
  for (const path of ['/', '/app.js', '/style.css', '/icon-192.png']) {
    const response = await fetch(h.host.origin + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  assert.equal((await fetch(`${h.host.origin}/api/sessions`)).status, 401);
  const token = (await readFile(join(h.directory, 'token'), 'utf8')).trim();
  assert.equal((await fetch(`${h.host.origin}/api/sessions`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status, 403);
  const ep = JSON.parse(await readFile(join(h.directory, 'endpoints', `${first.pid}.json`), 'utf8'));
  assert.equal((await fetch(ep.origin)).status, 404);
  assert.equal((await fetch(`${ep.origin}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  assert.equal((await h.request('prompt', { id: randomUUID(), sessionId: first.sessionId, text: 'missing-target' })).status, 400);
  for (const handle of [undefined, null, '', 'invalid/handle']) {
    assert.equal((await h.request('session/restore', { id: randomUUID(), handle })).status, 400);
  }
  assert.equal(h.processes.size, 1, 'Malformed Restore cannot start a new worker');
  const forgedTarget = await new Promise((resolve, reject) => {
    const req = http.request(h.host.origin, { method: 'GET', path: 'http://127.0.0.1:1/api/state', headers: { Authorization: `Bearer ${token}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(forgedTarget, 400, 'Absolute HTTP targets cannot redirect authenticated forwarding');
  const list = JSON.stringify((await h.list()));
  assert.ok(!list.includes(token) && !list.includes('sessionFile') && !list.includes('origin'));
});

test('worker crash restores the same handle and saved conversation; closed sessions stay closed across host recovery', async (t) => {
  const h = await fixture(t);
  const first = await h.ready();
  h.processes.get(first.handle).child.kill('SIGKILL');
  await until(async () => (await h.list()).stopped.some((e) => e.handle === first.handle), 'crash recovery record');
  const restored = await h.request('session/restore', { id: randomUUID(), handle: first.handle });
  assert.equal(restored.status, 202);
  assert.equal(restored.data.handle, first.handle);
  const next = await h.ready(first.handle);
  assert.equal(next.sessionId, first.sessionId);
  assert.notEqual(next.instanceId, first.instanceId);
  assert.notEqual(next.pid, first.pid);
  const registry = await openRegistry(h.directory);
  assert.equal(registry.data.entries[first.handle].managed, true);
  assert.equal((await h.request('session/close', { sessionId: first.sessionId, instanceId: first.instanceId }, first)).status, 409);
});

test('a reserved host port conflict fails instead of changing origin or disturbing surviving workers', async (t) => {
  const h = await fixture(t); const worker = await h.ready();
  const port = Number(new URL(h.host.origin).port);
  await h.host.close();
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  await assert.rejects(h.start(), { code: 'EADDRINUSE' });
  assert.equal(h.processes.get(worker.handle).child.exitCode, null);
  assert.equal((await openRegistry(h.directory)).data.port, port);
});

test('host model switching is explicit-target, isolated per process, capability-aware and history preserving', async (t) => {
  const h = await fixture(t); const first = await h.ready();
  const spawn = await h.request('session/spawn', { id: randomUUID() }, first);
  const second = await h.ready(spawn.data.handle);
  assert.equal((await h.request('models')).status, 400, 'Model listing must not silently target another session');
  assert.equal((await h.request('models', undefined, { ...first, instanceId: 'stale' })).status, 409);
  assert.equal((await h.request('prompt', { id: randomUUID(), sessionId: first.sessionId, text: 'Keep my history' }, first)).status, 200);
  const list = await h.request('models', undefined, first);
  assert.equal(list.status, 200);
  assert.equal(list.data.models.length, 2);
  const body = { sessionId: first.sessionId, provider: 'custom-local', id: 'generic/model:Q5', expectedModel: list.data.current };
  assert.equal((await h.request('model', body, first)).status, 409, 'Busy worker must not change models');
  h.processes.get(first.handle).child.send('finish');
  const before = await until(async () => { const state = (await h.request('state', undefined, first)).data; return !state.busy && state.messages.length === 2 ? state : null; }, 'first turn completion');
  assert.equal((await h.request('model', body)).status, 400);
  assert.equal((await h.request('model', body, { ...first, instanceId: 'old-process' })).status, 409);
  assert.equal((await h.request('model', { ...body, sessionId: 'stale-conversation' }, first)).status, 409);
  const selected = await h.request('model', body, first);
  assert.equal(selected.status, 200);
  const after = (await h.request('state', undefined, first)).data;
  assert.equal(after.model, 'custom-local/generic/model:Q5');
  assert.equal(after.modelSupportsImages, true);
  assert.equal(after.modelSwitchingSupported, true);
  assert.equal(after.modelSwitching, false);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.sessionId, before.sessionId);
  const untouched = (await h.request('state', undefined, second)).data;
  assert.equal(untouched.model, 'test/deterministic');
  assert.equal(untouched.modelSupportsImages, false);
  assert.equal((await h.request('model', { ...body, id: 'different', expectedModel: list.data.current }, first)).status, 409, 'Old model snapshots cannot override a later choice');
});
