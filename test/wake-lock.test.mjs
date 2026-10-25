import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWakeLock } from '../wake-lock.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-voice-wake-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const pids = new Set([101, 102, 103]);
  const environment = {
    directory,
    alive: (pid) => pids.has(pid),
    identity: async (pid) => `boot:start-${pid}`,
    run: async (command) => { calls.push(command); },
  };
  return { directory, calls, pids, session: (pid, extra) => createWakeLock({ ...environment, pid, ...extra }) };
}

test('wake lock is acquired only on request, idempotent, privately recorded and released on close', async (t) => {
  const h = await setup(t);
  const session = h.session(101);
  assert.deepEqual(session.status(), { active: false, shared: false, error: null });
  await session.close();
  assert.deepEqual(h.calls, []);
  await session.setEnabled(true);
  await session.setEnabled(true);
  assert.deepEqual(h.calls, ['termux-wake-lock']);
  assert.equal(session.status().active, true);
  const file = join(h.directory, '101.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).identity, 'boot:start-101');
  await session.close();
  await session.close();
  assert.deepEqual(h.calls, ['termux-wake-lock', 'termux-wake-unlock']);
  assert.deepEqual(await readdir(h.directory), []);
});

test('closing one voice session does not unlock another active voice session', async (t) => {
  const h = await setup(t);
  const one = h.session(101);
  const two = h.session(102);
  await Promise.all([one.setEnabled(true), two.setEnabled(true)]);
  assert.deepEqual(h.calls, ['termux-wake-lock', 'termux-wake-lock']);
  await one.close();
  assert.equal(one.status().shared, true);
  assert.equal(two.status().active, true);
  assert.equal(h.calls.includes('termux-wake-unlock'), false);
  await two.close();
  assert.equal(h.calls.at(-1), 'termux-wake-unlock');
  assert.deepEqual(await readdir(h.directory), []);
});

test('dead-session leases are pruned rather than keeping the device awake forever', async (t) => {
  const h = await setup(t);
  await writeFile(join(h.directory, '999.json'), JSON.stringify({ identity: 'old' }));
  const session = h.session(101);
  await session.setEnabled(true);
  assert.equal((await readdir(h.directory)).includes('999.json'), false);
  await session.close();
  assert.equal(h.calls.at(-1), 'termux-wake-unlock');
});

test('a reused PID with a different process start identity does not retain a stale lease', async (t) => {
  const h = await setup(t);
  await writeFile(join(h.directory, '102.json'), JSON.stringify({ identity: 'previous-boot:old-start' }));
  const session = h.session(101);
  await session.setEnabled(true);
  assert.equal(session.status().shared, false);
  await session.close();
  assert.equal(h.calls.at(-1), 'termux-wake-unlock');
});

test('failed acquisition is reported, records no lease and can be retried', async (t) => {
  const h = await setup(t);
  let fail = true;
  const session = h.session(101, { run: async (command) => {
    h.calls.push(command);
    if (fail) throw new Error('Android denied service');
  } });
  await assert.rejects(session.setEnabled(true), /Android denied service/);
  assert.equal(session.status().active, false);
  assert.equal(session.status().error, 'Android denied service');
  assert.deepEqual(await readdir(h.directory), []);
  await session.setEnabled(false);
  assert.equal(session.status().error, null, 'opting out clears an obsolete acquisition error');
  fail = false;
  await session.setEnabled(true);
  assert.equal(session.status().active, true);
  assert.equal(session.status().error, null);
  await session.close();
});

test('failed release preserves the lease and active state for a later retry', async (t) => {
  const h = await setup(t);
  let failUnlock = true;
  const session = h.session(101, { run: async (command) => {
    if (command === 'termux-wake-unlock' && failUnlock) throw new Error('Unlock failed');
    h.calls.push(command);
  } });
  await session.setEnabled(true);
  await assert.rejects(session.close(), /Unlock failed/);
  assert.equal(session.status().active, true);
  assert.ok((await readdir(h.directory)).includes('101.json'));
  failUnlock = false;
  await session.close();
  assert.equal(session.status().active, false);
  assert.deepEqual(await readdir(h.directory), []);
});

test('dead guard owners are recovered after interrupted wake-lock management', async (t) => {
  const h = await setup(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(h.directory, '.guard'));
  await writeFile(join(h.directory, '.guard', 'owner'), '999');
  const session = h.session(101);
  await session.setEnabled(true);
  assert.equal(session.status().active, true);
  await session.close();
});

test('rapid enable/disable requests are serialized within a session', async (t) => {
  const h = await setup(t);
  const session = h.session(101);
  await Promise.all([session.setEnabled(true), session.setEnabled(false), session.setEnabled(true)]);
  assert.deepEqual(h.calls, ['termux-wake-lock', 'termux-wake-unlock', 'termux-wake-lock']);
  assert.equal(session.status().active, true);
  await session.close();
});

test('starting work can reassert a lost Android lock without disturbing other leases', async (t) => {
  const h = await setup(t);
  const one = h.session(101), two = h.session(102);
  await one.setEnabled(true); await two.setEnabled(true);
  await one.setEnabled(true, { refresh: true });
  assert.deepEqual(h.calls, ['termux-wake-lock', 'termux-wake-lock', 'termux-wake-lock']);
  await one.close();
  assert.equal(h.calls.includes('termux-wake-unlock'), false);
  await two.close();
  assert.equal(h.calls.at(-1), 'termux-wake-unlock');
});
