import { pathToFileURL } from 'node:url';
import { stateDir } from './config.mjs';
import { discoverHost } from './native/connection.mjs';

// Read-only report. Deliberately excludes credentials, prompts, replies,
// provider configuration, filesystem paths and raw provider error messages.
export async function collectDiagnostics(directory = stateDir) {
  const connection = await discoverHost(directory);
  const report = { capturedAt: new Date().toISOString(), hostReachable: Boolean(connection) };
  if (!connection) return report;
  const url = new URL(connection.url);
  const token = url.hash.slice(1);
  async function get(path) {
    const response = await fetch(`${url.origin}/api/${path}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Diagnostics request failed (${response.status}).`);
    return response.json();
  }
  const [health, list, state] = await Promise.all([get('health'), get('sessions'), get('state')]);
  report.host = { pid: health.pid, instanceId: health.instanceId };
  report.workers = (list.sessions || []).map(({ handle, pid, instanceId, status, busy, pending }) => ({ handle, pid, instanceId, status, busy, pending }));
  report.stoppedSessions = (list.stopped || []).length;
  const assistant = state.messages?.findLast((message) => message.role === 'assistant');
  report.selected = {
    handle: state.handle, pid: state.pid, instanceId: state.instanceId, empty: Boolean(state.empty),
    busy: Boolean(state.busy), pending: Boolean(state.pending),
    wakeLockRequested: Boolean(state.wakeLock?.active), wakeLockRequestFailed: Boolean(state.wakeLock?.error),
    lastReplyOutcome: assistant?.stopReason || (assistant ? 'reply' : 'none'),
  };
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await collectDiagnostics(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
