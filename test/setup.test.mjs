import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, access, readlink } from 'node:fs/promises';
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
  return { home, projectDir, agentDir };
}

test('fresh-checkout setup registers the extension, supports spaces and is idempotent', async (t) => {
  const h = await fixture(t);
  const result = await setupPiVoice(h);
  const entry = await readFile(result.extension, 'utf8');
  assert.ok(entry.includes(`from ${JSON.stringify(join(h.projectDir, 'extension.mjs'))};`));
  assert.equal((await stat(result.extension)).mode & 0o777, 0o600);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(await setupPiVoice(h), result);
});

test('setup refuses unrelated extensions', async (t) => {
  const h = await fixture(t);
  const extension = join(h.agentDir, 'extensions', 'pi-voice.ts');
  await mkdir(dirname(extension), { recursive: true });
  await writeFile(extension, '// my own extension\n');
  await assert.rejects(setupPiVoice(h), /Refusing to replace your existing extension/);
  assert.equal(await readFile(extension, 'utf8'), '// my own extension\n');
});

test('setup removes only the launchers earlier versions created', async (t) => {
  const h = await fixture(t);
  const ours = join(h.agentDir, 'bin', 'pi-voice');
  const foreign = join(h.home, '.local', 'bin', 'pi-voice');
  await mkdir(dirname(ours), { recursive: true });
  await mkdir(dirname(foreign), { recursive: true });
  await symlink(join(h.projectDir, 'launch.mjs'), ours);
  await symlink(join(h.home, 'other-project', 'launch.mjs'), foreign);
  const script = join(h.home, '.shortcuts', 'Pi Voice');
  const icon = join(h.home, '.shortcuts', 'icons', 'Pi Voice.png');
  await mkdir(dirname(icon), { recursive: true });
  await writeFile(script, '#!/bin/bash\n# Managed by Pi Voice: install-shortcut.mjs\nexec node launch.mjs --app\n');
  await writeFile(icon, 'png');
  const own = join(h.home, '.shortcuts', 'My script');
  await writeFile(own, '#!/bin/bash\necho mine\n');
  const result = await setupPiVoice(h);
  assert.deepEqual(result.removed, [ours, script, icon]);
  await assert.rejects(access(ours));
  assert.equal(await readlink(foreign), join(h.home, 'other-project', 'launch.mjs'), 'Foreign links stay');
  assert.equal(await readFile(own, 'utf8'), '#!/bin/bash\necho mine\n', 'Unrelated shortcuts stay');
  await rm(foreign);
  await writeFile(script, '#!/bin/bash\necho a user script with our name\n');
  assert.deepEqual((await setupPiVoice(h)).removed, [], 'Unmarked scripts stay');
});

test('setup recognizes only the matching legacy local registration', async (t) => {
  const h = await fixture(t);
  const path = join(h.agentDir, 'extensions', 'pi-voice.ts');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '// Local mobile speech interface. Source and tests: ~/pi-voice/\nexport { default } from "../../../pi-voice/extension.mjs";\n');
  await setupPiVoice(h);
  assert.match(await readFile(path, 'utf8'), /^\/\/ Managed by Pi Voice: setup.mjs\n/);
});
