// Real on-device tmux PTY + installed Pi, isolated discovery/session directory.
// No provider prompts, real wake locks or user-session changes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runNativeHost } from './host.mjs';
import { discoverConnections, waitForConnection } from './connection.mjs';
import { stoppedRecords, writeRecord } from '../running.mjs';

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
let resumedHost;
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
  const staleStop = await fetch(`${url.origin}/api/abort`, {
    method: 'POST', headers, body: JSON.stringify({ sessionId: state.sessionId }),
  });
  assert.equal(staleStop.status, 409, 'An old native view must not abort the new TUI session');
  await exec(tmux, ['-L', socket, 'send-keys', '-t', '=pi-voice:0.0', 'C-d']);
  await Promise.race([host, delay(10000).then(() => { throw new Error('Native host did not exit with its Pi PTY'); })]);
  if (hostFailure) throw hostFailure;
  // A tmux pane can be created successfully even when Pi then fails to start.
  // Recovery must remain available, including older main conversations.
  // Pi migrates legacy *.jsonl files in the agent root before CLI startup;
  // keep fixtures in a subdirectory, like real persisted conversations.
  await mkdir(join(directory, 'saved'), { recursive: true });
  const sessionFile = join(directory, 'saved', 'saved.jsonl');
  const olderFile = join(directory, 'saved', 'older.jsonl');
  await writeFile(sessionFile, '{}\n');
  await writeFile(olderFile, '{}\n');
  await writeRecord(options.directory, { pid: 2147480000, sessionFile: olderFile, cwd: directory });
  await writeRecord(options.directory, { pid: 2147480001, sessionFile, cwd: directory });
  const failedPi = join(directory, 'failed-pi');
  await writeFile(failedPi, `#!${process.execPath}\nsetTimeout(() => process.exit(17), 200);\n`, { mode: 0o700 });
  await runNativeHost({ ...options, args: undefined, pi: failedPi });
  assert.deepEqual((await stoppedRecords(options.directory)).map((record) => record.pid).sort(), [2147480000, 2147480001], 'A failed restart must not discard any recoverable conversation');
  // Exercise the successful restore plan against real Pi, with a synthetic
  // saved conversation rather than any user data or provider-generated output.
  const savedId = randomUUID();
  const timestamp = new Date().toISOString();
  const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  await writeFile(sessionFile, [
    { type: 'session', version: 3, id: savedId, cwd: directory, timestamp },
    { type: 'message', id: '00000001', parentId: null, timestamp, message: { role: 'user', content: 'Saved recovery question', timestamp: Date.now() } },
    { type: 'message', id: '00000002', parentId: '00000001', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Saved recovery answer' }], api: 'openai-completions', provider: 'openai', model: 'gpt-4o', usage: zeroUsage, stopReason: 'stop', timestamp: Date.now() } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  await writeRecord(options.directory, { pid: 2147480001, sessionId: savedId, sessionFile, cwd: directory });
  const isolatedPi = join(directory, 'isolated-pi');
  const flags = options.args.filter((arg) => arg !== '--no-session');
  await writeFile(isolatedPi, `#!${process.execPath}\nconst { spawn } = require('node:child_process');\nconst child = spawn(${JSON.stringify(options.pi)}, ${JSON.stringify(flags)}.concat(process.argv.slice(2)), { stdio: 'inherit' });\nchild.on('error', () => process.exit(1));\nchild.on('exit', (code) => process.exit(code ?? 1));\n`, { mode: 0o700 });
  resumedHost = runNativeHost({ ...options, args: undefined, pi: isolatedPi }).catch((error) => { hostFailure = error; });
  const resumed = new URL((await waitForConnection({ directory: options.directory })).url);
  if (hostFailure) throw hostFailure;
  const restored = await fetch(`${resumed.origin}/api/state`, { headers: { Authorization: `Bearer ${resumed.hash.slice(1)}` } }).then((response) => response.json());
  assert.equal(restored.sessionId, savedId, 'Cold restart must reopen exactly the saved conversation');
  assert.equal(restored.cwd, directory);
  assert.equal(restored.messages.at(-1).text, 'Saved recovery answer');
  assert.deepEqual((await stoppedRecords(options.directory)).map((record) => record.pid), [2147480000], 'Only the resumed conversation is retired, not an older stopped one');
  await exec(tmux, ['-L', socket, 'send-keys', '-t', '=pi-voice:0.0', 'C-d']);
  await Promise.race([resumedHost, delay(10000).then(() => { throw new Error('Resumed host did not exit'); })]);
  if (hostFailure) throw hostFailure;
  console.log('Native PTY integration passed: real Pi cold start, discovery, retap reuse, new session, same connection, clean exit, failed-start preservation and exact saved-conversation recovery. No provider calls.');
} finally {
  await exec(tmux, ['-L', socket, 'kill-server']).catch(() => {});
  await host;
  await resumedHost;
  await rm(directory, { recursive: true, force: true });
}
