import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
const source = await readFile(new URL('../src/playback.js', import.meta.url), 'utf8');
function setup({ browser = true, native = false, oldNative = false } = {}) {
  const utterances = [], calls = [], errors = [], timers = new Map();
  let tick = 0, changes = 0;
  class Utterance { constructor(text) { this.text = text; } }
  const synthesis = { speak: (utterance) => utterances.push(utterance), cancel: () => calls.push(['cancel']), resume: () => calls.push(['resume']) };
  const bridge = native ? { speakText: (...args) => calls.push(['speak', ...args]), stopReading: (id) => calls.push(['stop', id]) } : oldNative ? {} : undefined;
  const window = { PiVoiceAndroid: bridge, speechSynthesis: browser ? synthesis : undefined, SpeechSynthesisUtterance: browser ? Utterance : undefined };
  const context = vm.createContext({ window, navigator: { language: 'en-US' }, crypto: { randomUUID },
    setTimeout: (fn, ms) => { const id = ++tick; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id) });
  vm.runInContext(source, context);
  const api = context.PiVoicePlayback;
  const reader = api.create({ onState: () => changes++, onError: (code) => errors.push(code) });
  return { reader, api, window, synthesis, utterances, calls, errors, timers, changes: () => changes };
}

test('playback never starts on initialization and unsupported/old native shells are detected', () => {
  const h = setup();
  assert.equal(h.reader.supported, true);
  assert.equal(h.reader.active, false);
  assert.equal(h.utterances.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(setup({ browser: false }).reader.supported, false);
  const old = setup({ oldNative: true });
  assert.equal(old.reader.supported, false, 'Do not use browser synthesis in an old WebView');
  assert.equal(old.reader.needsUpgrade, true);
  old.reader.speak('Hello', 'en-US');
  assert.deepEqual(old.errors, ['upgrade']);
  assert.equal(old.utterances.length, 0);
});

test('browser reads bounded chunks in order and ignores duplicate completion callbacks', () => {
  const h = setup();
  const text = 'A complete sentence. '.repeat(60).trim();
  h.reader.speak(text, 'de-DE');
  assert.equal(h.reader.active, true);
  assert.equal(h.utterances.length, 1);
  assert.equal(h.utterances[0].lang, 'de-DE');
  assert.deepEqual(h.calls[0], ['resume'], 'Explicit start resumes an engine left paused by interruption');
  const first = h.utterances[0];
  first.onend();
  first.onend();
  assert.equal(h.utterances.length, 2);
  for (let i = 1; i < h.utterances.length; i++) h.utterances[i].onend();
  assert.equal(h.utterances.map((item) => item.text).join(''), text);
  assert.ok(h.utterances.every((item) => item.text.length <= 320));
  assert.equal(h.reader.active, false);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.errors, []);
});

test('cancelled browser callbacks never advance the old reply or stop a newer reading', () => {
  const h = setup();
  h.reader.speak('Old answer. '.repeat(100), 'en-US');
  const old = h.utterances[0];
  h.reader.stop();
  h.reader.speak('New answer', 'en-US');
  old.onend(); old.onerror({ error: 'interrupted' });
  assert.equal(h.utterances.length, 2);
  assert.equal(h.reader.active, true);
  assert.deepEqual(h.errors, []);
  h.utterances[1].onend();
  assert.equal(h.reader.active, false);
});

test('native playback sends plain text and language to Android, handles progress and isolates IDs', () => {
  const h = setup({ native: true });
  h.reader.speak('Eine Antwort.', 'de-DE');
  const [, id, text, language] = h.calls[0];
  assert.equal(text, 'Eine Antwort.'); assert.equal(language, 'de-DE');
  assert.equal(h.utterances.length, 0);
  h.window.__piVoiceNativePlayback('stale', 'end', '');
  assert.equal(h.reader.active, true);
  h.window.__piVoiceNativePlayback(id, 'progress', '');
  assert.equal([...h.timers.values()][0].ms, 180000);
  h.reader.stop();
  assert.deepEqual(h.calls.at(-1), ['stop', id]);
  h.reader.speak('New', 'en-US');
  h.window.__piVoiceNativePlayback(id, 'error', 'unavailable');
  assert.equal(h.reader.active, true);
  assert.deepEqual(h.errors, []);
  h.window.__piVoiceNativePlayback(h.calls.at(-1)[1], 'end', '');
  assert.equal(h.reader.active, false);
  assert.equal(h.timers.size, 0);
});

test('voice errors, thrown starts and stalled engines leave a retryable stopped state', () => {
  const h = setup();
  h.reader.speak('Hello', 'en-US');
  h.utterances[0].onerror({ error: 'language-unavailable' });
  assert.equal(h.reader.active, false);
  assert.equal(h.timers.size, 0);
  h.reader.speak('Retry', 'en-US');
  [...h.timers.values()][0].fn();
  assert.equal(h.reader.active, false);
  h.synthesis.speak = () => { throw new Error('No speech service'); };
  h.reader.speak('Retry', 'en-US');
  assert.equal(h.reader.active, false);
  assert.deepEqual(h.errors, ['language-unavailable', 'unavailable', 'unavailable']);
  assert.equal(h.timers.size, 0);
});

test('empty/oversize text and malformed language are rejected before speech starts', () => {
  const h = setup();
  h.reader.speak(' ', 'en-US');
  h.reader.speak('a'.repeat(32001), 'en-US');
  h.reader.speak('Hello', 'en_US');
  assert.equal(h.utterances.length, 0);
  assert.equal(h.reader.active, false);
  assert.deepEqual(h.errors, ['text-limit', 'text-limit', 'language']);
});

test('speech chunks round-trip whitespace/Unicode and never split surrogate pairs', () => {
  const h = setup();
  for (const text of ['', 'a'.repeat(4000), 'hello world\n'.repeat(100), `abc${'😀'.repeat(16000)}xyz`]) {
    for (const limit of [2, 11, 320]) {
      const parts = h.api.chunks(text, limit);
      assert.equal(parts.join(''), text);
      for (const part of parts) {
        assert.ok(part.length <= limit && part.length > 0);
        assert.equal(/[\uD800-\uDBFF]$/.test(part), false);
        assert.equal(/^[\uDC00-\uDFFF]/.test(part), false);
      }
    }
  }
  assert.throws(() => h.api.chunks('a', 1), /Invalid speech chunk/);
});
