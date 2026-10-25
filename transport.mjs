import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
]);

export function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

export async function readJSON(req, maxBytes = 64 * 1024) {
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

/** Common authenticated loopback boundary for the host and worker APIs. */
export async function createApiServer({ token, port = 0, fallbackPorts = false, serveAssets = false, handle, onClose }) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('A strong voice bridge token is required.');
  let origin;
  let closing = false;
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
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (closing) throw fail(503, 'Service is stopping. Reconnect in a moment.');
      if (req.headers.host !== new URL(origin).host) throw fail(403, 'Invalid host.');
      const requested = new URL(req.url, origin);
      if (!req.url.startsWith('/') || requested.origin !== origin) throw fail(400, 'Invalid request target.');
      const path = requested.pathname;
      // An app-initiated WebView load may be marked as cross-site. The public
      // landing page contains no credentials or session data and must load. Never extend this exception to APIs or non-GET requests.
      const publicLandingPage = req.method === 'GET' && path === '/';
      if (!publicLandingPage) {
        if (req.headers.origin && req.headers.origin !== origin) throw fail(403, 'Cross-origin requests are not allowed.');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'Cross-site requests are not allowed.');
      }
      if (serveAssets && req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const data = await readFile(`${publicDir}/${file}`);
        res.writeHead(200, { 'Content-Type': type });
        res.end(data);
        return;
      }
      if (!path.startsWith('/api/')) throw fail(404, 'Not found.');
      if (!authenticated(req, token)) throw fail(401, 'Open the app using /voice in Pi to connect securely.');
      await handle({ req, res, path, send });
    } catch (error) {
      send(error.status || 500, { error: error.status ? error.message : 'Pi Voice service error. Check Termux.' });
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 2000;
  server.maxConnections = 24;

  // Each concurrently running Pi gets its own port/session; never silently steal a bridge.
  const attempts = port === 0 || !fallbackPorts ? [port] : Array.from({ length: 20 }, (_, i) => port + i);
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
    server,
    async close() {
      if (closing) return;
      closing = true;
      onClose?.();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
