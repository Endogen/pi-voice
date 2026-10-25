import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelSelection, publicModel, supportedThinkingLevels } from '../models.mjs';

function setup() {
  const first = { provider: 'cloud-a', id: 'one', name: 'One', input: ['text', 'image'], contextWindow: 128000 };
  const next = { provider: 'local-custom', id: 'folder/model:Q5_K_M', name: 'Local', input: ['text'], contextWindow: 4096, reasoning: true };
  let sessionId = 'session-one';
  const ctx = { model: first, isIdle: () => true, hasPendingMessages: () => false,
    modelRegistry: { getAvailable: () => [first, next] }, getContextUsage: () => ({ tokens: 7000 }),
    sessionManager: { getSessionId: () => sessionId } };
  const calls = [];
  const pi = { async setModel(...args) { calls.push(args); ctx.model = args[0]; return true; } };
  const controller = createModelSelection({ pi, getContext: () => ctx });
  const body = () => ({ sessionId, provider: next.provider, id: next.id, expectedModel: { provider: first.provider, id: first.id } });
  return { first, next, ctx, pi, calls, controller, body, session: (id) => { sessionId = id; } };
}

test('registry responses expose an allowlist, deduplicate provider/id and retain generic model IDs', () => {
  const h = setup();
  h.first.baseUrl = 'http://secret-server'; h.first.headers = { Authorization: 'secret' }; h.first.apiKey = 'secret';
  h.ctx.modelRegistry.getAvailable = () => [h.first, h.next, h.first, { provider: 'bad', id: '\nbad' }];
  const list = h.controller.list();
  assert.equal(list.models.length, 2);
  assert.equal(list.contextTokens, 7000);
  assert.equal(JSON.stringify(list).includes('secret'), false);
  assert.deepEqual(list.current, { provider: 'cloud-a', id: 'one' });
  assert.equal(list.models[1].id, 'folder/model:Q5_K_M');
  assert.deepEqual(publicModel({ provider: 'x', id: 'y', contextWindow: -1, maxTokens: Infinity }).input, []);
});

test('selection passes the canonical registry object to Pi without persistence or resetting history', async () => {
  const h = setup();
  const result = await h.controller.select({ ...h.body(), baseUrl: 'https://attacker.example', headers: { Authorization: 'not-used' } });
  assert.deepEqual(result, { ok: true, model: { provider: h.next.provider, id: h.next.id } });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].length, 1, 'Never opt into persisting the default');
  assert.equal(h.calls[0][0], h.next);
  assert.equal(h.controller.switching, false);
  assert.equal(h.controller.list().current.id, h.next.id);
});

test('stale conversations, external model changes and unavailable choices are rejected without mutation', async () => {
  for (const [change, status] of [
    [h => { h.session('new-session'); }, 409],
    [h => { h.ctx.model = { provider: 'elsewhere', id: 'changed-in-terminal' }; }, 409],
    [h => { h.ctx.modelRegistry.getAvailable = () => [h.first]; }, 422],
  ]) {
    const h = setup(); const body = h.body(); change(h);
    await assert.rejects(h.controller.select(body), (error) => error.status === status);
    assert.equal(h.calls.length, 0);
  }
});

test('selection requires an explicit previous model and validates IDs, not a provider-specific naming convention', async () => {
  for (const patch of [{ expectedModel: undefined }, { expectedModel: {} }, { provider: '' }, { id: '\nbad' }, { id: ' ' }, { id: 'x'.repeat(513) }]) {
    const h = setup(); await assert.rejects(h.controller.select({ ...h.body(), ...patch }), (error) => error.status === 400);
    assert.equal(h.calls.length, 0);
  }
  const h = setup(); h.ctx.model = undefined;
  await h.controller.select({ ...h.body(), expectedModel: null });
  assert.equal(h.ctx.model, h.next);
});

test('idle, queue and lifecycle guards are checked before calling Pi', async () => {
  for (const flag of ['busy', 'pending', 'closing']) {
    const h = setup();
    if (flag === 'busy') h.ctx.isIdle = () => false;
    if (flag === 'pending') h.ctx.hasPendingMessages = () => true;
    const controller = createModelSelection({ pi: h.pi, getContext: () => h.ctx, blocked: () => flag === 'closing' });
    await assert.rejects(controller.select(h.body()), (error) => error.status === 409);
    assert.equal(h.calls.length, 0);
  }
});

test('one in-flight model change excludes overlapping switches, and always releases the lock', async () => {
  const h = setup(); let finish;
  h.pi.setModel = (model) => new Promise((resolve) => { finish = () => { h.ctx.model = model; resolve(true); }; });
  const pending = h.controller.select(h.body());
  assert.equal(h.controller.switching, true);
  await assert.rejects(h.controller.select(h.body()), (error) => error.status === 409);
  finish(); await pending;
  assert.equal(h.controller.switching, false);
});

test('missing authentication, thrown provider errors and unexpected resulting model do not claim success', async () => {
  for (const [setModel, status] of [
    [async () => false, 422],
    [async () => { throw new Error('secret-token in provider headers'); }, 502],
    [async () => true, 409],
  ]) {
    const h = setup(); h.pi.setModel = setModel;
    await assert.rejects(h.controller.select(h.body()), (error) => error.status === status && !error.message.includes('secret-token'));
    assert.equal(h.controller.switching, false);
    h.pi.setModel = async (model) => { h.ctx.model = model; return true; };
    assert.equal((await h.controller.select(h.body())).ok, true, 'A failure must not leave the picker locked');
  }
});

test('session changes while Pi authenticates are detected and selecting the current model is a no-op', async () => {
  const h = setup();
  await h.controller.select({ ...h.body(), provider: h.first.provider, id: h.first.id });
  assert.equal(h.calls.length, 0);
  h.pi.setModel = async (model) => { h.ctx.model = model; h.session('changed'); return true; };
  await assert.rejects(h.controller.select(h.body()), (error) => error.status === 409);
  assert.equal(h.controller.switching, false);
});

test('old Pi API and broken registries fail clearly without leaking configuration', async () => {
  const h = setup();
  h.ctx.modelRegistry.getAvailable = () => { throw new Error('private baseUrl'); };
  assert.throws(() => h.controller.list(), (error) => error.status === 502 && !error.message.includes('baseUrl'));
  delete h.pi.setModel;
  assert.equal(h.controller.supported(), false);
  assert.throws(() => h.controller.list(), (error) => error.status === 501);
  await assert.rejects(h.controller.select(h.body()), (error) => error.status === 501);
});

test('thinking levels mirror Pi’s model capabilities', () => {
  assert.deepEqual(supportedThinkingLevels(undefined), []);
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ['off']);
  assert.deepEqual(supportedThinkingLevels({ reasoning: true }), ['off', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: null } }), ['off', 'low', 'medium', 'high', 'xhigh']);
});

test('thinking changes are session-scoped, validated, never race a model change and read Pi’s clamped level back', async () => {
  const h = setup();
  assert.deepEqual(h.controller.thinking(), { supported: false, level: null, levels: [] }, 'Older Pi has no thinking API');
  assert.throws(() => h.controller.setThinking({ sessionId: 'session-one', level: 'high' }), (error) => error.status === 501);
  let level = 'medium';
  const set = [];
  h.pi.getThinkingLevel = () => level;
  h.pi.setThinkingLevel = (next) => { set.push(next); level = next === 'xhigh' ? 'high' : next; };
  h.ctx.model = h.next;
  assert.deepEqual(h.controller.thinking(), { supported: true, level: 'medium', levels: ['off', 'minimal', 'low', 'medium', 'high'] });
  assert.deepEqual(h.controller.setThinking({ sessionId: 'session-one', level: 'high' }), { ok: true, thinkingLevel: 'high' });
  for (const [body, status] of [[{ sessionId: 'session-one', level: 'loud' }, 400], [{ sessionId: 'stale', level: 'low' }, 409], [{ sessionId: 'session-one', level: 'xhigh' }, 422]]) {
    assert.throws(() => h.controller.setThinking(body), (error) => error.status === status, JSON.stringify(body));
  }
  h.ctx.model = h.first; // No reasoning: only "off".
  assert.throws(() => h.controller.setThinking({ sessionId: 'session-one', level: 'low' }), (error) => error.status === 422);
  let finish;
  h.ctx.model = h.next;
  h.pi.setModel = () => new Promise((resolve) => { finish = resolve; });
  const switching = h.controller.select({ ...h.body(), id: h.first.id, provider: h.first.provider, expectedModel: { provider: h.next.provider, id: h.next.id } });
  assert.throws(() => h.controller.setThinking({ sessionId: 'session-one', level: 'low' }), (error) => error.status === 409);
  finish(true); await switching.catch(() => {});
  assert.deepEqual(set, ['high']);
});

test('model lists mark Pi’s scoped models and report context use with its window', () => {
  const h = setup();
  h.ctx.scopedModels = [{ model: h.next, thinkingLevel: 'high' }];
  h.ctx.getContextUsage = () => ({ tokens: 3000, contextWindow: 4096, percent: 73 });
  const list = h.controller.list();
  assert.deepEqual(list.models.map((model) => Boolean(model.scoped)), [false, true]);
  assert.deepEqual(list.contextUsage, { tokens: 3000, contextWindow: 4096 });
  h.ctx.getContextUsage = () => ({ tokens: null, contextWindow: 4096, percent: null });
  assert.deepEqual(h.controller.list().contextUsage, { tokens: null, contextWindow: 4096 }, 'Unknown right after compaction');
  h.ctx.getContextUsage = () => { throw new Error('No usage'); };
  assert.equal(h.controller.list().contextUsage, null);
});
