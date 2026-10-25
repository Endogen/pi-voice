import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
class Element {
  constructor() {
    this.value = ''; this.checked = false; this.listeners = {}; this.dataset = {}; this.attributes = {};
    this.classes = new Set(); this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
  }
  set textContent(value) { this._text = value; this._html = undefined; }
  get textContent() { return this._text; }
  set innerHTML(value) { this._html = value; this._text = undefined; this.htmlWrites = (this.htmlWrites || 0) + 1; }
  get innerHTML() { return this._html; }
  setAttribute(name, value) { this.attributes[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  append(...children) { this.children = [...(this.children || []), ...children]; }
  replaceChildren(...children) { this.children = children; this.lastElementChild = children.at(-1); }
  click() { this.clicked = (this.clicked || 0) + 1; return this.listeners.click?.(); }
  scrollIntoView() { throw new Error('Conversation updates must not force-scroll.'); }
}
async function setup({ auto = false, speech = true, awake = true, confirmed = true, native = false, playback = false, nativePlayback = true, nativeTerminal = true, nativeReconnect = true } = {}) {
  const elements = new Map();
  const prompts = [];
  const instances = [];
  const nativeCalls = [];
  const nativeBridge = native ? {
    startSpeech: (id, lang) => nativeCalls.push({ method: 'start', id, lang }),
    stopSpeech: (id) => nativeCalls.push({ method: 'stop', id }),
    abortSpeech: (id) => nativeCalls.push({ method: 'abort', id }),
    ...(nativePlayback ? {
      speakText: (id, text, language) => nativeCalls.push({ method: 'read', id, text, language }),
      stopReading: (id) => nativeCalls.push({ method: 'stop-reading', id }),
    } : {}),
    ...(nativeTerminal ? { openTerminal: (session) => nativeCalls.push({ method: 'terminal', session }) } : {}),
    ...(nativeReconnect ? { reconnect: () => nativeCalls.push({ method: 'reconnect' }) } : {}),
  } : undefined;
  const utterances = [];
  class Utterance { constructor(text) { this.text = text; } }
  const synthesis = { cancellations: 0, speak: (utterance) => utterances.push(utterance), cancel() { this.cancellations++; } };
  const values = new Map([['pi-voice-autosend', String(auto)], ['pi-voice-awake', String(awake)]]);
  const state = { pid: 100, sessionId: 'session-one', sessionName: 'Test', cwd: '/project', model: 'test/test', busy: false, messages: [], imageAttachments: true, modelSupportsImages: true };
  const imageProcessing = {
    calls: [], encoded: [], closed: 0,
    async decode(file) { return { width: file.width || 4000, height: file.height || 3000, close() { imageProcessing.closed++; } }; },
    encode(canvas, callback, mimeType, quality) {
      imageProcessing.encoded.push({ width: canvas.width, height: canvas.height, mimeType, quality });
      callback(new Blob([Buffer.from('ffd8ffe000104a46494600ffd9', 'hex')], { type: 'image/jpeg' }));
    },
  };
  class Reader {
    readAsDataURL(blob) {
      void blob.arrayBuffer().then((bytes) => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload(); });
    }
  }
  const requests = [];
  const confirmations = [];
  const stopped = [];
  const sessions = [{ pid: 100, sessionId: 'session-one', title: 'Test', cwd: '/project', busy: false, spawned: false }];
  const network = {
    state: () => Response.json(state),
    sessions: () => Response.json({ self: 100, sessions, stopped }),
    activity: () => Response.json({ version: 1, steps: [], terminal: {} }),
    spawn: () => Response.json({ ok: true }, { status: 202 }),
    close: () => Response.json({ ok: true }, { status: 202 }),
    prompt: () => Response.json({ ok: true, queued: false }),
    newSession: () => Response.json({ ok: true }, { status: 202 }),
    listen: () => Response.json({ text: 'fallback transcript' }),
    awake: (body) => { state.wakeLock = { active: body.enabled }; return Response.json({ wakeLock: state.wakeLock }); },
  };
  class Speech {
    constructor() { instances.push(this); }
    start() {}
    stop() { this.onend(); }
    abort() { this.onerror({ error: 'aborted' }); this.onend(); }
  }
  const document = {
    hidden: false, body: { scrollHeight: 10000 }, listeners: {},
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement(tag) {
      const node = new Element();
      if (tag === 'canvas') {
        node.getContext = () => ({ fillRect() {}, drawImage() {} });
        node.toBlob = (...args) => imageProcessing.encode(node, ...args);
      }
      return node;
    },
    addEventListener(event, callback) { this.listeners[event] = callback; },
  };
  const context = vm.createContext({
    document, window: { SpeechRecognition: speech ? Speech : undefined, PiVoiceAndroid: nativeBridge, innerHeight: 900, scrollY: 0,
      speechSynthesis: playback ? synthesis : undefined, SpeechSynthesisUtterance: playback ? Utterance : undefined },
    location: { hash: '#test-token', pathname: '/' }, history: { replaceState() {} },
    localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    navigator: { language: 'en-US' }, crypto: { randomUUID }, AbortController,
    FileReader: Reader,
    createImageBitmap: async (file, options) => { imageProcessing.calls.push({ file, options }); return imageProcessing.decode(file); },
    setInterval() {}, setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    confirm: (message) => { confirmations.push(message); return confirmed; },
    async fetch(path, options) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      const pid = options.headers['X-Pi-Voice-Pid'];
      requests.push({ path, body, pid });
      if (path === '/api/state') return network.state(pid);
      if (path === '/api/sessions') return network.sessions();
      if (path === '/api/activity') return network.activity(pid);
      if (path === '/api/session/spawn') return network.spawn(body);
      if (path === '/api/session/close') return network.close(body, pid);
      if (path === '/api/session/restore') return Response.json({ ok: true, id: body.id }, { status: 202 });
      if (path === '/api/session/forget') return Response.json({ ok: true });
      if (path === '/api/prompt') { prompts.push(body); return network.prompt(body); }
      if (path === '/api/session/new') return network.newSession(body);
      if (path === '/api/awake') return network.awake(body);
      if (path === '/api/listen') return network.listen(options.signal);
      if (path === '/api/listen/cancel') return Response.json({ ok: true });
      if (path === '/api/abort') { state.busy = false; return Response.json({ ok: true }); }
      throw new Error(`Unexpected API call: ${path}`);
    },
  });
  vm.runInContext(source, context);
  await flush();
  return { elements, prompts, instances, nativeCalls, state, sessions, stopped, context, document, values, network, requests, confirmations, imageProcessing, utterances, synthesis, el: (id) => elements.get(id) };
}
function result(text, final = true) {
  return { results: [Object.assign([{ transcript: text }], { isFinal: final })] };
}

test('completed speech ignores duplicate completion and late callbacks during a later recording', async () => {
  const h = await setup({ auto: true });
  h.el('microphone').click();
  const first = h.instances[0];
  first.onresult(result('First question'));
  first.onend();
  await flush();
  assert.equal(h.prompts.length, 1);
  first.onend();
  await flush();
  assert.equal(h.prompts.length, 1, 'A duplicate end must not send the transcript again');

  h.el('microphone').click();
  const second = h.instances[1];
  second.onresult(result('Second question', false));
  first.onresult(result('Late first question'));
  first.onerror({ error: 'network' });
  first.onend();
  assert.equal(h.el('draft').value, 'Second question');
  assert.equal(h.el('microphone').attributes['aria-pressed'], 'true');
  assert.equal(h.el('send').disabled, true);
  second.onresult(result('Second question'));
  second.onend();
  await flush();
  assert.deepEqual(h.prompts.map((prompt) => prompt.text), ['First question', 'Second question']);
});

test('an acknowledged prompt with no assistant reply does not leave the app permanently busy', async () => {
  const h = await setup();
  h.el('draft').value = 'Task stopped before a reply';
  await vm.runInContext('send()', h.context);
  h.state.messages = [{ id: 'accepted-user', role: 'user', text: 'Task stopped before a reply' }];
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('thinking').hidden, true);
  assert.equal(h.el('abort').hidden, true);
  assert.equal(h.el('new-session').disabled, false);
  assert.match(h.el('latest-answer').textContent, /No reply yet/);
});

const photo = (extra = {}) => ({ name: 'screenshot.png', type: 'image/png', size: 120000, ...extra });
async function attach(h, files = [photo()]) {
  h.context.selectedFiles = files;
  await vm.runInContext('addImages(selectedFiles)', h.context);
}

async function completedReply(h, text = '**Hello** from Pi. [Docs](https://example.com).') {
  h.state.messages = [{ role: 'user', text: 'Question' }, { role: 'assistant', text }];
  await vm.runInContext('poll()', h.context);
}

test('Read aloud is manual, speaks the completed reply without Markdown and never sends a prompt', async () => {
  const h = await setup({ playback: true });
  assert.equal(h.el('read-aloud').hidden, true);
  await completedReply(h);
  assert.equal(h.utterances.length, 0, 'No autoplay on polling or reconnect');
  assert.equal(h.el('read-aloud').disabled, false);
  h.el('read-aloud').click();
  assert.equal(h.utterances[0].text, 'Hello from Pi. Docs.');
  assert.equal(h.el('read-label').textContent, 'Stop reading');
  assert.equal(h.el('read-aloud').attributes['aria-pressed'], 'true');
  assert.equal(h.prompts.length, 0);
  await vm.runInContext('poll()', h.context);
  assert.equal(h.utterances.length, 1, 'Unchanged polling does not restart playback');
  h.utterances[0].onend();
  assert.equal(h.el('read-label').textContent, 'Read aloud');
  assert.equal(h.el('read-aloud').attributes['aria-pressed'], 'false');
});

test('native Read aloud uses Android TTS, ignores old events and keeps recording separate', async () => {
  const h = await setup({ playback: true, native: true });
  await completedReply(h);
  h.el('read-language').value = 'de-DE';
  h.el('read-language').listeners.change();
  assert.equal(h.values.get('pi-voice-read-language'), 'de-DE');
  h.el('read-aloud').click();
  const reading = h.nativeCalls.at(-1);
  assert.equal(reading.method, 'read');
  assert.equal(reading.text, 'Hello from Pi. Docs.');
  assert.equal(reading.language, 'de-DE');
  assert.equal(h.utterances.length, 0);
  h.el('read-aloud').click();
  assert.equal(h.nativeCalls.at(-1).method, 'stop-reading');
  assert.equal(h.nativeCalls.at(-1).id, reading.id);
  h.context.window.__piVoiceNativePlayback(reading.id, 'error', 'unavailable');
  assert.equal(h.el('read-label').textContent, 'Read aloud');
  assert.doesNotMatch(h.el('notice').textContent, /Could not read/);
  assert.equal(h.prompts.length, 0);
});

test('old native shells explain the APK upgrade instead of relying on WebView synthesis', async () => {
  const h = await setup({ playback: true, native: true, nativePlayback: false });
  await completedReply(h);
  assert.equal(h.el('read-aloud').disabled, true);
  assert.match(h.el('read-support').textContent, /APK 0\.1\.2/);
  assert.equal(h.utterances.length, 0);
});

test('starting the microphone stops playback and cannot read a reply into a new prompt', async () => {
  const h = await setup({ playback: true });
  await completedReply(h);
  h.el('read-aloud').click();
  h.el('microphone').click();
  assert.equal(h.synthesis.cancellations, 1);
  assert.equal(h.el('read-aloud').disabled, true);
  h.el('read-aloud').click();
  assert.equal(h.utterances.length, 1);
  h.instances[0].abort();
  assert.equal(h.prompts.length, 0);
});

test('leaving the app stops playback and returning never auto-resumes it', async () => {
  const h = await setup({ playback: true });
  await completedReply(h, 'Long answer. '.repeat(80));
  h.el('read-aloud').click();
  const old = h.utterances[0];
  h.document.hidden = true;
  h.document.listeners.visibilitychange();
  assert.equal(h.synthesis.cancellations, 1);
  old.onend();
  h.document.hidden = false;
  h.document.listeners.visibilitychange();
  await flush();
  assert.equal(h.utterances.length, 1);
  assert.equal(h.el('read-label').textContent, 'Read aloud');
});

for (const change of ['reply', 'session', 'busy', 'send']) {
  test(`reading stops when ${change} changes the displayed reply context`, async () => {
    const h = await setup({ playback: true });
    await completedReply(h);
    h.el('read-aloud').click();
    if (change === 'reply') h.state.messages[1].text = 'A new reply';
    if (change === 'session') h.state.sessionId = 'session-two';
    if (change === 'busy') h.state.busy = true;
    if (change === 'send') { h.el('draft').value = 'Next question'; await vm.runInContext('send()', h.context); }
    else await vm.runInContext('poll()', h.context);
    assert.equal(h.synthesis.cancellations, 1);
    assert.equal(h.el('read-label').textContent, 'Read aloud');
  });
}

test('speech playback errors preserve the reply and draft and permit manual retry', async () => {
  const h = await setup({ playback: true });
  await completedReply(h);
  h.el('draft').value = 'Unsent draft';
  h.el('read-aloud').click();
  h.utterances[0].onerror({ error: 'synthesis-unavailable' });
  assert.match(h.el('notice').textContent, /Could not read/);
  assert.equal(h.el('draft').value, 'Unsent draft');
  assert.equal(h.el('read-aloud').disabled, false);
  h.el('read-aloud').click();
  assert.equal(h.utterances.length, 2);
  h.el('read-aloud').click();
});

test('picker prepares bounded JPEG previews, sends text plus images and clears only after acceptance', async () => {
  const h = await setup();
  h.el('attach').click();
  assert.equal(h.el('image-input').clicked, 1);
  h.el('image-input').files = [photo()];
  h.el('image-input').value = 'selected-file';
  h.el('image-input').listeners.change();
  await flush();
  assert.equal(h.el('image-input').value, '', 'The same file can be picked again after removal');
  assert.equal(h.prompts.length, 0);
  assert.equal(h.el('attachments').hidden, false);
  assert.match(h.el('attachments').children[0].children[0].src, /^data:image\/jpeg;base64,/);
  assert.equal(h.imageProcessing.encoded[0].width, 2048);
  assert.equal(h.imageProcessing.encoded[0].height, 1536);
  assert.equal(h.imageProcessing.encoded[0].mimeType, 'image/jpeg');
  assert.equal(h.imageProcessing.calls[0].options.imageOrientation, 'from-image');
  assert.equal(h.imageProcessing.closed, 1);
  assert.equal(h.el('send').disabled, false, 'Image-only send is allowed');
  h.el('draft').value = 'What does this screenshot mean?';
  let complete;
  h.network.prompt = () => new Promise((resolve) => { complete = resolve; });
  const sending = vm.runInContext('send()', h.context);
  assert.equal(h.el('attachments').hidden, false);
  assert.equal(h.el('attach').disabled, true);
  assert.match(h.el('latest-question').textContent, /\[1 image attached\]/);
  assert.equal(h.prompts[0].images.length, 1);
  assert.equal(h.prompts[0].images[0].mimeType, 'image/jpeg');
  assert.equal(h.prompts[0].images[0].name, undefined, 'Local filename is not sent to Pi');
  complete(Response.json({ ok: true, queued: false }));
  await sending;
  assert.equal(h.el('draft').value, '');
  assert.equal(h.el('attachments').hidden, true);
});

test('failed image sends preserve previews and reuse the same ID on unchanged manual retries', async () => {
  const h = await setup();
  await attach(h);
  h.network.prompt = () => { throw new TypeError('Lost acknowledgement'); };
  await vm.runInContext('send()', h.context);
  assert.equal(h.el('attachments').hidden, false);
  assert.match(h.el('notice').textContent, /text and images are kept/);
  const first = h.prompts[0];
  await vm.runInContext('send()', h.context);
  assert.equal(h.prompts[1].id, first.id);
  assert.deepEqual(h.prompts[1].images, first.images);
  await attach(h, [photo({ name: 'another.png' })]);
  await vm.runInContext('send()', h.context);
  assert.notEqual(h.prompts[2].id, first.id, 'Changing attachments is a new message');
  assert.equal(h.prompts[2].images.length, 2);
});

test('previews can be removed; Clear clears text and images without sending anything', async () => {
  const h = await setup();
  await attach(h, [photo(), photo({ name: '<img onerror=alert(1)>.png' })]);
  assert.equal(h.el('attachments').children[1].children[1].textContent, '<img onerror=alert(1)>.png');
  h.el('attachments').children[0].children[2].click();
  assert.equal(h.el('attachments').children.length, 1);
  h.el('draft').value = 'discard this too';
  h.el('clear').click();
  assert.equal(h.el('attachments').hidden, true);
  assert.equal(h.el('draft').value, '');
  assert.equal(h.el('send').disabled, true);
  assert.deepEqual(h.prompts, []);
});

test('speech auto-send never uploads attached images without a Send tap', async () => {
  const h = await setup({ auto: true });
  await attach(h);
  h.el('microphone').click();
  h.instances[0].onresult(result('Explain this photo'));
  h.instances[0].onend();
  await flush();
  assert.equal(h.el('draft').value, 'Explain this photo');
  assert.match(h.el('notice').textContent, /Transcript and images ready/);
  assert.equal(h.el('listening').textContent, 'Review images, then send');
  assert.equal(h.el('attachments').hidden, false);
  assert.deepEqual(h.prompts, []);
});

test('old backends and text-only models cannot silently discard selected images', async () => {
  const h = await setup();
  h.state.imageAttachments = undefined;
  await vm.runInContext('poll()', h.context);
  h.el('attach').click();
  assert.match(h.el('notice').textContent, /Restart Pi once/);
  assert.equal(h.el('image-input').clicked, undefined);
  h.state.imageAttachments = true;
  h.state.modelSupportsImages = false;
  await vm.runInContext('poll()', h.context);
  await attach(h);
  assert.match(h.el('notice').textContent, /vision-capable/);
  assert.equal(h.imageProcessing.calls.length, 0);
  h.state.modelSupportsImages = true;
  await vm.runInContext('poll()', h.context);
  await attach(h);
  h.state.modelSupportsImages = false;
  await vm.runInContext('poll()', h.context);
  h.el('draft').value = 'Keep the image with this';
  await vm.runInContext('send()', h.context);
  assert.deepEqual(h.prompts, []);
  assert.equal(h.el('attachments').hidden, false);
  assert.equal(h.el('draft').value, 'Keep the image with this');
});

test('image preparation rejects excess count, size, type, decode failures and huge dimensions atomically', async () => {
  const h = await setup();
  await attach(h, Array(5).fill(photo()));
  assert.match(h.el('notice').textContent, /at most 4/);
  for (const file of [photo({ size: 16 * 1024 * 1024 }), photo({ type: 'image/svg+xml' })]) {
    await attach(h, [file]);
    assert.match(h.el('notice').textContent, /15 MiB/);
  }
  assert.equal(h.imageProcessing.calls.length, 0);
  await attach(h, [photo({ width: 10000, height: 10000 })]);
  assert.match(h.el('notice').textContent, /40 megapixels/);
  assert.equal(h.imageProcessing.closed, 1);
  h.imageProcessing.decode = async () => { throw new Error('Invalid image'); };
  await attach(h);
  assert.match(h.el('notice').textContent, /Could not decode/);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.el('attach').disabled, false);
});

test('prepared image size limits and encoder failures keep the existing selection unchanged', async () => {
  const h = await setup();
  await attach(h);
  const original = h.el('attachments').children;
  h.imageProcessing.encode = (_canvas, callback) => callback(null);
  await attach(h);
  assert.match(h.el('notice').textContent, /Could not prepare/);
  assert.equal(h.el('attachments').children, original);
  h.imageProcessing.encode = (_canvas, callback) => callback(new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: 'image/jpeg' }));
  await attach(h);
  assert.match(h.el('notice').textContent, /exceeds 3 MiB/);
  assert.equal(h.el('attachments').children, original);
  // Use a size-reporting blob stub to exercise the combined limit without
  // allocating megabytes of irrelevant pixel data in this DOM simulation.
  h.imageProcessing.encode = (_canvas, callback) => callback({ size: 3 * 1024 * 1024, type: 'image/jpeg', arrayBuffer: async () => Buffer.from('ffd8ffffd9', 'hex') });
  await attach(h, [photo(), photo(), photo()]);
  assert.match(h.el('notice').textContent, /8 MiB total/);
  assert.equal(h.el('attachments').children, original);
  assert.equal(h.prompts.length, 0);
});

test('preparing images locks editing/sending and discards selections if Pi switches sessions meanwhile', async () => {
  const h = await setup();
  let decode;
  h.imageProcessing.decode = () => new Promise((resolve) => { decode = resolve; });
  h.context.selectedFiles = [photo()];
  const preparing = vm.runInContext('addImages(selectedFiles)', h.context);
  assert.equal(h.el('new-session').disabled, true);
  assert.equal(h.el('microphone').disabled, true);
  assert.equal(h.el('send').disabled, true);
  h.state.sessionId = 'different-session';
  await vm.runInContext('poll()', h.context);
  decode({ width: 400, height: 300, close() {} });
  await preparing;
  assert.match(h.el('notice').textContent, /select them again/);
  assert.equal(h.el('attachments').hidden, true, 'No previews were attached');
  assert.equal(h.prompts.length, 0);
});

test('image-only questions remain visible in the focus view and history after Pi acknowledges them', async () => {
  const h = await setup();
  await attach(h);
  await vm.runInContext('send()', h.context);
  h.state.messages = [{ id: 'image-question', role: 'user', text: '', imageCount: 1 }, { id: 'image-answer', role: 'assistant', text: 'It is a screenshot.' }];
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('question-card').hidden, false);
  assert.equal(h.el('latest-question').textContent, '[1 image attached]');
  assert.match(h.el('latest-answer').innerHTML, /It is a screenshot/);
  assert.equal(h.el('thinking').hidden, true);
  h.el('open-history').click();
  assert.equal(h.el('messages').children[1].children[1].textContent, '[1 image attached]');
});

test('New always spawns once, keeps the original listed and preserves the unsent draft and images', async () => {
  const h = await setup({ auto: true });
  await attach(h);
  h.state.messages = [{ role: 'user', text: 'Old question' }, { role: 'assistant', text: 'Old answer' }];
  h.el('draft').value = 'unsent words';
  h.el('open-history').click();
  await vm.runInContext('poll()', h.context);
  await vm.runInContext('startNewSession(); startNewSession()', h.context);
  assert.equal(h.requests.filter((r) => r.path === '/api/session/spawn').length, 1);
  assert.equal(h.requests.some((r) => r.path === '/api/session/new'), false, 'Never replace the original runtime');
  const { body } = h.requests.find((r) => r.path === '/api/session/spawn');
  assert.ok(body.id);
  assert.equal(h.el('draft').value, 'unsent words');
  assert.equal(h.el('attachments').hidden, false);
  assert.equal(h.el('draft').readOnly, true);
  assert.equal(h.el('new-session').disabled, true);
  assert.equal(h.el('send').disabled, true);
  assert.equal(h.el('microphone').disabled, true);
  h.sessions.push({ pid: 200, sessionId: 'session-two', title: 'New session', spawnId: body.id, spawned: true });
  h.network.state = (pid) => Response.json(pid === '200' ? { ...h.state, pid: 200, sessionId: 'session-two', messages: [] } : h.state);
  await vm.runInContext('pollSessions()', h.context);
  await flush();
  assert.equal(h.el('draft').value, 'unsent words');
  assert.equal(h.el('draft').readOnly, false);
  assert.equal(h.el('attachments').hidden, false);
  assert.equal(h.el('new-session').disabled, false);
  assert.equal(h.el('autosend').checked, true);
  assert.equal(h.el('question-card').hidden, true);
  assert.equal(h.el('latest-answer').textContent, 'Tap the microphone or type a question below.');
  assert.deepEqual(h.el('messages').children, []);
  assert.match(h.el('notice').textContent, /New session ready/);
  h.el('open-sessions').click();
  assert.equal(h.el('session-list').children.length, 2);
  h.el('session-list').children[0].children[0].click();
  await flush();
  assert.match(h.el('latest-answer').innerHTML, /Old answer/);
  assert.equal(h.el('draft').value, 'unsent words');
  assert.equal(h.el('attachments').hidden, false);
  assert.deepEqual(h.prompts, [], 'Nothing is silently sent to either session');
});

test('cancelling New session leaves the conversation and draft unchanged', async () => {
  const h = await setup({ confirmed: false });
  await attach(h);
  h.el('draft').value = 'keep me';
  await vm.runInContext('startNewSession()', h.context);
  assert.equal(h.requests.some((r) => ['/api/session/new', '/api/session/spawn'].includes(r.path)), false);
  assert.equal(h.el('draft').value, 'keep me');
  assert.equal(h.el('attachments').hidden, false);
  assert.equal(h.el('new-session').disabled, false);
});

test('New keeps even an ephemeral original running rather than replacing it or claiming it is saved', async () => {
  const h = await setup();
  h.state.sessionPersistent = false;
  await vm.runInContext('poll()', h.context);
  await vm.runInContext('startNewSession()', h.context);
  assert.match(h.confirmations[0], /keeps running/);
  assert.doesNotMatch(h.confirmations[0], /saved/);
  assert.equal(h.requests.some((r) => r.path === '/api/session/new'), false);
  assert.equal(h.state.sessionId, 'session-one');
});

test('New stays available while Pi is busy but never while speech is recording', async () => {
  const h = await setup();
  for (const key of ['busy', 'pending']) {
    h.state[key] = true;
    await vm.runInContext('poll()', h.context);
    assert.equal(h.el('new-session').disabled, false, 'A busy Pi gets a parallel session instead');
    h.state[key] = false;
  }
  await vm.runInContext('poll()', h.context);
  h.el('microphone').listeners.click();
  assert.equal(h.el('new-session').disabled, true);
  await vm.runInContext('startNewSession()', h.context);
  assert.equal(h.requests.some((r) => ['/api/session/new', '/api/session/spawn'].includes(r.path)), false);
});

for (const working of ['busy', 'pending']) test(`New while Pi is ${working} starts a parallel session and can switch back before a reply`, async () => {
  const h = await setup({ auto: true });
  h.state[working] = true;
  await vm.runInContext('poll()', h.context);
  await vm.runInContext('startNewSession()', h.context);
  assert.match(h.confirmations.at(-1), /keeps running/);
  const spawn = h.requests.find((r) => r.path === '/api/session/spawn');
  assert.ok(spawn, 'The busy session is not replaced');
  assert.equal(h.requests.some((r) => r.path === '/api/session/new'), false);
  assert.equal(h.el('new-session').disabled, true, 'A second New waits for the first parallel session');
  h.sessions.push({ pid: 200, sessionId: 'session-two', title: 'New session', cwd: '/project', busy: false, spawned: true, spawnId: spawn.body.id });
  h.network.state = (pid) => Response.json(pid === '200' ? { ...h.state, pid: 200, sessionId: 'session-two', busy: false, title: 'New session' } : h.state);
  await vm.runInContext('pollSessions()', h.context);
  await flush();
  assert.equal(h.requests.at(-1).pid, '200', 'Later requests go to the new Pi through this bridge');
  assert.equal(h.el('session-title').textContent, 'New session');
  assert.match(h.el('notice').textContent, /previous one keeps running/);
  assert.equal(h.el('autosend').checked, true, 'A switch the user asked for does not reset auto-send');
  assert.equal(h.values.get('pi-voice-session-pid'), '200');
  h.el('draft').value = 'question for the new session';
  await vm.runInContext('send()', h.context);
  assert.equal(h.prompts.at(-1).sessionId, 'session-two');
  assert.equal(h.requests.find((r) => r.path === '/api/prompt').pid, '200');
  h.el('open-sessions').click();
  assert.equal(h.el('session-list').children.length, 2);
  h.el('session-list').children[0].children[0].click();
  await flush();
  assert.equal(h.values.get('pi-voice-session-pid'), '');
  assert.equal(h.state[working], true, 'The first task is still running, with no reply needed to switch');
  assert.equal(h.el('thinking').hidden, false);
  assert.equal(h.el('new-session').disabled, false);
  h.el('open-sessions').click();
  assert.equal(h.el('session-list').children.length, 2, 'Both sessions remain in the list');
  h.el('session-list').children[1].children[0].click();
  await flush();
  assert.equal(h.values.get('pi-voice-session-pid'), '200');
});

test('a background session that finishes is flagged, and switching back clears the flag', async () => {
  const h = await setup();
  h.sessions.push({ pid: 200, sessionId: 'session-two', title: 'Background', cwd: '/project', busy: true, spawned: true });
  await vm.runInContext('pollSessions()', h.context);
  assert.equal(h.el('sessions-badge').hidden, false);
  assert.equal(h.el('sessions-badge').textContent, '2');
  h.sessions[1].busy = false;
  await vm.runInContext('pollSessions()', h.context);
  assert.equal(h.el('sessions-badge').classes.has('unread'), true);
  h.el('open-sessions').click();
  const rows = h.el('session-list').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children.length, 1, 'The session hosting this page cannot be closed from it');
  assert.equal(rows[1].children.length, 2, 'App-started sessions can be closed');
  h.network.state = (pid) => Response.json(pid === '200' ? { ...h.state, pid: 200, sessionId: 'session-two' } : h.state);
  rows[1].children[0].listeners.click();
  await flush();
  assert.equal(h.el('sessions-dialog').open, false);
  assert.equal(h.el('sessions-badge').classes.has('unread'), false);
  assert.doesNotMatch(h.el('notice').textContent || '', /Pi switched sessions/);
});

test('closing a parallel session targets that Pi and a vanished session falls back to the main one', async () => {
  const h = await setup();
  h.sessions.push({ pid: 200, sessionId: 'session-two', title: 'Background', cwd: '/project', busy: true, spawned: true });
  await vm.runInContext('pollSessions()', h.context);
  h.el('open-sessions').click();
  await h.el('session-list').children[1].children[1].listeners.click();
  assert.match(h.confirmations.at(-1), /still working/);
  const close = h.requests.find((r) => r.path === '/api/session/close');
  assert.deepEqual([close.pid, close.body.sessionId], ['200', 'session-two']);

  h.network.state = (pid) => pid === '300' ? Response.json({ error: 'That session is no longer running.' }, { status: 410 }) : Response.json(h.state);
  await vm.runInContext('selectTarget(300); poll()', h.context);
  await flush();
  assert.match(h.el('notice').textContent, /has ended/);
  assert.equal(h.requests.at(-1).pid, undefined);
  assert.equal(h.el('session-title').textContent, 'Test');
});

test('older backends without session switching keep working', async () => {
  const h = await setup();
  h.network.sessions = () => Response.json({ error: 'Not found.' }, { status: 404 });
  await vm.runInContext('pollSessions()', h.context);
  h.el('open-sessions').click();
  assert.match(h.el('sessions-hint').textContent, /Restart Pi once/);
  h.state.busy = true;
  await vm.runInContext('poll()', h.context);
  await vm.runInContext('startNewSession()', h.context);
  assert.match(h.el('notice').textContent, /Restart Pi once to run sessions in parallel/);
});

test('unsupported backend and session limit errors keep the draft and re-enable New', async () => {
  const h = await setup();
  h.el('draft').value = 'keep this draft';
  for (const status of [404, 501, 409]) {
    h.network.spawn = () => Response.json({ error: status === 409 ? 'Up to 4 sessions can run at once.' : 'Not supported' }, { status });
    await vm.runInContext('startNewSession()', h.context);
    assert.match(h.el('notice').textContent, status === 409 ? /Up to 4 sessions/ : /Restart Pi once/);
    assert.equal(h.el('new-session').disabled, false);
    assert.equal(h.el('draft').value, 'keep this draft');
    assert.equal(h.state.sessionId, 'session-one');
  }
  assert.equal(h.requests.some((r) => r.path === '/api/session/new'), false);
});

test('New discovers the spawned Pi after a lost acknowledgement without launching a duplicate', async () => {
  const h = await setup();
  h.el('draft').value = 'keep on success too';
  h.network.spawn = () => { throw new TypeError('Network closed after launching Pi'); };
  await vm.runInContext('startNewSession()', h.context);
  assert.match(h.el('notice').textContent, /Checking whether/);
  assert.equal(h.el('new-session').disabled, true);
  await vm.runInContext('startNewSession()', h.context);
  const { body } = h.requests.find((r) => r.path === '/api/session/spawn');
  h.sessions.push({ pid: 200, sessionId: 'session-two', spawnId: body.id });
  h.network.state = (pid) => Response.json(pid === '200' ? { ...h.state, pid: 200, sessionId: 'session-two' } : h.state);
  await vm.runInContext('pollSessions()', h.context);
  await flush();
  assert.equal(h.el('draft').value, 'keep on success too');
  assert.equal(h.el('new-session').disabled, false);
  assert.equal(h.values.get('pi-voice-session-pid'), '200');
  assert.equal(h.requests.filter((r) => r.path === '/api/session/spawn').length, 1);
});

test('New session timeout never clears an unconfirmed draft', async () => {
  const h = await setup();
  h.el('draft').value = 'still here';
  await vm.runInContext('startNewSession()', h.context);
  await vm.runInContext('spawnRequest.deadline = 0; pollSessions()', h.context);
  assert.match(h.el('notice').textContent, /did not start in time/);
  assert.equal(h.el('draft').value, 'still here');
  assert.equal(h.el('new-session').disabled, false);
});

test('a stopped Pi offers Reconnect, and returning to the app reconnects once by itself', async () => {
  const h = await setup({ native: true });
  assert.equal(h.el('reconnect').hidden, true, 'Nothing to reconnect while Pi answers');
  h.network.state = () => { throw new Error('Server stopped'); };
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('connection').textContent, 'Disconnected');
  assert.match(h.el('notice').textContent, /Tap Reconnect/);
  assert.equal(h.el('reconnect').hidden, false);
  assert.equal(h.nativeCalls.some((call) => call.method === 'reconnect'), false, 'Polling alone never restarts Pi');
  h.el('reconnect').click();
  assert.equal(h.nativeCalls.filter((call) => call.method === 'reconnect').length, 1);
  h.document.listeners.visibilitychange();
  await flush();
  await vm.runInContext('poll()', h.context);
  assert.equal(h.nativeCalls.filter((call) => call.method === 'reconnect').length, 2, 'One automatic attempt after returning');
  await vm.runInContext('poll()', h.context);
  assert.equal(h.nativeCalls.filter((call) => call.method === 'reconnect').length, 2, 'No retry loop');
});

test('without a reconnect-capable native shell the app explains how to restart Pi', async () => {
  const old = await setup({ native: true, nativeReconnect: false });
  old.network.state = () => { throw new Error('Server stopped'); };
  await vm.runInContext('poll()', old.context);
  assert.match(old.el('notice').textContent, /Update Pi Voice Native/);
  assert.equal(old.el('reconnect').hidden, true);
  const page = await setup();
  page.network.state = () => { throw new Error('Server stopped'); };
  await vm.runInContext('poll()', page.context);
  assert.match(page.el('notice').textContent, /Open Pi Voice Native/);
});

test('sessions that stopped earlier can be restored or dismissed by PID only', async () => {
  const h = await setup();
  h.stopped.push({ pid: 4321, title: 'Refactor bridge', cwd: '/project', updated: Date.now() - 2 * 3600000 });
  await vm.runInContext('pollSessions()', h.context);
  assert.equal(h.el('restore-banner').hidden, false);
  assert.equal(h.el('restore-label').textContent, '1 earlier session stopped · Restore');
  h.el('restore-banner').click();
  assert.equal(h.el('sessions-dialog').open, true);
  const [row] = h.el('stopped-list').children;
  assert.match(row.children[0].children[1].children[1].textContent, /Stopped · 2 h ago · project/);
  await row.children[1].listeners.click();
  const restore = h.requests.find((r) => r.path === '/api/session/restore');
  assert.deepEqual(Object.keys(restore.body).sort(), ['id', 'pid'], 'No paths are sent from the page');
  assert.equal(restore.body.pid, 4321);
  h.stopped.length = 0;
  h.sessions.push({ pid: 500, sessionId: 'restored', title: 'Refactor bridge', cwd: '/project', spawned: true, spawnId: restore.body.id });
  h.network.state = (pid) => Response.json(pid === '500' ? { ...h.state, pid: 500, sessionId: 'restored' } : h.state);
  await vm.runInContext('pollSessions()', h.context);
  await flush();
  assert.equal(h.requests.at(-1).pid, '500');
  assert.match(h.el('notice').textContent, /Session restored/);
  assert.equal(h.el('restore-banner').hidden, true);
  h.stopped.push({ pid: 9876, title: 'Old', cwd: '/x', updated: Date.now() });
  await vm.runInContext('pollSessions()', h.context);
  vm.runInContext('renderSessions()', h.context);
  await h.el('stopped-list').children[0].children[2].listeners.click();
  assert.equal(h.requests.at(-1).path, '/api/session/forget');
  assert.equal(h.requests.at(-1).body.pid, 9876);
});

test('speech is user-initiated and review-before-send is the default', async () => {
  const h = await setup();
  assert.equal(h.instances.length, 0);
  h.el('microphone').listeners.click();
  const engine = h.instances[0];
  engine.onresult(result('please inspect the project'));
  engine.onend();
  await flush();
  assert.equal(h.el('draft').value, 'please inspect the project');
  assert.equal(h.prompts.length, 0);
  h.el('send').listeners.click();
  await flush();
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].text, 'please inspect the project');
  assert.equal(h.prompts[0].sessionId, 'session-one');
  assert.equal(h.el('draft').value, '');
});

test('auto-send submits final speech exactly once, not interim results', async () => {
  const h = await setup({ auto: true });
  h.el('microphone').listeners.click();
  const engine = h.instances[0];
  engine.onresult(result('partial words', false));
  assert.equal(h.prompts.length, 0);
  engine.onresult(result('finished words'));
  assert.equal(h.prompts.length, 0);
  engine.onend();
  await flush();
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].text, 'finished words');
});

test('permission errors and no-speech never auto-send a pre-existing draft', async () => {
  const h = await setup({ auto: true });
  h.el('draft').value = 'keep this unsent';
  h.el('microphone').listeners.click();
  h.instances[0].onerror({ error: 'not-allowed' });
  h.instances[0].onend();
  await flush();
  assert.equal(h.prompts.length, 0);
  assert.equal(h.el('draft').value, 'keep this unsent');
  assert.match(h.el('notice').textContent, /microphone permission/);
  h.el('microphone').listeners.click();
  h.instances[1].onend();
  await flush();
  assert.equal(h.prompts.length, 0);
  assert.equal(h.el('draft').value, 'keep this unsent');
});

test('switching sessions during speech disables auto-send and cancels recording', async () => {
  const h = await setup({ auto: true });
  h.el('microphone').listeners.click();
  h.instances[0].onresult(result('do not send into the wrong session'));
  h.state.sessionId = 'session-two';
  await vm.runInContext('poll()', h.context);
  await flush();
  assert.equal(h.el('autosend').checked, false);
  assert.equal(h.prompts.length, 0);
});

test('backgrounding browser speech cancels without sending', async () => {
  const h = await setup({ auto: true });
  h.el('microphone').listeners.click();
  h.instances[0].onresult(result('not yet sent'));
  h.document.hidden = true;
  h.document.listeners.visibilitychange();
  await flush();
  assert.equal(h.prompts.length, 0);
});

test('backgrounding Termux fallback aborts recording and never auto-sends a late result', async () => {
  const h = await setup({ auto: true, speech: false });
  h.el('engine').value = 'termux';
  h.el('draft').value = 'keep this draft';
  let complete, signal;
  h.network.listen = (requestSignal) => { signal = requestSignal; return new Promise((resolve) => { complete = resolve; }); };
  const recording = vm.runInContext('startSpeech()', h.context);
  h.document.hidden = true;
  h.document.listeners.visibilitychange();
  // Simulate a final HTTP result already in flight when cancellation occurs.
  complete(Response.json({ text: 'do not send this while hidden' }));
  await recording;
  assert.equal(h.prompts.length, 0);
  assert.equal(signal.aborted, true);
  assert.equal(h.requests.filter((r) => r.path === '/api/listen/cancel').length, 0, 'Cancel only this request, never another tab’s recognizer');
  assert.equal(h.el('draft').value, 'keep this draft');
  assert.match(h.el('notice').textContent, /cancelled/);
});

test('Stop Pi sends the displayed session ID rather than a sessionless abort', async () => {
  const h = await setup();
  h.state.busy = true;
  await vm.runInContext('poll()', h.context);
  await h.el('abort').click();
  const request = h.requests.find((r) => r.path === '/api/abort');
  assert.deepEqual(request.body, { sessionId: 'session-one' });
});

test('shows newest messages first without mutating session order or forcing scroll', async () => {
  const h = await setup();
  h.el('open-history').listeners.click();
  h.context.window.scrollY = 9500; // Previously triggered the old scroll-to-bottom code.
  h.state.messages = [
    { role: 'user', text: 'First question' },
    { role: 'assistant', text: 'First answer' },
    { role: 'user', text: 'Latest question' },
    { role: 'assistant', text: 'Latest answer' },
  ];
  await vm.runInContext('poll()', h.context);
  const articles = h.el('messages').children;
  assert.match(articles[0].children[1].innerHTML, /Latest answer/);
  assert.equal(articles[1].children[1].textContent, 'Latest question');
  assert.match(articles[2].children[1].innerHTML, /First answer/);
  assert.equal(articles[3].children[1].textContent, 'First question');
  assert.equal(h.state.messages[0].text, 'First question');
  assert.equal(h.el('connection').textContent, 'Ready · project');
  h.state.messages.push({ role: 'assistant', text: '**New reply**' });
  await vm.runInContext('poll()', h.context);
  assert.match(h.el('messages').children[0].children[1].innerHTML, /<strong>New reply<\/strong>/);
  assert.equal(h.el('connection').textContent, 'Ready · project');
  const unchanged = h.el('messages').children;
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('messages').children, unchanged, 'unchanged polling should not rebuild the DOM');
});

test('formats assistant Markdown but keeps user transcripts as literal text', async () => {
  const h = await setup();
  h.el('open-history').listeners.click();
  const text = '## Heading\n\n**Bold** with `code`\n\n- item\n- another';
  h.state.messages = [{ role: 'user', text }, { role: 'assistant', text }];
  await vm.runInContext('poll()', h.context);
  const assistant = h.el('messages').children[0];
  assert.equal(assistant.children[0].className, 'message-role');
  assert.equal(assistant.children[1].className, 'message-body markdown-body');
  assert.match(assistant.children[1].innerHTML, /<h2>Heading<\/h2>/);
  assert.match(assistant.children[1].innerHTML, /<strong>Bold<\/strong>/);
  assert.match(assistant.children[1].innerHTML, /<code>code<\/code>/);
  assert.match(assistant.children[1].innerHTML, /<ul>/);
  const user = h.el('messages').children[1].children[1];
  assert.equal(user.className, 'message-body plain-text');
  assert.equal(user.textContent, text);
  assert.equal(user.innerHTML, undefined);
});

test('escapes untrusted raw HTML instead of injecting executable elements', async () => {
  const h = await setup();
  h.el('open-history').listeners.click();
  h.state.messages = [{ role: 'assistant', text: '<img src=x onerror=alert(1)>' }];
  await vm.runInContext('poll()', h.context);
  const textElement = h.el('messages').children[0].children[1];
  assert.match(textElement.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(textElement.innerHTML.includes('<img'), false);
});

test('falls back to plain text if Markdown rendering fails without disconnecting', async () => {
  const h = await setup();
  h.el('open-history').listeners.click();
  h.context.PiVoiceMarkdown = { render() { throw new Error('simulated parser failure'); } };
  h.state.messages = [{ role: 'assistant', text: '<strong>Still visible</strong>' }];
  await vm.runInContext('poll()', h.context);
  const textElement = h.el('messages').children[0].children[1];
  assert.equal(textElement.className, 'message-body plain-text');
  assert.equal(textElement.textContent, '<strong>Still visible</strong>');
  assert.equal(textElement.innerHTML, undefined);
  assert.equal(h.el('connection').textContent, 'Ready · project');
});

test('focus view shows only the latest question and its answer without opening history', async () => {
  const h = await setup();
  h.state.messages = [
    { id: 'q1', role: 'user', text: 'Old question' }, { id: 'a1', role: 'assistant', text: 'Old answer' },
    { id: 'q2', role: 'user', text: 'Latest question' }, { id: 'a2', role: 'assistant', text: '**Latest answer**' },
  ];
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('latest-question').textContent, 'Latest question');
  assert.match(h.el('latest-answer').innerHTML, /<strong>Latest answer<\/strong>/);
  assert.doesNotMatch(h.el('latest-answer').innerHTML, /Old answer/);
  assert.equal(h.el('history-dialog').open, undefined);
  assert.equal(h.el('messages'), undefined, 'history parsing is deferred until opened');
});

test('a new question never displays the preceding question’s old answer', async () => {
  const h = await setup();
  h.state.messages = [
    { role: 'user', text: 'First question' }, { role: 'assistant', text: 'First answer' },
    { role: 'user', text: 'Second question' },
  ];
  h.state.busy = true;
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('latest-question').textContent, 'Second question');
  assert.equal(h.el('latest-answer').innerHTML, undefined);
  assert.match(h.el('latest-answer').textContent, /Working/);
});

test('thinking indicator tracks busy state, queued work and completed replies', async () => {
  const h = await setup();
  assert.equal(h.el('thinking').hidden, true);
  h.state.busy = true;
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('thinking').hidden, false);
  assert.equal(h.el('thinking-label').textContent, 'Pi is thinking…');
  assert.equal(h.el('latest-answer').attributes['aria-busy'], 'true');
  assert.equal(h.el('abort').hidden, false);
  h.state.pending = true;
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('thinking-label').textContent, 'Follow-up queued');
  h.state.busy = false;
  h.state.pending = false;
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('thinking').hidden, true);
  assert.equal(h.el('abort').hidden, true);
  assert.equal(h.el('latest-answer').attributes['aria-busy'], 'false');
});

test('shows the submitted question immediately and keeps activity visible until Pi acknowledges it', async () => {
  const h = await setup();
  let finish;
  h.network.prompt = () => new Promise((resolve) => { finish = resolve; });
  h.el('draft').value = 'Start this task';
  h.el('send').listeners.click();
  assert.equal(h.el('thinking').hidden, false);
  assert.equal(h.el('thinking-label').textContent, 'Sending…');
  assert.equal(h.el('latest-question').textContent, 'Start this task');
  finish(Response.json({ ok: true, queued: false }));
  await flush();
  assert.equal(h.el('thinking').hidden, false);
  h.state.messages = [{ id: 'new-question', role: 'user', text: 'Start this task' }];
  h.state.busy = true;
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('thinking').hidden, false);
  h.state.messages.push({ id: 'new-reply', role: 'assistant', text: 'All done' });
  h.state.busy = false;
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('thinking').hidden, true);
  assert.match(h.el('latest-answer').innerHTML, /All done/);
});

test('failed submission clears the optimistic activity, keeps the draft and restores the actual reply', async () => {
  const h = await setup();
  h.state.messages = [{ role: 'user', text: 'Earlier' }, { role: 'assistant', text: 'Earlier reply' }];
  await vm.runInContext('poll()', h.context);
  h.network.prompt = () => Response.json({ error: 'Not accepted' }, { status: 409 });
  h.el('draft').value = 'Keep me';
  h.el('send').listeners.click();
  await flush();
  assert.equal(h.el('draft').value, 'Keep me');
  assert.equal(h.el('thinking').hidden, true);
  assert.equal(h.el('latest-question').textContent, 'Earlier');
  assert.match(h.el('latest-answer').innerHTML, /Earlier reply/);
});

test('unchanged polling preserves the reply DOM and internal scroll position', async () => {
  const h = await setup();
  h.state.messages = [{ role: 'user', text: 'A question' }, { role: 'assistant', text: 'A long reply' }];
  await vm.runInContext('poll()', h.context);
  const answer = h.el('latest-answer');
  answer.scrollTop = 180;
  const writes = answer.htmlWrites;
  h.state.busy = true;
  await vm.runInContext('poll()', h.context);
  await vm.runInContext('poll()', h.context);
  assert.equal(answer.scrollTop, 180);
  assert.equal(answer.htmlWrites, writes);
});

test('settings and history open and close as separate native sheets', async () => {
  const h = await setup();
  for (const name of ['settings', 'history']) {
    h.el(`open-${name}`).listeners.click();
    assert.equal(h.el(`${name}-dialog`).open, true);
    h.el(`close-${name}`).listeners.click();
    assert.equal(h.el(`${name}-dialog`).open, false);
  }
});

test('automatically requests stay-awake once on connect and allows opting out', async () => {
  const h = await setup();
  assert.deepEqual(h.requests.filter((r) => r.path === '/api/awake').map((r) => r.body), [{ enabled: true }]);
  await vm.runInContext('poll()', h.context);
  assert.equal(h.requests.filter((r) => r.path === '/api/awake').length, 1);
  assert.match(h.el('wake-status').textContent, /Stay awake is on/);
  h.el('awake').checked = false;
  h.el('awake').listeners.change();
  await flush();
  assert.equal(h.requests.filter((r) => r.path === '/api/awake').at(-1).body.enabled, false);
  assert.equal(h.values.get('pi-voice-awake'), 'false');
  assert.match(h.el('wake-status').textContent, /Stay awake is off/);
});

test('stored stay-awake opt-out is respected when opening the app', async () => {
  const h = await setup({ awake: false });
  assert.equal(h.requests.find((r) => r.path === '/api/awake').body.enabled, false);
  assert.equal(h.el('awake').checked, false);
});

test('native speech uses Android rather than Web Speech, supports partial/final results and ignores duplicate callbacks', async () => {
  const h = await setup({ native: true, auto: true });
  h.el('microphone').click();
  await flush();
  assert.equal(h.instances.length, 0, 'Native never invokes Web Speech');
  const call = h.nativeCalls[0];
  assert.equal(call.method, 'start');
  assert.equal(call.lang, 'en-US');
  const callback = h.context.window.__piVoiceNativeSpeech;
  callback('stale-id', 'result', 'do not use');
  assert.equal(h.el('draft').value, '');
  callback(call.id, 'partial', 'Partial text');
  assert.equal(h.el('draft').value, 'Partial text');
  assert.equal(h.prompts.length, 0);
  callback(call.id, 'result', 'Final "text" <not code>');
  callback(call.id, 'end', '');
  callback(call.id, 'end', '');
  await flush();
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].text, 'Final "text" <not code>');
});

test('native speech Stop waits for final text; interrupted recording never auto-sends', async () => {
  const h = await setup({ native: true, speech: false, auto: true });
  h.el('microphone').click();
  await flush();
  const id = h.nativeCalls[0].id;
  h.el('microphone').click();
  assert.equal(h.nativeCalls.at(-1).method, 'stop');
  assert.equal(h.prompts.length, 0);
  h.context.window.__piVoiceNativeSpeech(id, 'partial', 'Unfinished');
  h.document.hidden = true;
  h.document.listeners.visibilitychange();
  assert.equal(h.nativeCalls.at(-1).method, 'abort');
  h.context.window.__piVoiceNativeSpeech(id, 'result', 'Must not send');
  h.context.window.__piVoiceNativeSpeech(id, 'end', '');
  await flush();
  assert.equal(h.prompts.length, 0);
  assert.match(h.el('notice').textContent, /cancelled/);
});

test('native microphone permission errors name the native app', async () => {
  const h = await setup({ native: true });
  h.el('microphone').click();
  await flush();
  const id = h.nativeCalls[0].id;
  h.context.window.__piVoiceNativeSpeech(id, 'error', 'not-allowed');
  h.context.window.__piVoiceNativeSpeech(id, 'end', '');
  await flush();
  assert.match(h.el('notice').textContent, /Pi Voice Native/);
  assert.equal(h.prompts.length, 0);
});

test('older backend stay-awake error explains a restart without breaking the conversation', async () => {
  const h = await setup();
  h.network.awake = () => Response.json({ error: 'Unknown endpoint.' }, { status: 404 });
  h.el('awake').listeners.change();
  await flush();
  assert.match(h.el('wake-status').textContent, /Restart Pi once/);
  assert.equal(h.el('connection').textContent, 'Ready · project');
});

test('settings show the app and connected Pi versions and flag a stale backend', async () => {
  const h = await setup();
  assert.equal(h.el('voice-version').textContent, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(h.el('pi-version').textContent, 'Restart Pi to show', 'Older backends report no versions');
  h.state.voiceVersion = h.el('voice-version').textContent;
  h.state.piVersion = '1.4.0';
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('pi-version').textContent, '1.4.0');
  assert.equal(h.el('version-hint').hidden, true);
  h.state.voiceVersion = '1.7.0';
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('version-hint').hidden, false);
  assert.match(h.el('version-hint').textContent, /1\.7\.0 backend/);
});

test('the working line names the current step and opens the live Activity sheet', async () => {
  const h = await setup();
  h.state.busy = true;
  h.state.activity = { version: 3, step: { kind: 'tool', name: 'bash', summary: 'npm test' } };
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('thinking-label').textContent, 'bash · npm test');
  h.state.activity = { version: 4, prompt: { kind: 'confirm', title: 'Allow push?' } };
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('thinking-label').textContent, 'Waiting for you in Termux: Allow push?');
  assert.equal(h.el('thinking').classes.has('waiting'), true);
  h.network.activity = () => Response.json({ version: 5, terminal: { session: 'pi-voice' }, steps: [
    { id: 1, kind: 'tool', name: 'bash', summary: 'npm test', status: 'running', started: Date.now() - 2000, output: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') },
    { id: 2, kind: 'thinking', status: 'done', started: 1, ended: 2 },
  ] });
  h.el('thinking').click();
  await flush();
  assert.equal(h.el('activity-dialog').open, true);
  const [tool, thinking] = h.el('activity-list').children;
  assert.equal(tool.className, 'step tool running');
  const output = tool.children[1];
  assert.equal(output.textContent.split('\n').length, 6, 'Collapsed output shows a live tail');
  tool.children[0].listeners.click();
  assert.equal(h.el('activity-list').children[0].children[1].textContent.split('\n').length, 20);
  assert.equal(thinking.children.length, 1, 'Thinking steps never carry content');
  h.network.activity = () => Response.json({ version: 6, terminal: {}, steps: [{ id: 3, kind: 'tool', name: 'read', summary: 'a.js', status: 'done', started: 1, ended: 2, output: 'contents' }] });
  await vm.runInContext('pollActivity()', h.context);
  assert.equal(h.el('activity-list').children[0].children.length, 1, 'Finished steps collapse to one line');
});

test('Open in Termux attaches the native tmux session after a one-time warning', async () => {
  const h = await setup({ native: true });
  h.state.terminal = { session: 'pi-voice-0a1b2c3d' };
  await vm.runInContext('poll()', h.context);
  h.el('open-terminal').click();
  assert.match(h.confirmations.at(-1), /Ctrl\+B then D/);
  assert.deepEqual(h.nativeCalls.filter((call) => call.method === 'terminal'), [{ method: 'terminal', session: 'pi-voice-0a1b2c3d' }]);
  h.el('open-terminal').click();
  assert.equal(h.confirmations.filter((text) => /Ctrl\+B/.test(text)).length, 1, 'The warning is shown once');
  h.state.terminal = { session: 'pi-voice; rm -rf ~' };
  await vm.runInContext('poll()', h.context);
  const calls = h.nativeCalls.length;
  h.el('open-terminal').click();
  assert.equal(h.el('open-terminal').disabled, true);
  assert.equal(h.nativeCalls.length, calls, 'Never open an unrelated Termux tab for an unknown target');
});

test('legacy backends and user-run Pi do not offer an unrelated Termux tab as this session’s terminal', async () => {
  const h = await setup({ native: true });
  assert.equal(h.el('open-terminal').disabled, true);
  assert.equal(h.el('version-hint').hidden, false, 'Backends predating version reporting still need an update hint');
  assert.match(h.el('version-hint').textContent, /older Pi Voice.*Restart Pi/);
  assert.match(h.el('terminal-hint').textContent, /Restart Pi/);
  h.state.voiceVersion = '2.1.1';
  await vm.runInContext('poll()', h.context);
  assert.match(h.el('terminal-hint').textContent, /could not identify.*terminal/);
  assert.doesNotMatch(h.el('terminal-hint').textContent, /was not started/);
  h.el('open-terminal').click();
  assert.equal(h.nativeCalls.some((call) => call.method === 'terminal'), false);
});

for (const source of ['state', 'activity']) test(`a recovered terminal from ${source} polling enables Open in Termux without reconnecting`, async () => {
  const h = await setup({ native: true });
  h.state.voiceVersion = '2.1.1';
  h.state.terminal = {};
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('open-terminal').disabled, true);
  assert.match(h.el('terminal-hint').textContent, /could not identify.*terminal/);
  assert.doesNotMatch(h.el('terminal-hint').textContent, /was not started/);
  const terminal = { session: 'pi-voice-abcdef12' };
  if (source === 'state') {
    h.state.terminal = terminal;
    await vm.runInContext('poll()', h.context);
  } else {
    h.network.activity = () => Response.json({ version: 1, steps: [], terminal });
    h.el('activity-dialog').showModal();
    await vm.runInContext('pollActivity()', h.context);
  }
  assert.equal(h.el('open-terminal').disabled, false);
  h.el('open-terminal').click();
  assert.equal(h.nativeCalls.at(-1).session, terminal.session);
  assert.equal(h.nativeCalls.some((call) => call.method === 'reconnect'), false);
  assert.deepEqual(h.prompts, [], 'Terminal recovery never sends a prompt');
});

test('switching sessions retargets Open in Termux and ignores late activity from the previous session', async () => {
  const h = await setup({ native: true });
  h.state.busy = true;
  h.state.terminal = { session: 'pi-voice' };
  await vm.runInContext('poll()', h.context);
  let finishActivity;
  h.network.activity = () => new Promise((resolve) => { finishActivity = resolve; });
  const previousActivity = vm.runInContext('pollActivity()', h.context);
  let finishState;
  h.network.state = (pid) => pid === '200' ? new Promise((resolve) => { finishState = resolve; }) : Response.json(h.state);
  vm.runInContext('switchTo(200)', h.context);
  assert.equal(h.el('open-terminal').disabled, true, 'Cannot attach the old terminal during a switch');
  h.el('open-terminal').click();
  assert.equal(h.nativeCalls.some((call) => call.method === 'terminal'), false);
  finishState(Response.json({ ...h.state, pid: 200, sessionId: 'session-two', terminal: { session: 'pi-voice-abcdef12' } }));
  await flush();
  finishActivity(Response.json({ terminal: { session: 'pi-voice' }, steps: [] }));
  await previousActivity;
  h.el('open-terminal').click();
  assert.equal(h.nativeCalls.at(-1).session, 'pi-voice-abcdef12');
  vm.runInContext('switchTo(100)', h.context);
  await flush();
  h.el('open-terminal').click();
  assert.equal(h.nativeCalls.at(-1).session, 'pi-voice');
});

test('late failed state/activity polls cannot disconnect the newly selected session', async () => {
  const h = await setup({ native: true });
  let failState;
  let failActivity;
  h.network.state = () => new Promise((_resolve, reject) => { failState = reject; });
  h.network.activity = () => new Promise((resolve) => { failActivity = resolve; });
  const previousState = vm.runInContext('poll()', h.context);
  const previousActivity = vm.runInContext('pollActivity()', h.context);
  h.network.state = () => Response.json({ ...h.state, pid: 200, sessionId: 'session-two', terminal: { session: 'pi-voice-abcdef12' } });
  vm.runInContext('switchTo(200)', h.context);
  failState(new TypeError('Old session connection closed'));
  failActivity(Response.json({ error: 'Not found' }, { status: 404 }));
  await Promise.all([previousState, previousActivity]);
  await flush();
  assert.equal(h.el('connection').textContent, 'Ready · project');
  assert.equal(h.el('open-terminal').disabled, false);
  vm.runInContext('renderActivity()', h.context);
  assert.doesNotMatch(h.el('activity-list').children[0].textContent, /Restart Pi/);
});

test('old native shells and plain browsers explain how to reach the terminal instead', async () => {
  const old = await setup({ native: true, nativeTerminal: false });
  vm.runInContext('renderActivity()', old.context);
  assert.equal(old.el('open-terminal').disabled, true);
  assert.match(old.el('terminal-hint').textContent, /APK 0\.1\.5/);
  const page = await setup();
  page.state.terminal = { session: 'pi-voice' };
  await vm.runInContext('poll()', page.context);
  vm.runInContext('renderActivity()', page.context);
  assert.equal(page.el('open-terminal').hidden, true);
  assert.match(page.el('terminal-hint').textContent, /Pi Voice Native/);
});

function pullDown(h, distance, { dx = 0 } = {}) {
  const exchange = h.el('exchange');
  let prevented = false;
  const touches = (x, y) => ({ touches: [{ clientX: x, clientY: y }], preventDefault() { prevented = true; } });
  exchange.listeners.touchstart(touches(100, 100));
  for (let step = 1; step <= 4; step++) exchange.listeners.touchmove(touches(100 + dx * step / 4, 100 + distance * step / 4));
  exchange.listeners.touchend({ touches: [] });
  return prevented;
}

test('pulling the conversation down re-syncs with Pi', async () => {
  const h = await setup();
  const before = h.requests.length;
  assert.equal(pullDown(h, 60), true, 'The pull is handled by the page');
  await flush();
  assert.equal(h.requests.length, before, 'A short pull does nothing');
  pullDown(h, 220);
  await flush();
  const paths = h.requests.slice(before).map((r) => r.path);
  assert.ok(paths.includes('/api/state') && paths.includes('/api/sessions'));
  assert.equal(h.el('pull-indicator').classes.has('refreshing'), true);
});

test('pulling down when Pi has stopped reconnects, and other gestures are left alone', async () => {
  const h = await setup({ native: true });
  h.network.state = () => { throw new Error('Server stopped'); };
  await vm.runInContext('poll()', h.context);
  assert.equal(pullDown(h, 30, { dx: 200 }), false, 'Sideways swipes keep scrolling code blocks');
  h.el('latest-answer').scrollTop = 40;
  pullDown(h, 220);
  h.el('latest-answer').scrollTop = 0;
  h.el('history-dialog').open = true;
  pullDown(h, 220);
  h.el('history-dialog').open = false;
  assert.equal(h.nativeCalls.filter((call) => call.method === 'reconnect').length, 0);
  pullDown(h, 220);
  assert.equal(h.nativeCalls.filter((call) => call.method === 'reconnect').length, 1);
  assert.match(h.el('notice').textContent, /Starting Pi/);
});
