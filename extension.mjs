import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { createVoiceBridge } from './bridge.mjs';
import { createWakeLock } from './wake-lock.mjs';
import { imageLimits } from './image-attachments.mjs';
import { discoverConnections, readEndpoint } from './discovery.mjs';
import { createActivity } from './activity.mjs';
import { removeRecord, stoppedRecord, stoppedRecords, writeRecord } from './running.mjs';

export const stateDir = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'voice');

async function loadToken() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const file = join(stateDir, 'token');
  try {
    await writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await chmod(file, 0o600);
  const token = (await readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`Invalid token file: ${file}`);
  return token;
}

const readVersion = async (file) => {
  const data = JSON.parse(await readFile(file, 'utf8'));
  return typeof data.version === 'string' ? { name: data.name, version: data.version.slice(0, 40) } : {};
};

// Versions shown in Settings. Pi's extension API has no version field: find
// Pi's package.json above the running CLI, else ask its (aliased) package.
export async function detectVersions(cli = process.argv[1]) {
  const voice = await readVersion(new URL('./package.json', import.meta.url)).then((data) => data.version, () => undefined);
  let pi;
  try {
    for (let directory = dirname(await realpath(cli)), i = 0; i < 6 && !pi; directory = dirname(directory), i++) {
      const data = await readVersion(join(directory, 'package.json')).catch(() => ({}));
      if (/pi-coding-agent$/.test(data.name || '')) pi = data.version;
    }
  } catch { /* No CLI path, e.g. a compiled binary. */ }
  if (!pi) pi = await import('@earendil-works/pi-coding-agent').then((module) => String(module.VERSION || '') || undefined, () => undefined);
  return { voice, pi };
}

const tmuxBinary = () => (process.env.PREFIX ? join(process.env.PREFIX, 'bin', 'tmux') : 'tmux');

// Which terminal shows this Pi. Only the native host's private tmux server can
// be attached from the app; its session names are fixed and validated again
// by the native shell before anything runs.
export function detectTerminal(env = process.env) {
  const socket = (env.TMUX || '').split(',')[0];
  if (!socket || socket.split('/').at(-1) !== 'pi-voice-native') return Promise.resolve({});
  return new Promise((resolve) => execFile(tmuxBinary(), ['display-message', '-p', ...(env.TMUX_PANE ? ['-t', env.TMUX_PANE] : []), '#S'], { timeout: 5000 }, (error, stdout) => {
    const session = String(stdout || '').trim();
    resolve(!error && /^pi-voice(-[a-f0-9]{8})?$/.test(session) ? { session } : {});
  }));
}

const maxSessions = 4;
const spawnId = /^[a-zA-Z0-9-]{8,80}$/.test(process.env.PI_VOICE_SPAWN_ID || '') ? process.env.PI_VOICE_SPAWN_ID : undefined;
const fail = (status, message) => Object.assign(new Error(message), { status });

// Start another Pi beside this one in the native host's private tmux server.
// The new Pi publishes its own bridge; the app finds it by its spawn ID.
export async function launchSession({ id, cwd, args: piArgs = [] }) {
  const tmux = tmuxBinary();
  const managed = join(homedir(), '.pi', 'agent', 'bin', 'pi');
  const command = await access(managed).then(() => [managed], () => [process.execPath, process.argv[1]]);
  const env = [`PI_VOICE_SPAWN_ID=${id}`, ...(process.env.PI_CODING_AGENT_DIR ? [`PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR}`] : [])];
  const args = ['-L', 'pi-voice-native', 'new-session', '-d', '-s', `pi-voice-${randomBytes(4).toString('hex')}`, '-x', '100', '-y', '36', '-c', cwd, ...env.flatMap((item) => ['-e', item]), ...command, ...piArgs];
  await new Promise((resolve, reject) => execFile(tmux, args, { timeout: 10000 }, (error, _stdout, stderr) => {
    if (!error) return resolve();
    reject(error.code === 'ENOENT'
      ? fail(501, 'Parallel sessions need tmux. Install it in Termux with: pkg install tmux')
      : fail(502, `Could not start a parallel session: ${String(stderr || error.message).trim().slice(0, 200)}`));
  }));
}

function textOf(message) {
  if (typeof message.content === 'string') return message.content;
  return (message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

export default function installVoiceExtension(pi, { wakeLock = createWakeLock({ directory: join(stateDir, 'wake-lock') }), launch = launchSession } = {}) {
  let bridge;
  const spawned = new Set();
  const spawning = new Map();
  let versions = {};
  let terminal = {};
  const activity = createActivity();
  void detectVersions().then((found) => { versions = found; }, () => {});
  void detectTerminal().then((found) => { terminal = found; }, () => {});
  let context;
  let starting;
  let newSessionAction;
  const endpointFile = join(stateDir, 'endpoints', `${process.pid}.json`);
  // Runtime replacement reloads this module. Carry only the preferred port,
  // never a stale Pi context, across /new, /resume and /reload.
  const reconnectFile = join(stateDir, `reconnect-${process.pid}.json`);

  const snapshot = () => {
    // Pi persists a message AFTER emitting message_end. Read at request time so
    // the most recent user/reply is not missing during a long-running tool call.
    return {
      pid: process.pid,
      sessionId: context.sessionManager.getSessionId(),
      sessionName: context.sessionManager.getSessionName() || 'Pi session',
      title: context.sessionManager.getSessionName() || firstQuestion() || 'New session',
      spawned: Boolean(spawnId),
      voiceVersion: versions.voice,
      piVersion: versions.pi,
      terminal,
      activity: activity.current(),
      spawnId,
      sessionPersistent: Boolean(context.sessionManager.getSessionFile()),
      cwd: context.cwd,
      model: context.model ? `${context.model.provider}/${context.model.id}` : 'No model selected',
      imageAttachments: imageLimits,
      modelSupportsImages: Boolean(context.model?.input?.includes('image')),
      busy: !context.isIdle(),
      pending: context.hasPendingMessages(),
      wakeLock: wakeLock.status(),
      newSessionAction: newSessionAction ? { id: newSessionAction.id, status: newSessionAction.status, error: newSessionAction.error } : undefined,
      messages: readMessages(),
    };
  };

  const firstQuestion = () => {
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type !== 'message' || entry.message.role !== 'user') continue;
      const text = textOf(entry.message).replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 80);
    }
  };

  async function spawnSession(id, record) {
    if (spawned.has(id)) return { ok: true, id };
    if (spawning.has(id)) return spawning.get(id);
    // Reserve the ID before discovery yields: concurrent retries share the
    // acknowledgement (including failures), not just completed launches.
    const pending = (async () => {
      const live = await discoverConnections(stateDir);
      if (live.length >= maxSessions) throw fail(409, `Up to ${maxSessions} sessions can run at once. Close one first.`);
      await launch(record ? { id, cwd: record.cwd, args: ['--session', record.sessionFile] } : { id, cwd: context.cwd });
      spawned.add(id);
      // Keep a recovery record until the replacement publishes its own. The
      // stopped-record scan then retires duplicates of that live conversation.
      return { ok: true, id };
    })();
    spawning.set(id, pending);
    try { return await pending; } finally { spawning.delete(id); }
  }
  const record = () => ({
    pid: process.pid, sessionId: context.sessionManager.getSessionId(), sessionFile: context.sessionManager.getSessionFile(),
    cwd: context.cwd, spawned: Boolean(spawnId), title: context.sessionManager.getSessionName() || firstQuestion() || 'New session',
  });
  const saveRecord = () => writeRecord(stateDir, record()).catch(() => {});

  const readMessages = () => context.sessionManager.getBranch()
    .filter((entry) => entry.type === 'message' && ['user', 'assistant'].includes(entry.message.role))
    .slice(-40)
    .map((entry) => {
      const imageCount = Array.isArray(entry.message.content) ? entry.message.content.filter((part) => part.type === 'image').length : 0;
      // Never return base64 in the frequently polled state/history response.
      return { id: entry.id, role: entry.message.role, text: textOf(entry.message).slice(-24000), ...(imageCount ? { imageCount } : {}) };
    })
    .filter((message) => message.text || message.imageCount);

  async function start(ctx, port) {
    context = ctx;
    if (bridge) return bridge;
    if (starting) return starting;
    starting = (async () => {
      const token = await loadToken();
      const created = await createVoiceBridge({
        token, port,
        getState: snapshot,
        getActivity: () => ({ ...activity.snapshot(), terminal }),
        listSessions: async () => (await discoverConnections(stateDir)).map(({ url, ...session }) => session),
        // Conversations whose Pi stopped (phone off, Android killed Termux).
        listStopped: async () => (await stoppedRecords(stateDir)).map(({ pid, title, cwd, updated }) => ({ pid, title, cwd, updated })),
        async onRestore(id, pid) {
          const found = await stoppedRecord(stateDir, pid);
          if (!found && !spawned.has(id)) throw fail(410, 'That session can no longer be restored.');
          return spawnSession(id, found);
        },
        async onForget(pid) {
          if (await stoppedRecord(stateDir, pid)) await removeRecord(stateDir, pid);
          return { ok: true };
        },
        peerOrigin: async (pid) => {
          const endpoint = await readEndpoint(stateDir, pid);
          return endpoint?.token === token ? endpoint.origin : undefined;
        },
        onSpawn: spawnSession,
        onClose() {
          // Only app-started sessions: never quit a Pi the user runs in a terminal.
          if (!spawnId) throw fail(409, 'Only sessions started from the app can be closed here. Quit this one in Termux.');
          // Closed on purpose: never offer it for restoring later.
          setImmediate(() => { void removeRecord(stateDir, process.pid).finally(() => context.shutdown()); });
          return { ok: true };
        },
        onPrompt(text, images = []) {
          if (images.length && !context.model?.input?.includes('image')) {
            throw Object.assign(new Error('Select a vision-capable model before sending images.'), { status: 422 });
          }
          const queued = !context.isIdle();
          const content = images.length ? [...(text ? [{ type: 'text', text }] : []), ...images] : text;
          // Text/speech with or without images is literal, never a slash command.
          pi.sendUserMessage(content, { deliverAs: 'followUp', expandPromptTemplates: false });
          return { ok: true, queued };
        },
        onAbort() { context.abort(); },
        onAwake: (enabled) => wakeLock.setEnabled(enabled),
        onNewSession(id, sessionId) {
          if (newSessionAction?.id === id) return { ok: true, id };
          if (newSessionAction?.status === 'starting') throw Object.assign(new Error('A new session is already starting.'), { status: 409 });
          const action = { id, sessionId, ticket: randomBytes(16).toString('hex'), status: 'starting' };
          newSessionAction = action;
          setImmediate(() => {
            try {
              // Only this fixed, explicit control action is executable. Dictated
              // messages still use expandPromptTemplates: false above.
              pi.sendUserMessage(`/voice-new-session ${action.ticket}`, { deliverAs: 'followUp', expandPromptTemplates: true });
            } catch (error) { action.status = 'error'; action.error = error.message; }
          });
          return { ok: true, id };
        },
      });
      try {
        await mkdir(join(stateDir, 'endpoints'), { recursive: true, mode: 0o700 });
        await writeFile(endpointFile, JSON.stringify({
          pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
          origin: created.origin, url: created.url, token,
        }), { mode: 0o600 });
        await chmod(endpointFile, 0o600);
      } catch (error) {
        await created.close();
        throw error;
      }
      bridge = created;
      await saveRecord();
      if (ctx.mode === 'tui') ctx.ui.setStatus('pi-voice', `Voice ready · /voice · ${new URL(created.origin).port}`);
      return bridge;
    })();
    try { return await starting; } finally { starting = undefined; }
  }

  async function stop(event) {
    if (starting) { try { await starting; } catch {} }
    const old = bridge;
    bridge = undefined;
    if (old && ['new', 'resume', 'fork', 'reload'].includes(event?.reason)) {
      await writeFile(reconnectFile, JSON.stringify({ port: Number(new URL(old.origin).port) }), { mode: 0o600 })
        .catch((error) => context?.ui.notify(`Pi Voice reconnect: ${error.message}`, 'warning'));
    } else await unlink(reconnectFile).catch(() => {});
    await old?.close();
    await wakeLock.close().catch((error) => context?.ui.notify(`Pi Voice stay-awake cleanup: ${error.message}. Run termux-wake-unlock if needed.`, 'warning'));
    await unlink(endpointFile).catch(() => {});
    if (context?.mode === 'tui') context.ui.setStatus('pi-voice', undefined);
  }

  pi.on('session_start', async (event, ctx) => {
    if (ctx.mode !== 'tui' && !(ctx.mode === 'rpc' && process.env.PI_VOICE_RPC === '1')) return;
    try {
      const reconnect = event.reason === 'startup' ? undefined : await readFile(reconnectFile, 'utf8').then(JSON.parse).catch(() => undefined);
      await unlink(reconnectFile).catch(() => {});
      const port = Number.isInteger(reconnect?.port) && reconnect.port > 0 && reconnect.port < 65536 ? reconnect.port : undefined;
      await start(ctx, port);
    } catch (error) {
      ctx.ui.notify(`Pi Voice: ${error.message}`, 'error');
    }
  });
  pi.on('session_shutdown', stop);
  // Keep the live context current; history is read only when a snapshot is requested.
  // Live activity for the app's Activity sheet. One handler per event: each
  // also keeps the live context current while the bridge runs.
  const track = {
    agent_start: () => activity.start(),
    agent_settled: () => { activity.settle(); if (bridge) void saveRecord(); },
    session_info_changed: () => { if (bridge) void saveRecord(); },
    message_update: (event) => activity.stream(event.assistantMessageEvent),
    tool_execution_start: (event) => activity.toolStart(event),
    tool_execution_update: (event) => activity.toolUpdate(event),
    tool_execution_end: (event) => activity.toolEnd(event),
    ui_prompt_start: (event) => activity.promptStart(event),
    ui_prompt_end: () => activity.promptEnd(),
  };
  for (const event of ['message_end', 'agent_start', 'agent_settled', 'model_select', 'session_tree', 'session_compact', 'session_info_changed', 'message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'ui_prompt_start', 'ui_prompt_end']) {
    pi.on(event, (data, ctx) => {
      try { track[event]?.(data || {}); } catch { /* Activity is informational only. */ }
      if (!bridge || !ctx) return;
      context = ctx;
    });
  }

  // Session replacement is only safe from a command context, not a lifecycle
  // context captured by the HTTP server. The one-use ticket ties this internal
  // command to an authenticated browser action; typing/dictating it is not enough.
  pi.registerCommand('voice-new-session', {
    description: 'Internal Pi Voice new-session control',
    handler: async (args, ctx) => {
      const action = newSessionAction;
      if (!action || action.status !== 'starting' || args.trim() !== action.ticket) return;
      action.ticket = undefined;
      const reject = (message) => { action.status = 'error'; action.error = message; };
      if (action.sessionId !== ctx.sessionManager.getSessionId()) { reject('The Pi session changed. Review it and try again.'); return; }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) { reject('Pi is busy. Finish or stop its task, then try again.'); return; }
      try {
        const result = await ctx.newSession();
        // On success this runtime is invalidated. Do not use ctx or pi again.
        if (result.cancelled) reject('New session was cancelled by Pi. Your conversation is unchanged.');
      } catch (error) { reject(`Could not start a new session: ${error.message}`); }
    },
  });

  pi.registerCommand('voice', {
    description: 'Connect Pi Voice Native to this Pi (/voice stop | awake | sleep)',
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === 'stop') { await stop(); ctx.ui.notify('Pi Voice disconnected from this Pi.', 'info'); return; }
      if (action === 'sleep') {
        try { await wakeLock.setEnabled(false); ctx.ui.notify('Pi Voice stay awake disabled for this session.', 'info'); }
        catch (error) { ctx.ui.notify(error.message, 'error'); }
        return;
      }
      if (action && action !== 'awake') { ctx.ui.notify('Usage: /voice [stop|awake|sleep]', 'warning'); return; }
      try {
        await start(ctx);
        await wakeLock.setEnabled(true).catch((error) => ctx.ui.notify(`Stay awake unavailable: ${error.message}`, 'warning'));
        if (action === 'awake') ctx.ui.notify(wakeLock.status().active ? 'Termux wake lock requested. Android battery restrictions still apply.' : 'Stay awake could not be enabled. Check Android/Termux.', wakeLock.status().active ? 'info' : 'warning');
        else ctx.ui.notify('Pi Voice is connected. Open Pi Voice Native.', 'info');
      } catch (error) {
        ctx.ui.notify(`Pi Voice: ${error.message}`, 'error');
      }
    },
  });

}
