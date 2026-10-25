import { test as base, expect } from '@playwright/test';
import { createApiServer, readJSON, fail } from '../../transport.mjs';

const modelList = [
  { provider: 'cloud', id: 'vision', name: 'Cloud vision', input: ['text', 'image'], contextWindow: 128000 },
  { provider: 'local', id: 'qwen/model:Q5', name: 'Local text', input: ['text'], contextWindow: 4096 },
];
const reference = ({ provider, id }) => ({ provider, id });
const makeSession = (handle, title) => ({
  handle, title, instanceId: `instance-${handle}`, sessionId: `conversation-${handle}`, sessionName: title,
  cwd: '/test/project', pid: 100, busy: false, pending: false, messages: [],
  model: 'cloud/vision', modelSelection: reference(modelList[0]), modelSwitchingSupported: true, modelSwitching: false,
  imageAttachments: true, modelSupportsImages: true, wakeLock: { active: false },
  status: 'ready', managed: true, capabilities: { close: true },
});

export const test = base.extend({
  app: async ({ page }, use) => {
    const states = [makeSession('session-first', 'First session'), makeSession('session-second', 'Second session')];
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const h = { states, models: modelList, requests: [], selected: states[0].handle, state: states[0] };
    const holds = new Set();
    h.holdNextState = (handle) => {
      let start, release;
      const gate = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { start = resolve; });
      const held = { handle, gate, start, release, used: false };
      holds.add(held);
      return { started, release };
    };
    h.choose = (state, model) => {
      Object.assign(state, { model: `${model.provider}/${model.id}`, modelSelection: reference(model), modelSwitching: false,
        modelSupportsImages: model.input.includes('image') });
    };
    const server = await createApiServer({ token: 'a'.repeat(64), serveAssets: true,
      async handle({ req, path, send }) {
        const handle = req.headers['x-pi-voice-session'] || h.selected;
        const state = states.find((item) => item.handle === handle);
        const body = req.method === 'POST' ? await readJSON(req, 12 * 1024 * 1024) : undefined;
        h.requests.push({ path, body, handle });
        if (path === '/api/state') {
          if (!state) throw fail(410, 'Session gone');
          const snapshot = structuredClone(state);
          const held = [...holds].find((hold) => !hold.used && hold.handle === handle);
          if (held) { held.used = true; held.start(); await held.gate; }
          send(200, snapshot);
        } else if (path === '/api/sessions') send(200, { selected: h.selected, sessions: states, stopped: [] });
        else if (path === '/api/session/select') { h.selected = body.handle; send(200, { ok: true }); }
        else if (path === '/api/models') send(200, { sessionId: state.sessionId, current: state.modelSelection, models: modelList, contextTokens: 8000 });
        else if (path === '/api/model') {
          if (h.onModel) await h.onModel(body, state);
          else h.choose(state, modelList.find((model) => model.id === body.id && model.provider === body.provider));
          send(200, { ok: true });
        } else if (path === '/api/awake') { state.wakeLock.active = body.enabled; send(200, { wakeLock: state.wakeLock }); }
        else if (path === '/api/activity') send(200, { version: 1, steps: [], terminal: {} });
        else if (path === '/api/prompt') {
          state.messages.push({ id: body.id, role: 'user', text: body.text, imageCount: body.images?.length || 0 });
          send(200, { ok: true });
        } else throw fail(404, `Unexpected route: ${path}`);
      },
    });
    page.on('dialog', (dialog) => dialog.accept());
    try {
      await page.goto(server.url);
      await expect(page.locator('#connection')).toContainText('Ready');
      await use(h);
      expect(errors, 'No unhandled browser exceptions').toEqual([]);
    } finally {
      for (const hold of holds) hold.release();
      await server.close();
    }
  },
});
export { expect, fail };
