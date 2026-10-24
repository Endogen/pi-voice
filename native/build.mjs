import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir, copyFile, access, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';

// Fail a native build if the executable request-boundary regression checks fail.
await import('./test-policy.mjs');

const exec = promisify(execFile);
const root = fileURLToPath(new URL('./', import.meta.url));
const out = join(root, 'out');
const platform = process.env.ANDROID_JAR || join(root, 'tools/android.jar');
const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
const tool = (name) => join(prefix, 'bin', name);
const run = async (name, args, cwd = root) => {
  try {
    const result = await exec(tool(name), args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    // Never echo exec's command string: future tool arguments might be private.
    throw new Error(`${name} failed. ${error.stderr || 'Check installed build tools and native/README.md.'}`);
  }
};
async function files(directory, suffix) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path, suffix));
    else if (entry.name.endsWith(suffix)) result.push(path);
  }
  return result;
}

await access(platform).catch(() => { throw new Error('Missing native/tools/android.jar. See native/README.md for the official SDK download.'); });
for (const directory of ['out/gen', 'out/classes', 'out/dex']) await rm(join(root, directory), { recursive: true, force: true });
for (const directory of ['out', 'out/gen', 'out/classes', 'out/dex', 'res/drawable']) await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
await copyFile(new URL('../public/icon-192.png', import.meta.url), join(root, 'res/drawable/icon.png'));
await chmod(join(root, 'host.sh'), 0o700);
await run('aapt', ['package', '-f', '-m', '-M', join(root, 'AndroidManifest.xml'), '-S', join(root, 'res'), '-I', platform, '-J', join(out, 'gen'), '-F', join(out, 'resources.apk'), '-0', 'arsc']);
await run('javac', ['--release', '8', '-classpath', platform, '-d', join(out, 'classes'), ...await files(join(root, 'java'), '.java'), ...await files(join(out, 'gen'), '.java')]);
await run('d8', ['--lib', platform, '--min-api', '26', '--output', join(out, 'dex'), ...await files(join(out, 'classes'), '.class')]);
await copyFile(join(out, 'resources.apk'), join(out, 'unsigned.apk'));
await run('aapt', ['add', join(out, 'unsigned.apk'), 'classes.dex'], join(out, 'dex'));
await run('zipalign', ['-f', '4', join(out, 'unsigned.apk'), join(out, 'aligned.apk')]);

const signing = join(homedir(), '.pi/agent/voice-native-signing');
await mkdir(signing, { recursive: true, mode: 0o700 });
await chmod(signing, 0o700);
const password = join(signing, 'password.txt');
try { await writeFile(password, randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
await chmod(password, 0o600);
const key = join(signing, 'keystore.p12');
try { await access(key); }
catch {
  await run('keytool', ['-genkeypair', '-alias', 'pi-voice', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Pi Voice local build', '-storetype', 'PKCS12', '-keystore', key, '-storepass:file', password, '-keypass:file', password]);
}
await chmod(key, 0o600);
const apk = join(out, 'pi-voice-native.apk');
await run('apksigner', ['sign', '--ks', key, '--ks-key-alias', 'pi-voice', '--ks-pass', `file:${password}`, '--out', apk, join(out, 'aligned.apk')]);
await run('apksigner', ['verify', '--verbose', '--print-certs', apk]);
await run('zipalign', ['-c', '4', apk]);
await chmod(apk, 0o600);
const digest = createHash('sha256').update(await readFile(apk)).digest('hex');
await writeFile(join(out, 'pi-voice-native.apk.sha256'), `${digest}  pi-voice-native.apk\n`, { mode: 0o600 });
console.log(`\nBuilt ${apk}\nSHA-256: ${digest}\nExisting shortcuts and Termux security settings were not changed.`);
