// Real on-device tmux PTY + installed Pi, isolated discovery/session directory.
// No provider prompts, real wake locks, Chrome launch or user-session changes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runNativeHost } from './host.mjs';
import { discoverConnections, waitForConnection } from './connection.mjs';

const directory = await mkdtemp(join(tmpdir(), 'pi-voice-native-pty-'));
const socket = `pi-voice-test-${randomUUID().slice(0, 8)}`;
const tmux = join(process.env.PREFIX || '/data/data/com.termux/files/usr', 'bin/tmux');
const exec = promisify(execFile);
const options = {
  directory: join(directory, 'voice'), socket, interval: 100,
  pi: join(homedir(), '.pi/agent/bin/pi'), cwd: directory,
  args: ['--no-session', '--offline', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-tools', '--no-extensions', '--provider', 'openai', '--model', 'gpt-4o', '-e', fileURLToPath(new URL('../extension.mjs', import.meta.url))],
  env: { ...process.env, PI_CODING_AGENT_DIR: directory, TERM: 'xterm-256color' },
};
let hostFailure;
const host = runNativeHost(options).catch((error) => { hostFailure = error; });
try {
  const connection = await waitForConnection({ directory: options.directory });
  if (hostFailure) throw hostFailure;
  assert.match(connection.url, /^http:\/\/127\.0\.0\.1:\d+\/#\w{64}$/);
  const url = new URL(connection.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  const state = await fetch(`${url.origin}/api/state`, { headers }).then((response) => response.json());
  assert.equal(state.busy, false);
  assert.equal(state.sessionPersistent, false);
  assert.equal(state.imageAttachments.maxCount, 4);
  assert.equal(state.modelSupportsImages, true);
  assert.equal(state.wakeLock.active, false);
  assert.deepEqual(await runNativeHost(options), { reused: true });
  const sessions = await exec(tmux, ['-L', socket, 'list-sessions', '-F', '#{session_name}']);
  assert.equal(sessions.stdout.trim(), 'pi-voice', 'Retapping must reuse the same PTY');

  const response = await fetch(`${url.origin}/api/session/new`, {
    method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), sessionId: state.sessionId }),
  });
  assert.equal(response.status, 202);
  let next;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    next = await fetch(`${url.origin}/api/state`, { headers }).then((result) => result.json()).catch(() => undefined);
    if (next?.sessionId && next.sessionId !== state.sessionId) break;
    await delay(100);
  }
  assert.ok(next?.sessionId && next.sessionId !== state.sessionId, 'New session must also work in an actual TUI PTY');
  assert.equal((await discoverConnections(options.directory))[0].url, connection.url, 'Session replacement must keep the connection');
  await exec(tmux, ['-L', socket, 'send-keys', '-t', '=pi-voice:0.0', 'C-d']);
  await Promise.race([host, delay(10000).then(() => { throw new Error('Native host did not exit with its Pi PTY'); })]);
  if (hostFailure) throw hostFailure;
  console.log('Native PTY integration passed: real Pi cold start, authenticated discovery, retap reuse, new session, same connection, clean host exit. No provider calls or Chrome launch.');
} finally {
  await exec(tmux, ['-L', socket, 'kill-server']).catch(() => {});
  await host;
  await rm(directory, { recursive: true, force: true });
}
