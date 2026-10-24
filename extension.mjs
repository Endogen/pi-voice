import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createVoiceBridge } from './bridge.mjs';
import { createWakeLock } from './wake-lock.mjs';
import { imageLimits } from './image-attachments.mjs';

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

export function openBrowser(url) {
  return new Promise((resolve, reject) => {
    const command = `${process.env.PREFIX || '/data/data/com.termux/files/usr'}/bin/termux-open-url`;
    // Prefer Chrome: other Android browsers frequently lack speech recognition.
    execFile(command, [url, 'com.android.chrome'], { timeout: 10000 }, (error) => {
      if (!error) return resolve();
      execFile(command, [url], { timeout: 10000 }, (fallbackError) => fallbackError ? reject(fallbackError) : resolve());
    });
  });
}

function textOf(message) {
  if (typeof message.content === 'string') return message.content;
  return (message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

export default function installVoiceExtension(pi, { wakeLock = createWakeLock({ directory: join(stateDir, 'wake-lock') }) } = {}) {
  let bridge;
  let context;
  let starting;
  let newSessionAction;
  let messages = [];
  const endpointFile = join(stateDir, 'endpoints', `${process.pid}.json`);
  // Runtime replacement reloads this module. Carry only the preferred port,
  // never a stale Pi context, across /new, /resume and /reload.
  const reconnectFile = join(stateDir, `reconnect-${process.pid}.json`);

  pi.registerFlag('voice-open', { description: 'Open the Pi Voice mobile app at startup', type: 'boolean', default: false });

  const snapshot = () => {
    // Pi persists a message AFTER emitting message_end. Read at request time so
    // the most recent user/reply is not missing during a long-running tool call.
    refreshMessages();
    return {
      pid: process.pid,
      sessionId: context.sessionManager.getSessionId(),
      sessionName: context.sessionManager.getSessionName() || 'Pi session',
      sessionPersistent: Boolean(context.sessionManager.getSessionFile()),
      cwd: context.cwd,
      model: context.model ? `${context.model.provider}/${context.model.id}` : 'No model selected',
      imageAttachments: imageLimits,
      modelSupportsImages: Boolean(context.model?.input?.includes('image')),
      busy: !context.isIdle(),
      pending: context.hasPendingMessages(),
      wakeLock: wakeLock.status(),
      newSessionAction: newSessionAction ? { id: newSessionAction.id, status: newSessionAction.status, error: newSessionAction.error } : undefined,
      messages,
    };
  };

  const refreshMessages = () => {
    messages = context.sessionManager.getBranch()
      .filter((entry) => entry.type === 'message' && ['user', 'assistant'].includes(entry.message.role))
      .slice(-40)
      .map((entry) => {
        const imageCount = Array.isArray(entry.message.content) ? entry.message.content.filter((part) => part.type === 'image').length : 0;
        // Never return base64 in the frequently polled state/history response.
        return { id: entry.id, role: entry.message.role, text: textOf(entry.message).slice(-24000), ...(imageCount ? { imageCount } : {}) };
      })
      .filter((message) => message.text || message.imageCount);
  };

  async function start(ctx, port) {
    context = ctx;
    if (bridge) return bridge;
    if (starting) return starting;
    starting = (async () => {
      refreshMessages();
      const token = await loadToken();
      const created = await createVoiceBridge({
        token, port,
        getState: snapshot,
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
      const live = await start(ctx, port);
      if (event.reason === 'startup' && pi.getFlag('voice-open')) {
        await wakeLock.setEnabled(true).catch((error) => ctx.ui.notify(`Stay awake unavailable: ${error.message}`, 'warning'));
        await openBrowser(live.url);
      }
    } catch (error) {
      ctx.ui.notify(`Pi Voice: ${error.message}`, 'error');
    }
  });
  pi.on('session_shutdown', stop);
  pi.on('message_end', (_event, ctx) => {
    if (!bridge) return;
    context = ctx;
    refreshMessages();
  });
  // These notifications also refresh model/status and branch changes without polling the session file.
  for (const event of ['agent_start', 'agent_settled', 'model_select', 'session_tree', 'session_compact', 'session_info_changed']) {
    pi.on(event, (_event, ctx) => {
      if (!bridge) return;
      context = ctx;
      refreshMessages();
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
    description: 'Open the voice app (/voice url | awake | sleep | stop)',
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === 'stop') { await stop(); ctx.ui.notify('Pi Voice stopped.', 'info'); return; }
      if (action === 'sleep') {
        try { await wakeLock.setEnabled(false); ctx.ui.notify('Pi Voice stay awake disabled for this session.', 'info'); }
        catch (error) { ctx.ui.notify(error.message, 'error'); }
        return;
      }
      if (action && !['url', 'awake'].includes(action)) { ctx.ui.notify('Usage: /voice [url|awake|sleep|stop]', 'warning'); return; }
      try {
        const live = await start(ctx);
        await wakeLock.setEnabled(true).catch((error) => ctx.ui.notify(`Stay awake unavailable: ${error.message}`, 'warning'));
        if (action === 'awake') { ctx.ui.notify(wakeLock.status().active ? 'Termux wake lock requested. Android battery restrictions still apply.' : 'Stay awake could not be enabled. Check Android/Termux.', wakeLock.status().active ? 'info' : 'warning'); }
        else if (action === 'url') ctx.ui.notify(live.url, 'info');
        else {
          await openBrowser(live.url);
          ctx.ui.notify('Pi Voice opened. You can add it to your home screen from Chrome.', 'info');
        }
      } catch (error) {
        ctx.ui.notify(`Pi Voice: ${error.message}. Try /voice url and open the link manually.`, 'error');
      }
    },
  });
}
