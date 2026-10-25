import { chmod, lstat, mkdir, readFile, readlink, rm, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const marker = '// Managed by Pi Voice: setup.mjs';
const legacy = '// Local mobile speech interface. Source and tests: ~/pi-voice/\nexport { default } from "../../../pi-voice/extension.mjs";\n';
const shortcutMarker = '# Managed by Pi Voice: install-shortcut.mjs';
const exists = async (path) => lstat(path).catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });

// Earlier versions installed a `pi-voice` command and a Termux:Widget shortcut.
// Remove only what they created: links into this checkout and the marked script.
async function removeOldLaunchers({ home, agentDir, projectDir }) {
  const removed = [];
  for (const link of new Set([join(agentDir, 'bin', 'pi-voice'), join(home, '.local', 'bin', 'pi-voice')])) {
    const info = await exists(link);
    if (info?.isSymbolicLink() && resolve(dirname(link), await readlink(link)) === resolve(projectDir, 'launch.mjs')) {
      await rm(link);
      removed.push(link);
    }
  }
  const script = join(home, '.shortcuts', 'Pi Voice');
  const info = await exists(script);
  if (info?.isFile() && (await readFile(script, 'utf8')).includes(`\n${shortcutMarker}\n`)) {
    await rm(script);
    removed.push(script);
    const icon = join(home, '.shortcuts', 'icons', 'Pi Voice.png');
    if ((await exists(icon))?.isFile()) { await rm(icon); removed.push(icon); }
  }
  return removed;
}

// Register this checkout as a Pi extension; never install Pi, edit credentials,
// enable Android external commands or open Android UI. Refuse unrelated files.
export async function setupPiVoice({ home = homedir(), agentDir = process.env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), projectDir = root } = {}) {
  const extensionSource = resolve(projectDir, 'extension.mjs');
  await access(extensionSource);
  const extension = join(agentDir, 'extensions', 'pi-voice.ts');
  const extensionStat = await exists(extension);
  if (extensionStat) {
    if (!extensionStat.isFile()) throw new Error(`Refusing to replace a non-file extension: ${extension}`);
    const current = await readFile(extension, 'utf8');
    const sameLegacy = current === legacy && resolve(dirname(extension), '../../../pi-voice/extension.mjs') === extensionSource;
    if (!current.startsWith(`${marker}\n`) && !sameLegacy) throw new Error(`Refusing to replace your existing extension: ${extension}`);
  }
  await mkdir(dirname(extension), { recursive: true, mode: 0o700 });
  await writeFile(extension, `${marker}\nexport { default } from ${JSON.stringify(extensionSource)};\n`, {
    mode: 0o600, flag: extensionStat ? 'w' : 'wx',
  });
  await chmod(extension, 0o600);
  return { extension, removed: await removeOldLaunchers({ home, agentDir, projectDir }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node setup.mjs');
    const result = await setupPiVoice();
    console.log(`Registered ${result.extension}`);
    if (result.removed.length) console.log(`Removed old launchers:\n${result.removed.join('\n')}\nRemove the old Pi Voice shortcut icon from your home screen.`);
    console.log('Keep this checkout in place. Pi must already be installed/configured.');
    console.log('Next: install the Pi Voice app (see README.md). No credentials, Termux permissions or Android apps were changed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
