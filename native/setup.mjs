import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function enableExternalApps(contents) {
  const property = /^[\t ]*allow-external-apps[\t ]*=.*$/gm;
  if (property.test(contents)) return contents.replace(property, 'allow-external-apps=true');
  return `${contents}${contents.endsWith('\n') || !contents ? '' : '\n'}\n# Pi Voice: only apps granted RUN_COMMAND may execute in Termux.\nallow-external-apps=true\n`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--enable', '--install'].includes(arg))) throw new Error('Usage: node native/setup.mjs [--enable] [--install]');
  const directory = join(homedir(), '.termux');
  const path = join(directory, 'termux.properties');
  const contents = await readFile(path, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  const exec = promisify(execFile);
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
  if (args.includes('--enable')) {
    const next = enableExternalApps(contents);
    if (next !== contents) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const backup = `${path}.before-pi-voice-native-${Date.now()}`;
      await writeFile(backup, contents, { flag: 'wx', mode: 0o600 });
      await writeFile(path, next, { mode: 0o600 });
      await chmod(path, 0o600);
      console.log(`Enabled allow-external-apps=true. Previous settings backed up to ${backup}.`);
    } else console.log('allow-external-apps=true was already enabled.');
    await exec(join(prefix, 'bin/termux-reload-settings'), []).catch(() => console.log('Reopen Termux once to reload its settings.'));
    console.log('This enables the Termux external-command interface. Only grant RUN_COMMAND to trusted apps: it is a broad shell permission.');
  } else {
    const value = [...contents.matchAll(/^[\t ]*allow-external-apps[\t ]*=[\t ]*([^\r\n]*)/gm)].at(-1)?.[1].trim();
    console.log(`Termux external commands: ${value === 'true' ? 'enabled' : 'disabled/default'}. Settings were not changed.`);
    console.log('To enable the required interface explicitly: node native/setup.mjs --enable');
  }
  if (args.includes('--install')) {
    const apk = fileURLToPath(new URL('out/pi-voice.apk', import.meta.url));
    await readFile(apk).catch(() => { throw new Error('Build the APK first: npm run build:native'); });
    await exec(join(prefix, 'bin/termux-open'), ['--view', '--content-type', 'application/vnd.android.package-archive', apk]);
    console.log('Opened the Android installer. Approve installation, then open Pi Voice and grant Run commands in Termux.');
  }
  console.log('Saved Pi sessions are unchanged.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
