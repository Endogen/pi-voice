import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeRecord, stoppedRecords, writeRecord } from '../running.mjs';
import { launchPlan } from '../native/host.mjs';

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

test('the native host resumes the latest stopped main session in its folder, else continues in home', async (t) => {
  const h = await fixture(t);
  const isAlive = () => false;
  assert.deepEqual(await launchPlan({ directory: h.directory, cwd: '/home', isAlive }), { cwd: '/home', args: ['-c'], stale: [] });
  const older = await h.file('older');
  const newer = await h.file('newer');
  await writeRecord(h.directory, { pid: 21, sessionFile: older, cwd: h.directory });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeRecord(h.directory, { pid: 22, sessionFile: newer, cwd: h.project });
  await writeRecord(h.directory, { pid: 23, sessionFile: await h.file('parallel'), cwd: h.project, spawned: true });
  const plan = await launchPlan({ directory: h.directory, cwd: '/home', isAlive });
  assert.deepEqual([plan.cwd, plan.args], [h.project, ['--session', newer]]);
  assert.deepEqual(plan.stale.map((record) => record.pid), [22, 21], 'Parallel sessions are left for the app to offer');
  assert.deepEqual((await launchPlan({ directory: h.directory, args: ['--offline'], isAlive })).args, ['--offline'], 'Explicit arguments win');
});
