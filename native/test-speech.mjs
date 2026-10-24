// Executable native speech text checks without an Android runtime. Requires JDK.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'pi-voice-java-speech-'));
try {
  const java = (path) => fileURLToPath(new URL(path, import.meta.url));
  await exec('javac', ['--release', '8', '-d', directory,
    java('java/com/pivoice/app/SpeechText.java'), java('test/com/pivoice/app/SpeechTextChecks.java')], { timeout: 30000 });
  const { stdout } = await exec('java', ['-cp', directory, 'com.pivoice.app.SpeechTextChecks'], { timeout: 15000 });
  console.log(stdout.trim());
} finally { await rm(directory, { recursive: true, force: true }); }
