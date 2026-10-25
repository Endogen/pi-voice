import { fail } from './transport.mjs';

// Explicit wire format: a Pi model also contains endpoints, headers and provider
// implementation details. None of those belong in the browser or session list.
export const modelReference = (model) => model ? { provider: model.provider, id: model.id } : null;
export const sameModel = (a, b) => a?.provider === b?.provider && a?.id === b?.id;
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
export const validModelReference = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && identifier(value.provider) && identifier(value.id);
const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : undefined;
export function publicModel(model) {
  if (!validModelReference(model)) return;
  return {
    ...modelReference(model), name: typeof model.name === 'string' ? model.name.slice(0, 512) : model.id,
    input: ['text', 'image'].filter((input) => model.input?.includes(input)),
    reasoning: model.reasoning === true,
    contextWindow: positive(model.contextWindow), maxTokens: positive(model.maxTokens),
  };
}

/** Session-scoped adapter. Pi owns authentication, persistence and capabilities. */
export function createModelSelection({ pi, getContext, blocked = () => false }) {
  let switching = false;
  const supported = () => typeof pi.setModel === 'function' && typeof getContext()?.modelRegistry?.getAvailable === 'function';
  const available = () => {
    try { return getContext().modelRegistry.getAvailable(); }
    catch { throw fail(502, 'Could not read Pi’s model registry. Check its configuration in Termux.'); }
  };
  function checkSession(sessionId) {
    if (sessionId !== getContext()?.sessionManager.getSessionId()) throw fail(409, 'The Pi session changed. Refresh models before trying again.');
  }
  function checkIdle() {
    const ctx = getContext();
    if (switching || blocked() || !ctx.isIdle() || ctx.hasPendingMessages()) {
      throw fail(409, 'Finish or stop the current task before changing models.');
    }
  }
  return {
    supported,
    get switching() { return switching; },
    list() {
      if (!supported()) throw fail(501, 'Model switching is unavailable. Restart Pi after updating.');
      const ctx = getContext();
      const seen = new Set();
      const models = available().map(publicModel).filter((model) => {
        if (!model) return false;
        const key = JSON.stringify([model.provider, model.id]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const usage = ctx.getContextUsage?.();
      return { sessionId: ctx.sessionManager.getSessionId(), current: modelReference(ctx.model), models,
        contextTokens: Number.isSafeInteger(usage?.tokens) && usage.tokens >= 0 ? usage.tokens : null };
    },
    async select({ sessionId, provider, id, expectedModel }) {
      if (!supported()) throw fail(501, 'Model switching is unavailable. Restart Pi after updating.');
      if (!validModelReference({ provider, id }) || !(expectedModel === null || validModelReference(expectedModel))) {
        throw fail(400, 'A model provider, ID and previous model selection are required.');
      }
      checkSession(sessionId);
      checkIdle();
      if (!sameModel(expectedModel, getContext().model)) throw fail(409, 'Pi’s model changed. Refresh models and review the selection.');
      if (sameModel({ provider, id }, getContext().model)) return { ok: true, model: modelReference(getContext().model) };
      const model = available().find((candidate) => candidate.provider === provider && candidate.id === id);
      if (!model) throw fail(422, 'That model is no longer available. Configure its provider in Pi, then refresh models.');
      // Lock before awaiting Pi: HTTP prompts/listening/session controls must not
      // race provider authentication. Never call the runtime with persist:true.
      switching = true;
      try {
        let selected;
        try { selected = await pi.setModel(model); }
        catch { throw fail(502, 'Pi could not confirm the model change. Check its provider configuration in Termux, then refresh.'); }
        checkSession(sessionId);
        if (selected === false) throw fail(422, 'Pi could not select this model. Check its provider authentication in Termux.');
        if (!sameModel(model, getContext().model)) throw fail(409, 'Pi selected a different model. Refresh models before continuing.');
        return { ok: true, model: modelReference(getContext().model) };
      } finally { switching = false; }
    },
  };
}
