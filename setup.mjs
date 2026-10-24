import { access, chmod, lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const marker = '// Managed by Pi Voice: setup.mjs';
const legacy = '// Local mobile speech interface. Source and tests: ~/pi-voice/\nexport { default } from "../../../pi-voice/extension.mjs";\n';
const exists = async (path) => lstat(path).catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });

// Register this checkout; never install Pi, edit credentials, enable Android
// external commands or open Android UI. Refuse unrelated existing files.
export async function setupPiVoice({ home = homedir(), agentDir = process.env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), projectDir = root } = {}) {
  const extensionSource = resolve(projectDir, 'extension.mjs');
  const launcher = resolve(projectDir, 'launch.mjs');
  await Promise.all([access(extensionSource), access(launcher)]);
  const extension = join(agentDir, 'extensions', 'pi-voice.ts');
  const links = [...new Set([join(agentDir, 'bin', 'pi-voice'), join(home, '.local', 'bin', 'pi-voice')])];
  const extensionStat = await exists(extension);
  if (extensionStat) {
    if (!extensionStat.isFile()) throw new Error(`Refusing to replace a non-file extension: ${extension}`);
    const current = await readFile(extension, 'utf8');
    const sameLegacy = current === legacy && resolve(dirname(extension), '../../../pi-voice/extension.mjs') === extensionSource;
    if (!current.startsWith(`${marker}\n`) && !sameLegacy) throw new Error(`Refusing to replace your existing extension: ${extension}`);
  }
  for (const link of links) {
    const info = await exists(link);
    if (info && (!info.isSymbolicLink() || resolve(dirname(link), await readlink(link)) !== launcher)) {
      throw new Error(`Refusing to replace your existing launcher: ${link}`);
    }
  }
  // Preflight is complete, so an unrelated file cannot cause a half-install.
  await mkdir(dirname(extension), { recursive: true, mode: 0o700 });
  await writeFile(extension, `${marker}\nexport { default } from ${JSON.stringify(extensionSource)};\n`, {
    mode: 0o600, flag: extensionStat ? 'w' : 'wx',
  });
  await chmod(extension, 0o600);
  await chmod(launcher, 0o700);
  for (const link of links) {
    await mkdir(dirname(link), { recursive: true, mode: 0o700 });
    if (!await exists(link)) await symlink(launcher, link);
  }
  return { extension, links };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node setup.mjs');
    const result = await setupPiVoice();
    console.log(`Registered ${result.extension}\nLauncher links:\n${result.links.join('\n')}`);
    console.log('Keep this checkout in place. Pi must already be installed/configured.');
    console.log('Ensure ~/.local/bin or your Pi agent bin directory is on PATH. Restart Pi, then use /voice.');
    console.log('Optional home icon: pi-voice --pin. Native setup is separate: see native/README.md.');
    console.log('No credentials, Termux permissions, Android apps or existing home-screen icons were changed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
