// Smoke-test the REAL Pi CLI. A test-only input hook consumes image prompts
// before any provider call; this never uses API credit or a real Android lock.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureTestModels } from './fixtures/test-models.mjs';

const directory = await mkdtemp(join(tmpdir(), 'pi-voice-integration-'));
await configureTestModels(directory);
const executable = process.env.PI_VOICE_TEST_PI || join(homedir(), '.pi/agent/bin/pi');
const extension = process.env.PI_VOICE_TEST_EXTENSION || join(homedir(), '.pi/agent/extensions/pi-voice.ts');
const child = spawn(executable, [
  '--mode', 'rpc', '--no-session', '--offline', '--no-context-files', '--no-skills',
  '--no-prompt-templates', '--no-themes', '--no-tools', '--no-extensions',
  '--provider', 'pi-voice-test', '--model', 'vision',
  '-e', extension,
  '-e', fileURLToPath(new URL('./fixtures/capture-input.mjs', import.meta.url)),
], { env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_VOICE_RPC: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
let buffer = '';
const responses = new Map();
const pending = new Map();
const exited = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let data;
    try { data = JSON.parse(line); } catch { continue; }
    if (data.type !== 'response' || !data.id) continue;
    responses.set(data.id, data);
    pending.get(data.id)?.(data);
  }
});
let sequence = 0;
function command(type) {
  const id = `${type}-${++sequence}`;
  child.stdin.write(`${JSON.stringify({ id, type })}\n`);
  return Promise.race([
    new Promise((resolve) => { if (responses.has(id)) resolve(responses.get(id)); else pending.set(id, resolve); }),
    exited.then((exit) => { throw new Error(`Pi exited early: ${JSON.stringify(exit)}\n${stderr}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Pi startup timed out.\n${stderr}`)), 25000); timer.unref(); }),
  ]);
}
try {
  const rpcState = await command('get_state');
  assert.equal(rpcState.success, true, JSON.stringify(rpcState));
  const commands = await command('get_commands');
  assert.equal(commands.success, true, JSON.stringify(commands));
  assert.ok(commands.data.commands.some((item) => item.name === 'voice'), 'Pi must load /voice');
  const endpoints = join(directory, 'voice', 'endpoints');
  const files = await readdir(endpoints);
  assert.equal(files.length, 1);
  const endpoint = JSON.parse(await readFile(join(endpoints, files[0]), 'utf8'));
  const stateResponse = await fetch(`${endpoint.origin}/api/state`, { headers: { Authorization: `Bearer ${endpoint.token}` } });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.sessionId, rpcState.data.sessionId);
  assert.equal(state.busy, false);
  assert.equal(state.imageAttachments.maxCount, 4);
  assert.equal(state.modelSupportsImages, true);
  assert.deepEqual(state.wakeLock, { active: false, shared: false, error: null });
  const awakeResponse = await fetch(`${endpoint.origin}/api/awake`, {
    method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(awakeResponse.status, 200);
  assert.equal((await awakeResponse.json()).wakeLock.active, false);
  // Never acquire/release the real shared Android lock during a smoke test.
  assert.equal((await fetch(`${endpoint.origin}/api/state`)).status, 401);
  assert.equal((await fetch(endpoint.origin)).status, 404, 'Workers do not serve the app');
  assert.equal((await fetch(`${endpoint.origin}/api/state`, { headers: {
    Authorization: `Bearer ${endpoint.token}`, 'Sec-Fetch-Site': 'cross-site',
  } })).status, 403);
  const abort = await fetch(`${endpoint.origin}/api/abort`, {
    method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.sessionId }),
  });
  assert.equal(abort.status, 200);
  const headers = { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' };
  const modelsResponse = await fetch(`${endpoint.origin}/api/models`, { headers });
  assert.equal(modelsResponse.status, 200);
  const listed = await modelsResponse.json();
  assert.equal(listed.sessionId, state.sessionId);
  assert.deepEqual(listed.current, { provider: 'pi-voice-test', id: 'vision' });
  assert.ok(listed.models.some((model) => model.provider === 'pi-voice-test' && model.id === 'text'));
  assert.equal(state.modelSwitchingSupported, true);
  const settingsBefore = await readFile(join(directory, 'settings.json'), 'utf8').catch(() => null);
  const configBefore = await readFile(join(directory, 'models.json'), 'utf8');
  let expectedModel = listed.current;
  for (const id of ['text', 'vision']) {
    const result = await fetch(`${endpoint.origin}/api/model`, { method: 'POST', headers,
      body: JSON.stringify({ sessionId: state.sessionId, provider: 'pi-voice-test', id, expectedModel }) });
    assert.equal(result.status, 200, await result.text());
    const confirmed = await command('get_state');
    assert.equal(confirmed.data.model.provider, 'pi-voice-test');
    assert.equal(confirmed.data.model.id, id);
    assert.equal(confirmed.data.sessionId, state.sessionId);
    const worker = await (await fetch(`${endpoint.origin}/api/state`, { headers })).json();
    assert.deepEqual(worker.modelSelection, { provider: 'pi-voice-test', id });
    assert.equal(worker.modelSupportsImages, id === 'vision');
    assert.equal(worker.modelSwitching, false);
    assert.deepEqual(worker.messages, state.messages);
    expectedModel = worker.modelSelection;
  }
  assert.equal(await readFile(join(directory, 'settings.json'), 'utf8').catch(() => null), settingsBefore, 'Session-only model switches must not change Pi defaults');
  assert.equal(await readFile(join(directory, 'models.json'), 'utf8'), configBefore);
  const staleModel = await fetch(`${endpoint.origin}/api/model`, { method: 'POST', headers,
    body: JSON.stringify({ sessionId: state.sessionId, provider: 'pi-voice-test', id: 'text', expectedModel: { provider: 'pi-voice-test', id: 'text' } }) });
  assert.equal(staleModel.status, 409, 'A stale previous-model snapshot must not override a later selection');
  // Exercise real RPC session replacement and extension recreation. App New
  // now spawns a separate TUI, covered by native/integration.mjs. Internal slash
  // commands sent by an extension are not dispatched in Pi's RPC mode.
  let previous = state;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await command('new_session');
    assert.equal(response.success, true, JSON.stringify(response));
    let next;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const result = await fetch(`${endpoint.origin}/api/state`, { headers: { Authorization: `Bearer ${endpoint.token}` } });
        if (result.ok) {
          next = await result.json();
          if (next.newSessionAction?.status === 'error') throw new Error(JSON.stringify(next.newSessionAction));
          if (next.sessionId !== previous.sessionId) break;
        }
      } catch (error) { if (next?.newSessionAction?.status === 'error') throw error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(next && next.sessionId !== previous.sessionId, `New session was not created. ${stderr}`);
    assert.deepEqual(next.messages, []);
    assert.equal(next.busy, false);
    assert.equal(next.wakeLock.active, false);
    const rpcNext = await command('get_state');
    assert.equal(rpcNext.data.sessionId, next.sessionId);
    const refreshed = JSON.parse(await readFile(join(endpoints, files[0]), 'utf8'));
    assert.equal(refreshed.origin, endpoint.origin, 'Browser must keep the same port');
    assert.equal(refreshed.token, endpoint.token);
    const stale = await fetch(`${endpoint.origin}/api/session/new`, {
      method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'stale-session-req', sessionId: previous.sessionId }),
    });
    assert.equal(stale.status, 409, 'An old tab/retry must not create another session');
    const staleStop = await fetch(`${endpoint.origin}/api/abort`, {
      method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: previous.sessionId }),
    });
    assert.equal(staleStop.status, 409, 'An old tab must not stop the new session');
    previous = next;
  }
  // Exercise the native sendUserMessage structured-content path. The separate
  // test extension captures/consumes input, so no image ever reaches a provider.
  const png = { mimeType: 'image/png', data: (await readFile(new URL('../public/icon-192.png', import.meta.url))).toString('base64') };
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = { id: `image-native-${attempt}`, sessionId: previous.sessionId, text: attempt ? '' : '/new inspect this screenshot literally', images: [png] };
    for (let retry = 0; retry < 2; retry++) {
      const result = await fetch(`${endpoint.origin}/api/prompt`, {
        method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(result.status, 200, await result.text());
    }
    let captured;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      captured = await readFile(join(directory, 'captured-input.json'), 'utf8').then(JSON.parse).catch(() => undefined);
      if (captured?.count === attempt + 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(captured?.count, attempt + 1, 'HTTP retries must not send twice');
    assert.equal(captured.text, body.text);
    assert.equal(captured.source, 'extension');
    assert.deepEqual(captured.images, [{ type: 'image', ...png }]);
    const stillSame = await command('get_state');
    assert.equal(stillSame.data.sessionId, previous.sessionId, 'Image captions beginning /new stay literal');
  }
  // Closing stdin is the documented RPC graceful-shutdown operation.
  child.stdin.end();
  const exit = await Promise.race([exited, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Pi did not stop gracefully')), 10000); timer.unref();
  })]);
  assert.equal(exit.code, 0, stderr);
  assert.deepEqual(await readdir(endpoints), []);
  await assert.rejects(fetch(`${endpoint.origin}/api/state`));
  console.log('PASS: real Pi authenticates its worker API, switches configured models without changing defaults/history, updates image capabilities, rejects stale selections, survives two RPC session replacements, preserves its port/token, receives native text+image and image-only inputs once despite retries, aborts and shuts down cleanly. No provider/inference requests or Android wake-lock changes made.');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await exited.catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
