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

// Mirrors Pi's getSupportedThinkingLevels. Pi clamps every request again and
// the level is always read back, so a mismatch is shown, never assumed.
export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function supportedThinkingLevels(model) {
  if (!model) return [];
  if (!model.reasoning) return ['off'];
  return thinkingLevels.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && (!['xhigh', 'max'].includes(level) || mapped !== undefined);
  });
}
function contextUsage(ctx) {
  let usage;
  try { usage = ctx.getContextUsage?.(); } catch { return null; }
  if (!usage) return null;
  return { tokens: Number.isSafeInteger(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null, contextWindow: positive(usage.contextWindow) ?? null };
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
      // Pi's scoped models (enabledModels, its Ctrl+P cycle) are listed first.
      const scoped = new Set((ctx.scopedModels || []).map((item) => JSON.stringify([item?.model?.provider, item?.model?.id])));
      for (const model of models) if (scoped.has(JSON.stringify([model.provider, model.id]))) model.scoped = true;
      const usage = contextUsage(ctx);
      return { sessionId: ctx.sessionManager.getSessionId(), current: modelReference(ctx.model), models,
        contextTokens: usage?.tokens ?? null, contextUsage: usage };
    },
    thinking() {
      if (typeof pi.getThinkingLevel !== 'function' || typeof pi.setThinkingLevel !== 'function') return { supported: false, level: null, levels: [] };
      let level;
      try { level = pi.getThinkingLevel(); } catch {}
      return { supported: true, level: thinkingLevels.includes(level) ? level : null, levels: supportedThinkingLevels(getContext()?.model) };
    },
    setThinking({ sessionId, level }) {
      if (!this.thinking().supported) throw fail(501, 'Thinking levels are unavailable. Restart Pi after updating.');
      if (!thinkingLevels.includes(level)) throw fail(400, 'Choose a valid thinking level.');
      checkSession(sessionId);
      // A level applies to Pi's next request, so a running task is fine; a model
      // change would re-clamp it underneath this request.
      if (switching || blocked()) throw fail(409, 'Wait for the current model change or session action to finish.');
      if (!supportedThinkingLevels(getContext().model).includes(level)) throw fail(422, 'This model does not support that thinking level.');
      pi.setThinkingLevel(level);
      return { ok: true, thinkingLevel: this.thinking().level };
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
