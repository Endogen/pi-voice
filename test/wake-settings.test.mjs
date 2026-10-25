import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWakeSettings } from '../wake-settings.mjs';

test('the backend remembers enabled and disabled wake preferences across cold starts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-voice-wake-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await createWakeSettings(directory, true).load(), true);
  assert.equal(await createWakeSettings(directory, false).load(), false, 'Desktop integration tests never acquire a real lock by default');
  for (const enabled of [false, true]) {
    await createWakeSettings(directory).save(enabled);
    assert.equal(await createWakeSettings(directory, !enabled).load(), enabled);
    assert.equal((await stat(join(directory, 'wake-settings.json'))).mode & 0o777, 0o600);
  }
  await writeFile(join(directory, 'wake-settings.json'), '{}');
  await assert.rejects(createWakeSettings(directory).load(), /Could not read/);
});
