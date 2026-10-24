import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setupPiVoice } from '../setup.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-voice-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home with 'quotes'");
  const projectDir = join(home, 'pi-voice');
  const agentDir = join(home, '.pi', 'agent');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'extension.mjs'), 'export default function() {}\n');
  await writeFile(join(projectDir, 'launch.mjs'), '#!/usr/bin/env node\n');
  return { home, projectDir, agentDir };
}

test('fresh-checkout setup registers the extension and executable launcher, supports spaces and is idempotent', async (t) => {
  const h = await fixture(t);
  const result = await setupPiVoice(h);
  const entry = await readFile(result.extension, 'utf8');
  assert.ok(entry.includes(`from ${JSON.stringify(join(h.projectDir, 'extension.mjs'))};`));
  assert.equal((await stat(result.extension)).mode & 0o777, 0o600);
  assert.equal((await stat(join(h.projectDir, 'launch.mjs'))).mode & 0o777, 0o700);
  for (const link of result.links) assert.equal(await readlink(link), join(h.projectDir, 'launch.mjs'));
  assert.deepEqual(await setupPiVoice(h), result);
});

test('setup refuses unrelated extensions without creating launcher links', async (t) => {
  const h = await fixture(t);
  const extension = join(h.agentDir, 'extensions', 'pi-voice.ts');
  await mkdir(dirname(extension), { recursive: true });
  await writeFile(extension, '// my own extension\n');
  await assert.rejects(setupPiVoice(h), /Refusing to replace your existing extension/);
  assert.equal(await readFile(extension, 'utf8'), '// my own extension\n');
  await assert.rejects(access(join(h.home, '.local', 'bin', 'pi-voice')));
});

test('setup preflights existing launcher files and foreign symlinks before writing the extension', async (t) => {
  const h = await fixture(t);
  const link = join(h.agentDir, 'bin', 'pi-voice');
  await mkdir(dirname(link), { recursive: true });
  await symlink(join(h.home, 'other-project', 'launch.mjs'), link);
  await assert.rejects(setupPiVoice(h), /Refusing to replace your existing launcher/);
  await assert.rejects(access(join(h.agentDir, 'extensions', 'pi-voice.ts')));
  await rm(link);
  await writeFile(link, 'unrelated command');
  await assert.rejects(setupPiVoice(h), /Refusing to replace your existing launcher/);
  assert.equal(await readFile(link, 'utf8'), 'unrelated command');
});

test('setup recognizes only the matching legacy local registration', async (t) => {
  const h = await fixture(t);
  const path = join(h.agentDir, 'extensions', 'pi-voice.ts');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '// Local mobile speech interface. Source and tests: ~/pi-voice/\nexport { default } from "../../../pi-voice/extension.mjs";\n');
  await setupPiVoice(h);
  assert.match(await readFile(path, 'utf8'), /^\/\/ Managed by Pi Voice: setup.mjs\n/);
});
