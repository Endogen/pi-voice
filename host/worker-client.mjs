import http from 'node:http';
import { readEndpoint } from '../discovery.mjs';
import { fail } from '../transport.mjs';

export function createWorkerClient(directory, token) {
  async function endpoint(entry) {
    const found = await readEndpoint(directory, entry.pid);
    if (!found || found.token !== token || found.instanceId !== entry.instanceId) throw fail(410, 'That process instance is no longer available.');
    return found;
  }
  const headers = (entry) => ({ Authorization: `Bearer ${token}`, 'X-Pi-Voice-Pid': String(entry.pid), 'X-Pi-Voice-Instance': entry.instanceId });
  return {
    async request(entry, path, body) {
      const { origin } = await endpoint(entry);
      const response = await fetch(`${origin}/api/${path}`, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { ...headers(entry), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
      const value = await response.json();
      if (!response.ok) throw fail(response.status, value.error || 'Pi request failed.');
      return value;
    },
    async forward(entry, req, res) {
      const { origin } = await endpoint(entry);
      if (req.aborted || res.destroyed) return;
      const incoming = new URL(req.url, 'http://127.0.0.1');
      const url = new URL(incoming.pathname + incoming.search, origin);
      const outgoing = { ...headers(entry) };
      for (const key of ['content-type', 'content-length']) if (req.headers[key]) outgoing[key] = req.headers[key];
      await new Promise((resolve) => {
        const upstream = http.request(url, { method: req.method, headers: outgoing }, (reply) => {
          res.writeHead(reply.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
          reply.pipe(res);
          reply.once('end', resolve);
          reply.once('error', () => { res.destroy(); resolve(); });
        });
        upstream.setTimeout(55000, () => upstream.destroy(new Error('Pi stopped responding.')));
        upstream.once('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Pi stopped responding. Delivery may be uncertain; review before retrying.' }));
          } else res.destroy();
          resolve();
        });
        const abort = () => upstream.destroy();
        const close = () => { if (!res.writableFinished) abort(); };
        req.once('aborted', abort);
        res.once('close', close);
        upstream.once('close', () => { req.off('aborted', abort); res.off('close', close); resolve(); });
        req.pipe(upstream);
      });
    },
  };
}
