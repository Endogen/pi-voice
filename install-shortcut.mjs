import { mkdir, chmod, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const projectDir = fileURLToPath(new URL('.', import.meta.url));
const marker = '# Managed by Pi Voice: install-shortcut.mjs';
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

export async function installShortcut({ home = homedir(), prefix = process.env.PREFIX || '/data/data/com.termux/files/usr' } = {}) {
  const shortcuts = join(home, '.shortcuts');
  const icons = join(shortcuts, 'icons');
  await mkdir(icons, { recursive: true, mode: 0o700 });
  await chmod(shortcuts, 0o700);
  await chmod(icons, 0o700);
  const script = join(shortcuts, 'Pi Voice');
  const content = `#!${join(prefix, 'bin', 'bash')}
${marker}
# Widget commands do not source ~/.profile or fully initialise Termux's env.
export HOME=${quote(home)}
export PREFIX=${quote(prefix)}
export PATH="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin:$HOME/.local/bin:$PREFIX/bin:\${PATH:-}"
# Required by Pi's /bin/sh and /usr/bin/env shebangs in a cold plugin launch.
export LD_PRELOAD="$PREFIX/lib/libtermux-exec.so\${LD_PRELOAD:+:$LD_PRELOAD}"
cd "$HOME" || exit 1
"$PREFIX/bin/node" ${quote(join(projectDir, 'launch.mjs'))} --app
status=$?
if [ "$status" -ne 0 ]; then
  printf '\\nPi Voice could not open. See the error above. Press Enter to close.\\n'
  read -r ignored
fi
exit "$status"
`;
  try {
    await writeFile(script, content, { flag: 'wx', mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = await readFile(script, 'utf8');
    if (!current.includes(`\n${marker}\n`)) throw new Error(`Refusing to replace your existing shortcut: ${script}`);
    await writeFile(script, content, { mode: 0o700 });
  }
  await chmod(script, 0o700);
  const icon = join(icons, 'Pi Voice.png');
  await writeFile(icon, await readFile(join(projectDir, 'public', 'icon-192.png')), { mode: 0o600 });
  await chmod(icon, 0o600);
  return { script, icon };
}

// Open the plugin's official single-script picker. Only Android/the launcher
// can confirm pinning; successfully starting this activity is not proof of that.
export async function openShortcutPicker({ run = promisify(execFile) } = {}) {
  const user = String(Math.floor(process.getuid() / 100000));
  const { stdout = '', stderr = '' } = await run('am', [
    'start', '--user', user, '-n', 'com.termux.widget/.TermuxCreateShortcutActivity',
  ], { timeout: 15000, maxBuffer: 128 * 1024 });
  // Some Android am implementations print errors without a nonzero exit code.
  if (/\b(?:error|[\w.$]*exception|permission denial)\b/i.test(`${stdout}\n${stderr}`)) {
    throw new Error(`Android could not open the shortcut picker: ${`${stdout}\n${stderr}`.trim()}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--pin') || args.length > 1) {
    console.error('Usage: node install-shortcut.mjs [--pin]');
    process.exit(1);
  }
  const { script } = await installShortcut();
  console.log(`Installed ${script}

One-time Android setup:
1. Install Termux:Widget from the SAME source as Termux (GitHub / F-Droid).
   GitHub: https://github.com/termux/termux-widget/releases
2. Run pi-voice --pin, select "Pi Voice", then approve Android's Add prompt.
   This creates a SINGLE microphone icon, not the large Termux list widget.
   Your launcher may add a small Termux badge; this is still a shortcut,
   not a separately installed app in the app drawer.
3. After testing the new icon, remove the old list widget/Chrome-only shortcut
   from the home screen. Keep Termux and Termux:Widget installed.
4. If Android blocks foreground startup, allow Termux "Display over other apps".

Use this launcher instead of the Chrome-only shortcut. It opens a running Pi,
or resumes the most recent saved session in your home directory with pi -c.
No running shell or Pi is required before tapping it; Termux stays installed.
Keep Termux battery/background activity unrestricted for ongoing availability.`);
  if (args.includes('--pin')) {
    try {
      await openShortcutPicker();
      console.log('\nOpened the shortcut picker. Choose "Pi Voice", then confirm Add.');
    } catch (error) {
      console.error(`${error.message}\nInstall/open Termux:Widget, then retry pi-voice --pin.`);
      process.exitCode = 1;
    }
  }
}
