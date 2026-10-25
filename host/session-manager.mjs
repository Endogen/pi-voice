import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { discoverConnections } from '../discovery.mjs';
import { alive, stoppedRecords } from '../running.mjs';
import { protocolVersion, validId } from '../config.mjs';
import { fail } from '../transport.mjs';

async function resumable(entry) {
  if (!isAbsolute(entry.cwd || '') || !isAbsolute(entry.sessionFile || '') || !entry.sessionFile.endsWith('.jsonl')) return false;
  const [cwd, file] = await Promise.all([stat(entry.cwd).catch(() => null), stat(entry.sessionFile).catch(() => null)]);
  return cwd?.isDirectory() && file?.isFile();
}

/** Single writer for lifecycle state. Dependencies are injectable for crash tests. */
export function createSessionManager({ directory, registry, launcher, client, cwd = homedir(), maxSessions = 4,
  discover = () => discoverConnections(directory), isAlive = alive, now = Date.now, startupTimeout = 45000, closeTimeout = 15000 }) {
  const data = registry.data;
  let queue = Promise.resolve();
  let stopping = false;
  let storageError;
  // A failed write can have an uncertain durable outcome (for example, a
  // directory fsync failure after rename). Stop actions until a restart loads
  // the actual journal; never act on an uncommitted in-memory intent.
  async function save() {
    try { await registry.save(); }
    catch {
      storageError = fail(503, 'Could not persist Pi Voice state. Check storage and restart the host before continuing.');
      throw storageError;
    }
  }
  const serial = (action) => {
    const result = queue.then(() => { if (storageError) throw storageError; return action(); });
    queue = result.catch(() => {});
    return result;
  };
  const entries = () => Object.values(data.entries);
  const active = (entry) => ['ready', 'starting', 'unavailable', 'closing', 'close-error', 'incompatible'].includes(entry.status);
  const chooseRemaining = (except) => entries().filter((e) => e.handle !== except && e.status === 'ready')
    .sort((a, b) => (b.viewed || 0) - (a.viewed || 0))[0]?.handle || null;
  const publicEntry = (e) => ({ handle: e.handle, managed: Boolean(e.managed), pid: e.pid, instanceId: e.instanceId, sessionId: e.sessionId,
    title: e.title || 'New session', cwd: e.cwd, model: e.model, busy: e.busy, pending: e.pending,
    status: e.status, error: e.error, operationId: e.operationId, updated: e.updated,
    capabilities: { close: Boolean(e.managed && e.compatible && ['ready', 'close-error'].includes(e.status)) } });

  async function reconcile() {
    const before = JSON.stringify(data);
    const live = await discover();
    const seen = new Set();
    for (const worker of live) {
      const compatible = worker.protocolVersion === protocolVersion && validId(worker.instanceId) && validId(worker.handle);
      const handle = compatible ? worker.handle : `legacy-${worker.pid}`;
      let entry = data.entries[handle];
      if (entry?.status === 'closed') continue;
      // A worker cannot claim ownership by setting an environment flag. Only a
      // host launch record matching the instance grants lifecycle capability.
      if (entry?.managed && entry.instanceId !== worker.instanceId) continue;
      entry ||= data.entries[handle] = { handle, managed: false };
      const closing = ['closing', 'close-error'].includes(entry.status);
      if (entry.sessionId !== worker.sessionId) {
        delete entry.sessionFile;
        delete entry.identity;
      }
      Object.assign(entry, { pid: worker.pid, instanceId: worker.instanceId, compatible, sessionId: worker.sessionId,
        title: worker.title, cwd: worker.cwd, model: worker.model, busy: worker.busy, pending: worker.pending,
        status: closing ? entry.status : compatible ? 'ready' : 'incompatible' });
      const record = await readFile(join(directory, 'running', `${worker.pid}.json`), 'utf8').then(JSON.parse).catch(() => null);
      if (record?.instanceId === entry.instanceId && record?.sessionId === entry.sessionId) {
        entry.sessionFile = record.sessionFile;
        entry.identity = record.identity;
      }
      seen.add(handle);
      if (closing && entry.status === 'closing') {
        if (entry.sessionId !== entry.closeIntent.sessionId) {
          entry.status = 'close-error'; entry.error = 'The conversation changed before shutdown. Review it before closing again.';
        } else {
          try { await client.request(entry, 'session/close', { sessionId: entry.closeIntent.sessionId }); }
          catch { /* Reconcile actual exit below or retry until the deadline. */ }
          if (now() - entry.closeIntent.at > closeTimeout) {
            entry.status = 'close-error'; entry.error = 'Pi has not exited. Review it in Termux or retry Close.';
          }
        }
      }
    }
    for (const entry of entries()) {
      if (seen.has(entry.handle) || entry.status === 'closed' || entry.status === 'forgotten') continue;
      const processLive = entry.pid && await isAlive(entry.pid, entry);
      const terminalLive = entry.managed && await launcher.present(entry);
      if (entry.status === 'starting') {
        if (now() - entry.started > startupTimeout) {
          entry.status = processLive || terminalLive ? 'unavailable' : 'failed';
          entry.error = 'Pi did not publish a compatible endpoint in time. Check its terminal.';
        }
      } else if (['closing', 'close-error'].includes(entry.status)) {
        if (!processLive && !terminalLive) {
          entry.status = 'closed'; delete entry.error;
          if (data.selected === entry.handle) data.selected = chooseRemaining(entry.handle);
        } else if (now() - entry.closeIntent.at > closeTimeout) {
          entry.status = 'close-error'; entry.error = 'Pi has not exited. Review it in Termux or retry Close.';
        }
      } else if (active(entry)) {
        entry.status = processLive || terminalLive ? 'unavailable' : 'stopped';
      }
    }
    // Import only stopped legacy recovery metadata. Never infer control over a
    // live legacy process; upgrading it is an explicit restart after its task.
    for (const old of await stoppedRecords(directory, { isAlive })) {
      if (entries().some((e) => e.pid === old.pid || (e.sessionFile && e.sessionFile === old.sessionFile))) continue;
      const handle = randomUUID();
      data.entries[handle] = { handle, managed: false, status: 'stopped', title: old.title, cwd: old.cwd,
        sessionFile: old.sessionFile, sessionId: old.sessionId, updated: old.updated, pid: old.pid };
    }
    if (JSON.stringify(data) !== before) await save();
  }

  async function start(id, restore, source) {
    if (stopping) throw fail(503, 'Pi Voice is stopping. Reconnect before starting a session.');
    if (!validId(id)) throw fail(400, 'A valid operation ID is required.');
    const kind = restore ? `restore:${restore}` : `new:${source || ''}`;
    const previous = data.operations[id];
    if (previous) {
      if (previous.kind !== kind) throw fail(409, 'That operation ID was already used for another action.');
      return { ok: true, id, handle: previous.handle };
    }
    await reconcile();
    let entry = restore && data.entries[restore];
    if (restore && (!entry || !['stopped', 'failed'].includes(entry.status) || !await resumable(entry))) throw fail(409, 'That conversation cannot be restored now.');
    if (entries().filter(active).length >= maxSessions) throw fail(409, `Up to ${maxSessions} sessions can run at once. Close one first.`);
    if (entry?.sessionFile && entries().some((e) => e !== entry && active(e) && e.sessionFile === entry.sessionFile)) throw fail(409, 'That conversation is already open or starting.');
    const base = source && data.entries[source];
    if (source && !base) throw fail(410, 'The source session is no longer known.');
    entry ||= { handle: randomUUID(), cwd: base?.cwd || cwd, title: 'New session' };
    Object.assign(entry, { managed: true, compatible: true, instanceId: randomUUID(), operationId: id,
      terminal: `pi-voice-${randomBytes(4).toString('hex')}`, status: 'starting', started: now(), updated: now() });
    delete entry.pid; delete entry.identity; delete entry.error; delete entry.closeIntent;
    data.entries[entry.handle] = entry;
    data.operations[id] = { kind, handle: entry.handle };
    data.initialized = true;
    await save(); // Durable reservation BEFORE creating a process.
    try { await launcher.launch(entry); }
    catch (error) {
      // An exec timeout can have created the named pane. Reconcile it first.
      if (!await launcher.present(entry).catch(() => true)) { entry.status = 'failed'; entry.error = error.message; await save(); }
      throw fail(502, 'Could not confirm Pi startup. Check Sessions before trying again.');
    }
    return { ok: true, id, handle: entry.handle };
  }

  return {
    reconcile: () => serial(reconcile),
    async initialize() {
      return serial(async () => {
        await reconcile();
        // Crash between reservation and tmux creation: the deterministic target
        // makes this safe, including when launch succeeded before the crash.
        for (const entry of entries().filter((e) => e.status === 'starting')) await launcher.launch(entry);
        if (!data.initialized) {
          const existing = entries().find((e) => e.status === 'ready');
          const saved = entries().filter((e) => e.status === 'stopped').sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
          if (existing) { data.selected = existing.handle; data.initialized = true; await save(); }
          else { const result = await start(randomUUID(), saved?.handle); data.selected = result.handle; await save(); }
        } else if (data.selected && data.entries[data.selected]?.status === 'stopped' && await resumable(data.entries[data.selected])) {
          await start(randomUUID(), data.selected);
        }
      });
    },
    spawn: (id, source) => serial(() => start(id, null, source)),
    restore: (id, handle) => serial(() => {
      if (!validId(handle)) throw fail(400, 'A valid session handle is required.');
      return start(id, handle);
    }),
    select: (handle) => serial(async () => {
      await reconcile();
      if (handle !== null && data.entries[handle]?.status !== 'ready') throw fail(409, 'That session is not ready.');
      data.selected = handle;
      if (handle) data.entries[handle].viewed = now();
      await save();
      return { ok: true, selected: handle };
    }),
    close: (handle, body) => serial(async () => {
      await reconcile();
      const entry = data.entries[handle];
      if (!entry?.managed || !entry.compatible) throw fail(409, 'Only compatible sessions created by this host can be closed here.');
      if (entry.instanceId !== body.instanceId || entry.sessionId !== body.sessionId) throw fail(409, 'The session changed. Review it before closing.');
      if (entry.status === 'closed' || entry.status === 'closing') return { ok: true, status: entry.status };
      if (!['ready', 'close-error'].includes(entry.status)) throw fail(409, 'That session is unavailable. Open its terminal to inspect it.');
      entry.status = 'closing'; entry.closeIntent = { at: now(), sessionId: body.sessionId }; delete entry.error;
      await save();
      try { await client.request(entry, 'session/close', { sessionId: body.sessionId }); }
      catch { /* The close response can be lost while Pi exits. Observe exit. */ }
      return { ok: true, status: 'closing' };
    }),
    forget: (handle) => serial(async () => {
      await reconcile();
      const entry = data.entries[handle];
      if (!entry || !['failed', 'stopped'].includes(entry.status)) throw fail(409, 'Only stopped sessions can be dismissed.');
      entry.status = 'forgotten';
      if (data.selected === handle) data.selected = chooseRemaining(handle);
      await save(); return { ok: true };
    }),
    snapshot: () => serial(async () => {
      await reconcile();
      return { selected: data.selected, sessions: entries().filter(active).map(publicEntry),
        stopped: await Promise.all(entries().filter((e) => ['stopped', 'failed'].includes(e.status)).map(async (e) => ({ ...publicEntry(e), restorable: Boolean(await resumable(e)) }))) };
    }),
    target: (handle) => serial(async () => {
      await reconcile();
      const entry = data.entries[handle];
      if (!entry || entry.status !== 'ready') throw fail(410, 'That session is not available. Choose another session or restore it.');
      return { ...entry };
    }),
    prepareStop: () => serial(async () => {
      await reconcile();
      if (entries().some((e) => e.managed && active(e))) throw fail(409, 'Close managed sessions before stopping Pi Voice.');
      stopping = true;
    }),
  };
}
