// Real interactive Pi in isolated tmux PTYs, using the production host,
// registry, launcher and worker extension. No model requests or user data.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHost } from '../host/server.mjs';
import { createLauncher } from '../host/launcher.mjs';
import { discoverHost } from './connection.mjs';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'pi-voice-pty-'));
const directory = join(root, 'voice');
const socket = `pi-voice-test-${randomUUID().slice(0, 8)}`;
const pi = process.env.PI_VOICE_TEST_PI || join(homedir(), '.pi/agent/bin/pi');
const tmux = process.env.PI_VOICE_TEST_TMUX || (process.env.PREFIX ? join(process.env.PREFIX, 'bin/tmux') : 'tmux');
const options = { socket, pi, tmux, env: { ...process.env, PI_CODING_AGENT_DIR: root, TERM: 'xterm-256color' },
  args: ['--offline', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-tools', '--no-extensions',
    '--provider', 'openai', '--model', 'gpt-4o', '-e', new URL('../extension.mjs', import.meta.url).pathname,
    '-e', new URL('../test/fixtures/hold-input.mjs', import.meta.url).pathname] };
let host;
let token;
async function start() { host = await createHost({ directory, port: 0, interval: 100, launcher: createLauncher(options), managerOptions: { cwd: root } }); await host.ready; token = (await readFile(join(directory, 'token'), 'utf8')).trim(); }
async function request(path, body, entry) {
  const response = await fetch(`${host.origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(entry ? { 'X-Pi-Voice-Session': entry.handle, 'X-Pi-Voice-Instance': entry.instanceId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${result.error || ''}`);
  return result;
}
async function until(check, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
try {
  await exec(pi, ['--version']); await exec(tmux, ['-V']);
  await start();
  const first = await until(async () => (await request('sessions')).sessions.find((e) => e.status === 'ready'), 'first Pi');
  const origin = host.origin;
  const operation = randomUUID();
  const launched = await request('session/spawn', { id: operation }, first);
  assert.equal((await request('session/spawn', { id: operation }, first)).handle, launched.handle);
  const second = await until(async () => (await request('sessions')).sessions.find((e) => e.handle === launched.handle && e.status === 'ready'), 'second Pi');
  await request('session/select', { handle: second.handle });
  await request('prompt', { id: randomUUID(), sessionId: second.sessionId, text: 'pi-voice-integration-hold' }, second);
  const progress = () => readFile(join(root, 'work-progress'), 'utf8').then(Number).catch(() => 0);
  await until(async () => await progress() > 2, 'Pi extension doing work');
  const before = await progress();
  await request('session/close', { sessionId: first.sessionId, instanceId: first.instanceId }, first);
  await until(async () => !(await request('sessions')).sessions.some((e) => e.handle === first.handle), 'first Pi exit');
  await until(async () => await progress() > before + 3, 'second Pi continues after first closes');
  assert.equal((await request('state', undefined, second)).pid, second.pid);
  assert.equal((await discoverHost(directory)).url, host.url);
  assert.equal(host.origin, origin);
  await writeFile(join(root, 'release-work'), 'release');
  await until(() => readFile(join(root, 'work-finished'), 'utf8').catch(() => null), 'second Pi finishes');
  await host.close(); await start();
  assert.equal(host.origin, origin);
  assert.equal((await request('state')).pid, second.pid, 'Host restart preserves selected survivor');
  assert.equal((await request('sessions')).sessions.length, 1);
  await request('session/close', { sessionId: second.sessionId, instanceId: second.instanceId }, second);
  await until(async () => (await request('sessions')).sessions.length === 0, 'last Pi exit');
  assert.equal((await request('state')).empty, true);
  await host.close(); await start();
  assert.equal((await request('sessions')).sessions.length, 0, 'Empty remains empty on restart');
  const third = await request('session/spawn', { id: randomUUID() });
  await until(async () => (await request('sessions')).sessions.find((e) => e.handle === third.handle && e.status === 'ready'), 'new Pi from empty state');
  console.log('PASS: real Pi/tmux first-session closure preserves another Pi’s running extension operation and the host origin; completion, host restart/adoption, last-session close, empty restart, and New from empty. No provider calls.');
} finally {
  await host?.close();
  await exec(tmux, ['-L', socket, 'kill-server']).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
