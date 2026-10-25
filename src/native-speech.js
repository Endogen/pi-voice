// Android WebView adapter: routes speech recognition to the native app.
// Without the native bridge, the Web Speech / Termux:API path is used.
(function () {
  const bridge = window.PiVoiceAndroid;
  if (!bridge || typeof bridge.startSpeech !== 'function' || typeof bridge.stopSpeech !== 'function' || typeof bridge.abortSpeech !== 'function') return;
  let active;
  class NativeRecognition {
    start() {
      if (active) throw new Error('Another recording is active.');
      this.id = crypto.randomUUID();
      active = this;
      // Newer apps can use a speech service chosen in Settings.
      try {
        if (this.service && this.service !== 'default' && typeof bridge.startSpeechWith === 'function') bridge.startSpeechWith(this.id, this.lang || 'en-US', this.service);
        else bridge.startSpeech(this.id, this.lang || 'en-US');
      }
      catch (error) { active = undefined; throw error; }
    }
    stop() { if (active === this) bridge.stopSpeech(this.id); }
    abort() { if (active === this) bridge.abortSpeech(this.id); }
  }
  window.__piVoiceNativeSpeech = (id, kind, text) => {
    const current = active;
    if (!current || id !== current.id) return;
    if (kind === 'partial' || kind === 'result') {
      const result = Object.assign([{ transcript: String(text) }], { isFinal: kind === 'result' });
      current.onresult?.({ results: [result] });
    } else if (kind === 'error') current.onerror?.({ error: String(text) });
    else if (kind === 'end') { active = undefined; current.onend?.(); }
  };
  globalThis.PiVoiceNativeRecognition = NativeRecognition;
})();
