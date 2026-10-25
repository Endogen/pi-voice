import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

// One private record per running voice-enabled Pi: which conversation it has
// open and where. If the phone or Android stops Pi, the records left behind
// tell the native host and the app what to resume. Records come only from
// this directory, never from the page.
const folder = (directory) => join(directory, 'running');
const recordName = /^[1-9]\d{0,9}\.json$/;

export async function writeRecord(directory, record) {
  await mkdir(folder(directory), { recursive: true, mode: 0o700 });
  await writeFile(join(folder(directory), `${record.pid}.json`), JSON.stringify({ ...record, updated: Date.now() }), { mode: 0o600 });
}

export async function removeRecord(directory, pid) {
  if (Number.isSafeInteger(pid) && pid > 0) await rm(join(folder(directory), `${pid}.json`), { force: true });
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// Only a saved session file in an existing folder can be resumed. Anything
// else (ephemeral --no-session runs, deleted files, odd paths) is skipped.
async function usable(record) {
  if (!record || !Number.isSafeInteger(record.pid) || typeof record.sessionFile !== 'string' || typeof record.cwd !== 'string') return false;
  if (!isAbsolute(record.sessionFile) || !record.sessionFile.endsWith('.jsonl') || /[\0\n\r]/.test(record.sessionFile + record.cwd) || !isAbsolute(record.cwd)) return false;
  const [file, cwd] = await Promise.all([stat(record.sessionFile).catch(() => undefined), stat(record.cwd).catch(() => undefined)]);
  return Boolean(file?.isFile() && cwd?.isDirectory());
}

/** Records whose Pi process is gone, newest first. Unusable ones are deleted. */
export async function stoppedRecords(directory, { isAlive = alive } = {}) {
  const names = (await readdir(folder(directory)).catch(() => [])).filter((name) => recordName.test(name));
  const entries = await Promise.all(names.map(async (name) => {
    const pid = Number(name.slice(0, -5));
    const record = await readFile(join(folder(directory), name), 'utf8').then(JSON.parse).catch(() => undefined);
    return { pid, record, live: isAlive(pid) };
  }));
  const liveFiles = new Set(entries.filter(({ pid, record, live }) => live && record?.pid === pid && typeof record.sessionFile === 'string').map(({ record }) => record.sessionFile));
  const records = [];
  for (const { pid, record, live } of entries) {
    if (live) continue;
    // Only retire recovery after a live replacement records the same saved
    // conversation. Creating a tmux pane alone does not prove Pi started.
    if (record?.pid === pid && await usable(record) && !liveFiles.has(record.sessionFile)) records.push(record);
    else await removeRecord(directory, pid);
  }
  return records.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

/** One stopped record by PID, re-validated, or undefined. */
export async function stoppedRecord(directory, pid, options) {
  return (await stoppedRecords(directory, options)).find((record) => record.pid === pid);
}
