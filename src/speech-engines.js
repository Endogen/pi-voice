/* Speech recognition and read-aloud engines for Settings. The choices are the
 * services installed on the phone (for example a Whisper-based recognizer or a
 * Piper voice engine), listed by the native app; nothing is downloaded here. */
(() => {
  'use strict';
  const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const valid = (item) => item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 400 && typeof item.label === 'string';
  function installed(call) {
    try {
      const list = JSON.parse(call());
      return Array.isArray(list) ? list.filter(valid).map((item) => ({ id: item.id, label: item.label.slice(0, 80), preferred: item.default === true })) : [];
    } catch { return []; }
  }
  function create({ element: $, createElement, bridge, storage, webSpeech, changed }) {
    const canChooseService = typeof bridge?.speechServices === 'function' && typeof bridge?.startSpeechWith === 'function';
    const canChooseVoice = typeof bridge?.readAloudEngines === 'function' && typeof bridge?.speakTextWith === 'function';
    let recognizers = [];
    let voices = [];
    // Older pages stored only "engine": browser (the phone's speech) or termux.
    let recognizer = storage.get('speech-service') || (storage.get('engine') === 'termux' || (!bridge && !webSpeech) ? 'termux' : 'default');
    let voice = storage.get('read-engine') || 'default';
    let locked = false;
    function recognizerOptions() {
      const preferred = recognizers.find((item) => item.preferred);
      const options = [{ id: 'default', label: bridge ? 'Phone default' : 'Browser speech', sub: bridge ? preferred ? `Android’s selected service: ${preferred.label}` : 'Android’s selected speech service' : 'The browser’s built-in recognition' }];
      for (const item of recognizers) {
        options.push({ id: item.id, label: item.label, sub: item.id === 'on-device' ? 'Built into Android; may need a downloaded language' : `Installed speech service${item.preferred ? ' · phone default' : ''}` });
      }
      options.push({ id: 'termux', label: 'Termux:API', sub: 'Fallback through Termux; uses its own language setting' });
      return options;
    }
    function voiceOptions() {
      const preferred = voices.find((item) => item.preferred);
      return [{ id: 'default', label: 'Phone default', sub: preferred ? `Android’s selected engine: ${preferred.label}` : 'Android’s selected text-to-speech engine' },
        ...voices.map((item) => ({ id: item.id, label: item.label, sub: `Installed text-to-speech engine${item.preferred ? ' · phone default' : ''}` }))];
    }
    function rows(options, selected, choose) {
      return options.map((option) => {
        const button = createElement('button');
        button.className = `option-row${option.id === selected ? ' current' : ''}`;
        button.dataset.id = option.id;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(option.id === selected));
        const text = createElement('span');
        text.className = 'option-text';
        const title = createElement('span');
        title.className = 'option-title';
        title.textContent = option.label;
        const sub = createElement('span');
        sub.className = 'option-sub';
        sub.textContent = option.sub;
        text.append(title, sub);
        const mark = createElement('span');
        mark.className = 'option-mark';
        if (option.id === selected) mark.innerHTML = check;
        button.append(text, mark);
        button.disabled = locked;
        button.addEventListener('click', () => choose(option.id));
        return button;
      });
    }
    function render() {
      const speech = recognizerOptions();
      // A service that was uninstalled falls back to the phone's default.
      const missing = !speech.some((option) => option.id === recognizer);
      $('speech-engines').replaceChildren(...rows(speech, missing ? 'default' : recognizer, (id) => {
        if (locked) return;
        recognizer = id;
        storage.set('speech-service', id);
        storage.set('engine', id === 'termux' ? 'termux' : 'browser');
        render(); changed();
      }));
      $('speech-engines-hint').textContent = missing ? 'Your previous speech service is no longer installed, so the phone default is used.'
        : bridge && !canChooseService ? 'Update the Pi Voice app to choose other speech services, such as a Whisper-based one.'
          : bridge ? 'Speech services installed on your phone appear here. For Whisper, install a Whisper-based speech service app (for example Whisper+ or Transcribro), then choose it. Some services ignore the speech language.'
            : 'Open Pi Voice in its Android app to choose installed speech services.';
      const reading = voiceOptions();
      const absent = !reading.some((option) => option.id === voice);
      $('read-engines').hidden = !canChooseVoice;
      $('read-engines').replaceChildren(...(canChooseVoice ? rows(reading, absent ? 'default' : voice, (id) => {
        voice = id;
        storage.set('read-engine', id);
        render(); changed();
      }) : []));
      $('read-engines-hint').textContent = !bridge ? 'Read aloud needs the Pi Voice app.'
        : !canChooseVoice ? 'Update the Pi Voice app to choose another text-to-speech engine, such as Piper voices.'
          : absent ? 'Your previous text-to-speech engine is no longer installed, so the phone default is used.'
            : 'Text-to-speech engines installed on your phone appear here. For natural offline Piper voices, install an engine such as SherpaTTS, then choose it.';
    }
    // Apps can be installed while Pi Voice runs: read the lists again on demand.
    function refresh() {
      recognizers = canChooseService ? installed(() => bridge.speechServices()) : [];
      voices = canChooseVoice ? installed(() => bridge.readAloudEngines()) : [];
      render();
    }
    function current(list, id) { return id === 'default' || list.some((item) => item.id === id) ? id : 'default'; }
    refresh();
    return {
      refresh,
      // 'browser' covers both Android's recognizers and the browser's own.
      get mode() { return recognizer === 'termux' ? 'termux' : 'browser'; },
      get service() { return current(recognizers, recognizer); },
      get voice() { return canChooseVoice ? current(voices, voice) : 'default'; },
      lock(value) { if (locked !== value) { locked = value; render(); } },
      restore(values) {
        if (typeof values['speech-service'] === 'string') recognizer = values['speech-service'];
        else if (values.engine === 'termux' || values.engine === 'browser') recognizer = values.engine === 'termux' ? 'termux' : 'default';
        if (typeof values['read-engine'] === 'string') voice = values['read-engine'];
        render();
      },
    };
  }
  globalThis.PiVoiceSpeechEngines = Object.freeze({ create });
})();
