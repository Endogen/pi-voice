/* One request at a time, with explicit freshness and session-generation checks. */
(() => {
  'use strict';
  function create({ capture, isCurrent, load, apply, failed, settled }) {
    let running = false;
    let finished;
    async function poll({ fresh = false } = {}) {
      if (running) {
        // A mutation cannot be reconciled by a request started before it.
        if (fresh) { await finished; return poll({ fresh: true }); }
        return;
      }
      running = true;
      let finish;
      finished = new Promise((resolve) => { finish = resolve; });
      const target = capture();
      let retry = false;
      let result;
      try {
        const next = await load(target);
        if (!isCurrent(target)) retry = true;
        else result = apply(next, target);
      } catch (error) {
        if (!isCurrent(target)) retry = true;
        else retry = failed(error, target) === true;
      } finally {
        running = false;
        finish();
        settled(result);
        if (retry) void poll();
      }
    }
    return poll;
  }
  globalThis.PiVoicePolling = Object.freeze({ create });
})();
