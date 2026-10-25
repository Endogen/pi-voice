import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON } from '../storage.mjs';
import { validId } from '../config.mjs';

export async function openRegistry(directory) {
  const file = join(directory, 'host-state.json');
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Pi Voice host state is unreadable. Preserve it before repairing it.');
    data = { version: 1, initialized: false, selected: null, entries: {}, operations: {} };
  }
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  if (data?.version !== 1 || typeof data.initialized !== 'boolean' || !object(data.entries) || !object(data.operations)
    || data.selected !== null && (!validId(data.selected) || !Object.hasOwn(data.entries, data.selected))
    || data.port !== undefined && (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535)) throw new Error('Unsupported Pi Voice host state.');
  for (const [handle, entry] of Object.entries(data.entries)) {
    if (!validId(handle) || !object(entry) || entry.handle !== handle
      || !['starting', 'ready', 'unavailable', 'incompatible', 'closing', 'close-error', 'closed', 'failed', 'stopped', 'forgotten'].includes(entry.status)
      || entry.managed && (!validId(entry.instanceId) || !/^pi-voice-[a-f0-9]{8}$/.test(entry.terminal || ''))
      || ['closing', 'close-error'].includes(entry.status) && (!object(entry.closeIntent) || typeof entry.closeIntent.sessionId !== 'string')) {
      throw new Error('Invalid Pi Voice lifecycle record. Preserve host-state.json before repairing it.');
    }
  }
  for (const [id, operation] of Object.entries(data.operations)) {
    if (!validId(id) || !object(operation) || typeof operation.kind !== 'string' || !Object.hasOwn(data.entries, operation.handle)) throw new Error('Invalid Pi Voice operation record.');
  }
  data.entries = Object.assign(Object.create(null), data.entries);
  data.operations = Object.assign(Object.create(null), data.operations);
  return { data, save: () => atomicJSON(file, data) };
}
