// Executable Java checks without an emulator or Android runtime. Requires JDK 21.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'pi-voice-java-policy-'));
try {
  const java = (path) => fileURLToPath(new URL(path, import.meta.url));
  await exec('javac', ['--release', '8', '-d', directory,
    java('java/com/pivoice/app/RequestPolicy.java'), java('test/com/pivoice/app/RequestPolicyChecks.java'),
    java('java/com/pivoice/app/TerminalTarget.java'), java('test/com/pivoice/app/TerminalTargetChecks.java')], { timeout: 30000 });
  for (const checks of ['RequestPolicyChecks', 'TerminalTargetChecks']) {
    const { stdout } = await exec('java', ['-cp', directory, `com.pivoice.app.${checks}`], { timeout: 15000 });
    console.log(stdout.trim());
  }
} finally { await rm(directory, { recursive: true, force: true }); }
