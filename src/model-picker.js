/* A registry-backed picker, not a provider client or local runtime manager. */
(() => {
  'use strict';
  const keyOf = (model) => model ? JSON.stringify([model.provider, model.id]) : '';
  const labelOf = (model) => `${model.provider}/${model.id}`;
  const valid = (model) => model && typeof model.provider === 'string' && typeof model.id === 'string';
  function create({ element: $, createElement, request, target, state, blockedReason, changed, refresh, notify, confirm, hasImages }) {
    let identity;
    let currentKey;
    let data;
    let chosen;
    let loading;
    let operation;
    let uncertain;
    let accepted;
    let loadFailed = false;
    let message = '';
    let error = false;
    const isCurrent = (capture) => identity === capture.key && target().key === capture.key;
    const selected = () => data?.models.find((model) => keyOf(model) === $('model-choice').value);
    const setMessage = (text, failed = false) => { message = text; error = failed; };
    function renderChoices() {
      const query = $('model-filter').value.trim().toLowerCase();
      const options = [];
      const groups = new Map();
      const matching = (data?.models || []).filter((model) => `${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(query));
      const current = state()?.modelSelection;
      // Keep the active/selected entry visible when filtering. An unavailable
      // current model is informational, never offered as an authenticated model.
      const kept = data?.models.find((model) => keyOf(model) === keyOf(chosen));
      if (kept && !matching.includes(kept)) matching.unshift(kept);
      if (current && !data?.models.some((model) => keyOf(model) === keyOf(current))) {
        const option = createElement('option');
        option.value = keyOf(current); option.textContent = `${labelOf(current)} (current, unavailable)`; option.disabled = true;
        options.push(option);
      }
      for (const model of matching) {
        let group = groups.get(model.provider);
        if (!group) { group = createElement('optgroup'); group.label = model.provider; groups.set(model.provider, group); options.push(group); }
        const option = createElement('option');
        option.value = keyOf(model); option.textContent = `${model.name || model.id}${keyOf(model) === keyOf(current) ? ' · Current' : ''}`;
        group.append(option);
      }
      if (!options.length) {
        const empty = createElement('option'); empty.value = ''; empty.textContent = query ? 'No matching models' : 'No available models'; empty.disabled = true; options.push(empty);
      }
      $('model-choice').replaceChildren(...options);
      $('model-choice').value = keyOf(chosen);
    }
    function render() {
      const ready = state()?.modelSwitchingSupported === true;
      const reason = blockedReason();
      const changing = Boolean(operation || accepted);
      $('model-controls').hidden = !ready;
      $('model-support').hidden = ready;
      $('model-support').textContent = !state() || state().empty ? 'Connect a Pi session to choose its model.' : 'Restart this Pi after updating to enable model switching.';
      $('model-refresh').disabled = !ready || Boolean(loading || changing) || !target().handle;
      $('model-filter').disabled = Boolean(loading || changing) || !data;
      $('model-choice').disabled = Boolean(loading || changing) || !data?.models.length;
      const model = selected();
      $('model-apply').disabled = Boolean(reason || loading || changing) || !model || keyOf(model) === keyOf(state()?.modelSelection);
      $('model-apply').textContent = changing ? 'Changing…' : 'Use model';
      const details = model ? [labelOf(model), model.contextWindow ? `${model.contextWindow.toLocaleString()} token context` : 'Context unknown', model.input?.includes('image') ? 'Images' : 'Text only', model.reasoning ? 'Reasoning' : ''].filter(Boolean).join(' · ') : '';
      $('model-details').textContent = details;
      $('model-status').textContent = loading ? 'Loading Pi’s configured models…' : operation ? 'Changing this session’s model…' : accepted ? 'Change accepted. Waiting for Pi’s state to confirm the active model.' : error ? message : reason || message || (data?.models.length ? 'Configured models only. Availability does not check whether a provider or local server is online.' : 'No available models. Configure a provider and authentication in Pi, then refresh.');
      $('model-status').classList.toggle('error', error);
    }
    function sync() {
      const capture = target();
      if (capture.key !== identity) {
        identity = capture.key; currentKey = undefined; data = undefined; chosen = undefined;
        loading = undefined; operation = undefined; uncertain = undefined; accepted = undefined; loadFailed = false; setMessage('');
        $('model-filter').value = ''; renderChoices();
      }
      const next = keyOf(state()?.modelSelection);
      if (next !== currentKey && currentKey !== undefined && !uncertain && !accepted && !operation) setMessage('');
      // Authentication can outlive the browser's request timeout. Ordinary
      // state polls must finish reconciliation without replaying the mutation.
      if (uncertain && next === keyOf(uncertain)) {
        setMessage(`Pi confirms this session is using ${labelOf(uncertain)}; the request acknowledgement was lost.`);
        uncertain = undefined;
      } else if (uncertain && !operation && state()?.modelSwitchingSupported && !state().modelSwitching) {
        setMessage('Model change not confirmed. Pi is no longer changing models; check the displayed active model before retrying.', true);
        uncertain = undefined;
      }
      if (accepted && (next === keyOf(accepted) || next !== currentKey)) {
        setMessage(next === keyOf(accepted) ? `Using ${labelOf(accepted)} for this session.` : 'Pi’s model changed again. Check the displayed active model before continuing.', next !== keyOf(accepted));
        accepted = undefined;
      }
      if (next !== currentKey) {
        currentKey = next; chosen = state()?.modelSelection;
        renderChoices();
      }
      render();
      if ($('settings-dialog').open && state()?.modelSwitchingSupported && !data && !loading && !loadFailed && capture.handle && !blockedReason()) void load();
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
        chosen = state()?.modelSelection;
        renderChoices();
      } catch (failure) {
        if (!isCurrent(capture) || loading !== capture) return;
        loadFailed = true;
        setMessage([404, 501].includes(failure.status) ? 'Update Pi Voice and restart its host and this Pi to enable model switching.' : failure.message, true);
      } finally {
        if (isCurrent(capture) && loading === capture) { loading = undefined; render(); }
      }
    }
    function syncIdentityOnly() {
      // Invalidate stale requests immediately, even before the next state poll.
      if (target().key !== identity) sync();
    }
    async function apply() {
      syncIdentityOnly();
      const model = selected();
      if (blockedReason() || operation || accepted || loading || !model || keyOf(model) === keyOf(state()?.modelSelection)) return;
      const capture = target();
      const current = state()?.modelSelection;
      const warnings = [`Use ${labelOf(model)} for this session? Your conversation is kept; other sessions and Pi’s default model are unchanged.`];
      if (current?.provider !== model.provider) warnings.push(`On your next message, Pi may send the existing conversation, including earlier images and tool results, to ${model.provider}.`);
      const previous = data.models.find((item) => keyOf(item) === keyOf(current));
      if (model.contextWindow && (model.contextWindow < previous?.contextWindow || data.contextTokens >= model.contextWindow)) warnings.push(`This model has a ${model.contextWindow.toLocaleString()} token context${data.contextTokens !== null ? `; the last estimate was ${data.contextTokens.toLocaleString()} tokens` : ''}. Pi may need to compact the conversation. Consider a new session for a much smaller model.`);
      if (hasImages() && !model.input?.includes('image')) warnings.push('Your unsent images will be kept, but this model cannot receive them. Remove them or choose an image-capable model before sending.');
      if (!confirm(warnings.join('\n\n')) || !isCurrent(capture) || blockedReason()) return;
      operation = capture; uncertain = undefined; accepted = undefined; setMessage(''); changed(); render();
      try {
        await request('model', { method: 'POST', handle: capture.handle, body: { sessionId: capture.sessionId, provider: model.provider, id: model.id, expectedModel: current } });
        if (!isCurrent(capture) || operation !== capture) return;
        await refresh();
        if (!isCurrent(capture) || operation !== capture) return;
        const confirmed = keyOf(state()?.modelSelection) === keyOf(model);
        accepted = confirmed ? undefined : model;
        setMessage(confirmed ? `Using ${labelOf(model)} for this session.` : 'Change accepted. Waiting for Pi’s state to confirm the active model.');
        notify(message);
      } catch (failure) {
        if (!isCurrent(capture) || operation !== capture) return;
        // A timeout is not a rejection. Always read authority back; never retry
        // a POST automatically or claim the previous model is still active.
        await refresh();
        if (!isCurrent(capture) || operation !== capture) return;
        const confirmed = keyOf(state()?.modelSelection) === keyOf(model);
        const pending = !confirmed && state()?.modelSwitching === true;
        uncertain = pending ? model : undefined;
        setMessage(confirmed ? `Pi confirms this session is using ${labelOf(model)}; the request acknowledgement was lost.` : pending ? 'Pi is still changing models. Waiting for its state to confirm; do not resend the request.' : `Model change not confirmed: ${failure.message} Refresh models and check the active model before retrying.`, !confirmed && !pending);
        notify(message, !confirmed && !pending);
      } finally {
        if (isCurrent(capture) && operation === capture) { operation = undefined; chosen = state()?.modelSelection; renderChoices(); changed(); render(); }
      }
    }
    $('model-refresh').addEventListener('click', () => { void load(); });
    $('model-filter').addEventListener('input', () => { chosen = selected() || chosen; renderChoices(); render(); });
    $('model-choice').addEventListener('change', () => { chosen = selected(); setMessage(''); render(); });
    $('model-apply').addEventListener('click', () => { void apply(); });
    return { sync, open: load, get busy() { return Boolean(operation || accepted); } };
  }
  globalThis.PiVoiceModelPicker = Object.freeze({ create });
})();
