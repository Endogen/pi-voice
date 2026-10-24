// User-initiated reply playback only. No model request, audio upload or autoplay.
globalThis.PiVoicePlayback = (() => {
  const maxText = 32000;
  function chunks(text, limit = 320) {
    if (!Number.isInteger(limit) || limit < 2) throw new Error('Invalid speech chunk size.');
    const parts = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + limit, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
      if (end < text.length) {
        const pause = Math.max(text.lastIndexOf('\n', end - 1), text.lastIndexOf(' ', end - 1));
        if (pause > start + limit / 2) end = pause + 1;
      }
      parts.push(text.slice(start, end));
      start = end;
    }
    return parts;
  }
  function create({ onState = () => {}, onError = () => {} } = {}) {
    const bridge = window.PiVoiceAndroid;
    const native = Boolean(bridge && typeof bridge.speakText === 'function' && typeof bridge.stopReading === 'function');
    // Older native shells must upgrade, rather than silently trying WebView's
    // often unavailable browser synthesis implementation.
    const synthesis = !bridge && window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    const supported = native || Boolean(synthesis && typeof synthesis.speak === 'function' && typeof synthesis.cancel === 'function' && typeof Utterance === 'function');
    let active, timer;
    function clearTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
    function stop() {
      const previous = active;
      active = undefined;
      clearTimer();
      if (!previous) return;
      try { if (native) bridge.stopReading(previous.id); else synthesis.cancel(); } catch {}
      onState();
    }
    function fail(code) { stop(); onError(String(code || 'unavailable')); }
    function arm(run, milliseconds) {
      clearTimer();
      timer = setTimeout(() => { if (active === run) fail('unavailable'); }, milliseconds);
    }
    function finish(run) {
      if (active !== run) return;
      active = undefined;
      clearTimer();
      onState();
    }
    if (native) window.__piVoiceNativePlayback = (id, kind, detail) => {
      const run = active;
      if (!run || id !== run.id) return;
      if (kind === 'start' || kind === 'progress') arm(run, 180000);
      else if (kind === 'end') finish(run);
      else if (kind === 'error') fail(detail);
    };
    function speak(text, language) {
      stop();
      if (!supported) { onError(bridge ? 'upgrade' : 'unsupported'); return; }
      text = String(text).trim();
      if (!text || text.length > maxText) { onError('text-limit'); return; }
      try { language = Intl.getCanonicalLocales(language || navigator.language || 'en-US')[0]; }
      catch { onError('language'); return; }
      const run = { id: crypto.randomUUID() };
      active = run;
      onState();
      try {
        if (native) {
          arm(run, 20000);
          bridge.speakText(run.id, text, language);
        } else {
          const parts = chunks(text);
          let index = 0;
          const next = () => {
            if (active !== run) return;
            const utterance = new Utterance(parts[index++]);
            run.utterance = utterance;
            utterance.lang = language;
            utterance.onend = () => {
              if (active !== run || run.utterance !== utterance) return;
              run.utterance = undefined; // Ignore duplicate/late end callbacks.
              if (index < parts.length) next(); else finish(run);
            };
            utterance.onerror = (event) => {
              if (active === run && run.utterance === utterance) fail(event.error);
            };
            arm(run, 120000);
            synthesis.speak(utterance);
          };
          // The first speak stays in the click handler for browser user-gesture
          // requirements. Later chunks follow only that explicit request.
          synthesis.resume?.(); // A previously interrupted engine may remain paused.
          next();
        }
      } catch { if (active === run) fail('unavailable'); }
    }
    return Object.freeze({ supported, needsUpgrade: Boolean(bridge && !native), get active() { return Boolean(active); }, speak, stop });
  }
  return Object.freeze({ create, chunks, maxText });
})();
