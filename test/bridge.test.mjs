import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { imageLimits } from '../image-attachments.mjs';
const png = { mimeType: 'image/png', data: (await readFile(new URL('../public/icon-192.png', import.meta.url))).toString('base64') };
import { createVoiceBridge } from '../bridge.mjs';
import { createApiServer } from '../transport.mjs';

const token = 'a'.repeat(64);
async function setup(t, options = {}) {
  const prompts = [];
  let aborted = 0;
  const bridge = await createVoiceBridge({
    token, port: 0,
    getState: () => ({ sessionId: 'session-1', messages: [], busy: false, imageAttachments: imageLimits, modelSupportsImages: true }),
    onPrompt: (text) => { prompts.push(text); return { ok: true, queued: false }; },
    onAbort: () => { aborted++; },
    ...options,
  });
  t.after(() => bridge.close());
  const request = (path, body, headers = {}) => fetch(`${bridge.origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { bridge, prompts, request, aborted: () => aborted };
}
const prompt = (extra = {}) => ({ text: 'Hello from speech', id: 'message-0001', sessionId: 'session-1', ...extra });

// Use raw HTTP so Node fetch cannot replace Sec-Fetch-Mode with its own value.
function browserRequest(origin, path, headers, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}${path}`, { method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}
const externalNavigation = {
  'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1',
};


async function shellSetup(t) {
  const bridge = await createApiServer({ token, port: 0, serveAssets: true, handle: ({ send }) => send(200, { sessionId: 'session-1' }) });
  t.after(() => bridge.close());
  const request = (path, body, headers = {}) => fetch(bridge.origin + path, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  return { bridge, request };
}

test('serves the app shell, scripts and icons with no external dependencies', async (t) => {
  const { bridge } = await shellSetup(t);
  for (const path of ['/', '/app.js', '/style.css', '/icon-192.png']) {
    const response = await fetch(bridge.origin + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('content-security-policy'), /img-src 'self' data:;/, 'Allow local previews, never remote image hosts');
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await fetch(`${bridge.origin}/private.txt`)).status, 404);
  assert.equal((await fetch(`${bridge.origin}/%2e%2e/extension.mjs`)).status, 404);
});

test('the WebView can open the public app page even when the load is marked cross-site', async (t) => {
  const { bridge, request } = await shellSetup(t);
  for (const origin of [undefined, 'android-app://com.termux', 'https://external.example']) {
    const headers = { ...externalNavigation, ...(origin ? { Origin: origin } : {}) };
    const response = await browserRequest(bridge.origin, '/', headers);
    assert.equal(response.status, 200, origin || 'no Origin header');
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.match(response.body, /Pi Voice/);
    assert.equal(response.body.includes(token), false);
  }
  // Once loaded, its own scripts and authenticated API calls are same-origin.
  assert.equal((await request('/app.js', undefined, { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await request('/api/state', undefined, { Origin: bridge.origin, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
});

test('external navigation exception cannot bypass API protection or the Host check', async (t) => {
  const { bridge, prompts, aborted } = await setup(t);
  for (const path of ['state', 'models', 'model', 'prompt', 'listen', 'listen/cancel', 'abort', 'awake', 'session/new']) {
    const response = await browserRequest(bridge.origin, `/api/${path}`, {
      ...externalNavigation, Authorization: `Bearer ${token}`,
    }, ['state', 'models'].includes(path) ? 'GET' : 'POST');
    assert.equal(response.status, 403, path);
  }
  assert.deepEqual(prompts, []);
  assert.equal(aborted(), 0);
  assert.equal((await browserRequest(bridge.origin, '/', { ...externalNavigation, Host: 'evil.example' })).status, 403);
  assert.equal((await browserRequest(bridge.origin, '/', externalNavigation, 'POST')).status, 403);
});

test('requires authentication for state, prompts, microphone, abort and stay-awake', async (t) => {
  const { bridge } = await setup(t);
  for (const path of ['state', 'models', 'model', 'prompt', 'listen', 'listen/cancel', 'abort', 'awake', 'session/new']) {
    const response = await fetch(`${bridge.origin}/api/${path}`, { method: ['state', 'models'].includes(path) ? 'GET' : 'POST' });
    assert.equal(response.status, 401, path);
  }
});

test('rejects cross-origin, cross-site and DNS rebinding Host requests', async (t) => {
  const { bridge, request } = await setup(t);
  assert.equal((await request('/api/state', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const code = await new Promise((resolve, reject) => {
    http.get(`${bridge.origin}/api/state`, { headers: { Host: 'evil.example', Authorization: `Bearer ${token}` } }, (res) => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(code, 403);
  const valid = await request('/api/state', undefined, { Origin: bridge.origin });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).sessionId, 'session-1');
});

test('delivers text literally and deduplicates lost-response retries', async (t) => {
  const { prompts, request } = await setup(t);
  const body = prompt({ text: '  /new; $(touch /tmp/not-a-command)  ' });
  const responses = await Promise.all([request('/api/prompt', body), request('/api/prompt', body)]);
  assert.deepEqual(responses.map((res) => res.status), [200, 200]);
  assert.deepEqual(prompts, ['/new; $(touch /tmp/not-a-command)']);
  assert.equal((await request('/api/prompt', prompt({ text: 'different' }))).status, 409);
});

test('image messages arrive as validated structured content, deduplicate and allow image-only input', async (t) => {
  const received = [];
  const { request } = await setup(t, {
    onPrompt: (text, images) => { received.push({ text, images }); return { ok: true, queued: false }; },
  });
  const body = prompt({ text: '  /new inspect this screenshot  ', images: [png] });
  const responses = await Promise.all([request('/api/prompt', body), request('/api/prompt', body)]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.deepEqual(received, [{ text: '/new inspect this screenshot', images: [{ type: 'image', ...png }] }]);
  assert.equal((await request('/api/prompt', { ...body, images: [] })).status, 409);
  const imageOnly = prompt({ id: 'image-only-1', text: '', images: [png] });
  assert.equal((await request('/api/prompt', imageOnly)).status, 200);
  assert.equal(received.at(-1).text, '');
  assert.equal((await request('/api/prompt', { ...imageOnly, id: 'stale-image-1', sessionId: 'old-session' })).status, 409);
});

test('image validation rejects unsupported types, invalid envelopes and disguised files', async (t) => {
  const { request, prompts } = await setup(t);
  const cases = [
    [null, 400], [{}, 400], [Array(5).fill(png), 400],
    [[{ ...png, mimeType: 'image/svg+xml' }], 415],
    [[{ ...png, data: 'data:image/png;base64,' + png.data }], 400],
    [[{ ...png, data: 'AAAA===' }], 400],
    [[{ ...png, data: 'AB==' }], 400],
    [[{ ...png, data: Buffer.from('<svg onload="alert(1)">').toString('base64') }], 400],
    [[{ ...png, mimeType: 'image/jpeg' }], 400],
    [[{ ...png, data: 'A'.repeat((imageLimits.maxImageBytes / 3 + 1) * 4) }], 413],
  ];
  for (const [images, status] of cases) {
    const response = await request('/api/prompt', prompt({ images }));
    assert.equal(response.status, status, await response.text());
  }
  // Signature-valid envelopes can still exceed the combined byte budget.
  const bytes = Buffer.alloc(imageLimits.maxImageBytes);
  Buffer.from(png.data, 'base64').copy(bytes);
  const large = { mimeType: 'image/png', data: bytes.toString('base64') };
  const response = await request('/api/prompt', prompt({ images: [large, large, { ...large, data: bytes.subarray(0, 2 * 1024 * 1024 + 1).toString('base64') }] }));
  assert.equal(response.status, 413);
  assert.deepEqual(prompts, []);
});

test('text-only models reject images without sending or silently dropping them', async (t) => {
  const { request, prompts } = await setup(t, {
    getState: () => ({ sessionId: 'session-1', imageAttachments: imageLimits, modelSupportsImages: false }),
  });
  assert.equal((await request('/api/prompt', prompt({ images: [png] }))).status, 422);
  assert.deepEqual(prompts, []);
  assert.equal((await request('/api/prompt', prompt())).status, 200);
  assert.deepEqual(prompts, ['Hello from speech']);
});

test('validates transcript, message IDs and the exact target session', async (t) => {
  const { prompts, request } = await setup(t);
  for (const body of [null, {}, prompt({ text: '' }), prompt({ text: '  ' }), prompt({ text: 12 }), prompt({ text: 'x'.repeat(16001) }), prompt({ id: '!' })]) {
    assert.equal((await request('/api/prompt', body)).status, 400);
  }
  assert.equal((await request('/api/prompt', prompt({ sessionId: 'old-session' }))).status, 409);
  assert.deepEqual(prompts, []);
  assert.equal((await request('/api/abort', { sessionId: 'session-1' })).status, 200);
});

test('Stop Pi rejects stale or missing session IDs without aborting another conversation', async (t) => {
  let sessionId = 'session-1';
  const h = await setup(t, { getState: () => ({ sessionId, busy: true }) });
  for (const body of [{}, null, { sessionId: 123 }]) {
    assert.equal((await h.request('/api/abort', body)).status, 400);
  }
  sessionId = 'session-2';
  assert.equal((await h.request('/api/abort', { sessionId: 'session-1' })).status, 409);
  assert.equal(h.aborted(), 0, 'Stale controls must have no effect');
  assert.equal((await h.request('/api/abort', { sessionId })).status, 200);
  assert.equal(h.aborted(), 1);
});

test('malformed JSON and wrong media types do not reach Pi', async (t) => {
  const { bridge } = await setup(t);
  const badJSON = await fetch(`${bridge.origin}/api/prompt`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(badJSON.status, 400);
  const wrongType = await fetch(`${bridge.origin}/api/prompt`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
});

test('oversized requests return 413 without buffering the entire body or disconnecting', async (t) => {
  const { request, prompts } = await setup(t);
  const response = await request('/api/prompt', prompt({ text: 'x'.repeat(imageLimits.maxRequestBytes) }));
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /too large/);
  assert.deepEqual(prompts, []);
});

test('duplicate IDs are scoped to the target session, not a previous session', async (t) => {
  let sessionId = 'session-1';
  const { request, prompts } = await setup(t, { getState: () => ({ sessionId, messages: [] }) });
  assert.equal((await request('/api/prompt', prompt())).status, 200);
  sessionId = 'session-2';
  assert.equal((await request('/api/prompt', prompt())).status, 409);
  assert.equal((await request('/api/prompt', prompt({ sessionId }))).status, 200);
  assert.deepEqual(prompts, ['Hello from speech', 'Hello from speech']);
});

test('speech result is returned only as a draft, never implicitly submitted', async (t) => {
  const { prompts, request } = await setup(t, { speech: async () => 'recognized words' });
  const response = await request('/api/listen', {});
  assert.deepEqual(await response.json(), { text: 'recognized words' });
  assert.deepEqual(prompts, []);
});

test('speech is single-flight, cancellable and releases the listening lock', async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { request } = await setup(t, { onNewSession: () => ({ ok: true }), speech: ({ signal }) => new Promise((resolve, reject) => {
    started();
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Listening cancelled.'), { status: 409 })), { once: true });
  }) });
  const first = request('/api/listen', {});
  await ready;
  assert.equal((await request('/api/state')).status, 200);
  assert.equal((await request('/api/listen', {})).status, 409);
  assert.equal((await request('/api/session/new', { id: 'new-session-1', sessionId: 'session-1' })).status, 409);
  assert.equal((await request('/api/listen/cancel', {})).status, 200);
  assert.equal((await first).status, 409);
  assert.equal((await (await request('/api/state')).json()).listening, false);
});

test('closing a speech response cancels only its own recognizer, not another tab’s rejected request', { timeout: 5000 }, async (t) => {
  let started, stopped, cancelled = false;
  const ready = new Promise((resolve) => { started = resolve; });
  const closed = new Promise((resolve) => { stopped = resolve; });
  const h = await setup(t, { speech: ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; stopped(); reject(Object.assign(new Error('Cancelled'), { status: 409 })); }, { once: true });
    started();
  }) });
  const headers = { Authorization: `Bearer ${token}` };
  const owner = new AbortController();
  const pending = fetch(`${h.bridge.origin}/api/listen`, { method: 'POST', headers, signal: owner.signal }).catch((error) => error);
  await ready;
  const other = new AbortController();
  const rejected = await fetch(`${h.bridge.origin}/api/listen`, { method: 'POST', headers, signal: other.signal });
  assert.equal(rejected.status, 409);
  other.abort();
  assert.equal(cancelled, false);
  owner.abort();
  await closed;
  assert.equal((await pending).name, 'AbortError');
  assert.deepEqual(h.prompts, []);
});

test('speech errors are reported and do not submit a prompt', async (t) => {
  const { request, prompts } = await setup(t, { speech: async () => { throw Object.assign(new Error('Microphone permission required'), { status: 502 }); } });
  const response = await request('/api/listen', {});
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /permission/);
  assert.deepEqual(prompts, []);
});

test('concurrent bridges use different ports and shutdown releases the port', async (t) => {
  const { bridge } = await setup(t);
  const port = Number(new URL(bridge.origin).port);
  const { bridge: second } = await setup(t, { port });
  assert.notEqual(second.origin, bridge.origin);
  await bridge.close();
  const { bridge: replacement } = await setup(t, { port });
  assert.equal(replacement.origin, bridge.origin);
});

test('new-session route validates session/ID and accepts only authenticated idle control actions', async (t) => {
  const calls = [];
  const state = { sessionId: 'session-1', messages: [], busy: false, pending: false };
  const { request, prompts } = await setup(t, {
    getState: () => state,
    onNewSession: (id, sessionId) => { calls.push({ id, sessionId }); return { ok: true, id }; },
  });
  const body = { id: 'new-session-1', sessionId: 'session-1' };
  for (const invalid of [null, {}, { ...body, id: '/new' }, { ...body, id: 7 }, { ...body, sessionId: null }]) {
    assert.equal((await request('/api/session/new', invalid)).status, 400);
  }
  assert.equal((await request('/api/session/new', { ...body, sessionId: 'old-session' })).status, 409);
  assert.equal((await request('/api/session/new', body, { Origin: 'https://evil.example' })).status, 403);
  for (const key of ['busy', 'pending']) {
    state[key] = true;
    assert.equal((await request('/api/session/new', body)).status, 409);
    state[key] = false;
  }
  assert.deepEqual(calls, []);
  const response = await request('/api/session/new', body);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, id: body.id });
  assert.deepEqual(calls, [body]);
  assert.deepEqual(prompts, [], 'Session control is never a dictated/model prompt');
});

test('new-session support has an actionable fallback; starting sessions reject prompts and recording', async (t) => {
  const { request } = await setup(t);
  const missing = await request('/api/session/new', { id: 'new-session-1', sessionId: 'session-1' });
  assert.equal(missing.status, 501);
  assert.match((await missing.json()).error, /Restart Pi/);
  const { request: switching, prompts } = await setup(t, {
    getState: () => ({ sessionId: 'session-1', newSessionAction: { status: 'starting' } }),
  });
  assert.equal((await switching('/api/prompt', prompt())).status, 409);
  assert.equal((await switching('/api/listen', {})).status, 409);
  assert.deepEqual(prompts, []);
});

test('authenticated stay-awake endpoint validates input and returns the managed lock status', async (t) => {
  const calls = [];
  const { request } = await setup(t, { onAwake: async (enabled) => {
    calls.push(enabled);
    return { active: enabled, error: null };
  } });
  for (const body of [null, {}, { enabled: 'true' }, { enabled: 1 }]) {
    assert.equal((await request('/api/awake', body)).status, 400);
  }
  assert.deepEqual(calls, []);
  const enabled = await request('/api/awake', { enabled: true });
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { wakeLock: { active: true, error: null } });
  assert.equal((await request('/api/awake', { enabled: false })).status, 200);
  assert.deepEqual(calls, [true, false]);
  assert.equal((await request('/api/awake', { enabled: true }, { Origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(calls, [true, false]);
});

test('missing or rejected Android wake-lock support returns an actionable error', async (t) => {
  const { request } = await setup(t);
  assert.equal((await request('/api/awake', { enabled: true })).status, 501);
  const { request: denied } = await setup(t, { onAwake: () => { throw new Error('Android denied the request'); } });
  const response = await denied('/api/awake', { enabled: true });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Android denied/);
});

test('worker rejects another process or instance and has no peer relay or lifecycle manager', async (t) => {
  const { request } = await setup(t, { pid: 111, instanceId: 'worker-instance' });
  assert.equal((await request('/api/state', undefined, { 'X-Pi-Voice-Pid': '222' })).status, 410);
  assert.equal((await request('/api/state', undefined, { 'X-Pi-Voice-Instance': 'stale-instance' })).status, 410);
  assert.equal((await request('/api/state', undefined, { 'X-Pi-Voice-Instance': 'worker-instance' })).status, 200);
  for (const path of ['sessions', 'session/spawn', 'session/restore', 'session/forget']) {
    assert.equal((await request(`/api/${path}`, path === 'sessions' ? undefined : { id: 'operation-1' })).status, 404);
  }
});

test('model routes are explicit, session-scoped and reject unsupported workers or malformed requests', async (t) => {
  const missing = await setup(t);
  assert.equal((await missing.request('/api/models')).status, 501);
  assert.equal((await missing.request('/api/model', { sessionId: 'session-1' })).status, 501);
  const calls = [];
  const list = { sessionId: 'session-1', current: { provider: 'a', id: 'one' }, models: [] };
  const h = await setup(t, { getModels: () => list, onModel: (body) => { calls.push(body); return { ok: true }; } });
  assert.deepEqual(await (await h.request('/api/models')).json(), list);
  for (const body of [null, [], {}, { sessionId: 5 }]) assert.equal((await h.request('/api/model', body)).status, 400);
  assert.equal((await h.request('/api/model', { sessionId: 'stale' })).status, 409);
  assert.equal(calls.length, 0);
  const body = { sessionId: 'session-1', provider: 'a', id: 'two', expectedModel: { provider: 'a', id: 'one' } };
  assert.equal((await h.request('/api/model', body)).status, 200);
  assert.deepEqual(calls, [body]);
  assert.equal((await h.request('/api/model', body, { Origin: 'https://evil.example' })).status, 403);
});

test('worker serializes model changes against prompts, new-session, close and speech controls', async (t) => {
  for (const flag of ['busy', 'pending', 'modelSwitching', 'starting']) {
    let calls = 0;
    const state = { sessionId: 'session-1', messages: [], busy: flag === 'busy', pending: flag === 'pending', modelSwitching: flag === 'modelSwitching', newSessionAction: flag === 'starting' ? { status: 'starting' } : undefined };
    const h = await setup(t, { getState: () => state, onModel: () => { calls++; }, onNewSession: () => { throw new Error('Must not run'); }, onClose: () => { throw new Error('Must not run'); } });
    assert.equal((await h.request('/api/model', { sessionId: 'session-1' })).status, 409, flag);
    assert.equal(calls, 0);
    if (flag !== 'modelSwitching') continue;
    for (const [path, body] of [['prompt', prompt()], ['session/new', { sessionId: 'session-1', id: 'operation-1' }], ['session/close', { sessionId: 'session-1' }], ['listen', {}]]) {
      assert.equal((await h.request(`/api/${path}`, body)).status, 409, path);
    }
    assert.equal(h.prompts.length, 0);
  }
});

test('an active Termux recognizer excludes model changes from another client', async (t) => {
  let finish;
  const h = await setup(t, { onModel: () => { throw new Error('Must not run'); }, speech: () => new Promise((resolve) => { finish = resolve; }) });
  const listening = h.request('/api/listen', {});
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await h.request('/api/model', { sessionId: 'session-1' })).status, 409);
  finish('draft only'); await listening;
});
