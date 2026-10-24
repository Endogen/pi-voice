// Optional Android WebView adapter. Chrome never gets a native bridge and keeps
// its existing Web Speech / Termux:API path. Only speech methods are exposed.
(function () {
  const bridge = window.PiVoiceAndroid;
  if (!bridge || typeof bridge.startSpeech !== 'function' || typeof bridge.stopSpeech !== 'function' || typeof bridge.abortSpeech !== 'function') return;
  let active;
  class NativeRecognition {
    start() {
      if (active) throw new Error('Another recording is active.');
      this.id = crypto.randomUUID();
      active = this;
      try { bridge.startSpeech(this.id, this.lang || 'en-US'); }
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
