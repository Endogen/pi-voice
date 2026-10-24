import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { installShortcut, openShortcutPicker } from '../install-shortcut.mjs';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../launch.mjs', import.meta.url));
const prefix = process.env.PREFIX || '/usr';
const flock = await exec('sh', ['-c', 'command -v flock']).then(({ stdout }) => stdout.trim(), () => undefined);
const bash = await exec('sh', ['-c', 'command -v bash']).then(({ stdout }) => stdout.trim());
const needsFlock = { skip: !flock && 'Requires util-linux flock (available in Termux/Linux).' };

async function fixture(t, fakePi) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-voice-app-launch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  if (flock) await symlink(flock, join(bin, 'flock'));
  await symlink(bash, join(bin, 'bash'));
  await symlink(process.execPath, join(bin, 'node'));
  await writeFile(join(bin, 'pi'), `#!${process.execPath}\n${fakePi}`, { mode: 0o700 });
  await writeFile(join(bin, 'termux-open-url'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.OPENED, JSON.stringify(process.argv.slice(2)));`, { mode: 0o700 });
  const env = {
    ...process.env, PI_CODING_AGENT_DIR: directory, PREFIX: directory,
    PATH: `${bin}:${process.env.PATH}`, STARTED: join(directory, 'started'), OPENED: join(directory, 'opened'),
  };
  return { directory, env };
}

const recordPi = `require('node:fs').appendFileSync(process.env.STARTED, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\n`;

test('cold app launch resumes with -c; a leftover lock file is harmless; CLI modes stay separate', needsFlock, async (t) => {
  const { directory, env } = await fixture(t, recordPi);
  const voice = join(directory, 'voice');
  await mkdir(voice);
  await writeFile(join(voice, 'app-launch.lock'), 'stale file', { mode: 0o600 });
  await exec(process.execPath, [launcher, '--app'], { env, cwd: directory, timeout: 10000 });
  const launches = () => readFile(env.STARTED, 'utf8').then((text) => text.trim().split('\n').map(JSON.parse));
  assert.deepEqual(await launches(), [{ args: ['--voice-open', '-c'], cwd: directory }]);
  await exec(process.execPath, [launcher, '--new', '-c'], { env, cwd: directory, timeout: 10000 });
  await exec(process.execPath, [launcher], { env, cwd: directory, timeout: 10000 });
  assert.deepEqual((await launches()).map((item) => item.args), [
    ['--voice-open', '-c'], ['--voice-open', '-c'], ['--voice-open'],
  ]);
  await assert.rejects(exec(process.execPath, [launcher, '--app', '--new'], { env }), /Use pi-voice --app by itself/);
  assert.equal((await launches()).length, 3);
});

test('rapid home-screen taps start only one Pi and the other tap opens its bridge', needsFlock, async (t) => {
  const { env } = await fixture(t, recordPi + `
const fs = require('node:fs');
const path = require('node:path');
const token = 'b'.repeat(64);
const server = require('node:http').createServer((_request, response) => {
  response.end(JSON.stringify({ pid: process.pid, sessionId: 'resumed-session', cwd: process.cwd() }));
});
setTimeout(() => server.listen(0, '127.0.0.1', () => {
  const origin = 'http://127.0.0.1:' + server.address().port;
  const directory = path.join(process.env.PI_CODING_AGENT_DIR, 'voice', 'endpoints');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, process.pid + '.json'), JSON.stringify({ pid: process.pid, token, origin, url: origin + '/#token=' + token }));
  setTimeout(() => server.close(), 2500);
}), 600);
`);
  const first = exec(process.execPath, [launcher, '--app'], { env, timeout: 10000 });
  const deadline = Date.now() + 5000;
  while (!await stat(env.STARTED).catch(() => null)) {
    if (Date.now() > deadline) throw new Error('Fake Pi failed to start');
    await delay(25);
  }
  const second = exec(process.execPath, [launcher, '--app'], { env, timeout: 10000 });
  const [, result] = await Promise.all([first, second]);
  assert.match(result.stdout, /already starting/);
  assert.match(result.stdout, /Opening Pi Voice for resumed-/);
  assert.equal((await readFile(env.STARTED, 'utf8')).trim().split('\n').length, 1);
  assert.match(JSON.parse(await readFile(env.OPENED, 'utf8'))[0], /^http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64}$/);
});

test('failed app startup reports failure and releases its kernel lock for a retry', needsFlock, async (t) => {
  const { env } = await fixture(t, recordPi + 'process.exit(9);');
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(exec(process.execPath, [launcher, '--app'], { env, timeout: 10000 }), (error) => {
      assert.equal(error.code, 9);
      return true;
    });
  }
  assert.equal((await readFile(env.STARTED, 'utf8')).trim().split('\n').length, 2);
});

test('single-icon picker uses the official activity without a shell and catches Android printed errors', async () => {
  const calls = [];
  await openShortcutPicker({ run: async (...args) => { calls.push(args); return { stdout: 'Starting: Intent { cmp=com.termux.widget/.TermuxCreateShortcutActivity }' }; } });
  assert.deepEqual(calls, [['am', ['start', '--user', String(Math.floor(process.getuid() / 100000)), '-n', 'com.termux.widget/.TermuxCreateShortcutActivity'], { timeout: 15000, maxBuffer: 128 * 1024 }]]);
  for (const result of [{ stdout: 'Error type 3\nActivity does not exist.' }, { stderr: 'java.lang.SecurityException: Permission Denial' }, { stderr: 'java.lang.IllegalStateException: Background activity start denied' }]) {
    await assert.rejects(openShortcutPicker({ run: async () => result }), /Android could not open the shortcut picker/);
  }
  await assert.rejects(openShortcutPicker({ run: async () => { throw new Error('spawn am ENOENT'); } }), /spawn am ENOENT/);
});

test('shortcut installation refuses symlinks before changing their targets or other installed files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-voice-shortcut-links-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  const { script, icon } = await installShortcut({ home, prefix });
  for (const path of [script, icon]) {
    const original = await readFile(path);
    const target = join(directory, 'target');
    await writeFile(target, original);
    await rm(path);
    await symlink(target, path);
    await assert.rejects(installShortcut({ home, prefix }), /Refusing to replace/);
    assert.deepEqual(await readFile(target), original);
    await rm(path);
    await writeFile(path, original);
  }
});

test('--pin creates resources and opens single-icon setup without starting Pi or a browser', async (t) => {
  const { directory, env: original } = await fixture(t, recordPi);
  const pinned = join(directory, 'pinned');
  const env = { ...original, HOME: directory, PINNED: pinned };
  await writeFile(join(directory, 'bin', 'am'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.PINNED, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log('Starting: Intent { cmp=com.termux.widget/.TermuxCreateShortcutActivity }');`, { mode: 0o700 });
  const result = await exec(process.execPath, [launcher, '--pin'], { env, timeout: 10000 });
  assert.match(result.stdout, /Choose "Pi Voice", then confirm Add/);
  assert.match(result.stdout, /single microphone icon/);
  assert.deepEqual(JSON.parse((await readFile(pinned, 'utf8')).trim()), ['start', '--user', String(Math.floor(process.getuid() / 100000)), '-n', 'com.termux.widget/.TermuxCreateShortcutActivity']);
  assert.equal((await stat(join(directory, '.shortcuts', 'Pi Voice'))).mode & 0o777, 0o700);
  assert.deepEqual(await readFile(join(directory, '.shortcuts', 'icons', 'Pi Voice.png')), await readFile(new URL('../public/icon-192.png', import.meta.url)));
  const installer = fileURLToPath(new URL('../install-shortcut.mjs', import.meta.url));
  const installed = await exec(process.execPath, [installer, '--pin'], { env, timeout: 10000 });
  assert.match(installed.stdout, /SINGLE microphone icon/);
  assert.equal((await readFile(pinned, 'utf8')).trim().split('\n').length, 2);
  for (const extra of ['--app', '--new', '-c']) {
    await assert.rejects(exec(process.execPath, [launcher, '--pin', extra], { env }), /Use pi-voice --pin by itself/);
  }
  const help = await exec(process.execPath, [launcher, '--help'], { env });
  assert.match(help.stdout, /pi-voice --pin/);
  assert.equal((await readFile(pinned, 'utf8')).trim().split('\n').length, 2, 'Invalid flags/help never launch Android UI');
  assert.equal(await stat(env.STARTED).catch(() => null), null);
  assert.equal(await stat(env.OPENED).catch(() => null), null);
});

test('--pin reports Android setup failures instead of claiming the icon was added or starting Pi', async (t) => {
  const { directory, env: original } = await fixture(t, recordPi);
  const env = { ...original, HOME: directory };
  await writeFile(join(directory, 'bin', 'am'), `#!${process.execPath}\nconsole.log('Error type 3\\nActivity class does not exist.');`, { mode: 0o700 });
  await assert.rejects(exec(process.execPath, [launcher, '--pin'], { env }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Check Termux:Widget is installed/);
    assert.match(error.stderr, /No Pi process was started/);
    assert.doesNotMatch(error.stdout, /Opened Android shortcut setup/);
    return true;
  });
  assert.equal(await stat(env.STARTED).catch(() => null), null);
  assert.equal(await stat(env.OPENED).catch(() => null), null);
});

test('shortcut installer produces private real files, cold-launch env and preserves unrelated scripts', async (t) => {
  const { directory } = await fixture(t, recordPi);
  const prefix = directory;
  const home = join(directory, "home with 'quotes'");
  const { script, icon } = await installShortcut({ home, prefix });
  const content = await readFile(script, 'utf8');
  assert.ok(content.startsWith(`#!${prefix}/bin/bash\n`));
  assert.match(content, /LD_PRELOAD=.*libtermux-exec\.so/);
  assert.match(content, /PI_CODING_AGENT_DIR:-\$HOME\/\.pi\/agent/);
  assert.match(content, /--app\n/);
  await exec(join(prefix, 'bin', 'bash'), ['-n', script]);
  await t.test('cold plugin launch uses real file locking', needsFlock, async () => {
    // No ~/.profile or inherited Pi PATH/LD_PRELOAD; Pi itself is a harmless stub.
    const agentBin = join(home, '.pi', 'agent', 'bin');
    await mkdir(agentBin, { recursive: true });
    const started = join(directory, 'cold-start.json');
    await writeFile(join(agentBin, 'pi'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.STARTED, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, preload: process.env.LD_PRELOAD }));`, { mode: 0o700 });
    await exec(join(prefix, 'bin', 'bash'), [script], {
      env: { HOME: directory, PATH: join(prefix, 'bin'), STARTED: started }, timeout: 10000,
    });
    const cold = JSON.parse(await readFile(started, 'utf8'));
    assert.deepEqual(cold.args, ['--voice-open', '-c']);
    assert.equal(cold.cwd, home);
    assert.equal(cold.home, home);
    assert.equal(cold.preload, join(prefix, 'lib', 'libtermux-exec.so'));
  });
  assert.equal((await stat(script)).mode & 0o777, 0o700);
  assert.equal((await stat(icon)).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, '.shortcuts'))).mode & 0o777, 0o700);
  assert.equal((await stat(icon)).isSymbolicLink(), false);
  assert.deepEqual(await installShortcut({ home, prefix }), { script, icon });
  await writeFile(script, '#!/bin/sh\necho unrelated\n');
  await assert.rejects(installShortcut({ home, prefix }), /Refusing to replace your existing shortcut/);
  assert.equal(await readFile(script, 'utf8'), '#!/bin/sh\necho unrelated\n');
});
