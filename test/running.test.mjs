import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alive, removeRecord, stoppedRecords, writeRecord } from '../running.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-voice-running-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  await mkdir(project);
  const file = (name) => { const path = join(directory, `${name}.jsonl`); return writeFile(path, '{}\n').then(() => path); };
  return { directory, project, file };
}

test('stopped records are newest first, skip live PIDs and drop unusable entries', async (t) => {
  const h = await fixture(t);
  const isAlive = (pid) => pid === 7;
  await writeRecord(h.directory, { pid: 5, sessionFile: await h.file('a'), cwd: h.project, title: 'Older' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeRecord(h.directory, { pid: 6, sessionFile: await h.file('b'), cwd: h.project, title: 'Newer', spawned: true });
  await writeRecord(h.directory, { pid: 7, sessionFile: await h.file('c'), cwd: h.project, title: 'Still running' });
  await writeRecord(h.directory, { pid: 8, sessionFile: undefined, cwd: h.project, title: 'Ephemeral --no-session' });
  await writeRecord(h.directory, { pid: 9, sessionFile: join(h.directory, 'deleted.jsonl'), cwd: h.project });
  await writeRecord(h.directory, { pid: 10, sessionFile: 'relative.jsonl', cwd: h.project });
  await writeFile(join(h.directory, 'running', '11.json'), '{ broken');
  const stopped = await stoppedRecords(h.directory, { isAlive });
  assert.deepEqual(stopped.map((record) => record.title), ['Newer', 'Older']);
  assert.deepEqual((await readdir(join(h.directory, 'running'))).sort(), ['5.json', '6.json', '7.json'], 'Unusable records are removed');
  await removeRecord(h.directory, 6);
  await removeRecord(h.directory, '../7');
  assert.deepEqual((await readdir(join(h.directory, 'running'))).sort(), ['5.json', '7.json']);
});

test('a replaced PID is no longer offered for restore once another live Pi records the same conversation', async (t) => {
  const h = await fixture(t);
  const sessionFile = await h.file('resumed');
  await writeRecord(h.directory, { pid: 5, sessionFile, cwd: h.project, title: 'Stopped' });
  assert.deepEqual((await stoppedRecords(h.directory, { isAlive: () => false })).map((record) => record.pid), [5], 'Keep recovery until the replacement actually records its session');
  await writeRecord(h.directory, { pid: 7, sessionFile, cwd: h.project, title: 'Resumed' });
  assert.deepEqual(await stoppedRecords(h.directory, { isAlive: (pid) => pid === 7 }), []);
  assert.deepEqual(await readdir(join(h.directory, 'running')), ['7.json']);
});

test('a PID now owned by another app or a newer process does not count as our Pi', async () => {
  assert.equal(await alive(process.pid), true);
  assert.equal(await alive(1), false, 'EPERM: another user owns PID 1, so it is not a Pi we started');
  assert.equal(await alive(2147480002), false);
  // Linux/Android: a recorded start identity that no longer matches means reuse.
  const { processIdentity } = await import('../wake-lock.mjs');
  if (await processIdentity(process.pid)) assert.equal(await alive(process.pid, { identity: 'other-boot:1' }), false);
});
