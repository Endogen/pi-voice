import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoiceBridge } from '../bridge.mjs';
import { writeRecord } from '../running.mjs';

// These mocked Pi contexts are not panes in the reviewer's actual terminal.
// Node runs this test file in its own process; don't inherit a native tmux pane.
delete process.env.TMUX;
delete process.env.TMUX_PANE;
const temp = await mkdtemp(join(tmpdir(), 'pi-voice-test-'));
process.env.PI_CODING_AGENT_DIR = temp;
process.env.PI_VOICE_RPC = '1';
const { default: install, stateDir, createTerminal } = await import('../extension.mjs');
after(() => rm(temp, { recursive: true, force: true }));

function harness(mode = 'rpc', options = {}) {
  const events = new Map();
  const commands = new Map();
  const sent = [];
  let busy = false;
  let aborts = 0;
  let shutdowns = 0;
  const branch = [{ type: 'message', id: 'one', message: { role: 'user', content: [{ type: 'text', text: 'Existing session' }] } }];
  const ctx = {
    mode, cwd: '/test/project', model: { provider: 'test', id: 'test-model', input: ['text', 'image'] },
    isIdle: () => !busy, hasPendingMessages: () => busy,
    abort: () => { aborts++; },
    ui: { notify() {}, setStatus() {} },
    shutdown: () => { shutdowns++; },
    sessionManager: { getSessionFile: () => '/test/session.jsonl', getSessionId: () => 'test-session', getSessionName: () => 'Test session', getBranch: () => branch },
  };
  install({
    on: (name, handler) => { events.set(name, handler); },
    registerFlag() {}, getFlag: () => false,
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage: (text, options) => { sent.push({ text, options }); },
  }, options);
  return { events, commands, ctx, branch, sent, busy: (value) => { busy = value; }, aborts: () => aborts, shutdowns: () => shutdowns };
}
async function endpoint() {
  const names = await readdir(join(stateDir, 'endpoints'));
  return JSON.parse(await readFile(join(stateDir, 'endpoints', names[0]), 'utf8'));
}

test('terminal lookup retries failures without blocking polls or starting overlapping tmux commands', async () => {
  let time = 0;
  let attempts = 0;
  let complete;
  const terminal = createTerminal({
    now: () => time,
    detect: () => { attempts++; return new Promise((resolve) => { complete = resolve; }); },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(terminal(), {});
  await flush();
  assert.equal(attempts, 1);
  time = 60000;
  for (let i = 0; i < 10; i++) assert.deepEqual(terminal(), {});
  await flush();
  assert.equal(attempts, 1, 'Even slow probes have only one command in flight');
  complete({});
  await flush();
  for (const elapsed of [0, 4999]) {
    time = 60000 + elapsed;
    assert.deepEqual(terminal(), {});
    await flush();
    assert.equal(attempts, 1, 'Failures wait five seconds before retrying');
  }
  time = 65000;
  assert.deepEqual(terminal(), {});
  await flush();
  assert.equal(attempts, 2);
  complete({ session: 'pi-voice-abcdef12' });
  await flush();
  assert.deepEqual(terminal(), { session: 'pi-voice-abcdef12' });
  time += 60000;
  assert.deepEqual(terminal(), { session: 'pi-voice-abcdef12' });
  await flush();
  assert.equal(attempts, 2, 'A valid terminal stays cached');
});

for (const asynchronous of [false, true]) test(`terminal lookup recovers from a ${asynchronous ? 'rejected' : 'throwing'} probe`, async () => {
  let time = 0;
  let attempts = 0;
  const terminal = createTerminal({
    now: () => time,
    detect: () => {
      if (++attempts > 1) return Promise.resolve({ session: 'pi-voice' });
      const error = new Error('tmux temporarily unavailable');
      if (asynchronous) return Promise.reject(error);
      throw error;
    },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(terminal(), {});
  await flush();
  assert.deepEqual(terminal(), {});
  assert.equal(attempts, 1);
  time = 5000;
  assert.deepEqual(terminal(), {});
  await flush();
  assert.deepEqual(terminal(), { session: 'pi-voice' });
  assert.equal(attempts, 2);
});

test('state, session summaries and activity expose a terminal recovered after startup without a reload', async (t) => {
  let time = 0;
  let attempts = 0;
  let complete;
  const getTerminal = createTerminal({
    now: () => time,
    detect: () => { attempts++; return new Promise((resolve) => { complete = resolve; }); },
  });
  const h = harness('rpc', { getTerminal });
  await h.events.get('session_start')({ reason: 'startup' }, h.ctx);
  t.after(() => h.events.get('session_shutdown')({ reason: 'quit' }, h.ctx));
  const ep = await endpoint();
  const get = async (path) => (await fetch(`${ep.origin}/api/${path}`, { headers: { Authorization: `Bearer ${ep.token}` } })).json();
  assert.deepEqual((await get('state')).terminal, {});
  assert.deepEqual((await get('activity')).terminal, {});
  assert.equal(attempts, 1, 'Unresolved lookup must not block either HTTP response');
  complete({});
  await new Promise((resolve) => setImmediate(resolve));
  time = 4999;
  assert.deepEqual((await get('state?summary=1')).terminal, {});
  assert.equal(attempts, 1);
  time = 5000;
  assert.deepEqual((await get('activity')).terminal, {});
  assert.equal(attempts, 2, 'Activity polling also retries failed detection');
  complete({ session: 'pi-voice' });
  await new Promise((resolve) => setImmediate(resolve));
  for (const path of ['state', 'state?summary=1', 'activity']) {
    assert.deepEqual((await get(path)).terminal, { session: 'pi-voice' });
  }
  assert.equal(attempts, 2);
});

test('extension connects the existing session, queues speech, exposes replies and cleans up on reload', async (t) => {
  const h = harness();
  await h.events.get('session_start')({ reason: 'startup' }, h.ctx);
  t.after(() => h.events.get('session_shutdown')({ reason: 'quit' }, h.ctx));
  const ep = await endpoint();
  const request = (path, body) => fetch(`${ep.origin}/api/${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const state = await (await request('state')).json();
  assert.equal(state.sessionId, 'test-session');
  assert.equal(state.messages[0].text, 'Existing session');
  assert.equal((await stat(join(stateDir, 'token'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateDir, 'endpoints', `${process.pid}.json`))).mode & 0o777, 0o600);
  const send = async (id, text) => (await request('prompt', { id, text, sessionId: state.sessionId })).json();
  assert.equal((await send('prompt-one', 'hello')).queued, false);
  h.busy(true);
  assert.equal((await send('prompt-two', '/new')).queued, true);
  assert.deepEqual(h.sent, [
    { text: 'hello', options: { deliverAs: 'followUp', expandPromptTemplates: false } },
    { text: '/new', options: { deliverAs: 'followUp', expandPromptTemplates: false } },
  ]);
  // Real Pi emits message_end before persisting the message; the next HTTP read must still see it.
  await h.events.get('message_end')({}, h.ctx);
  h.branch.push({ type: 'message', id: 'two', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thought' }, { type: 'text', text: 'Here is the reply' }] } });
  const next = await (await request('state')).json();
  assert.equal(next.messages.at(-1).text, 'Here is the reply');
  assert.equal(JSON.stringify(next).includes('secret thought'), false);
  assert.equal((await request('abort', { sessionId: 'old-session' })).status, 409);
  assert.equal(h.aborts(), 0);
  await request('abort', { sessionId: state.sessionId });
  assert.equal(h.aborts(), 1);
  await h.events.get('session_shutdown')({ reason: 'reload' }, h.ctx);
  assert.deepEqual(await readdir(join(stateDir, 'endpoints')), []);
  await assert.rejects(fetch(`${ep.origin}/api/state`));
  // Fresh runtime reuses credentials and the default port, so the home-screen app reconnects.
  const replacement = harness();
  await replacement.events.get('session_start')({ reason: 'reload' }, replacement.ctx);
  t.after(() => replacement.events.get('session_shutdown')({ reason: 'quit' }, replacement.ctx));
  const ep2 = await endpoint();
  assert.equal(ep2.origin, ep.origin);
  assert.equal(ep2.token, ep.token);
  assert.equal(ep2.instanceId, ep.instanceId, 'Runtime reload retains the process identity');
  await send('prompt-one', 'hello');
  assert.equal(replacement.sent.length, 0, 'Reload retains accepted prompt IDs; a lost response cannot duplicate work');
  await replacement.commands.get('voice').handler('stop', replacement.ctx);
  assert.deepEqual(await readdir(join(stateDir, 'endpoints')), []);
});

test('extension forwards structured images to Pi, supports queued/image-only prompts and never polls base64', async (t) => {
  const h = harness();
  await h.events.get('session_start')({ reason: 'startup' }, h.ctx);
  t.after(() => h.events.get('session_shutdown')({ reason: 'quit' }, h.ctx));
  const ep = await endpoint();
  const png = { mimeType: 'image/png', data: (await readFile(new URL('../public/icon-192.png', import.meta.url))).toString('base64') };
  const image = { type: 'image', ...png };
  const state = async () => (await fetch(`${ep.origin}/api/state`, { headers: { Authorization: `Bearer ${ep.token}` } })).json();
  const send = (id, text) => fetch(`${ep.origin}/api/prompt`, {
    method: 'POST', headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, text, sessionId: 'test-session', images: [png] }),
  });
  assert.equal((await state()).modelSupportsImages, true);
  assert.equal((await state()).imageAttachments.maxCount, 4);
  assert.equal((await send('image-prompt-one', '/new inspect this')).status, 200);
  assert.deepEqual(h.sent[0], { text: [{ type: 'text', text: '/new inspect this' }, image], options: { deliverAs: 'followUp', expandPromptTemplates: false } });
  h.busy(true);
  assert.equal((await (await send('image-prompt-two', '')).json()).queued, true);
  assert.deepEqual(h.sent[1].text, [image]);
  h.branch.push({ type: 'message', id: 'image-question', message: { role: 'user', content: [image] } });
  const next = await state();
  assert.deepEqual(next.messages.at(-1), { id: 'image-question', role: 'user', text: '', imageCount: 1 });
  assert.equal(JSON.stringify(next).includes(png.data), false);
  h.ctx.model.input = ['text'];
  assert.equal((await state()).modelSupportsImages, false);
  assert.equal((await send('image-prompt-three', 'do not lose the image')).status, 422);
  assert.equal(h.sent.length, 2);
});

test('new-session control is one-shot, requires its ticket and reports busy/cancel/error without a model prompt', async (t) => {
  const h = harness();
  await h.events.get('session_start')({ reason: 'startup' }, h.ctx);
  t.after(() => h.events.get('session_shutdown')({ reason: 'quit' }, h.ctx));
  const ep = await endpoint();
  const request = (id) => fetch(`${ep.origin}/api/session/new`, {
    method: 'POST', headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, sessionId: 'test-session' }),
  });
  const state = async () => (await fetch(`${ep.origin}/api/state`, { headers: { Authorization: `Bearer ${ep.token}` } })).json();
  let created = 0;
  h.ctx.newSession = async () => { created++; return { cancelled: true }; };
  const handler = h.commands.get('voice-new-session').handler;
  await handler('not-a-ticket', h.ctx);
  assert.equal(created, 0);
  assert.equal((await request('new-request-one')).status, 202);
  assert.equal((await request('new-request-one')).status, 202);
  assert.equal((await request('new-request-two')).status, 409);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.expandPromptTemplates, true);
  assert.match(h.sent[0].text, /^\/voice-new-session [a-f0-9]{32}$/);
  const ticket = h.sent[0].text.split(' ')[1];
  assert.equal(JSON.stringify(await state()).includes(ticket), false);
  await handler('wrong-ticket', h.ctx);
  h.busy(true);
  await handler(ticket, h.ctx);
  assert.equal(created, 0);
  assert.match((await state()).newSessionAction.error, /Pi is busy/);
  h.busy(false);
  assert.equal((await request('new-request-two')).status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  await handler(h.sent.at(-1).text.split(' ')[1], h.ctx);
  assert.equal(created, 1);
  assert.match((await state()).newSessionAction.error, /cancelled/);
  await handler(h.sent.at(-1).text.split(' ')[1], h.ctx);
  assert.equal(created, 1, 'A ticket cannot execute twice');
  h.ctx.newSession = async () => { throw new Error('Session creation failed'); };
  assert.equal((await request('new-request-three')).status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  await handler(h.sent.at(-1).text.split(' ')[1], h.ctx);
  assert.match((await state()).newSessionAction.error, /Session creation failed/);
});

test('new-session replacement keeps the same non-default port even if an earlier port becomes free', async (t) => {
  const blocker = await createVoiceBridge({ token: 'b'.repeat(64), getState: () => ({}), port: 8765 });
  t.after(() => blocker.close());
  const h = harness();
  await h.events.get('session_start')({ reason: 'startup' }, h.ctx);
  t.after(() => h.events.get('session_shutdown')({ reason: 'quit' }, h.ctx));
  const before = await endpoint();
  assert.notEqual(before.origin, blocker.origin);
  let replacement;
  h.ctx.newSession = async () => {
    await h.events.get('session_shutdown')({ reason: 'new' }, h.ctx);
    assert.equal((await stat(join(stateDir, `reconnect-${process.pid}.json`))).mode & 0o777, 0o600);
    await blocker.close();
    replacement = harness();
    replacement.ctx.sessionManager.getSessionId = () => 'fresh-session';
    replacement.branch.length = 0;
    t.after(() => replacement.events.get('session_shutdown')({ reason: 'quit' }, replacement.ctx));
    await replacement.events.get('session_start')({ reason: 'new' }, replacement.ctx);
    return { cancelled: false };
  };
  const response = await fetch(`${before.origin}/api/session/new`, {
    method: 'POST', headers: { Authorization: `Bearer ${before.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'new-session-replacement', sessionId: 'test-session' }),
  });
  assert.equal(response.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  await h.commands.get('voice-new-session').handler(h.sent[0].text.split(' ')[1], h.ctx);
  const after = await endpoint();
  assert.equal(after.origin, before.origin);
  assert.equal(after.token, before.token);
  const state = await (await fetch(`${after.origin}/api/state`, { headers: { Authorization: `Bearer ${after.token}` } })).json();
  assert.equal(state.sessionId, 'fresh-session');
  assert.deepEqual(state.messages, []);
});

test('print mode loads the extension without opening a socket or endpoint', async () => {
  const h = harness('print');
  await h.events.get('session_start')({ reason: 'startup' }, h.ctx);
  assert.deepEqual(await readdir(join(stateDir, 'endpoints')), []);
});

test('extension exposes wake-lock state, responds to app controls and releases it on shutdown', async (t) => {
  let active = false;
  const calls = [];
  const wakeLock = {
    status: () => ({ active, error: null }),
    setEnabled: async (enabled) => { active = enabled; calls.push(enabled); return { active, error: null }; },
    close: async () => { calls.push('close'); active = false; },
  };
  const h = harness('rpc', { wakeLock });
  await h.events.get('session_start')({ reason: 'startup' }, h.ctx);
  t.after(() => h.events.get('session_shutdown')({ reason: 'quit' }, h.ctx));
  const ep = await endpoint();
  const request = (path, body) => fetch(`${ep.origin}/api/${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await (await request('state')).json()).wakeLock.active, false);
  await h.commands.get('voice').handler('awake', h.ctx);
  assert.equal((await (await request('state')).json()).wakeLock.active, true);
  assert.equal((await request('awake', { enabled: false })).status, 200);
  assert.equal(active, false);
  await request('awake', { enabled: true });
  await h.commands.get('voice').handler('sleep', h.ctx);
  assert.equal(active, false);
  await request('awake', { enabled: true });
  await h.events.get('session_shutdown')({ reason: 'reload' }, h.ctx);
  assert.equal(active, false);
  assert.deepEqual(calls, [true, false, true, false, true, 'close']);
  assert.deepEqual(await readdir(join(stateDir, 'endpoints')), []);
});

test('extension exposes live activity from Pi events, including for the state poll', async (t) => {
  const h = harness();
  await h.events.get('session_start')({ reason: 'startup' }, h.ctx);
  t.after(() => h.events.get('session_shutdown')({ reason: 'quit' }, h.ctx));
  const ep = await endpoint();
  const get = async (path) => (await fetch(`${ep.origin}/api/${path}`, { headers: { Authorization: `Bearer ${ep.token}` } })).json();
  h.events.get('agent_start')({}, h.ctx);
  h.events.get('message_update')({ assistantMessageEvent: { type: 'thinking_delta', delta: 'secret plan' } }, h.ctx);
  h.events.get('tool_execution_start')({ toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls -la' } }, h.ctx);
  h.events.get('tool_execution_update')({ toolCallId: 'call-1', partialResult: { content: [{ type: 'text', text: 'total 8' }] } }, h.ctx);
  assert.deepEqual((await get('state')).activity.step, { kind: 'tool', name: 'bash', summary: 'ls -la' });
  const activity = await get('activity');
  assert.equal(activity.steps.at(-1).output, 'total 8');
  assert.deepEqual(activity.terminal, {}, 'A Pi outside the native tmux server cannot be attached');
  assert.equal(JSON.stringify(activity).includes('secret plan'), false);
  h.events.get('tool_execution_end')({ toolCallId: 'call-1', result: { content: [] }, isError: false }, h.ctx);
  h.events.get('agent_settled')({}, h.ctx);
  assert.equal((await get('state')).activity.step, undefined);
});

test('a finished run with a new reply alerts the app once; runs without one do not', async (t) => {
  const alerts = [];
  const h = harness('rpc', { alert: (details) => alerts.push(details) });
  await h.events.get('session_start')({ reason: 'startup' }, h.ctx);
  t.after(() => h.events.get('session_shutdown')({ reason: 'quit' }, h.ctx));
  const ep = await endpoint();
  h.events.get('agent_start')({}, h.ctx);
  h.events.get('agent_settled')({}, h.ctx);
  assert.equal(alerts.length, 0, 'No reply, no alert');
  h.events.get('agent_start')({}, h.ctx);
  h.branch.push({ type: 'message', id: 'reply-1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'All **12** tests pass.' }] } });
  h.events.get('agent_settled')({}, h.ctx);
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].pid, alerts[0].title, alerts[0].text, alerts[0].token, alerts[0].handle, alerts[0].sessionId], [process.pid, 'Test session', 'All **12** tests pass.', ep.token, ep.handle, 'test-session']);
  h.events.get('agent_settled')({}, h.ctx);
  assert.equal(alerts.length, 1, 'A repeated settle does not alert twice');
});

test('closing a managed worker aborts its task; host retains ownership of recovery decisions', async (t) => {
  process.env.PI_VOICE_MANAGED_ID = 'managed-session-1';
  const { default: installSpawned } = await import('../extension.mjs?spawned');
  delete process.env.PI_VOICE_MANAGED_ID;
  const sessionFile = join(temp, 'closing.jsonl');
  await (await import('node:fs/promises')).writeFile(sessionFile, '{}\n');
  const events = new Map();
  let busy = true;
  const calls = [];
  const ctx = {
    mode: 'rpc', cwd: temp, model: { provider: 'test', id: 'm', input: ['text'] }, ui: { notify() {}, setStatus() {} },
    isIdle: () => !busy, hasPendingMessages: () => false,
    abort: () => { calls.push('abort'); busy = false; }, shutdown: () => calls.push('shutdown'),
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'closing', getSessionName: () => 'Closing', getBranch: () => [] },
  };
  installSpawned({ on: (name, handler) => events.set(name, handler), registerFlag() {}, getFlag: () => false, registerCommand() {}, sendUserMessage() {} },
    { wakeLock: { status: () => ({ active: false }), setEnabled: async () => ({}), close: async () => {} } });
  await events.get('session_start')({ reason: 'startup' }, ctx);
  t.after(() => events.get('session_shutdown')({ reason: 'quit' }, ctx));
  const ep = JSON.parse(await readFile(join(stateDir, 'endpoints', `${process.pid}.json`), 'utf8'));
  const response = await fetch(`${ep.origin}/api/session/close`, {
    method: 'POST', headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'closing' }),
  });
  assert.equal(response.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(calls, ['abort', 'shutdown'], 'Pi only quits once idle, so the task is stopped first');
  // Pi settles the aborted run before exiting: that must not write the record back.
  events.get('agent_settled')({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(JSON.parse(await readFile(join(stateDir, 'running', `${process.pid}.json`), 'utf8')).sessionId, 'closing');
});

test('stay-awake survives a /reload of the extension', async (t) => {
  let active = false;
  const enabled = [];
  const wakeLock = { status: () => ({ active }), setEnabled: async (on) => { active = on; enabled.push(on); return { active }; }, close: async () => { active = false; } };
  const h = harness('rpc', { wakeLock });
  await h.events.get('session_start')({ reason: 'startup' }, h.ctx);
  await wakeLock.setEnabled(true);
  await h.events.get('session_shutdown')({ reason: 'reload' }, h.ctx);
  assert.equal(active, false);
  const replacement = harness('rpc', { wakeLock });
  await replacement.events.get('session_start')({ reason: 'reload' }, replacement.ctx);
  t.after(() => replacement.events.get('session_shutdown')({ reason: 'quit' }, replacement.ctx));
  assert.equal(active, true, 'The replacement runtime takes the wake lock again');
  assert.deepEqual(enabled, [true, true]);
});
