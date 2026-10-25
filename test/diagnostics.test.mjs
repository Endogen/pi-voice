import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiServer } from '../transport.mjs';
import { atomicJSON } from '../storage.mjs';
import { collectDiagnostics } from '../diagnostics.mjs';

test('diagnostics identify process continuity and failed turns without leaking conversations or credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-voice-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await collectDiagnostics(directory)).hostReachable, false);
  const token = 'a'.repeat(64);
  const health = { role: 'host', protocolVersion: 1, pid: process.pid, instanceId: 'host-instance' };
  const worker = { handle: 'test-session', pid: 101, instanceId: 'worker-instance', status: 'ready', title: 'PRIVATE', cwd: '/PRIVATE' };
  const server = await createApiServer({ token, handle: ({ req, path, send }) => {
    assert.equal(req.method, 'GET');
    send(200, path === '/api/health' ? health : path === '/api/sessions' ? { sessions: [worker], stopped: [] }
      : { ...worker, busy: false, wakeLock: { active: true }, messages: [{ role: 'assistant', text: 'PRIVATE', stopReason: 'error', error: 'PRIVATE' }] });
  } });
  t.after(() => server.close());
  await writeFile(join(directory, 'token'), token);
  await atomicJSON(join(directory, 'host-endpoint.json'), { ...health, origin: server.origin });
  const report = await collectDiagnostics(directory);
  assert.equal(report.selected.instanceId, 'worker-instance');
  assert.equal(report.selected.lastReplyOutcome, 'error');
  assert.equal(report.selected.wakeLockRequested, true);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(report).includes(token), false);
});
