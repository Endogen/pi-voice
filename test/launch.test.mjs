import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoiceBridge } from '../bridge.mjs';
const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../launch.mjs', import.meta.url));

test('launcher opens current session, rejects stale PID files and refuses ambiguous sessions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-voice-launch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const endpoints = join(directory, 'voice', 'endpoints');
  const bin = join(directory, 'bin');
  await mkdir(endpoints, { recursive: true });
  await mkdir(bin);
  const opened = join(directory, 'opened.json');
  // Fake Android opener: test the executable/arguments without opening the real browser.
  await writeFile(join(bin, 'termux-open-url'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.PI_VOICE_TEST_OPENED, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const token = 'b'.repeat(64);
  const options = {
    token, port: 0, onPrompt() {}, onAbort() {},
    getState: () => ({ pid: 1234, sessionId: 'current-session', cwd: '/current/project', messages: [] }),
  };
  const bridge = await createVoiceBridge(options);
  t.after(() => bridge.close());
  const endpoint = { pid: 1234, token, origin: bridge.origin, url: bridge.url, sessionId: 'outdated-session', cwd: '/old/project' };
  await writeFile(join(endpoints, '1234.json'), JSON.stringify(endpoint));
  await writeFile(join(endpoints, '9999.json'), JSON.stringify({ ...endpoint, pid: 9999 }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: directory, PREFIX: directory, PI_VOICE_TEST_OPENED: opened };
  const result = await exec(process.execPath, [launcher], { env, timeout: 10000 });
  assert.match(result.stdout, /current-.*\/current\/project/);
  assert.deepEqual(JSON.parse(await readFile(opened, 'utf8')), [bridge.url, 'com.android.chrome']);
  assert.deepEqual((await readdir(endpoints)).sort(), ['1234.json', '9999.json'], 'Discovery must not delete files owned by a running extension');
  const appResult = await exec(process.execPath, [launcher, '--app'], { env, timeout: 10000 });
  assert.match(appResult.stdout, /Opening Pi Voice for current-/);
  assert.doesNotMatch(appResult.stdout, /resuming Pi/);
  const unavailable = http.createServer((_req, res) => { res.writeHead(503); res.end('Temporarily busy'); });
  await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
  t.after(() => { unavailable.closeAllConnections(); unavailable.close(); });
  await writeFile(join(endpoints, '7777.json'), JSON.stringify({ pid: 7777, token, origin: `http://127.0.0.1:${unavailable.address().port}` }));
  await exec(process.execPath, [launcher], { env, timeout: 10000 });
  assert.ok((await readdir(endpoints)).includes('7777.json'), 'A transient 503 must not permanently lose a live session endpoint');
  const second = await createVoiceBridge({ ...options, getState: () => ({ pid: 5678, sessionId: 'second-session', cwd: '/other' }) });
  t.after(() => second.close());
  await writeFile(join(endpoints, '5678.json'), JSON.stringify({ pid: 5678, token, origin: second.origin, url: second.url }));
  await assert.rejects(exec(process.execPath, [launcher, '--app'], { env, timeout: 10000 }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Several Pi sessions are running/);
    return true;
  });
});
