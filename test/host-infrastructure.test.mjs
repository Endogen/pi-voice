import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJSON } from '../storage.mjs';
import { createWorkerClient } from '../host/worker-client.mjs';
import { createLauncher } from '../host/launcher.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-voice-infrastructure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('failed record serialization preserves the durable record and removes its temporary file', async (t) => {
  const root = await directory(t);
  const file = join(root, 'state.json');
  await atomicJSON(file, { version: 1 });
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(atomicJSON(file, cycle), TypeError);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1 });
  assert.deepEqual(await readdir(root), ['state.json']);
});

test('a request cancelled while waiting for a worker is never forwarded afterward', async (t) => {
  const root = await directory(t);
  let forwarded = 0;
  const worker = http.createServer((_req, res) => { forwarded++; res.end(); });
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { worker.close(resolve); worker.closeAllConnections(); }));
  const token = 'a'.repeat(64);
  const entry = { pid: 123, instanceId: 'instance-test' };
  await atomicJSON(join(root, 'endpoints', '123.json'), { ...entry, token, origin: `http://127.0.0.1:${worker.address().port}` });
  const req = new PassThrough();
  Object.assign(req, { url: '/api/listen', method: 'POST', headers: {}, aborted: true });
  req.end();
  const res = new PassThrough(); res.writeHead = () => {};
  const closed = once(res, 'close'); res.destroy(); await closed;
  await createWorkerClient(root, token).forward(entry, req, res);
  assert.equal(forwarded, 0, 'A cancelled recording must not activate the microphone later');
});

test('unexpected tmux probe errors are not evidence that a session exited', async (t) => {
  const root = await directory(t);
  const tmux = join(root, 'tmux');
  const entry = { terminal: 'pi-voice-12345678' };
  await writeFile(tmux, '#!/bin/sh\nexit 2\n', { mode: 0o700 });
  const launcher = createLauncher({ tmux });
  await assert.rejects(launcher.present(entry), { code: 2 });
  await writeFile(tmux, '#!/bin/sh\nexit 1\n');
  assert.equal(await launcher.present(entry), false);
  await writeFile(tmux, '#!/bin/sh\nexit 0\n');
  assert.equal(await launcher.present(entry), true);
});

test('disconnecting an active forwarded recording closes its worker request', { timeout: 5000 }, async (t) => {
  const root = await directory(t);
  let started, cancelled;
  const listening = new Promise((resolve) => { started = resolve; });
  const stopped = new Promise((resolve) => { cancelled = resolve; });
  const worker = http.createServer((_req, res) => {
    res.once('close', cancelled);
    started(); // Keep speech pending until its caller disconnects.
  });
  const token = 'b'.repeat(64);
  const entry = { pid: 456, instanceId: 'recording-worker' };
  const client = createWorkerClient(root, token);
  const host = http.createServer((req, res) => { void client.forward(entry, req, res).catch(() => res.destroy()); });
  for (const server of [worker, host]) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  }
  await atomicJSON(join(root, 'endpoints', '456.json'), { ...entry, token, origin: `http://127.0.0.1:${worker.address().port}` });
  const controller = new AbortController();
  const response = fetch(`http://127.0.0.1:${host.address().port}/api/listen`, { method: 'POST', signal: controller.signal });
  await listening;
  controller.abort();
  await assert.rejects(response, { name: 'AbortError' });
  await stopped;
});
