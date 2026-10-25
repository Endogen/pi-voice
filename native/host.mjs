import { pathToFileURL } from 'node:url';
import { stateDir } from '../config.mjs';
import { createHost } from '../host/server.mjs';
import { createLauncher } from '../host/launcher.mjs';
import { discoverHost } from './connection.mjs';

// host.sh owns the kernel lock for this service's entire lifetime. No Pi
// conversation or tmux pane decides when the registered Termux task exits.
export async function runNativeHost({ directory = stateDir, signal, ...options } = {}) {
  if (await discoverHost(directory)) return { reused: true };
  const host = await createHost({ directory, ...options, launcher: options.launcher || createLauncher(options) });
  const stop = () => { void host.close(); };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try { await host.closed; }
  finally { signal?.removeEventListener('abort', stop); }
  return { reused: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  try { await runNativeHost({ signal: controller.signal }); }
  catch (error) { process.stderr.write(`Pi Voice host could not start: ${error.code === 'EADDRINUSE' ? 'The reserved host port is occupied. Stop the conflicting service before reconnecting.' : error.message}\n`); process.exitCode = 1; }
}
