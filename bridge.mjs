import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { imageLimits, validateImages } from './image-attachments.mjs';
import { createApiServer, fail, readJSON } from './transport.mjs';

export function termuxSpeech({ signal, timeout = 45000 } = {}) {
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
  return new Promise((resolve, reject) => {
    // Call the API binary directly: no shell, pipelines, or orphaned wrapper processes.
    execFile(`${prefix}/libexec/termux-api`, ['SpeechToText'], {
      signal, timeout, maxBuffer: 64 * 1024, encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (signal?.aborted) return reject(fail(409, 'Listening cancelled.'));
      if (error) {
        return reject(fail(502, error.killed
          ? 'Speech timed out. Check Termux:API microphone permission, or use Browser speech.'
          : `Android speech failed: ${(stderr || error.message).trim().slice(0, 300)}`));
      }
      const output = stdout.trim();
      if (output.startsWith('{')) {
        try {
          const result = JSON.parse(output);
          if (result.error) return reject(fail(502, String(result.error)));
        } catch {} // Non-JSON speech may itself start with a brace.
      }
      const text = output.split(/\r?\n/).filter(Boolean).at(-1) || '';
      if (!text) return reject(fail(422, 'No speech detected. Check microphone permission or try Browser speech.'));
      resolve(text);
    });
  });
}

/** Adapter for exactly one Pi process. No discovery, launch, or peer relay. */
export async function createVoiceBridge({ token, getState, getActivity, getModels, onModel, onPrompt, onAbort, onAwake, onNewSession, onClose,
  pid = process.pid, instanceId, retries = [], speech = termuxSpeech, port = 8765 }) {
  let listener;
  const submissions = new Map(retries.slice(-200).filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].length <= 200
    && /^[a-f0-9]{64}$/.test(entry[1]?.digest || '') && entry[1]?.result?.ok === true));
  const server = await createApiServer({ token, port, fallbackPorts: true, onClose: () => listener?.abort(),
    async handle({ req, res, path, send }) {
      if (req.headers['x-pi-voice-pid'] && req.headers['x-pi-voice-pid'] !== String(pid)) throw fail(410, 'That process has ended.');
      if (req.headers['x-pi-voice-instance'] && req.headers['x-pi-voice-instance'] !== instanceId) throw fail(410, 'That process instance has ended.');
      if (req.method === 'GET' && path === '/api/state') {
        const state = { ...getState(), listening: Boolean(listener) };
        if (new URL(req.url, 'http://127.0.0.1').searchParams.get('summary') !== '1') send(200, state);
        else {
          // Lightweight form for the session switcher: no message history.
          const { messages = [], ...summary } = state;
          send(200, { ...summary, preview: messages.findLast((message) => message.role === 'user')?.text?.slice(0, 160) || '' });
        }
      } else if (req.method === 'GET' && path === '/api/activity') {
        if (!getActivity) throw fail(501, 'Live activity is not installed. Restart Pi after updating.');
        send(200, getActivity());
      } else if (req.method === 'GET' && path === '/api/models') {
        if (!getModels) throw fail(501, 'Model switching is not installed. Restart Pi after updating.');
        send(200, getModels());
      } else if (req.method === 'POST' && path === '/api/model') {
        const body = await readJSON(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.sessionId !== 'string') throw fail(400, 'A model selection and current session ID are required.');
        const state = getState();
        if (body.sessionId !== state.sessionId) throw fail(409, 'The Pi session changed. Refresh models before trying again.');
        if (!onModel) throw fail(501, 'Model switching is not installed. Restart Pi after updating.');
        if (state.busy || state.pending || state.modelSwitching || state.newSessionAction?.status === 'starting' || listener) {
          throw fail(409, 'Finish or stop the current task/recording before changing models.');
        }
        send(200, await onModel(body));
      } else if (req.method === 'POST' && path === '/api/session/close') {
        const body = await readJSON(req);
        if (getState().modelSwitching) throw fail(409, 'Wait for the model change before closing this session.');
        if (!body || typeof body.sessionId !== 'string' || body.sessionId !== getState().sessionId) throw fail(409, 'The Pi session changed. Review it before closing.');
        if (!onClose) throw fail(501, 'Closing sessions is not installed. Restart Pi after updating.');
        send(202, onClose());
      } else if (req.method === 'POST' && path === '/api/prompt') {
        const body = await readJSON(req, imageLimits.maxRequestBytes);
        if (!body || typeof body.text !== 'string' || body.text.length > 16000) {
          throw fail(400, 'Enter a message up to 16000 characters.');
        }
        const images = validateImages(body.images);
        if (!body.text.trim() && !images.length) throw fail(400, 'Enter a message or attach an image.');
        if (typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(body.id)) {
          throw fail(400, 'A valid message ID is required.');
        }
        const state = getState();
        if (body.sessionId !== state.sessionId) {
          throw fail(409, 'The Pi session changed. Review the connected session and send again.');
        }
        // Keep only a digest for retries, not hundreds of base64 image copies.
        const hash = createHash('sha256').update(JSON.stringify(body.text));
        for (const image of images) hash.update(`\0${image.mimeType}\0${image.data.length}\0`).update(image.data);
        const digest = hash.digest('hex');
        const submissionKey = `${body.sessionId}:${body.id}`;
        const existing = submissions.get(submissionKey);
        if (existing) {
          if (existing.digest !== digest) throw fail(409, 'Message ID was already used for different text or images.');
          send(200, existing.result);
          return;
        }
        if (images.length && (!state.imageAttachments || !state.modelSupportsImages)) {
          throw fail(422, 'The connected Pi model does not support images. Select a vision-capable model first.');
        }
        if (state.modelSwitching) throw fail(409, 'A model change is in progress. Wait before sending.');
        if (state.newSessionAction?.status === 'starting') throw fail(409, 'A new session is starting. Wait before sending.');
        // onPrompt must enqueue synchronously, so duplicate requests cannot race.
        const result = onPrompt(body.text.trim(), images);
        submissions.set(submissionKey, { digest, result });
        if (submissions.size > 200) submissions.delete(submissions.keys().next().value);
        send(200, result);
      } else if (req.method === 'POST' && path === '/api/session/new') {
        const body = await readJSON(req);
        if (!body || typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(body.id) || typeof body.sessionId !== 'string') {
          throw fail(400, 'A valid request ID and current session ID are required.');
        }
        const state = getState();
        if (body.sessionId !== state.sessionId) throw fail(409, 'The Pi session changed. Review it before starting another.');
        if (!onNewSession) throw fail(501, 'New-session support is not installed. Restart Pi after updating.');
        if (state.busy || state.pending || state.modelSwitching || listener) throw fail(409, 'Finish or stop the current task/recording before starting a new session.');
        // The callback accepts synchronously, then defers session replacement so
        // this acknowledgement is sent before Pi shuts down the old bridge.
        send(202, onNewSession(body.id, body.sessionId));
      } else if (req.method === 'POST' && path === '/api/awake') {
        const body = await readJSON(req);
        if (!body || typeof body.enabled !== 'boolean') throw fail(400, 'A boolean enabled setting is required.');
        if (!onAwake) throw fail(501, 'Stay-awake support is not installed. Restart Pi after updating.');
        try { send(200, { wakeLock: await onAwake(body.enabled) }); }
        catch (error) { throw fail(502, error.message); }
      } else if (req.method === 'POST' && path === '/api/abort') {
        const body = await readJSON(req);
        if (!body || typeof body.sessionId !== 'string' || !body.sessionId) throw fail(400, 'The current session ID is required. Refresh the app after updating.');
        if (body.sessionId !== getState().sessionId) throw fail(409, 'The Pi session changed. Review the connected session before stopping it.');
        onAbort();
        send(200, { ok: true });
      } else if (req.method === 'POST' && path === '/api/listen/cancel') {
        listener?.abort();
        send(200, { ok: true });
      } else if (req.method === 'POST' && path === '/api/listen') {
        if (getState().modelSwitching) throw fail(409, 'A model change is in progress. Wait before recording.');
        if (getState().newSessionAction?.status === 'starting') throw fail(409, 'A new session is starting. Wait before recording.');
        if (listener) throw fail(409, 'Android speech is already listening.');
        const controller = new AbortController();
        listener = controller;
        const cancel = () => controller.abort();
        res.once('close', cancel);
        try {
          const text = await speech({ signal: controller.signal });
          if (!controller.signal.aborted) send(200, { text });
          else throw fail(409, 'Listening cancelled.');
        } finally {
          res.off('close', cancel);
          if (listener === controller) listener = undefined;
        }
      } else {
        throw fail(404, 'Not found.');
      }
    },
  });
  return { ...server, retryState: () => [...submissions] };
}
