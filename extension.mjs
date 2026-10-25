import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, chmod, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { createVoiceBridge } from './bridge.mjs';
import { createWakeLock, processIdentity } from './wake-lock.mjs';
import { imageLimits } from './image-attachments.mjs';
import { createActivity } from './activity.mjs';
import { sendReplyAlert } from './notify.mjs';
import { writeRecord } from './running.mjs';
import { stateDir, loadToken, protocolVersion, validId } from './config.mjs';
import { atomicJSON } from './storage.mjs';
import { createModelSelection, modelReference } from './models.mjs';
import { fail } from './transport.mjs';
import { createWakeSettings } from './wake-settings.mjs';
export { stateDir } from './config.mjs';

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
  return new Promise((resolve) => execFile(tmuxBinary(), ['-S', socket, 'display-message', '-p', ...(env.TMUX_PANE ? ['-t', env.TMUX_PANE] : []), '#S'], { timeout: 5000 }, (error, stdout) => {
    const session = String(stdout || '').trim();
    resolve(!error && /^pi-voice(-[a-f0-9]{8})?$/.test(session) ? { session } : {});
  }));
}

// Missing metadata can be a transient tmux failure, not an unmanaged Pi.
// State/summary/activity polls share one non-blocking probe. Retry failures
// after a cooldown; no background timers or repeated commands once identified.
export function createTerminal({ detect = detectTerminal, now = Date.now } = {}) {
  let terminal = {};
  let pending;
  let retryAt = 0;
  return () => {
    if (!terminal.session && !pending && now() >= retryAt) {
      pending = Promise.resolve().then(detect)
        .then((found) => { terminal = found; }, () => {})
        .finally(() => { retryAt = now() + 5000; pending = undefined; });
    }
    return terminal;
  };
}

const managedId = validId(process.env.PI_VOICE_MANAGED_ID) ? process.env.PI_VOICE_MANAGED_ID : undefined;

function textOf(message) {
  if (typeof message.content === 'string') return message.content;
  return (message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

export default function installVoiceExtension(pi, { wakeLock = createWakeLock({ directory: join(stateDir, 'wake-lock') }), wakeSettings = createWakeSettings(stateDir), getTerminal = createTerminal(), alert = sendReplyAlert } = {}) {
  let bridge;
  let instanceId = validId(process.env.PI_VOICE_INSTANCE_ID) ? process.env.PI_VOICE_INSTANCE_ID : randomUUID();
  let handle = managedId || `external-${process.pid}-${instanceId}`;
  let retries = [];
  let versions = {};
  const activity = createActivity();
  let bridgeToken;
  let answerBefore;
  let closing = false;
  let awakeRequested = false;
  const identity = processIdentity(process.pid);
  void detectVersions().then((found) => { versions = found; }, () => {});
  let context;
  let starting;
  let newSessionAction;
  const models = createModelSelection({ pi, getContext: () => context, blocked: () => closing || newSessionAction?.status === 'starting' });
  const endpointFile = join(stateDir, 'endpoints', `${process.pid}.json`);
  // Runtime replacement carries transport identity and accepted request hashes,
  // never a stale Pi context, across /new, /resume and /reload.
  const reconnectFile = join(stateDir, `reconnect-${process.pid}.json`);

  const snapshot = () => {
    // Pi persists a message AFTER emitting message_end. Read at request time so
    // the most recent user/reply is not missing during a long-running tool call.
    return {
      pid: process.pid, handle, instanceId, protocolVersion, role: 'worker', managed: Boolean(managedId),
      sessionId: context.sessionManager.getSessionId(),
      sessionName: context.sessionManager.getSessionName() || 'Pi session',
      title: context.sessionManager.getSessionName() || firstQuestion() || 'New session',
      voiceVersion: versions.voice,
      piVersion: versions.pi,
      terminal: getTerminal(),
      activity: activity.current(),
      sessionPersistent: Boolean(context.sessionManager.getSessionFile()),
      cwd: context.cwd,
      model: context.model ? `${context.model.provider}/${context.model.id}` : 'No model selected',
      modelSelection: modelReference(context.model),
      modelSwitchingSupported: models.supported(),
      modelSwitching: models.switching,
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

  const record = () => ({
    pid: process.pid, handle, instanceId, protocolVersion, managed: Boolean(managedId), sessionId: context.sessionManager.getSessionId(), sessionFile: context.sessionManager.getSessionFile(),
    cwd: context.cwd, title: context.sessionManager.getSessionName() || firstQuestion() || 'New session',
  });
  // A session being closed from the app must not write its record back.
  const saveRecord = async () => {
    if (closing) return;
    try { await writeRecord(stateDir, { ...record(), identity: await identity }); } catch {}
  };

  const readMessages = () => context.sessionManager.getBranch()
    .filter((entry) => entry.type === 'message' && ['user', 'assistant'].includes(entry.message.role))
    .slice(-40)
    .map((entry) => {
      const imageCount = Array.isArray(entry.message.content) ? entry.message.content.filter((part) => part.type === 'image').length : 0;
      // Never return base64 in the frequently polled state/history response.
      const stopReason = entry.message.role === 'assistant' && ['error', 'aborted'].includes(entry.message.stopReason) ? entry.message.stopReason : undefined;
      const error = stopReason === 'error' ? String(entry.message.errorMessage || 'The model request failed.').slice(0, 1000) : undefined;
      return { id: entry.id, role: entry.message.role, text: textOf(entry.message).slice(-24000), ...(imageCount ? { imageCount } : {}),
        ...(stopReason ? { stopReason, ...(error ? { error } : {}) } : {}) };
    })
    .filter((message) => message.text || message.imageCount || message.stopReason);

  async function start(ctx, port) {
    context = ctx;
    if (bridge) return bridge;
    if (starting) return starting;
    starting = (async () => {
      const token = await loadToken();
      bridgeToken = token;
      const created = await createVoiceBridge({
        token, port, instanceId, retries,
        getState: snapshot,
        getActivity: () => ({ ...activity.snapshot(), terminal: getTerminal() }),
        getModels: () => models.list(),
        onModel: (selection) => models.select(selection),
        onClose() {
          // Only app-started sessions: never quit a Pi the user runs in a terminal.
          if (!managedId) throw fail(409, 'Only sessions started from the app can be closed here. Quit this one in Termux.');
          // Closed on purpose: stop its task (Pi only quits once idle) and
          // never offer it for restoring later.
          closing = true;
          setImmediate(() => {
            try { if (!context.isIdle()) context.abort(); } catch {}
            context.shutdown();
          });
          return { ok: true };
        },
        onPrompt(text, images = []) {
          if (images.length && !context.model?.input?.includes('image')) {
            throw fail(422, 'Select a vision-capable model before sending images.');
          }
          const queued = !context.isIdle();
          const content = images.length ? [...(text ? [{ type: 'text', text }] : []), ...images] : text;
          // Text/speech with or without images is literal, never a slash command.
          pi.sendUserMessage(content, { deliverAs: 'followUp', expandPromptTemplates: false });
          return { ok: true, queued };
        },
        onAbort() { context.abort(); },
        async onAwake(enabled) {
          await wakeSettings.save(enabled);
          awakeRequested = enabled;
          return wakeLock.setEnabled(enabled, { refresh: true });
        },
        onNewSession(id, sessionId) {
          if (newSessionAction?.id === id) return { ok: true, id };
          if (newSessionAction?.status === 'starting') throw fail(409, 'A new session is already starting.');
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
        await atomicJSON(endpointFile, {
          pid: process.pid, handle, instanceId, protocolVersion, managed: Boolean(managedId), sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
          origin: created.origin, token, role: 'worker',
        });
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
    retries = old?.retryState() || retries;
    bridge = undefined;
    if (old && ['new', 'resume', 'fork', 'reload'].includes(event?.reason)) {
      // The replacement runtime keeps the port and the stay-awake state.
      await atomicJSON(reconnectFile, { port: Number(new URL(old.origin).port), awake: awakeRequested, instanceId, retries: old.retryState() })
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
      if (validId(reconnect?.instanceId)) { instanceId = reconnect.instanceId; handle = managedId || `external-${process.pid}-${instanceId}`; }
      retries = Array.isArray(reconnect?.retries) ? reconnect.retries : [];
      const port = Number.isInteger(reconnect?.port) && reconnect.port > 0 && reconnect.port < 65536 ? reconnect.port : undefined;
      await start(ctx, port);
      try {
        awakeRequested = typeof reconnect?.awake === 'boolean' ? reconnect.awake : await wakeSettings.load();
        if (awakeRequested) await wakeLock.setEnabled(true);
      } catch (error) { ctx.ui.notify(`Pi Voice stay awake: ${error.message}`, 'warning'); }
    } catch (error) {
      ctx.ui.notify(`Pi Voice: ${error.message}`, 'error');
    }
  });
  pi.on('session_shutdown', stop);
  // Keep the live context current; history is read only when a snapshot is requested.
  // Live activity for the app's Activity sheet. One handler per event: each
  // also keeps the live context current while the bridge runs.
  const latestAnswer = (ctx) => {
    const branch = ctx?.sessionManager?.getBranch?.() || [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === 'message' && entry.message.role === 'assistant' && ['error', 'aborted'].includes(entry.message.stopReason)) return;
      if (entry.type === 'message' && entry.message.role === 'assistant' && textOf(entry.message).trim()) return entry;
    }
  };
  // Tell the app when a run ends with a new reply; it notifies only if closed.
  const replyFinished = (ctx) => {
    const answer = latestAnswer(ctx);
    if (!bridge || !answer || answer.id === answerBefore) return;
    answerBefore = answer.id;
    try {
      alert({ token: bridgeToken, pid: process.pid, handle, sessionId: ctx.sessionManager.getSessionId(), text: textOf(answer.message),
        title: ctx.sessionManager.getSessionName() || firstQuestion() || 'Pi replied' });
    } catch { /* Alerts are best effort. */ }
  };
  const track = {
    agent_start: async (_event, ctx) => {
      activity.start(); answerBefore = latestAnswer(ctx)?.id;
      // Reassert the shared Termux lock before work, even if a prior command
      // failed or another Termux client released the Android lock meanwhile.
      if (bridge && awakeRequested) {
        await wakeLock.setEnabled(true, { refresh: true })
          .catch((error) => ctx.ui.notify(`Pi Voice stay awake: ${error.message}`, 'warning'));
      }
    },
    agent_settled: (_event, ctx) => { activity.settle(); if (bridge) { replyFinished(ctx); return saveRecord(); } },
    session_info_changed: () => { if (bridge) return saveRecord(); },
    message_update: (event) => activity.stream(event.assistantMessageEvent),
    tool_execution_start: (event) => activity.toolStart(event),
    tool_execution_update: (event) => activity.toolUpdate(event),
    tool_execution_end: (event) => activity.toolEnd(event),
    ui_prompt_start: (event) => activity.promptStart(event),
    ui_prompt_end: () => activity.promptEnd(),
  };
  for (const event of ['message_end', 'agent_start', 'agent_settled', 'model_select', 'session_tree', 'session_compact', 'session_info_changed', 'message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'ui_prompt_start', 'ui_prompt_end']) {
    pi.on(event, async (data, ctx) => {
      if (bridge && ctx) context = ctx;
      try { await track[event]?.(data || {}, ctx); } catch { /* Activity is informational only. */ }
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
    description: 'Connect the Pi Voice app to this Pi (/voice stop | awake | sleep)',
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === 'stop') { await stop(); ctx.ui.notify('Pi Voice disconnected from this Pi.', 'info'); return; }
      if (action === 'sleep') {
        awakeRequested = false;
        try { await wakeLock.setEnabled(false); ctx.ui.notify('Pi Voice stay awake disabled for this session.', 'info'); }
        catch (error) { ctx.ui.notify(error.message, 'error'); }
        return;
      }
      if (action && action !== 'awake') { ctx.ui.notify('Usage: /voice [stop|awake|sleep]', 'warning'); return; }
      try {
        await start(ctx);
        awakeRequested = true;
        await wakeLock.setEnabled(true, { refresh: true }).catch((error) => ctx.ui.notify(`Stay awake unavailable: ${error.message}`, 'warning'));
        if (action === 'awake') ctx.ui.notify(wakeLock.status().active ? 'Termux wake lock requested. Android battery restrictions still apply.' : 'Stay awake could not be enabled. Check Android/Termux.', wakeLock.status().active ? 'info' : 'warning');
        else ctx.ui.notify('Pi Voice is connected. Open the Pi Voice app.', 'info');
      } catch (error) {
        ctx.ui.notify(`Pi Voice: ${error.message}`, 'error');
      }
    },
  });

}
