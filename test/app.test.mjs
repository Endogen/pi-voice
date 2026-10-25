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
  showModal() { this.open = true; this.onShowModal?.(); }
  close() { this.open = false; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  append(...children) { this.children = [...(this.children || []), ...children]; }
  replaceChildren(...children) { this.children = children; this.lastElementChild = children.at(-1); }
  click() { this.clicked = (this.clicked || 0) + 1; return this.listeners.click?.(); }
  scrollIntoView() { throw new Error('Conversation updates must not force-scroll.'); }
}
async function setup({ auto = false, autoSend = false, engines, speech = true, awake = true, confirmed = true, native = false, playback = false, nativePlayback = true, nativeTerminal = true, nativeReconnect = true, nativeAlerts = true, alertStatus = 'on', initialState } = {}) {
  const elements = new Map();
  const prompts = [];
  const instances = [];
  const nativeCalls = [];
  const feedback = [];
  const nativeBridge = native ? {
    startSpeech: (id, lang) => nativeCalls.push({ method: 'start', id, lang }),
    stopSpeech: (id) => nativeCalls.push({ method: 'stop', id }),
    abortSpeech: (id) => nativeCalls.push({ method: 'abort', id }),
    notificationHandled: (handle, sessionId, opened) => nativeCalls.push({ method: 'notification', handle, sessionId, opened }),
    ...(engines ? {
      speechServices: () => JSON.stringify(engines.speech),
      readAloudEngines: () => JSON.stringify(engines.voices),
      startSpeechWith: (id, lang, service) => nativeCalls.push({ method: 'start', id, lang, service }),
      speakTextWith: (id, text, language, engine) => nativeCalls.push({ method: 'read', id, text, language, engine }),
    } : {}),
    ...(nativePlayback ? {
      speakText: (id, text, language) => nativeCalls.push({ method: 'read', id, text, language }),
      stopReading: (id) => nativeCalls.push({ method: 'stop-reading', id }),
    } : {}),
    ...(nativeTerminal ? { openTerminal: (session) => nativeCalls.push({ method: 'terminal', session }) } : {}),
    ...(nativeReconnect ? { reconnect: () => nativeCalls.push({ method: 'reconnect' }) } : {}),
    ...(nativeAlerts ? {
      haptic: (kind) => feedback.push({ method: 'haptic', kind }),
      setReplyAlerts: (notify, sound, ask) => feedback.push({ method: 'alerts', notify, sound, ask }),
      replyAlertStatus: () => alertStatus,
    } : {}),
  } : undefined;
  const utterances = [];
  class Utterance { constructor(text) { this.text = text; } }
  const synthesis = { cancellations: 0, speak: (utterance) => utterances.push(utterance), cancel() { this.cancellations++; } };
  const values = new Map([['pi-voice-autosend', String(auto)], ['pi-voice-auto-send', String(autoSend)], ['pi-voice-awake', String(awake)]]);
  const state = { handle: 'session-100', instanceId: 'instance-100', status: 'ready', capabilities: { close: true }, sessionId: 'session-one', sessionName: 'Test', cwd: '/project', model: 'test/test', modelSelection: { provider: 'test', id: 'test' }, modelSwitchingSupported: true, modelSwitching: false, busy: false, messages: [], imageAttachments: true, modelSupportsImages: true,
    modelName: 'Cloud model', thinkingSupported: true, thinkingLevel: 'medium', thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'], compactSupported: true };
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
  const sessions = [{ handle: 'session-100', instanceId: 'instance-100', status: 'ready', capabilities: { close: true }, sessionId: 'session-one', title: 'Test', cwd: '/project', busy: false, spawned: false }];
  const models = [
    { provider: 'test', id: 'test', name: 'Cloud model', input: ['text', 'image'], contextWindow: 128000, reasoning: true },
    { provider: 'custom-local', id: 'qwen/model:Q5_K_M', name: 'Local model', input: ['text'], contextWindow: 4096, reasoning: true },
  ];
  const network = {
    models: () => Response.json({ sessionId: state.sessionId, current: state.modelSelection, models, contextTokens: 8000 }),
    model: (body) => {
      state.modelSelection = { provider: body.provider, id: body.id }; state.model = `${body.provider}/${body.id}`;
      state.modelSupportsImages = models.find((item) => item.provider === body.provider && item.id === body.id)?.input.includes('image');
      return Response.json({ ok: true, model: state.modelSelection });
    },
    state: initialState || (() => Response.json(state)),
    sessions: () => Response.json({ selected: state.handle, sessions, stopped }),
    activity: () => Response.json({ version: 1, steps: [], terminal: {} }),
    spawn: () => Response.json({ ok: true }, { status: 202 }),
    close: () => Response.json({ ok: true }, { status: 202 }),
    prompt: () => Response.json({ ok: true, queued: false }),
    newSession: () => Response.json({ ok: true }, { status: 202 }),
    listen: () => Response.json({ text: 'fallback transcript' }),
    awake: (body) => { state.wakeLock = { active: body.enabled }; return Response.json({ wakeLock: state.wakeLock }); },
    thinking: (body) => { state.thinkingLevel = body.level; return Response.json({ ok: true, thinkingLevel: body.level }); },
    compact: () => { state.compaction = { status: 'running' }; return Response.json({ ok: true }, { status: 202 }); },
  };
  class Speech {
    constructor() { instances.push(this); }
    start() {}
    stop() { this.onend(); }
    abort() { this.onerror({ error: 'aborted' }); this.onend(); }
  }
  const document = {
    hidden: false, body: { scrollHeight: 10000 }, listeners: {},
    getElementById(id) { if (!elements.has(id)) elements.set(id, Object.assign(new Element(), { id })); return elements.get(id); },
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
  const tones = [];
  class FakeAudio {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createOscillator() { const node = { frequency: {}, connect: (next) => next, start: () => tones.push(node.frequency.value), stop() {} }; return node; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (next) => next }; }
  }
  const context = vm.createContext({
    document, window: { SpeechRecognition: speech ? Speech : undefined, PiVoiceAndroid: nativeBridge, innerHeight: 900, scrollY: 0, AudioContext: FakeAudio,
      speechSynthesis: playback ? synthesis : undefined, SpeechSynthesisUtterance: playback ? Utterance : undefined },
    location: { hash: '#test-token', pathname: '/' }, history: { replaceState() {} },
    localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    navigator: { language: 'en-US' }, crypto: { randomUUID }, AbortController,
    FileReader: Reader,
    createImageBitmap: async (file, options) => { imageProcessing.calls.push({ file, options }); return imageProcessing.decode(file); },
    setInterval() {}, setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    confirm: () => { throw new Error('Use the page’s own confirmation dialog, not Android’s native one.'); },
    async fetch(path, options) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      const handle = options.headers['X-Pi-Voice-Session'];
      requests.push({ path, body, handle });
      if (path === '/api/state') return network.state(handle);
      if (path === '/api/sessions') return network.sessions();
      if (path === '/api/activity') return network.activity(handle);
      if (path === '/api/models') return network.models(handle);
      if (path === '/api/model') return network.model(body, handle);
      if (path === '/api/thinking') return network.thinking(body, handle);
      if (path === '/api/compact') return network.compact(body, handle);
      if (path === '/api/session/select') return Response.json({ ok: true });
      if (path === '/api/session/spawn') return network.spawn(body);
      if (path === '/api/session/close') return network.close(body, handle);
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
  // The page's own confirmation dialog: record the question, then answer it.
  const answers = { confirmed };
  document.getElementById('confirm-dialog').onShowModal = () => {
    const paragraphs = (elements.get('confirm-message').children || []).map((child) => child.textContent);
    confirmations.push([elements.get('confirm-title').textContent, ...paragraphs].join('\n\n'));
    queueMicrotask(() => elements.get(answers.confirmed ? 'confirm-accept' : 'confirm-cancel').click());
  };
  vm.runInContext(source, context);
  await flush();
  return { answers, elements, prompts, instances, nativeCalls, feedback, state, models, sessions, stopped, tones, context, document, values, network, requests, confirmations, imageProcessing, utterances, synthesis, el: (id) => elements.get(id) };
}
function result(text, final = true) {
  return { results: [Object.assign([{ transcript: text }], { isFinal: final })] };
}

test('Enter and modified Enter leave textarea editing native; only the Send button submits', async () => {
  const h = await setup({ auto: true });
  h.el('draft').value = 'first line';
  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
    let prevented = false;
    h.el('draft').listeners.keydown?.({ key: 'Enter', ...modifiers, preventDefault() { prevented = true; } });
    await flush();
    assert.equal(prevented, false);
    assert.equal(h.prompts.length, 0);
  }
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<textarea\b[^>]*enterkeyhint="enter"/);
  h.el('draft').value += '\nsecond line';
  h.el('draft').listeners.input();
  h.el('send').click(); await flush();
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].text, 'first line\nsecond line');
});

test('completed speech ignores duplicate completion and late callbacks during a later recording', async () => {
  const h = await setup({ auto: true });
  h.el('microphone').click();
  const first = h.instances[0];
  first.onresult(result('First question'));
  first.onend();
  await flush();
  assert.equal(h.prompts.length, 0);
  h.el('send').click(); await flush();
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
  assert.equal(h.prompts.length, 1);
  h.el('send').click(); await flush();
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
  assert.match(h.el('read-support').textContent, /Update the Pi Voice app/);
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
  h.sessions.push({ handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'session-two', title: 'New session', operationId: body.id, spawned: true });
  h.network.state = (handle) => Response.json(handle === 'session-200' ? { ...h.state, handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'session-two', messages: [] } : h.state);
  await vm.runInContext('pollSessions()', h.context);
  await flush();
  assert.equal(h.el('draft').value, 'unsent words');
  assert.equal(h.el('draft').readOnly, false);
  assert.equal(h.el('attachments').hidden, false);
  assert.equal(h.el('new-session').disabled, false);
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
  h.sessions.push({ handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'session-two', title: 'New session', cwd: '/project', busy: false, spawned: true, operationId: spawn.body.id });
  h.network.state = (handle) => Response.json(handle === 'session-200' ? { ...h.state, handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'session-two', busy: false, title: 'New session' } : h.state);
  await vm.runInContext('pollSessions()', h.context);
  await flush();
  assert.equal(h.requests.at(-1).handle, 'session-200', 'Later requests go to the new Pi through the independent host');
  assert.equal(h.el('session-title').textContent, 'New session');
  assert.match(h.el('notice').textContent, /previous one keeps running/);
  assert.equal(vm.runInContext('sessionState.targetHandle', h.context), 'session-200');
  h.el('draft').value = 'question for the new session';
  await vm.runInContext('send()', h.context);
  assert.equal(h.prompts.at(-1).sessionId, 'session-two');
  assert.equal(h.requests.find((r) => r.path === '/api/prompt').handle, 'session-200');
  h.el('open-sessions').click();
  assert.equal(h.el('session-list').children.length, 2);
  h.el('session-list').children[0].children[0].click();
  await flush();
  assert.equal(vm.runInContext('sessionState.targetHandle', h.context), 'session-100');
  assert.equal(h.state[working], true, 'The first task is still running, with no reply needed to switch');
  assert.equal(h.el('thinking').hidden, false);
  assert.equal(h.el('new-session').disabled, false);
  h.el('open-sessions').click();
  assert.equal(h.el('session-list').children.length, 2, 'Both sessions remain in the list');
  h.el('session-list').children[1].children[0].click();
  await flush();
  assert.equal(vm.runInContext('sessionState.targetHandle', h.context), 'session-200');
});

test('a background session that finishes is flagged, and switching back clears the flag', async () => {
  const h = await setup();
  h.sessions.push({ handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'session-two', title: 'Background', cwd: '/project', busy: true, spawned: true });
  await vm.runInContext('pollSessions()', h.context);
  assert.equal(h.el('sessions-badge').hidden, false);
  assert.equal(h.el('sessions-badge').textContent, '2');
  h.sessions[1].busy = false;
  await vm.runInContext('pollSessions()', h.context);
  assert.equal(h.el('sessions-badge').classes.has('unread'), true);
  h.el('open-sessions').click();
  const rows = h.el('session-list').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children.length, 2, 'The first session has the same Close action as later sessions');
  assert.equal(rows[1].children.length, 2, 'App-started sessions can be closed');
  h.network.state = (handle) => Response.json(handle === 'session-200' ? { ...h.state, handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'session-two' } : h.state);
  rows[1].children[0].listeners.click();
  await flush();
  assert.equal(h.el('sessions-dialog').open, false);
  assert.equal(h.el('sessions-badge').classes.has('unread'), false);
  assert.doesNotMatch(h.el('notice').textContent || '', /Pi switched sessions/);
});

test('closing a parallel session targets that Pi and a vanished session reloads host selection', async () => {
  const h = await setup();
  h.sessions.push({ handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'session-two', title: 'Background', cwd: '/project', busy: true, spawned: true });
  await vm.runInContext('pollSessions()', h.context);
  h.el('open-sessions').click();
  h.el('session-list').children[1].children[1].listeners.click(); await flush();
  assert.match(h.confirmations.at(-1), /still working/);
  const close = h.requests.find((r) => r.path === '/api/session/close');
  assert.deepEqual([close.handle, close.body.sessionId], ['session-200', 'session-two']);

  await flush();
  h.network.state = (handle) => handle === 'session-300' ? Response.json({ error: 'That session is no longer running.' }, { status: 410 }) : Response.json(h.state);
  await vm.runInContext('selectTarget("session-300"); poll()', h.context);
  await flush();
  assert.match(h.el('notice').textContent, /unavailable/);
  assert.equal(h.requests.at(-1).handle, undefined);
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
  h.sessions.push({ handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'session-two', operationId: body.id });
  h.network.state = (handle) => Response.json(handle === 'session-200' ? { ...h.state, handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'session-two' } : h.state);
  await vm.runInContext('pollSessions()', h.context);
  await flush();
  assert.equal(h.el('draft').value, 'keep on success too');
  assert.equal(h.el('new-session').disabled, false);
  assert.equal(vm.runInContext('sessionState.targetHandle', h.context), 'session-200');
  assert.equal(h.requests.filter((r) => r.path === '/api/session/spawn').length, 1);
});

test('New session timeout never clears an unconfirmed draft', async () => {
  const h = await setup();
  h.el('draft').value = 'still here';
  await vm.runInContext('startNewSession()', h.context);
  await vm.runInContext('sessionState.spawnRequest.deadline = 0; pollSessions()', h.context);
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
  assert.match(old.el('notice').textContent, /Update the Pi Voice app/);
  assert.equal(old.el('reconnect').hidden, true);
  const page = await setup();
  page.network.state = () => { throw new Error('Server stopped'); };
  await vm.runInContext('poll()', page.context);
  assert.match(page.el('notice').textContent, /Open the Pi Voice app/);
});

test('sessions that stopped earlier can be restored or dismissed by opaque handle only', async () => {
  const h = await setup();
  h.stopped.push({ handle: 'restore-4321', restorable: true, title: 'Refactor bridge', cwd: '/project', updated: Date.now() - 2 * 3600000 });
  await vm.runInContext('pollSessions()', h.context);
  assert.equal(h.el('restore-banner').hidden, false);
  assert.equal(h.el('restore-label').textContent, '1 earlier session stopped · Restore');
  h.el('restore-banner').click();
  assert.equal(h.el('sessions-dialog').open, true);
  const [row] = h.el('stopped-list').children;
  assert.match(row.children[0].children[1].children[1].textContent, /Stopped · 2 h ago · project/);
  await row.children[1].listeners.click();
  const restore = h.requests.find((r) => r.path === '/api/session/restore');
  assert.deepEqual(Object.keys(restore.body).sort(), ['handle', 'id'], 'No paths are sent from the page');
  assert.equal(restore.body.handle, 'restore-4321');
  h.stopped.length = 0;
  h.sessions.push({ handle: 'session-500', instanceId: 'instance-500', status: 'ready', sessionId: 'restored', title: 'Refactor bridge', cwd: '/project', spawned: true, operationId: restore.body.id });
  h.network.state = (handle) => Response.json(handle === 'session-500' ? { ...h.state, handle: 'session-500', instanceId: 'instance-500', status: 'ready', sessionId: 'restored' } : h.state);
  await vm.runInContext('pollSessions()', h.context);
  await flush();
  assert.equal(h.requests.at(-1).handle, 'session-500');
  assert.match(h.el('notice').textContent, /Session restored/);
  assert.equal(h.el('restore-banner').hidden, true);
  h.stopped.push({ handle: 'restore-9876', restorable: true, title: 'Old', cwd: '/x', updated: Date.now() });
  await vm.runInContext('pollSessions()', h.context);
  vm.runInContext('renderSessions()', h.context);
  await h.el('stopped-list').children[0].children[2].listeners.click();
  assert.equal(h.requests.at(-1).path, '/api/session/forget');
  assert.equal(h.requests.at(-1).body.handle, 'restore-9876');
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

test('a legacy auto-send preference cannot submit speech without the Send button', async () => {
  const h = await setup({ auto: true });
  h.el('microphone').listeners.click();
  const engine = h.instances[0];
  engine.onresult(result('partial words', false));
  assert.equal(h.prompts.length, 0);
  engine.onresult(result('finished words'));
  assert.equal(h.prompts.length, 0);
  engine.onend();
  await flush();
  assert.equal(h.prompts.length, 0);
  assert.equal(h.el('draft').value, 'finished words');
  h.el('send').click(); await flush();
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

test('switching sessions during speech cancels recording without submitting it', async () => {
  const h = await setup({ auto: true });
  h.el('microphone').listeners.click();
  h.instances[0].onresult(result('do not send into the wrong session'));
  h.state.sessionId = 'session-two';
  await vm.runInContext('poll()', h.context);
  await flush();
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
  assert.equal(vm.runInContext('speechEngines.mode', h.context), 'termux', 'Without any speech recognition, Termux:API is used');
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
  assert.equal(h.prompts.length, 0);
  h.el('send').click(); await flush();
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
  assert.match(h.el('notice').textContent, /permission for Pi Voice/);
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
  h.el('open-terminal').click(); await flush();
  assert.match(h.confirmations.at(-1), /Ctrl\+B then D/);
  assert.deepEqual(h.nativeCalls.filter((call) => call.method === 'terminal'), [{ method: 'terminal', session: 'pi-voice-0a1b2c3d' }]);
  h.el('open-terminal').click(); await flush();
  assert.equal(h.confirmations.filter((text) => /Ctrl\+B/.test(text)).length, 1, 'The warning is shown once');
  h.state.terminal = { session: 'pi-voice; rm -rf ~' };
  await vm.runInContext('poll()', h.context);
  const calls = h.nativeCalls.length;
  h.el('open-terminal').click(); await flush();
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
  h.el('open-terminal').click(); await flush();
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
  h.el('open-terminal').click(); await flush();
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
  h.network.state = (handle) => handle === 'session-200' ? new Promise((resolve) => { finishState = resolve; }) : Response.json(h.state);
  vm.runInContext("sessionsController.switchTo('session-200')", h.context);
  assert.equal(h.el('open-terminal').disabled, true, 'Cannot attach the old terminal during a switch');
  h.el('open-terminal').click(); await flush();
  assert.equal(h.nativeCalls.some((call) => call.method === 'terminal'), false);
  finishState(Response.json({ ...h.state, handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'session-two', terminal: { session: 'pi-voice-abcdef12' } }));
  await flush();
  finishActivity(Response.json({ terminal: { session: 'pi-voice' }, steps: [] }));
  await previousActivity;
  h.el('open-terminal').click(); await flush();
  assert.equal(h.nativeCalls.at(-1).session, 'pi-voice-abcdef12');
  vm.runInContext("sessionsController.switchTo('session-100')", h.context);
  await flush();
  h.el('open-terminal').click(); await flush();
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
  h.network.state = () => Response.json({ ...h.state, handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'session-two', terminal: { session: 'pi-voice-abcdef12' } });
  vm.runInContext("sessionsController.switchTo('session-200')", h.context);
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
  assert.match(old.el('terminal-hint').textContent, /Update the Pi Voice app/);
  const page = await setup();
  page.state.terminal = { session: 'pi-voice' };
  await vm.runInContext('poll()', page.context);
  vm.runInContext('renderActivity()', page.context);
  assert.equal(page.el('open-terminal').hidden, true);
  assert.match(page.el('terminal-hint').textContent, /Pi Voice app/);
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

test('a new reply chimes and vibrates once; switching sessions or loading history does not', async () => {
  const h = await setup({ native: true });
  h.document.listeners.pointerdown(); // Android allows audio after the first tap.
  const haptics = () => h.feedback.filter((call) => call.method === 'haptic').map((call) => call.kind);
  h.state.messages = [{ id: 'q1', role: 'user', text: 'Run the tests' }];
  h.state.busy = true;
  await vm.runInContext('poll()', h.context);
  // Pi stores its final message before it reports idle.
  h.state.messages = [...h.state.messages, { id: 'a1', role: 'assistant', text: 'All pass.' }];
  await vm.runInContext('poll()', h.context);
  assert.equal(h.tones.length, 0, 'Nothing while Pi is still working');
  h.state.busy = false;
  await vm.runInContext('poll()', h.context);
  assert.deepEqual(h.tones, [659.25, 987.77], 'The first answer of a conversation counts too');
  assert.deepEqual(haptics(), ['confirm']);
  await vm.runInContext('poll()', h.context);
  assert.equal(h.tones.length, 2, 'An unchanged reply is not announced again');
  h.network.state = (handle) => Response.json(handle === 'session-200' ? { ...h.state, handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'two', messages: [{ id: 'b1', role: 'assistant', text: 'Other' }] } : h.state);
  await vm.runInContext('selectTarget("session-200"); poll()', h.context);
  assert.equal(h.tones.length, 2, 'A switch shows an existing reply silently');
  h.el('sound').checked = false;
  h.el('haptics').checked = false;
  h.network.state = (handle) => Response.json({ ...h.state, handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'two', messages: [{ id: 'b2', role: 'assistant', text: 'Newer' }] });
  await vm.runInContext('poll()', h.context);
  assert.equal(h.tones.length, 2, 'Sound can be turned off');
  assert.deepEqual(haptics(), ['confirm'], 'Haptics can be turned off');
});

test('a background session finishing also announces its reply while the app is open', async () => {
  const h = await setup();
  h.document.listeners.pointerdown();
  h.sessions.push({ handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'two', title: 'Background', cwd: '/project', busy: true, spawned: true });
  await vm.runInContext('pollSessions()', h.context);
  h.sessions[1].busy = false;
  await vm.runInContext('pollSessions()', h.context);
  assert.equal(h.tones.length, 2);
  h.document.hidden = true;
  h.sessions[1].busy = true;
  await vm.runInContext('pollSessions()', h.context);
  h.sessions[1].busy = false;
  await vm.runInContext('pollSessions()', h.context);
  assert.equal(h.tones.length, 2, 'Hidden pages leave alerts to the app notification');
});

test('haptics follow actions, and settings reach the native reply receiver', async () => {
  const h = await setup({ native: true });
  const calls = (method) => h.feedback.filter((call) => call.method === method);
  assert.deepEqual(calls('alerts')[0], { method: 'alerts', notify: true, sound: true, ask: true }, 'First start asks for notification permission');
  assert.equal(h.values.get('pi-voice-notify-asked'), 'true');
  h.el('draft').value = 'hello';
  await vm.runInContext('send()', h.context);
  assert.deepEqual(calls('haptic').map((call) => call.kind), ['confirm']);
  h.el('sound').checked = false;
  h.el('sound').listeners.change();
  assert.deepEqual(calls('alerts').at(-1), { method: 'alerts', notify: true, sound: false, ask: false });
  h.el('notify').checked = false;
  h.el('notify').listeners.change();
  assert.deepEqual(calls('alerts').at(-1), { method: 'alerts', notify: false, sound: false, ask: false });
  h.el('notify').checked = true;
  h.el('notify').listeners.change();
  assert.equal(calls('alerts').at(-1).ask, true, 'Turning notifications on asks again');
  assert.equal(h.values.get('pi-voice-notify'), 'true');
  const blocked = await setup({ native: true, alertStatus: 'off' });
  assert.match(blocked.el('notify-status').textContent, /blocked/);
  const old = await setup({ native: true, nativeAlerts: false });
  assert.match(old.el('notify-status').textContent, /Update the Pi Voice app/);
});

test('a reply notification opens its session', async () => {
  const h = await setup({ native: true });
  h.network.state = (handle) => Response.json(handle === 'session-300' ? { ...h.state, handle: 'session-300', instanceId: 'instance-300', status: 'ready', capabilities: { close: true }, sessionId: 'three' } : h.state);
  h.sessions.push({ handle: 'session-300', instanceId: 'instance-300', status: 'ready', sessionId: 'three' });
  await h.context.window.__piVoiceOpenSession("session-300");
  await flush();
  assert.equal(vm.runInContext('state.handle', h.context), 'session-300');
  assert.deepEqual(h.nativeCalls.filter((call) => call.method === 'notification'), [{ method: 'notification', handle: 'session-300', sessionId: '', opened: true }]);
  h.context.window.__piVoiceOpenSession('300; alert(1)');
  h.context.window.__piVoiceOpenSession(-1);
  await flush();
  assert.equal(vm.runInContext('state.handle', h.context), 'session-300');
});

test('a notification received before the initial connection waits for discovery and opens its session', async () => {
  let release;
  const initial = new Promise((resolve) => { release = resolve; });
  const h = await setup({ native: true, initialState: () => initial });
  h.sessions.push({ handle: 'session-300', instanceId: 'instance-300', status: 'ready', sessionId: 'three' });
  h.network.state = (handle) => Response.json(handle === 'session-300' ? { ...h.state, handle, instanceId: 'instance-300', sessionId: 'three' } : h.state);
  await h.context.window.__piVoiceOpenSession('session-300');
  assert.doesNotMatch(h.el('notice')?.textContent || '', /no longer running/);
  release(Response.json(h.state));
  await flush(); await flush();
  assert.equal(vm.runInContext('state.handle', h.context), 'session-300');
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function notificationSession(h, handle = 'session-300', sessionId = 'conversation-three') {
  const next = { ...h.state, handle, sessionId, instanceId: `instance-${handle}`, sessionName: 'Notified conversation', messages: [{ role: 'assistant', id: 'notified-reply', text: 'The notified answer' }] };
  h.network.state = (target) => Response.json(target === handle ? next : h.state);
  return next;
}
const notificationCalls = (h) => h.nativeCalls.filter((call) => call.method === 'notification');

test('notification navigation does not depend on a cached session list and closes old sheets', async () => {
  const h = await setup({ native: true });
  const next = notificationSession(h);
  h.el('draft').value = 'Keep my draft';
  h.el('history-dialog').showModal();
  // The list does not know about this session yet. Only its explicit state is authoritative.
  assert.equal(h.context.window.__piVoiceOpenSession(next.handle, next.sessionId), true);
  await flush(); await flush();
  assert.equal(vm.runInContext('state.sessionId', h.context), next.sessionId);
  assert.equal(h.el('history-dialog').open, false);
  assert.equal(h.el('draft').value, 'Keep my draft');
  assert.equal(notificationCalls(h).at(-1).opened, true);
  assert.equal(h.context.window.__piVoiceOpenSession(next.handle, 'bad;identity'), false);
  assert.equal(h.context.window.__piVoiceOpenSession(next.handle, null), false);
});

for (const failure of [false, true]) test(`a notification waits for an in-flight prompt (${failure ? 'failed' : 'accepted'}) rather than being dropped`, async () => {
  const h = await setup({ native: true });
  const next = notificationSession(h);
  const prompt = deferred();
  h.network.prompt = () => prompt.promise;
  h.el('draft').value = 'A question for the original session';
  const sending = vm.runInContext('send()', h.context);
  h.context.window.__piVoiceOpenSession(next.handle, next.sessionId);
  assert.equal(vm.runInContext('state.handle', h.context), h.state.handle, 'Never retarget a prompt in flight');
  assert.equal(notificationCalls(h).length, 0);
  if (failure) prompt.reject(new Error('lost connection'));
  else prompt.resolve(Response.json({ ok: true }));
  await sending; await flush(); await flush();
  assert.equal(vm.runInContext('state.sessionId', h.context), next.sessionId);
  assert.equal(h.prompts[0].sessionId, h.state.sessionId);
  assert.equal(h.el('draft').value, failure ? 'A question for the original session' : '');
  assert.equal(notificationCalls(h).at(-1).opened, true);
});

test('a notification waits for image preparation and keeps the prepared attachments', async () => {
  const h = await setup({ native: true });
  const next = notificationSession(h);
  const decode = deferred();
  h.imageProcessing.decode = () => decode.promise;
  h.context.selectedFiles = [photo()];
  const preparing = vm.runInContext('addImages(selectedFiles)', h.context);
  h.context.window.__piVoiceOpenSession(next.handle, next.sessionId);
  assert.equal(notificationCalls(h).length, 0);
  decode.resolve({ width: 400, height: 300, close() {} });
  await preparing; await flush(); await flush();
  assert.equal(vm.runInContext('state.sessionId', h.context), next.sessionId);
  assert.equal(vm.runInContext('attachments.length', h.context), 1);
  assert.equal(h.prompts.length, 0);
});

test('a queued notification wins after a new-session launch finishes', async () => {
  const h = await setup({ native: true });
  const next = notificationSession(h);
  vm.runInContext("sessionState.spawnRequest = { id: 'operation-1234', deadline: Date.now() + 45000 }; controls()", h.context);
  h.context.window.__piVoiceOpenSession(next.handle, next.sessionId);
  assert.equal(notificationCalls(h).length, 0);
  h.sessions.push({ handle: 'spawned-session', status: 'ready', operationId: 'operation-1234' });
  await vm.runInContext('pollSessions()', h.context);
  await flush(); await flush();
  assert.equal(vm.runInContext('state.sessionId', h.context), next.sessionId);
  assert.equal(vm.runInContext('sessionState.spawnRequest', h.context), undefined);
});

test('a notification deferred during session startup is opened when startup settles', async () => {
  const h = await setup({ native: true });
  const next = notificationSession(h);
  h.state.newSessionAction = { status: 'starting' };
  await vm.runInContext('poll()', h.context);
  h.context.window.__piVoiceOpenSession(next.handle, next.sessionId);
  assert.equal(notificationCalls(h).length, 0);
  delete h.state.newSessionAction;
  await vm.runInContext('poll()', h.context);
  await flush(); await flush();
  assert.equal(vm.runInContext('state.sessionId', h.context), next.sessionId);
});

test('a session-list response started before a notification cannot undo its explicit target', async () => {
  const h = await setup({ native: true });
  const next = notificationSession(h);
  const list = deferred();
  h.network.sessions = () => list.promise;
  const listing = vm.runInContext('pollSessions()', h.context);
  h.context.window.__piVoiceOpenSession(next.handle, next.sessionId);
  await flush(); await flush();
  assert.equal(vm.runInContext('state.sessionId', h.context), next.sessionId);
  list.resolve(Response.json({ sessions: h.sessions }));
  await listing;
  assert.equal(vm.runInContext('sessionState.targetHandle', h.context), next.handle);
  assert.equal(vm.runInContext('state.sessionId', h.context), next.sessionId);
});

for (const status of [410, 502]) test(`an unavailable notification (${status}) never silently falls back to another conversation`, async () => {
  const h = await setup({ native: true });
  h.network.state = (handle) => handle === 'session-300' ? Response.json({ error: 'Session unavailable' }, { status }) : Response.json(h.state);
  h.context.window.__piVoiceOpenSession('session-300', 'conversation-three');
  await flush(); await flush();
  assert.equal(vm.runInContext('state', h.context), undefined, 'An unrelated old answer is not left on screen');
  assert.equal(vm.runInContext('sessionState.targetHandle', h.context), 'session-300');
  assert.equal(h.el('send').disabled, true);
  assert.match(h.el('notice').textContent, /notified conversation is unavailable/);
  await vm.runInContext('pollSessions(); poll()', h.context);
  assert.equal(vm.runInContext('sessionState.targetHandle', h.context), 'session-300', 'Missing from the list is not permission to show another Pi');
  assert.equal(notificationCalls(h).length, 0, 'The native request is not acknowledged as shown');
  vm.runInContext(`sessionsController.switchTo('${h.state.handle}')`, h.context);
  await flush(); await flush();
  assert.equal(vm.runInContext('state.handle', h.context), h.state.handle, 'Explicit manual selection can recover');
  assert.equal(notificationCalls(h).at(-1).opened, false);
});

test('a stopped notification target can still be discovered and explicitly restored', async () => {
  const h = await setup({ native: true });
  h.network.state = (handle) => handle === 'session-300' ? Response.json({ error: 'Stopped' }, { status: 410 }) : Response.json(h.state);
  h.context.window.__piVoiceOpenSession('session-300', 'conversation-three');
  await flush(); await flush();
  h.stopped.push({ handle: 'session-300', restorable: true, title: 'Notified conversation' });
  await vm.runInContext('pollSessions()', h.context);
  assert.equal(h.el('restore-banner').hidden, false);
  assert.equal(vm.runInContext('sessionState.stopped[0].handle', h.context), 'session-300');
  await vm.runInContext('sessionsController.restoreSession(sessionState.stopped[0])', h.context);
  const restore = h.requests.find((r) => r.path === '/api/session/restore');
  assert.equal(restore.body.handle, 'session-300');
  assert.equal(notificationCalls(h).at(-1).opened, false, 'Restore is an explicit action, not successful notification navigation yet');
});

test('a list fetched during notification loading cannot revert a successfully opened target', async () => {
  const h = await setup({ native: true });
  const next = notificationSession(h);
  const state = deferred();
  const list = deferred();
  h.network.state = () => state.promise;
  h.network.sessions = () => list.promise;
  h.context.window.__piVoiceOpenSession(next.handle, next.sessionId);
  const listing = vm.runInContext('pollSessions()', h.context);
  state.resolve(Response.json(next));
  await flush(); await flush();
  list.resolve(Response.json({ sessions: h.sessions }));
  await listing;
  assert.equal(vm.runInContext('state.sessionId', h.context), next.sessionId);
  assert.equal(vm.runInContext('sessionState.targetHandle', h.context), next.handle);
});

test('a notification for a replaced conversation is rejected before display or persistent selection', async () => {
  const h = await setup({ native: true });
  const next = notificationSession(h, 'session-300', 'replacement-conversation');
  const start = h.requests.length;
  h.context.window.__piVoiceOpenSession(next.handle, 'original-conversation');
  await flush(); await flush();
  assert.equal(vm.runInContext('state', h.context), undefined);
  assert.match(h.el('notice').textContent, /different conversation/);
  assert.equal(h.requests.slice(start).some((r) => r.path === '/api/session/select'), false);
  assert.equal(notificationCalls(h).length, 0);
});

test('after rejecting an old notification, the user can explicitly open the replacement in the same worker', async () => {
  const h = await setup({ native: true });
  const next = notificationSession(h, 'session-300', 'replacement-conversation');
  h.context.window.__piVoiceOpenSession(next.handle, 'original-conversation');
  await flush(); await flush();
  assert.equal(vm.runInContext('state', h.context), undefined);
  vm.runInContext(`sessionsController.switchTo('${next.handle}')`, h.context);
  await flush(); await flush();
  assert.equal(vm.runInContext('state.sessionId', h.context), next.sessionId);
  assert.equal(notificationCalls(h).at(-1).opened, false, 'An explicit choice overrides rather than acknowledges the old notification');
});

test('newest notification wins over a late state response or failure from the previous tap', async () => {
  for (const failure of [false, true]) {
    const h = await setup({ native: true });
    const previous = deferred();
    const newest = { ...h.state, handle: 'session-newest', sessionId: 'newest-conversation' };
    h.network.state = (handle) => handle === 'session-previous' ? previous.promise : Response.json(newest);
    h.context.window.__piVoiceOpenSession('session-previous', 'previous-conversation');
    h.context.window.__piVoiceOpenSession(newest.handle, newest.sessionId);
    if (failure) previous.reject(new Error('old worker failed'));
    else previous.resolve(Response.json({ ...h.state, handle: 'session-previous', sessionId: 'previous-conversation' }));
    await flush(); await flush();
    assert.equal(vm.runInContext('state.sessionId', h.context), newest.sessionId);
    assert.equal(notificationCalls(h).length, 1);
    assert.equal(notificationCalls(h)[0].handle, newest.handle);
    assert.equal(notificationCalls(h)[0].opened, true);
  }
});

test('a cold-start notification still opens if the initial default state request fails', async () => {
  const first = deferred();
  const h = await setup({ native: true, initialState: () => first.promise });
  const next = notificationSession(h);
  h.context.window.__piVoiceOpenSession(next.handle, next.sessionId);
  first.reject(new Error('default worker disappeared'));
  await flush(); await flush();
  assert.equal(vm.runInContext('state.sessionId', h.context), next.sessionId);
  assert.equal(notificationCalls(h).at(-1).opened, true);
  assert.equal(h.nativeCalls.some((call) => call.method === 'reconnect'), false);
});

test('a parallel session killed without cleanup reloads host selection instead of sticking', async () => {
  const h = await setup();
  h.sessions.push({ handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'two', title: 'Two', cwd: '/project', spawned: true });
  await vm.runInContext('pollSessions()', h.context);
  h.network.state = (handle) => handle === 'session-200' ? Response.json({ error: 'That session stopped responding.' }, { status: 502 }) : Response.json(h.state);
  await vm.runInContext('selectTarget("session-200"); poll()', h.context);
  await flush();
  assert.equal(h.requests.at(-1).handle, undefined, 'Re-read the host selection');
  assert.equal(vm.runInContext('sessionState.targetHandle', h.context), 'session-100', 'The dead target is not remembered');
  assert.equal(h.el('connection').textContent, 'Ready · project');
});

test('tapping the current session while another one loads switches back', async () => {
  const h = await setup();
  h.sessions.push({ handle: 'session-200', instanceId: 'instance-200', status: 'ready', capabilities: { close: true }, sessionId: 'two', title: 'Two', cwd: '/project', spawned: true });
  await vm.runInContext('pollSessions()', h.context);
  vm.runInContext("sessionsController.switchTo('session-200')", h.context);
  vm.runInContext("sessionsController.switchTo('session-100')", h.context);
  await flush();
  await flush();
  assert.equal(vm.runInContext('sessionState.targetHandle', h.context), 'session-100', 'The second tap wins');
});

test('Restore joins a launch in flight and survives a lost acknowledgement', async () => {
  const h = await setup();
  h.stopped.push({ handle: 'restore-4321', restorable: true, title: 'Earlier', cwd: '/project', updated: Date.now(), restoring: true });
  await vm.runInContext('pollSessions(); renderSessions()', h.context);
  await flush();
  vm.runInContext('renderSessions()', h.context);
  const row = h.el('stopped-list').children[0];
  assert.equal(row.children[1].disabled, true, 'A conversation being restored cannot be restored twice');
  assert.match(row.children[0].children[1].children[1].textContent, /^Restoring…/);
  h.stopped[0].restoring = false;
  h.context.fetch = ((original) => async (path, options) => {
    if (path === '/api/session/restore') throw new TypeError('Network lost');
    return original(path, options);
  })(h.context.fetch);
  await vm.runInContext(`sessionsController.restoreSession({ handle: 'restore-4321', restorable: true, title: 'Earlier' })`, h.context);
  assert.match(h.el('notice').textContent, /Checking whether the session was restored/);
  assert.ok(vm.runInContext('sessionState.spawnRequest', h.context), 'Still watching for the launched Pi; no second POST');
});

test('empty host stays connected, permits New, and blocks prompt and speech without a session', async () => {
  const h = await setup({ auto: true });
  h.sessions.length = 0;
  h.network.state = () => Response.json({ empty: true, sessionId: '', messages: [], status: 'empty', title: 'Pi Voice' });
  await vm.runInContext('selectTarget(undefined); poll()', h.context);
  await vm.runInContext('pollSessions()', h.context);
  assert.equal(h.el('new-session').disabled, false);
  assert.equal(h.el('microphone').disabled, true);
  h.el('draft').value = 'retain me';
  await vm.runInContext('send()', h.context);
  assert.deepEqual(h.prompts, []);
  assert.equal(h.el('draft').value, 'retain me');
  assert.match(h.el('latest-answer').textContent, /Start a new session/);
  assert.equal(h.el('reconnect').hidden, true);
  assert.equal(h.el('stop-host-section').hidden, false);
  h.el('open-sessions').click();
  assert.match(h.el('sessions-hint').textContent, /No session is running/);
  await vm.runInContext('startNewSession()', h.context);
  assert.equal(h.requests.filter((r) => r.path === '/api/session/spawn').length, 1);
});

test('closing the selected first session keeps draft/images and displays Closing until host confirms exit', async () => {
  const h = await setup({ auto: true });
  h.el('draft').value = 'my unsent draft';
  await attach(h);
  h.network.close = () => { h.sessions[0].status = 'closing'; h.sessions[0].capabilities.close = false; return Response.json({ status: 'closing' }, { status: 202 }); };
  await vm.runInContext('sessionsController.closeSession(sessionState.sessions[0])', h.context);
  assert.equal(h.el('draft').value, 'my unsent draft');
  assert.equal(h.el('attachments').children.length, 1);
  assert.equal(h.sessions[0].status, 'closing');
  assert.deepEqual(h.requests.find((r) => r.path === '/api/session/close').body, { sessionId: 'session-one', instanceId: 'instance-100' });
});

test('native preference migration imports allowlisted settings without replacing credentials or selection', async () => {
  const h = await setup();
  h.context.window.__piVoiceRestorePreferences({ language: 'de-DE', autosend: 'false', sound: 'false', token: 'attacker', 'session-handle': 'attacker' });
  assert.equal(h.el('language').value, 'de-DE');
  assert.equal(h.el('sound').checked, false);
  assert.equal(h.values.get('pi-voice-token'), 'test-token');
  assert.equal(vm.runInContext('sessionState.targetHandle', h.context), 'session-100');
});

// Auto-send waits 2 s; skip the wait instead of sleeping through it.
async function autoSendDue(h) {
  vm.runInContext('if (autoSend) autoSend.deadline = 0', h.context);
  await new Promise((resolve) => setTimeout(resolve, 300)); await flush();
}
function speak(h, text) {
  h.el('microphone').listeners.click();
  const engine = h.instances.at(-1);
  engine.onresult(result(text));
  engine.onend();
}

test('auto-send is off by default and, when on, sends the transcript after a visible countdown', async () => {
  const off = await setup();
  assert.equal(off.el('auto-send').checked, false);
  const h = await setup({ autoSend: true });
  assert.equal(h.el('auto-send').checked, true);
  h.el('microphone').listeners.click();
  assert.equal(h.el('listening').textContent, 'Listening… Sends when you pause');
  h.instances[0].onresult(result('run the tests'));
  h.instances[0].onend();
  await flush();
  assert.deepEqual(h.prompts, [], 'Never sent immediately');
  assert.match(h.el('notice').textContent, /Sending in 2 s/);
  assert.equal(h.el('auto-send-edit').hidden, false);
  await autoSendDue(h);
  assert.deepEqual(h.prompts.map((prompt) => [prompt.text, prompt.sessionId]), [['run the tests', 'session-one']]);
  assert.equal(h.el('auto-send-edit').hidden, true);
  assert.equal(h.el('draft').value, '');
});

test('Edit, typing, tapping the draft, attaching, leaving the app or switching sessions cancel auto-send', async () => {
  const cancels = {
    edit: (h) => h.el('auto-send-edit').click(),
    typing: (h) => { h.el('draft').value += ' and lint'; h.el('draft').listeners.input(); },
    tap: (h) => h.el('draft').listeners.pointerdown(),
    attach: (h) => h.el('attach').click(),
    hidden: (h) => { h.document.hidden = true; h.document.listeners.visibilitychange(); },
    switch: (h) => vm.runInContext("selectTarget('session-200')", h.context),
    setting: (h) => { h.el('auto-send').checked = false; h.el('auto-send').listeners.change(); },
  };
  for (const [name, cancel] of Object.entries(cancels)) {
    const h = await setup({ autoSend: true });
    speak(h, 'run the tests'); await flush();
    cancel(h);
    await autoSendDue(h);
    assert.deepEqual(h.prompts, [], name);
    assert.equal(h.el('auto-send-edit').hidden, true, name);
    if (name !== 'switch') assert.match(h.el('draft').value, /^run the tests/, `${name} keeps the transcript`);
    if (!['switch'].includes(name)) assert.match(h.el('notice').textContent, /Auto-send cancelled/, name);
  }
  const sent = await setup({ autoSend: true });
  speak(sent, 'send it now'); await flush();
  sent.el('send').click(); await flush(); await autoSendDue(sent);
  assert.equal(sent.prompts.length, 1, 'Tapping Send during the countdown sends once');
});

test('auto-send never sends images, a changed draft or into another conversation', async () => {
  const images = await setup({ autoSend: true });
  await attach(images);
  speak(images, 'Explain this photo'); await flush(); await autoSendDue(images);
  assert.deepEqual(images.prompts, []);
  assert.match(images.el('notice').textContent, /Transcript and images ready/);
  const moved = await setup({ autoSend: true });
  speak(moved, 'for the first conversation'); await flush();
  Object.assign(moved.state, { sessionId: 'session-two' });
  await vm.runInContext('poll()', moved.context); await autoSendDue(moved);
  assert.deepEqual(moved.prompts, []);
  assert.match(moved.el('notice').textContent, /Pi switched sessions|Auto-send cancelled/);
});

test('auto-send waits for a compaction or model change instead of dropping the message', async () => {
  const h = await setup({ autoSend: true });
  speak(h, 'continue after compacting'); await flush();
  h.state.compaction = { status: 'running' };
  await vm.runInContext('poll()', h.context);
  await autoSendDue(h);
  assert.deepEqual(h.prompts, []);
  assert.match(h.el('notice').textContent, /Sending when Pi finishes compacting/);
  assert.equal(h.el('auto-send-edit').hidden, false, 'Still cancellable while waiting');
  h.state.compaction = { status: 'done', ended: 1 };
  await vm.runInContext('poll()', h.context);
  await new Promise((resolve) => setTimeout(resolve, 600)); await flush();
  assert.deepEqual(h.prompts.map((prompt) => prompt.text), ['continue after compacting']);
});

test('the auto-send setting is saved under its own key and survives the native preference migration', async () => {
  const h = await setup({ auto: true });
  assert.equal(h.el('auto-send').checked, false, 'The pre-3.0 autosend preference stays ignored');
  h.el('auto-send').checked = true; h.el('auto-send').listeners.change();
  assert.equal(h.values.get('pi-voice-auto-send'), 'true');
  const restored = await setup();
  restored.context.window.__piVoiceRestorePreferences({ 'auto-send': 'true' });
  assert.equal(restored.el('auto-send').checked, true);
});

async function openModels(h) {
  h.el('open-model').click(); await flush();
}
const modelKey = (model) => JSON.stringify([model.provider, model.id]);
const modelRows = (h) => (h.el('model-list').children || []).filter((child) => child.className?.startsWith('option-row'));
const modelRow = (h, model = h.models[1]) => modelRows(h).find((row) => row.dataset.key === modelKey(model));
const textOf = (node) => node?.textContent ?? (node?.children || []).map(textOf).join(' ');
function chooseModel(h, model = h.models[1]) {
  modelRow(h, model).click();
}

test('model picker uses the registry, filters generically, and preserves drafts/images across an explicit session-only switch', async () => {
  const h = await setup();
  h.el('draft').value = 'Keep this unsent question'; await attach(h);
  await openModels(h);
  assert.equal(h.el('model-dialog').open, true);
  assert.equal(h.el('model-controls').hidden, false);
  assert.equal(modelRows(h).length, 2);
  assert.deepEqual(h.el('model-list').children.filter((child) => child.className === 'option-group').map((child) => child.textContent), ['test', 'custom-local'], 'Grouped by provider, in Pi’s order');
  assert.equal(modelRow(h, h.models[0]).attributes['aria-checked'], 'true');
  modelRow(h, h.models[0]).click(); await flush();
  assert.equal(h.requests.some((entry) => entry.path === '/api/model'), false, 'The current model is not an action');
  h.el('model-filter').value = 'Q5_K_M'; h.el('model-filter').listeners.input();
  assert.equal(modelRows(h).length, 1);
  assert.match(textOf(modelRow(h)), /Local model 4K context · Text only · Thinking/, 'The provider is the group heading');
  chooseModel(h); await flush(); await flush();
  const request = h.requests.find((entry) => entry.path === '/api/model');
  assert.equal(request.handle, 'session-100');
  assert.deepEqual(request.body, { sessionId: 'session-one', provider: 'custom-local', id: 'qwen/model:Q5_K_M', expectedModel: { provider: 'test', id: 'test' } });
  assert.match(h.confirmations.at(-1), /existing conversation.*custom-local/);
  assert.ok(h.confirmations.at(-1).includes(`${(4096).toLocaleString()} token context`));
  assert.match(h.confirmations.at(-1), /unsent images will be kept/);
  assert.equal(h.el('draft').value, 'Keep this unsent question');
  assert.equal(h.el('attachments').children.length, 1);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.el('model').textContent, 'custom-local/qwen/model:Q5_K_M');
  assert.equal(h.el('send').disabled, true, 'Do not drop images for a text-only model');
  assert.match(h.el('model-status').textContent, /Using custom-local/);
});

test('a same-provider model switch needs no confirmation; costly ones always ask', async () => {
  const h = await setup();
  h.models.push({ provider: 'test', id: 'test-large', name: 'Cloud large', input: ['text', 'image'], contextWindow: 200000, reasoning: true });
  await openModels(h);
  chooseModel(h, h.models[2]); await flush(); await flush();
  assert.equal(h.confirmations.length, 0);
  assert.deepEqual(h.requests.filter((entry) => entry.path === '/api/model').map((entry) => entry.body.id), ['test-large']);
  assert.match(h.el('model-status').textContent, /Using test\/test-large/);
});

test('model picker confirmation cancellation, busy/queued tasks, recording and image preparation never POST', async () => {
  const cancelled = await setup({ confirmed: false }); await openModels(cancelled); chooseModel(cancelled); await flush();
  assert.equal(cancelled.confirmations.length, 1);
  assert.equal(cancelled.requests.some((entry) => entry.path === '/api/model'), false);
  for (const flag of ['busy', 'pending', 'recording', 'preparing', 'switching', 'compacting']) {
    const h = await setup(); await openModels(h);
    if (flag === 'busy') h.state.busy = true;
    if (flag === 'pending') h.state.pending = true;
    if (flag === 'switching') h.state.modelSwitching = true;
    if (flag === 'compacting') h.state.compaction = { status: 'running' };
    if (flag === 'recording') h.el('microphone').click();
    if (flag === 'preparing') vm.runInContext('preparingImages = true', h.context);
    await vm.runInContext('poll()', h.context);
    assert.equal(h.el('model-list').classes.has('locked'), true, flag);
    chooseModel(h); await flush();
    assert.equal(h.requests.some((entry) => entry.path === '/api/model'), false, flag);
  }
});

test('model changes are single-flight and block composer side effects until Pi confirms', async () => {
  const h = await setup(); h.el('draft').value = 'Do not submit'; await openModels(h);
  let finish;
  h.network.model = (body) => new Promise((resolve) => { finish = () => {
    h.state.modelSelection = { provider: body.provider, id: body.id }; h.state.model = `${body.provider}/${body.id}`;
    resolve(Response.json({ ok: true }));
  }; });
  chooseModel(h); chooseModel(h); await flush();
  assert.equal(h.requests.filter((entry) => entry.path === '/api/model').length, 1);
  assert.equal(textOf(modelRow(h)).includes('Changing…'), true);
  for (const id of ['send', 'attach', 'microphone', 'new-session']) assert.equal(h.el(id).disabled, true, id);
  h.el('send').click(); h.el('microphone').click(); await vm.runInContext('startNewSession()', h.context);
  assert.equal(h.prompts.length, 0); assert.equal(h.instances.length, 0);
  assert.equal(h.requests.some((entry) => entry.path === '/api/session/spawn'), false);
  finish(); await flush(); await flush();
  assert.equal(h.el('draft').value, 'Do not submit');
  assert.equal(h.el('send').disabled, false);
});

test('a lost model acknowledgement reconciles authoritative state and never automatically retries POST', async () => {
  const h = await setup(); await openModels(h);
  h.network.model = async (body) => {
    h.state.modelSelection = { provider: body.provider, id: body.id }; h.state.model = `${body.provider}/${body.id}`;
    throw new Error('Timed out');
  };
  chooseModel(h); await flush(); await flush();
  assert.equal(h.requests.filter((entry) => entry.path === '/api/model').length, 1);
  assert.equal(h.el('model').textContent, 'custom-local/qwen/model:Q5_K_M');
  assert.match(h.el('model-status').textContent, /Pi confirms/);
  assert.equal(h.el('model-status').classes.has('error'), false);
});

test('a successful model acknowledgement keeps controls locked until a later poll confirms the active model', async () => {
  const h = await setup(); h.el('draft').value = 'Wait for confirmed state'; await openModels(h);
  h.network.model = () => Response.json({ ok: true }); // Simulate an already-running state poll returning an old snapshot.
  chooseModel(h); await flush(); await flush();
  assert.match(h.el('model-status').textContent, /Change accepted/);
  assert.equal(h.el('send').disabled, true);
  assert.equal(h.el('model-list').classes.has('locked'), true);
  h.state.modelSelection = { provider: h.models[1].provider, id: h.models[1].id };
  h.state.model = `${h.models[1].provider}/${h.models[1].id}`;
  await vm.runInContext('poll()', h.context);
  assert.match(h.el('model-status').textContent, /Using custom-local/);
  assert.equal(h.el('send').disabled, false);
  assert.equal(h.el('draft').value, 'Wait for confirmed state');
  assert.equal(h.requests.filter((entry) => entry.path === '/api/model').length, 1);
});

test('state polls settle authentication that outlives a timed-out model request, without replaying it', async () => {
  for (const succeeds of [true, false]) {
    const h = await setup(); h.el('draft').value = 'Keep this draft'; await openModels(h);
    h.network.model = async () => { h.state.modelSwitching = true; throw new Error('Timed out'); };
    chooseModel(h); await flush(); await flush();
    assert.equal(h.el('model-status').classes.has('error'), false, 'A pending change is not a rejection');
    assert.equal(h.el('send').disabled, true);
    h.state.modelSwitching = false;
    if (succeeds) {
      h.state.modelSelection = { provider: h.models[1].provider, id: h.models[1].id };
      h.state.model = `${h.models[1].provider}/${h.models[1].id}`;
    }
    await vm.runInContext('poll()', h.context);
    assert.match(h.el('model-status').textContent, succeeds ? /Pi confirms/ : /no longer changing models/);
    assert.equal(h.el('model-status').classes.has('error'), !succeeds);
    assert.equal(h.requests.filter((entry) => entry.path === '/api/model').length, 1);
    assert.equal(h.el('send').disabled, false);
  }
});

test('a timed-out model change waits for a fresh state request before unlocking controls', async () => {
  const h = await setup(); h.el('draft').value = 'Wait for authentication';
  await openModels(h);
  const oldState = Response.json(h.state);
  let finishPoll;
  h.network.state = () => new Promise((resolve) => { finishPoll = () => resolve(oldState); });
  const pendingPoll = vm.runInContext('poll()', h.context);
  h.network.model = async () => { h.state.modelSwitching = true; throw new Error('Timed out'); };
  chooseModel(h); await flush(); await flush();
  assert.equal(h.el('send').disabled, true, 'An older in-flight poll cannot resolve a model mutation');
  h.network.state = () => Response.json(h.state);
  finishPoll(); await pendingPoll; await flush(); await flush();
  assert.equal(h.el('send').disabled, true, 'Authentication is still running in Pi');
  assert.match(h.el('model-status').textContent, /still changing models|model change is in progress/);
  assert.equal(h.requests.filter((entry) => entry.path === '/api/model').length, 1);
  h.state.modelSwitching = false;
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('send').disabled, false);
});

test('a model changed back in Termux after acceptance does not leave the composer locked', async () => {
  const h = await setup(); h.el('draft').value = 'Keep this draft';
  await openModels(h);
  // Pi accepted the choice, but the terminal restored the previous model
  // before the browser could observe the intermediate selection.
  h.network.model = () => Response.json({ ok: true });
  chooseModel(h); await flush(); await flush();
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('send').disabled, false);
  assert.equal(h.el('model-refresh').disabled, false);
  assert.match(h.el('model-status').textContent, /changed again|no longer changing/);
  assert.equal(h.el('draft').value, 'Keep this draft');
  assert.equal(h.requests.filter((entry) => entry.path === '/api/model').length, 1);
});

test('provider rejection keeps the old model, releases controls and never silently falls back', async () => {
  const h = await setup(); h.el('draft').value = 'Keep me'; await openModels(h);
  h.network.model = () => Response.json({ error: 'Provider authentication unavailable' }, { status: 422 });
  chooseModel(h); await flush(); await flush();
  assert.equal(h.el('model').textContent, 'test/test');
  assert.equal(h.el('draft').value, 'Keep me');
  assert.match(h.el('model-status').textContent, /authentication unavailable/);
  assert.equal(h.el('model-status').classes.has('error'), true);
  assert.equal(h.el('send').disabled, false);
  assert.equal(h.requests.filter((entry) => entry.path === '/api/model').length, 1);
});

test('old backends, empty registries and vanished current models have actionable, non-destructive UI', async () => {
  const h = await setup(); delete h.state.modelSwitchingSupported;
  await vm.runInContext('poll()', h.context); await openModels(h);
  assert.equal(h.el('model-controls').hidden, true);
  h.state.modelSwitchingSupported = true;
  h.network.models = () => Response.json({ error: 'Not installed' }, { status: 404 });
  await vm.runInContext('poll()', h.context); await flush();
  assert.match(h.el('model-status').textContent, /restart its host and this Pi/);
  h.network.models = () => Response.json({ sessionId: h.state.sessionId, current: h.state.modelSelection, models: [] });
  h.el('model-refresh').click(); await flush();
  const [current] = modelRows(h);
  assert.equal(modelRows(h).length, 1);
  assert.equal(current.disabled, true);
  assert.match(textOf(current), /test\/test.*no longer configured/);
  assert.match(h.el('model-status').textContent, /Configure a provider/);
});

test('external Pi model selections update the picker without replacing the conversation or choosing for the user', async () => {
  const h = await setup(); await openModels(h);
  h.state.modelSelection = { provider: 'third-party', id: 'picked-in-termux' }; h.state.model = 'third-party/picked-in-termux';
  await vm.runInContext('poll()', h.context);
  const checked = modelRows(h).filter((row) => row.attributes['aria-checked'] === 'true');
  assert.deepEqual(checked.map((row) => row.dataset.key), [JSON.stringify(['third-party', 'picked-in-termux'])]);
  assert.equal(h.requests.some((entry) => entry.path === '/api/model'), false);
});

test('stale model lists and completed POSTs cannot overwrite or notify a newly selected session', async () => {
  for (const type of ['list', 'post']) {
    const h = await setup(); let finish;
    if (type === 'list') h.network.models = () => new Promise((resolve) => { finish = () => resolve(Response.json({ sessionId: 'session-one', current: { provider: 'test', id: 'test' }, models: h.models })); });
    await openModels(h);
    if (type === 'post') {
      h.network.model = () => new Promise((resolve) => { finish = () => resolve(Response.json({ ok: true })); });
      chooseModel(h); await flush();
    }
    const oldFinish = finish;
    h.network.models = () => Response.json({ sessionId: 'session-two', current: { provider: 'elsewhere', id: 'other' }, models: [{ provider: 'elsewhere', id: 'other', name: 'Other', input: ['text'] }] });
    Object.assign(h.state, { handle: 'session-200', instanceId: 'instance-200', sessionId: 'session-two', model: 'elsewhere/other', modelSelection: { provider: 'elsewhere', id: 'other' } });
    vm.runInContext("selectTarget('session-200')", h.context); await vm.runInContext('poll()', h.context); await flush();
    oldFinish(); await flush(); await flush();
    assert.equal(h.el('model').textContent, 'elsewhere/other', type);
    assert.deepEqual(modelRows(h).filter((row) => row.attributes['aria-checked'] === 'true').map((row) => row.dataset.key), [JSON.stringify(['elsewhere', 'other'])], type);
    assert.doesNotMatch(h.el('model-status').textContent, /Using custom-local|Change accepted|not confirmed/, type);
  }
});

test('Pi’s scoped models are listed first and the composer chip shows the model and thinking level', async () => {
  const h = await setup();
  h.models[1].scoped = true;
  await vm.runInContext('poll()', h.context);
  assert.equal(h.el('open-model').hidden, false);
  assert.deepEqual([h.el('model-chip-label').textContent, h.el('model-chip-level').textContent], ['Cloud model', 'Med']);
  assert.equal(h.el('open-model').attributes['aria-label'], 'Model: Cloud model, thinking level Medium');
  await openModels(h);
  assert.equal(h.el('model-list').children[0].textContent, 'Scoped in Pi');
  assert.equal(h.el('model-list').children[1].dataset.key, modelKey(h.models[1]));
  h.el('microphone').click();
  assert.equal(h.el('open-model').hidden, true, 'The live transcript hint replaces the chip while recording');
});

test('thinking levels come from Pi, apply to this session only and may change while Pi works', async () => {
  const h = await setup(); await openModels(h);
  const levels = () => h.el('thinking-levels').children;
  assert.deepEqual(levels().map((button) => button.textContent), ['Off', 'Min', 'Low', 'Med', 'High']);
  assert.deepEqual(levels().map((button) => button.attributes['aria-label']), ['Off', 'Minimal', 'Low', 'Medium', 'High']);
  assert.equal(levels().find((button) => button.attributes['aria-checked'] === 'true').textContent, 'Med');
  h.state.busy = true; await vm.runInContext('poll()', h.context);
  levels().find((button) => button.textContent === 'High').click(); await flush(); await flush();
  assert.deepEqual(h.requests.filter((entry) => entry.path === '/api/thinking').map((entry) => entry.body), [{ sessionId: 'session-one', level: 'high' }]);
  assert.equal(h.el('model-chip-level').textContent, 'High');
  assert.match(h.el('thinking-status').textContent, /High for this session/);
  assert.equal(h.confirmations.length, 0, 'A reversible session setting needs no confirmation');
  h.network.thinking = () => Response.json({ ok: true, thinkingLevel: 'low' });
  levels().find((button) => button.textContent === 'Min').click(); await flush(); await flush();
  assert.match(h.el('thinking-status').textContent, /Pi chose Low/);
  h.state.thinkingLevels = ['off']; await vm.runInContext('poll()', h.context);
  assert.equal(h.el('thinking-levels').hidden, true);
  assert.match(h.el('thinking-status').textContent, /no thinking levels/);
  assert.equal(h.el('model-chip-level').hidden, true);
  h.state.thinkingLevels = ['off', 'low']; h.state.modelSwitching = true; await vm.runInContext('poll()', h.context);
  assert.equal(levels().every((button) => button.disabled), true, 'Never races a model change');
});

test('compaction is confirmed, pauses sending, reports its outcome and refreshes context use', async () => {
  const h = await setup(); h.el('draft').value = 'Send after compaction'; await openModels(h);
  assert.equal(h.el('context-usage').textContent, '8K of 128K tokens used · 6%', 'Older hosts send only contextTokens');
  h.network.models = () => Response.json({ sessionId: h.state.sessionId, current: h.state.modelSelection, models: h.models, contextTokens: 96000, contextUsage: { tokens: 96000, contextWindow: 128000 } });
  h.el('model-refresh').click(); await flush();
  assert.equal(h.el('context-usage').textContent, '96K of 128K tokens used · 75%');
  h.el('compact').click(); await flush(); await flush();
  assert.match(h.confirmations.at(-1), /Compact this conversation\?/);
  assert.deepEqual(h.requests.filter((entry) => entry.path === '/api/compact').map((entry) => entry.body), [{ sessionId: 'session-one' }]);
  assert.equal(h.el('send').disabled, true);
  assert.equal(h.el('draft').readOnly, false, 'Typing continues while Pi compacts');
  assert.equal(h.el('thinking-label').textContent, 'Compacting the conversation…');
  assert.match(h.el('connection').textContent, /^Compacting/);
  assert.equal(h.el('compact').disabled, true);
  assert.equal(h.el('model-list').classes.has('locked'), true);
  h.el('send').click(); await flush();
  assert.equal(h.prompts.length, 0);
  h.network.models = () => Response.json({ sessionId: h.state.sessionId, current: h.state.modelSelection, models: h.models, contextTokens: null, contextUsage: { tokens: null, contextWindow: 128000 } });
  h.state.compaction = { status: 'done', tokensBefore: 96000, ended: 1 };
  await vm.runInContext('poll()', h.context); await flush();
  assert.match(h.el('notice').textContent, /Conversation compacted from about 96K tokens/);
  assert.match(h.el('context-usage').textContent, /Unknown until Pi’s next reply · 128K context/);
  assert.equal(h.el('send').disabled, false);
  assert.equal(h.el('draft').value, 'Send after compaction');
});

test('compaction can be declined, is blocked while Pi works, and failures and Stop are reported', async () => {
  const declined = await setup({ confirmed: false }); await openModels(declined);
  declined.el('compact').click(); await flush();
  assert.equal(declined.requests.some((entry) => entry.path === '/api/compact'), false);
  const busy = await setup(); busy.state.busy = true; await vm.runInContext('poll()', busy.context); await openModels(busy);
  assert.equal(busy.el('compact').disabled, true);
  assert.match(busy.el('compact-status').textContent, /Finish or stop the current task/);
  busy.el('compact').click(); await flush();
  assert.equal(busy.requests.some((entry) => entry.path === '/api/compact'), false);
  for (const [outcome, text] of [[{ status: 'error', error: 'Nothing to compact (session too small)' }, /Could not compact: Nothing to compact/], [{ status: 'cancelled' }, /Compaction stopped/]]) {
    const h = await setup(); await openModels(h);
    h.el('compact').click(); await flush(); await flush();
    if (outcome.status === 'cancelled') {
      h.el('abort').click(); await flush(); await flush();
      assert.match(h.confirmations.at(-1), /Stop compacting\?/);
      assert.equal(h.requests.filter((entry) => entry.path === '/api/abort').length, 1);
    }
    h.state.compaction = outcome;
    await vm.runInContext('poll()', h.context);
    assert.match(h.el('notice').textContent, text);
    assert.equal(h.el('notice').classes.has('error'), outcome.status === 'error');
  }
  const old = await setup(); delete old.state.compactSupported; delete old.state.thinkingSupported;
  await vm.runInContext('poll()', old.context); await openModels(old);
  assert.equal(old.el('compact').disabled, true);
  assert.match(old.el('compact-status').textContent, /Restart this Pi/);
  assert.match(old.el('thinking-status').textContent, /Restart this Pi/);
});

test('the page asks with its own dialog: declining keeps everything and Escape declines', async () => {
  const h = await setup({ confirmed: false, native: true });
  h.state.busy = true; await vm.runInContext('poll()', h.context);
  h.el('abort').click(); await flush();
  assert.match(h.confirmations.at(-1), /Stop Pi’s current task\?/);
  assert.equal(h.requests.some((entry) => entry.path === '/api/abort'), false);
  assert.equal(h.el('confirm-accept').classes.has('danger'), true);
  h.document.getElementById('confirm-dialog').onShowModal = undefined;
  const answer = vm.runInContext("dialogs.ask({ title: 'Question', message: ['One', 'Two'] })", h.context);
  assert.deepEqual(h.el('confirm-message').children.map((child) => child.textContent), ['One', 'Two']);
  h.el('confirm-dialog').open = false; h.el('confirm-dialog').listeners.close();
  assert.equal(await answer, false);
});

const engineRows = (h, id) => h.el(id).children || [];
const engineRow = (h, id, choice) => engineRows(h, id).find((row) => row.dataset.id === choice);

test('installed speech services and text-to-speech engines can be chosen, and an uninstalled one falls back', async () => {
  const whisper = 'org.woheller69.whisperplus/.RecognitionService';
  const engines = {
    speech: [{ id: 'com.google.android.as/.Recognizer', label: 'Google', default: true }, { id: whisper, label: 'Whisper+', default: false }, { id: 'on-device', label: 'Android on-device recognition', default: false }],
    voices: [{ id: 'com.google.android.tts', label: 'Speech Services by Google', default: true }, { id: 'org.woheller69.ttsengine', label: 'SherpaTTS', default: false }],
  };
  const h = await setup({ native: true, engines, playback: true });
  assert.deepEqual(engineRows(h, 'speech-engines').map((row) => row.dataset.id), ['default', 'com.google.android.as/.Recognizer', whisper, 'on-device', 'termux']);
  assert.match(textOf(engineRow(h, 'speech-engines', 'default')), /Android’s selected service: Google/);
  assert.equal(engineRow(h, 'speech-engines', 'default').attributes['aria-checked'], 'true');
  engineRow(h, 'speech-engines', whisper).click();
  assert.equal(h.values.get('pi-voice-speech-service'), whisper);
  assert.equal(engineRow(h, 'speech-engines', whisper).attributes['aria-checked'], 'true');
  h.el('microphone').click();
  assert.deepEqual(h.nativeCalls.find((call) => call.method === 'start'), { method: 'start', id: h.nativeCalls.find((call) => call.method === 'start').id, lang: 'en-US', service: whisper });
  assert.equal(engineRows(h, 'speech-engines').every((row) => row.disabled), true, 'Locked while recording');
  assert.deepEqual(engineRows(h, 'read-engines').map((row) => row.dataset.id), ['default', 'com.google.android.tts', 'org.woheller69.ttsengine']);
  engineRow(h, 'read-engines', 'org.woheller69.ttsengine').click();
  assert.equal(h.values.get('pi-voice-read-engine'), 'org.woheller69.ttsengine');
  assert.equal(vm.runInContext('speechEngines.voice', h.context), 'org.woheller69.ttsengine');
  vm.runInContext("cancelRecording(); playback.speak('Hello', 'en-US', speechEngines.voice)", h.context);
  assert.equal(h.nativeCalls.findLast((call) => call.method === 'read').engine, 'org.woheller69.ttsengine');
  // Uninstalled while the app ran: Settings reads the lists again when it opens.
  engines.speech = engines.speech.filter((item) => item.id !== whisper);
  engines.voices = engines.voices.slice(0, 1);
  h.el('open-settings').click();
  assert.equal(engineRow(h, 'speech-engines', 'default').attributes['aria-checked'], 'true');
  assert.match(h.el('speech-engines-hint').textContent, /no longer installed/);
  assert.equal(vm.runInContext('speechEngines.service', h.context), 'default');
  assert.equal(vm.runInContext('speechEngines.voice', h.context), 'default');
});

test('older apps and plain browsers keep their speech choices and explain what an update adds', async () => {
  const old = await setup({ native: true });
  assert.deepEqual(engineRows(old, 'speech-engines').map((row) => row.dataset.id), ['default', 'termux']);
  assert.match(old.el('speech-engines-hint').textContent, /Update the Pi Voice app/);
  assert.equal(old.el('read-engines').hidden, true);
  assert.match(old.el('read-engines-hint').textContent, /Update the Pi Voice app/);
  engineRow(old, 'speech-engines', 'termux').click();
  assert.deepEqual([old.values.get('pi-voice-speech-service'), old.values.get('pi-voice-engine')], ['termux', 'termux']);
  old.el('microphone').click(); await flush();
  assert.equal(old.requests.some((entry) => entry.path === '/api/listen'), true, 'Termux:API records through Pi');
  const browser = await setup();
  assert.match(textOf(engineRow(browser, 'speech-engines', 'default')), /Browser speech/);
  vm.runInContext("window.__piVoiceRestorePreferences({ engine: 'termux' })", browser.context);
  assert.equal(engineRow(browser, 'speech-engines', 'termux').attributes['aria-checked'], 'true', 'A migrated pre-list preference still applies');
});

test('failed replies retain partial output, show retry activity and do not play success feedback', async () => {
  const h = await setup({ native: true });
  h.state.busy = true;
  h.state.messages = [
    { id: 'question-failed', role: 'user', text: 'Do the work' },
    { id: 'answer-failed', role: 'assistant', text: 'Partial progress', stopReason: 'error', error: 'Connection reset' },
  ];
  await vm.runInContext('poll()', h.context);
  assert.match(h.el('latest-answer').innerHTML, /Partial progress/);
  assert.match(h.el('latest-answer').innerHTML, /still working/);
  assert.doesNotMatch(h.el('latest-answer').innerHTML, /send a message to continue/);
  h.state.busy = false;
  const before = h.feedback.length;
  await vm.runInContext('poll()', h.context);
  assert.match(h.el('latest-answer').innerHTML, /Connection reset/);
  assert.equal(h.feedback.length, before, 'An error is not a successful reply chime/haptic');
  assert.equal(h.prompts.length, 0, 'A failed turn is never automatically replayed');
  h.state.messages.at(-1).stopReason = 'aborted';
  await vm.runInContext('poll()', h.context);
  assert.match(h.el('latest-answer').innerHTML, /task was stopped/);
});
