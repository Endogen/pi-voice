import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createSessionManager } from '../host/session-manager.mjs';
import { openRegistry } from '../host/registry.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-voice-manager-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let registry = await openRegistry(directory);
  registry.data.initialized = true; await registry.save();
  let now = Date.now();
  let calls = 0;
  const live = [];
  const panes = new Set();
  const alive = new Set();
  const launcher = { present: async (e) => panes.has(e.handle), launch: async (e) => { calls++; panes.add(e.handle); } };
  const client = { request: async () => ({ ok: true }) };
  const options = () => ({ directory, registry, launcher, client, cwd: directory, discover: async () => live, isAlive: async (pid) => alive.has(pid), now: () => now });
  let manager = createSessionManager(options());
  return { directory, live, panes, alive, launcher, client, get calls() { return calls; }, get registry() { return registry; },
    get manager() { return manager; }, advance: (ms) => { now += ms; },
    async restart() { registry = await openRegistry(directory); manager = createSessionManager(options()); await manager.initialize(); },
    publish(handle, pid = 9001) {
      const e = registry.data.entries[handle]; alive.add(pid);
      live.push({ handle, pid, instanceId: e.instanceId, protocolVersion: 1, sessionId: `conversation-${handle}`, cwd: directory, title: 'Worker', managed: true });
    },
  };
}

test('capacity reservations are serialized across different operations, including unpublished live panes', async (t) => {
  const h = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => h.manager.spawn(randomUUID())));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 4);
  assert.equal(h.calls, 4);
  h.advance(50000);
  assert.equal((await h.manager.snapshot()).sessions.every((e) => e.status === 'unavailable'), true);
  await assert.rejects(h.manager.spawn(randomUUID()), { status: 409 });
});

test('durable launch reservation recovers after a host crash before launch and reuses existing panes', async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  h.launcher.launch = async () => { throw new Error('simulated host death'); };
  h.launcher.present = async () => true; // Outcome uncertain, retain reservation.
  await assert.rejects(h.manager.spawn(id), { status: 502 });
  const saved = Object.values(h.registry.data.entries)[0];
  let actual = 0;
  h.launcher.present = async (e) => h.panes.has(e.handle);
  h.launcher.launch = async (e) => { if (!h.panes.has(e.handle)) { actual++; h.panes.add(e.handle); } };
  await h.restart();
  assert.equal(actual, 1);
  await h.restart();
  assert.equal(actual, 1);
  assert.equal((await h.manager.spawn(id)).handle, saved.handle);
});

test('close intent survives endpoint disappearance and host restart; timeout never pretends exit', async (t) => {
  const h = await fixture(t);
  const { handle } = await h.manager.spawn(randomUUID());
  h.publish(handle);
  const entry = (await h.manager.snapshot()).sessions[0];
  await h.manager.close(handle, entry);
  h.live.length = 0; // Worker closes HTTP before the process has exited.
  assert.equal((await h.manager.snapshot()).sessions[0].status, 'closing');
  await h.restart();
  h.advance(20000);
  assert.equal((await h.manager.snapshot()).sessions[0].status, 'close-error');
  h.panes.clear(); h.alive.clear();
  assert.deepEqual((await h.manager.snapshot()).sessions, []);
  assert.equal(h.registry.data.entries[handle].status, 'closed');
  await h.restart();
  assert.equal(h.registry.data.entries[handle].status, 'closed');
});

test('external workers cannot grant themselves managed ownership and multiple external sessions are unambiguous', async (t) => {
  const h = await fixture(t);
  for (const pid of [101, 102]) {
    h.alive.add(pid);
    h.live.push({ pid, handle: `external-${pid}`, instanceId: randomUUID(), protocolVersion: 1, sessionId: `conversation-${pid}`, managed: true, cwd: h.directory });
  }
  const state = await h.manager.snapshot();
  assert.equal(state.sessions.length, 2);
  for (const entry of state.sessions) {
    assert.equal(entry.capabilities.close, false);
    await h.manager.select(entry.handle);
    await assert.rejects(h.manager.close(entry.handle, entry), { status: 409 });
  }
  assert.equal(h.calls, 0);
});

test('a changed conversation during close is never shut down by a retried old close intent', async (t) => {
  const h = await fixture(t);
  const { handle } = await h.manager.spawn(randomUUID()); h.publish(handle);
  const entry = (await h.manager.snapshot()).sessions[0];
  let shutdowns = 0; h.client.request = async () => { shutdowns++; };
  await h.manager.close(handle, entry);
  h.live[0].sessionId = 'replacement-conversation';
  const current = (await h.manager.snapshot()).sessions[0];
  assert.equal(current.status, 'close-error');
  assert.equal(shutdowns, 1);
  await assert.rejects(h.manager.close(handle, entry), { status: 409 });
});

test('restore reserves a saved conversation and rejects overlapping restores; failed launch retains history', async (t) => {
  const h = await fixture(t);
  const file = join(h.directory, 'saved.jsonl'); await writeFile(file, '{}\n');
  const handle = randomUUID();
  h.registry.data.entries[handle] = { handle, cwd: h.directory, sessionFile: file, status: 'stopped' };
  const results = await Promise.allSettled([h.manager.restore(randomUUID(), handle), h.manager.restore(randomUUID(), handle)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(h.calls, 1);
  assert.equal(h.registry.data.entries[handle].sessionFile, file);
  h.panes.clear(); h.advance(50000); await h.manager.reconcile();
  assert.equal(h.registry.data.entries[handle].status, 'failed');
  await h.manager.restore(randomUUID(), handle);
  assert.equal(h.calls, 2);
});

test('service stop and New are serialized, and operation IDs do not consult object prototypes', async (t) => {
  const h = await fixture(t);
  assert.ok((await h.manager.spawn('constructor')).handle);
  h.panes.clear(); h.advance(50000); await h.manager.reconcile();
  await h.manager.prepareStop();
  await assert.rejects(h.manager.spawn(randomUUID()), { status: 503 });
});

test('restore requires an explicit valid handle and never falls through to New', async (t) => {
  const h = await fixture(t);
  for (const handle of [undefined, null, '', [], 'bad/handle']) {
    await assert.rejects(h.manager.restore(randomUUID(), handle), { status: 400 });
  }
  assert.equal(h.calls, 0);
  assert.equal(Object.keys(h.registry.data.operations).length, 0);
});

test('a conversation change invalidates recovery metadata until its own running record arrives', async (t) => {
  const h = await fixture(t);
  const { handle } = await h.manager.spawn(randomUUID()); h.publish(handle);
  const file = join(h.directory, 'old.jsonl'); await writeFile(file, '{}\n');
  await mkdir(join(h.directory, 'running'));
  const record = { ...h.live[0], sessionFile: file, identity: 'old-identity' };
  await writeFile(join(h.directory, 'running', '9001.json'), JSON.stringify(record));
  await h.manager.reconcile();
  assert.equal(h.registry.data.entries[handle].sessionFile, file);
  h.live[0].sessionId = 'replacement-conversation';
  await h.manager.reconcile();
  assert.equal(h.registry.data.entries[handle].sessionFile, undefined);
  h.live.length = 0; h.panes.clear(); h.alive.clear();
  const stopped = (await h.manager.snapshot()).stopped.find((e) => e.handle === handle);
  assert.equal(stopped.restorable, false, 'The old history must never be restored as the replacement conversation');
});

test('failed durable writes stop lifecycle actions until recovery, before launching or closing a worker', async (t) => {
  for (const action of ['spawn', 'close']) {
    const h = await fixture(t);
    const { handle } = await h.manager.spawn(randomUUID()); h.publish(handle);
    const entry = (await h.manager.snapshot()).sessions[0];
    let shutdowns = 0; h.client.request = async () => { shutdowns++; };
    const calls = h.calls;
    h.registry.save = async () => { throw new Error('disk full'); };
    const id = randomUUID();
    await assert.rejects(action === 'spawn' ? h.manager.spawn(id) : h.manager.close(handle, entry));
    await assert.rejects(h.manager.reconcile(), { status: 503 });
    await assert.rejects(h.manager.spawn(id), { status: 503 });
    assert.equal(h.calls, calls);
    assert.equal(shutdowns, 0);
    await h.restart();
    assert.equal((await h.manager.snapshot()).sessions.length, 1);
    assert.equal(h.registry.data.entries[handle].status, 'ready');
  }
});
