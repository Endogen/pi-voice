/* A registry-backed picker, not a provider client or local runtime manager. */
(() => {
  'use strict';
  const keyOf = (model) => model ? JSON.stringify([model.provider, model.id]) : '';
  const labelOf = (model) => `${model.provider}/${model.id}`;
  const valid = (model) => model && typeof model.provider === 'string' && typeof model.id === 'string';
  const tokens = (count) => count >= 1e6 ? `${+(count / 1e6).toFixed(1)}M` : count >= 1000 ? `${Math.round(count / 1000)}K` : String(count);
  const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  function create({ element: $, createElement, request, target, state, blockedReason, changed, refresh, notify, confirm, hasImages }) {
    let identity;
    let currentKey;
    let data;
    let loading;
    let operation;
    let uncertain;
    let accepted;
    let acceptedState;
    let loadFailed = false;
    let message = '';
    let error = false;
    const isCurrent = (capture) => identity === capture.key && target().key === capture.key;
    const setMessage = (text, failed = false) => { message = text; error = failed; };
    const changing = () => operation || accepted || uncertain;
    function row(model, { current, unavailable = false, grouped = false }) {
      const button = createElement('button');
      button.className = `option-row${current ? ' current' : ''}`;
      button.dataset.key = keyOf(model);
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(current));
      const text = createElement('span');
      text.className = 'option-text';
      const title = createElement('span');
      title.className = 'option-title';
      title.textContent = unavailable ? labelOf(model) : model.name || model.id;
      const sub = createElement('span');
      sub.className = 'option-sub';
      sub.textContent = unavailable ? 'Current, no longer configured in Pi'
        : [grouped ? '' : model.provider, model.contextWindow ? `${tokens(model.contextWindow)} context` : '', model.input?.includes('image') ? 'Images' : 'Text only', model.reasoning ? 'Thinking' : ''].filter(Boolean).join(' · ');
      text.append(title, sub);
      const mark = createElement('span');
      mark.className = 'option-mark';
      const pending = changing();
      if (pending && keyOf(pending) === keyOf(model)) { mark.textContent = 'Changing…'; mark.className = 'option-mark busy'; }
      else if (current) mark.innerHTML = check;
      button.append(text, mark);
      button.disabled = unavailable;
      if (!unavailable) button.addEventListener('click', () => { void apply(model); });
      return button;
    }
    function heading(text) {
      const label = createElement('span');
      label.className = 'option-group';
      label.textContent = text;
      return label;
    }
    function renderList() {
      const query = $('model-filter').value.trim().toLowerCase();
      const models = data?.models || [];
      const current = state()?.modelSelection;
      const matching = models.filter((model) => `${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(query));
      const items = [];
      // An unavailable current model is informational, never offered as authenticated.
      if (current && data && !models.some((model) => keyOf(model) === keyOf(current))) items.push(row(current, { current: true, unavailable: true }));
      const scoped = matching.filter((model) => model.scoped);
      if (scoped.length) items.push(heading('Scoped in Pi'), ...scoped.map((model) => row(model, { current: keyOf(model) === keyOf(current) })));
      let provider;
      for (const model of matching.filter((item) => !item.scoped)) {
        if (model.provider !== provider) { provider = model.provider; items.push(heading(provider)); }
        items.push(row(model, { current: keyOf(model) === keyOf(current), grouped: true }));
      }
      if (data && !matching.length) {
        const empty = createElement('p');
        empty.className = 'option-empty';
        empty.textContent = query ? 'No matching models.' : 'No available models.';
        items.push(empty);
      }
      $('model-list').replaceChildren(...items);
      $('model-filter').hidden = models.length < 8;
    }
    function render() {
      const ready = state()?.modelSwitchingSupported === true;
      const reason = blockedReason();
      $('model-controls').hidden = !ready;
      $('model-support').hidden = ready;
      $('model-support').textContent = !state() || state().empty ? 'Connect a Pi session to choose its model.' : 'Restart this Pi after updating to enable model switching.';
      $('model-refresh').disabled = !ready || Boolean(loading || changing()) || !target().handle;
      $('model-filter').disabled = Boolean(loading) || !data;
      $('model-list').classList.toggle('locked', Boolean(reason || loading || changing()));
      $('model-list').setAttribute('aria-busy', String(Boolean(loading || changing())));
      $('model-status').textContent = loading ? 'Loading Pi’s configured models…' : operation ? 'Changing this session’s model…' : accepted ? 'Change accepted. Waiting for Pi’s state to confirm the active model.' : error ? message : reason || message || (data?.models.length ? '' : data ? 'No available models. Configure a provider and authentication in Pi, then refresh.' : '');
      $('model-status').classList.toggle('error', error);
    }
    function sync() {
      const capture = target();
      if (capture.key !== identity) {
        identity = capture.key; currentKey = undefined; data = undefined;
        loading = undefined; operation = undefined; uncertain = undefined; accepted = undefined; acceptedState = undefined; loadFailed = false; setMessage('');
        $('model-filter').value = ''; renderList();
      }
      const next = keyOf(state()?.modelSelection);
      if (next !== currentKey && currentKey !== undefined && !uncertain && !accepted && !operation) setMessage('');
      // Authentication can outlive the browser's request timeout. Ordinary
      // state polls must finish reconciliation without replaying the mutation.
      if (uncertain && next === keyOf(uncertain)) {
        setMessage(`Pi confirms this session is using ${labelOf(uncertain)}; the request acknowledgement was lost.`);
        uncertain = undefined;
      } else if (uncertain && !operation && state()?.modelSwitchingSupported && !state().modelSwitching) {
        setMessage('Model change not confirmed. Pi is no longer changing models; check the active model before retrying.', true);
        uncertain = undefined;
      }
      // Termux may switch back to the original model before we observe the
      // accepted choice. A later idle snapshot must still release the controls.
      if (accepted && (next === keyOf(accepted) || next !== currentKey
        || (!operation && state() !== acceptedState && state()?.modelSwitchingSupported && !state().modelSwitching))) {
        setMessage(next === keyOf(accepted) ? `Using ${labelOf(accepted)} for this session.` : 'Pi’s model changed again. Check the active model before continuing.', next !== keyOf(accepted));
        accepted = undefined;
        acceptedState = undefined;
      }
      if (next !== currentKey) { currentKey = next; renderList(); }
      render();
      if ($('model-dialog').open && state()?.modelSwitchingSupported && !data && !loading && !loadFailed && capture.handle && !blockedReason()) void load();
    }
    async function load() {
      syncIdentityOnly();
      if (loading || operation || accepted || state()?.modelSwitchingSupported !== true || !target().handle) return;
      const capture = target();
      loading = capture; loadFailed = false; setMessage(''); render();
      try {
        const result = await request('models', { handle: capture.handle });
        if (!isCurrent(capture) || loading !== capture) return;
        if (result.sessionId !== capture.sessionId || keyOf(result.current) !== keyOf(state()?.modelSelection)) throw new Error('Pi’s session or model changed while loading. Refresh models and review the selection.');
        if (!Array.isArray(result.models)) throw new Error('Pi returned an invalid model list. Update Pi Voice and restart this Pi.');
        data = { ...result, models: result.models.filter(valid) };
        renderList();
      } catch (failure) {
        if (!isCurrent(capture) || loading !== capture) return;
        loadFailed = true;
        setMessage([404, 501].includes(failure.status) ? 'Update Pi Voice and restart its host and this Pi to enable model switching.' : failure.message, true);
      } finally {
        if (isCurrent(capture) && loading === capture) { loading = undefined; render(); changed(); }
      }
    }
    function syncIdentityOnly() {
      // Invalidate stale requests immediately, even before the next state poll.
      if (target().key !== identity) sync();
    }
    async function apply(model) {
      syncIdentityOnly();
      if (blockedReason() || changing() || loading || !data || keyOf(model) === keyOf(state()?.modelSelection)) return;
      const capture = target();
      const current = state()?.modelSelection;
      // Switching is session-only and reversible. Ask only when it has a cost.
      const warnings = [];
      if (current?.provider !== model.provider) warnings.push(`On your next message, Pi may send the existing conversation, including earlier images and tool results, to ${model.provider}.`);
      const previous = data.models.find((item) => keyOf(item) === keyOf(current));
      if (model.contextWindow && (model.contextWindow < previous?.contextWindow || data.contextTokens >= model.contextWindow)) warnings.push(`This model has a ${model.contextWindow.toLocaleString()} token context${data.contextTokens !== null ? `; the last estimate was ${data.contextTokens.toLocaleString()} tokens` : ''}. Pi may need to compact the conversation. Consider a new session for a much smaller model.`);
      if (hasImages() && !model.input?.includes('image')) warnings.push('Your unsent images will be kept, but this model cannot receive them. Remove them or choose an image-capable model before sending.');
      if (warnings.length) {
        const proceed = await confirm({ title: `Use ${model.name || model.id}?`, message: [`${labelOf(model)} replaces ${current ? labelOf(current) : 'the current model'} for this session only. The conversation is kept.`, ...warnings], confirm: 'Use model' });
        if (!proceed || !isCurrent(capture) || blockedReason() || changing() || loading) return;
      }
      operation = model; uncertain = undefined; accepted = undefined; acceptedState = undefined; setMessage(''); changed(); renderList(); render();
      try {
        await request('model', { method: 'POST', handle: capture.handle, body: { sessionId: capture.sessionId, provider: model.provider, id: model.id, expectedModel: current } });
        if (!isCurrent(capture) || operation !== model) return;
        await refresh();
        if (!isCurrent(capture) || operation !== model) return;
        const confirmed = keyOf(state()?.modelSelection) === keyOf(model);
        accepted = confirmed ? undefined : model;
        acceptedState = confirmed ? undefined : state();
        setMessage(confirmed ? `Using ${labelOf(model)} for this session.` : 'Change accepted. Waiting for Pi’s state to confirm the active model.');
        notify(message);
      } catch (failure) {
        if (!isCurrent(capture) || operation !== model) return;
        // A timeout is not a rejection. Always read authority back; never retry
        // a POST automatically or claim the previous model is still active.
        await refresh();
        if (!isCurrent(capture) || operation !== model) return;
        const confirmed = keyOf(state()?.modelSelection) === keyOf(model);
        const pending = !confirmed && state()?.modelSwitching === true;
        uncertain = pending ? model : undefined;
        setMessage(confirmed ? `Pi confirms this session is using ${labelOf(model)}; the request acknowledgement was lost.` : pending ? 'Pi is still changing models. Waiting for its state to confirm; do not resend the request.' : `Model change not confirmed: ${failure.message} Refresh models and check the active model before retrying.`, !confirmed && !pending);
        notify(message, !confirmed && !pending);
      } finally {
        if (isCurrent(capture) && operation === model) { operation = undefined; renderList(); changed(); render(); }
      }
    }
    $('model-refresh').addEventListener('click', () => { data = undefined; void load(); });
    $('model-filter').addEventListener('input', renderList);
    return {
      sync, open: load, reload: () => { if (!loading && !changing()) { data = undefined; void load(); } },
      get busy() { return Boolean(operation || accepted); },
      get loading() { return Boolean(loading); },
      // For the context section: the last list response and the active model's limits.
      get context() {
        if (!data) return;
        const active = data.models.find((model) => keyOf(model) === keyOf(state()?.modelSelection));
        const window = active?.contextWindow || data.contextUsage?.contextWindow;
        return { tokens: data.contextUsage ? data.contextUsage.tokens : data.contextTokens, contextWindow: window || null };
      },
    };
  }
  globalThis.PiVoiceModelPicker = Object.freeze({ create });
})();
