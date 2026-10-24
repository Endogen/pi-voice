import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imageLimits, validateImages } from './image-attachments.mjs';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
]);

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readJSON(req, maxBytes = 64 * 1024) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw fail(415, 'Expected application/json.');
  }
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return; // Drain without buffering; preserve the socket for a 413 response.
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(fail(413, 'Request is too large.'));
      } else chunks.push(chunk);
    });
    req.once('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.once('error', reject);
    req.once('aborted', () => reject(fail(400, 'Request interrupted.')));
  });
  try {
    return JSON.parse(body);
  } catch {
    throw fail(400, 'Invalid JSON.');
  }
}

function authenticated(req, token) {
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

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

/** Local-only, authenticated transport. The extension owns the actual Pi session. */
export async function createVoiceBridge({
  token, getState, onPrompt, onAbort, onAwake, onNewSession, speech = termuxSpeech, port = 8765,
}) {
  if (!token || token.length < 32) throw new Error('A strong voice bridge token is required.');
  let origin;
  let closing = false;
  let listener;
  const submissions = new Map();

  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      }
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (closing) throw fail(503, 'Pi is reloading. Reconnect in a moment.');
      if (req.headers.host !== new URL(origin).host) throw fail(403, 'Invalid host.');
      const path = new URL(req.url, origin).pathname;
      // Android/Chrome may mark an external app launch as cross-site. The public
      // landing page contains no credentials or session data and must be openable
      // from a link. Never extend this exception to APIs or non-GET requests.
      const publicLandingPage = req.method === 'GET' && path === '/';
      if (!publicLandingPage) {
        if (req.headers.origin && req.headers.origin !== origin) throw fail(403, 'Cross-origin requests are not allowed.');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'Cross-site requests are not allowed.');
      }
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const data = await readFile(`${publicDir}/${file}`);
        res.writeHead(200, { 'Content-Type': type });
        res.end(data);
        return;
      }
      if (!path.startsWith('/api/')) throw fail(404, 'Not found.');
      if (!authenticated(req, token)) throw fail(401, 'Open the app using /voice in Pi to connect securely.');
      if (req.method === 'GET' && path === '/api/state') {
        send(200, { ...getState(), listening: Boolean(listener) });
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
        if (state.busy || state.pending || listener) throw fail(409, 'Finish or stop the current task/recording before starting a new session.');
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
        onAbort();
        send(200, { ok: true });
      } else if (req.method === 'POST' && path === '/api/listen/cancel') {
        listener?.abort();
        send(200, { ok: true });
      } else if (req.method === 'POST' && path === '/api/listen') {
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
    } catch (error) {
      send(error.status || 500, { error: error.status ? error.message : 'Voice bridge error. Check Pi in Termux.' });
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 2000;
  server.maxConnections = 24;

  // Each concurrently running Pi gets its own port/session; never silently steal a bridge.
  const attempts = port === 0 ? [0] : Array.from({ length: 20 }, (_, i) => port + i);
  for (const candidate of attempts) {
    try {
      await new Promise((resolve, reject) => {
        const error = (err) => { server.off('listening', ready); reject(err); };
        const ready = () => { server.off('error', error); resolve(); };
        server.once('error', error);
        server.once('listening', ready);
        server.listen(candidate, '127.0.0.1');
      });
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || candidate === attempts.at(-1)) throw error;
    }
  }
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: `${origin}/#${token}`,
    async close() {
      if (closing) return;
      closing = true;
      listener?.abort();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
