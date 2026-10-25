/* Thinking level and compaction for the selected session. Pi owns both; the
 * app sends one explicit request and then reads Pi's state back. */
(() => {
  'use strict';
  const levelNames = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  // Short enough for up to seven levels in one row; the full name is the label.
  const shortNames = { off: 'Off', minimal: 'Min', low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max' };
  const tokens = (count) => count >= 1e6 ? `${+(count / 1e6).toFixed(1)}M` : count >= 1000 ? `${Math.round(count / 1000)}K` : String(count);
  function create({ element: $, createElement, request, target, state, context, thinkingBlocked, compactBlocked, changed, refresh, reloadContext, notify, confirm }) {
    let identity;
    let setting;
    let compactRequest;
    let watched;
    let thinkingMessage = '';
    let thinkingError = false;
    let compactMessage = '';
    let compactError = false;
    const compacting = () => state()?.compaction?.status === 'running';
    function renderThinking() {
      const current = state();
      const levels = Array.isArray(current?.thinkingLevels) ? current.thinkingLevels.filter((level) => levelNames[level]) : [];
      const reason = thinkingBlocked();
      $('thinking-section').hidden = !current || current.empty;
      $('thinking-levels').hidden = !current?.thinkingSupported || levels.length < 2;
      $('thinking-levels').replaceChildren(...levels.map((level) => {
        const button = createElement('button');
        button.className = 'segment';
        button.dataset.level = level;
        button.textContent = shortNames[level];
        button.setAttribute('aria-label', levelNames[level]);
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(level === current.thinkingLevel));
        button.disabled = Boolean(reason || setting);
        button.addEventListener('click', () => { void choose(level); });
        return button;
      }));
      $('thinking-status').textContent = thinkingError ? thinkingMessage
        : !current?.thinkingSupported ? 'Restart this Pi after updating to choose a thinking level.'
          : levels.length < 2 ? 'This model has no thinking levels.'
            : setting ? 'Changing the thinking level…' : thinkingMessage || reason || 'More thinking is slower and uses more tokens. Applies to Pi’s next request in this session only.';
      $('thinking-status').classList.toggle('error', thinkingError);
    }
    function renderContext() {
      const current = state();
      const usage = context();
      $('context-section').hidden = !current || current.empty;
      const percent = usage?.contextWindow && usage.tokens !== null && usage.tokens !== undefined ? Math.min(100, Math.round(usage.tokens / usage.contextWindow * 100)) : null;
      // CSSOM, not a style attribute: the page's CSP blocks inline styles.
      $('context-meter').style?.setProperty('--fill', `${percent ?? 0}%`);
      $('context-meter').classList.toggle('high', percent !== null && percent >= 80);
      $('context-usage').textContent = !usage ? 'Context use appears once Pi’s models are loaded.'
        : percent === null ? `Unknown until Pi’s next reply${usage.contextWindow ? ` · ${tokens(usage.contextWindow)} context` : ''}`
          : `${tokens(usage.tokens)} of ${tokens(usage.contextWindow)} tokens used · ${percent}%`;
      const reason = compactBlocked();
      $('compact').disabled = !current?.compactSupported || Boolean(reason || compactRequest || compacting());
      $('compact-label').textContent = compacting() ? 'Compacting…' : 'Compact conversation';
      $('compact-status').textContent = compactError ? compactMessage
        : !current?.compactSupported ? 'Restart this Pi after updating to compact from the app.'
          : compacting() ? 'Pi is summarizing earlier messages. Sending is paused until it finishes; Stop cancels it.'
            : compactMessage || reason || 'Pi summarizes earlier messages so the conversation fits the model again. It also does this by itself when the context is nearly full.';
      $('compact-status').classList.toggle('error', compactError);
    }
    function sync() {
      const capture = target();
      if (capture.key !== identity) {
        identity = capture.key; setting = undefined; compactRequest = undefined; watched = undefined;
        thinkingMessage = ''; thinkingError = false; compactMessage = ''; compactError = false;
      }
      // Report how a compaction ended only if this page saw it running.
      const outcome = state()?.compaction;
      if (outcome?.status === 'running') watched = true;
      else if (watched && outcome) {
        watched = undefined;
        compactError = outcome.status === 'error';
        compactMessage = outcome.status === 'done' ? `Conversation compacted${outcome.tokensBefore ? ` from about ${tokens(outcome.tokensBefore)} tokens` : ''}.`
          : outcome.status === 'cancelled' ? 'Compaction stopped. The conversation is unchanged.' : `Could not compact: ${outcome.error || 'Pi reported an error.'}`;
        notify(compactMessage, compactError);
        reloadContext();
      }
      renderThinking();
      renderContext();
    }
    async function choose(level) {
      const current = state();
      if (setting || thinkingBlocked() || level === current?.thinkingLevel) return;
      const capture = target();
      setting = level; thinkingMessage = ''; thinkingError = false; renderThinking();
      try {
        const result = await request('thinking', { method: 'POST', handle: capture.handle, body: { sessionId: capture.sessionId, level } });
        if (target().key !== capture.key) return;
        await refresh();
        // Pi may clamp a level to what the model supports; show what it chose.
        const chosen = result?.thinkingLevel || state()?.thinkingLevel;
        thinkingMessage = chosen === level ? `Thinking level set to ${levelNames[level]} for this session.` : `Pi chose ${levelNames[chosen] || chosen} for this model.`;
      } catch (failure) {
        if (target().key !== capture.key) return;
        thinkingError = true;
        thinkingMessage = [404, 501].includes(failure.status) ? 'Update Pi Voice and restart its host and this Pi to choose a thinking level.' : failure.message;
      } finally {
        if (target().key === capture.key) { setting = undefined; changed(); }
      }
    }
    async function compact() {
      if (compactRequest || compactBlocked() || compacting() || !state()?.compactSupported) return;
      const capture = target();
      const proceed = await confirm({
        title: 'Compact this conversation?',
        message: ['Pi replaces earlier messages with a summary, so the model keeps the gist using less context. The full history stays saved in the session.', 'This makes one model request and can take a minute.'],
        confirm: 'Compact',
      });
      if (!proceed || target().key !== capture.key || compactBlocked() || compacting()) return;
      compactRequest = capture; compactMessage = ''; compactError = false; changed();
      try {
        await request('compact', { method: 'POST', handle: capture.handle, body: { sessionId: capture.sessionId } });
        if (target().key !== capture.key) return;
        watched = true;
        await refresh();
      } catch (failure) {
        if (target().key !== capture.key) return;
        compactError = true;
        compactMessage = [404, 501].includes(failure.status) ? 'Update Pi Voice and restart its host and this Pi to compact from the app.' : failure.message;
      } finally {
        if (target().key === capture.key) { compactRequest = undefined; changed(); }
      }
    }
    $('compact').addEventListener('click', () => { void compact(); });
    return {
      sync, compacting, get busy() { return Boolean(compactRequest || compacting()); },
      // The composer chip is narrow: a short level name there, full names for screen readers.
      label() {
        const current = state();
        const levels = current?.thinkingLevels || [];
        const level = current?.thinkingSupported && levels.length > 1 ? current.thinkingLevel : undefined;
        return { name: current?.modelName || current?.modelSelection?.id || 'Model', level: shortNames[level] || '', levelName: levelNames[level] || '' };
      },
    };
  }
  globalThis.PiVoiceSessionOptions = Object.freeze({ create });
})();
