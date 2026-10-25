/* Session lifecycle and session-sheet UI. The host owns durable state. */
(() => {
  'use strict';
  function create({ element: $, api, app, controls, poll, notice, haptic, confirm, currentHandle,
    sessionStarting, modelChanging, folder, replyArrived, resetTarget, clearState, notificationHandled }) {
    const sessionState = { targetHandle: undefined, selectionVersion: 0, sessions: [], sessionsSupported: true,
      notificationTarget: undefined, spawnRequest: undefined, switchPending: false, stopped: [], unread: new Set() };
    let selectionWrite = Promise.resolve();
    let sessionsPolling = false;
    const sessionBusy = new Map();
    async function startNewSession() {
      if (!app().connected || sessionStarting() || modelChanging() || sessionState.spawnRequest || sessionState.switchPending || app().sending || app().listening || app().preparingImages) return;
      if (!sessionState.sessionsSupported) { notice('Restart Pi once to run sessions in parallel. Your conversation and draft are kept.', true); return; }
      // Always keep the current Pi: replacing an idle runtime made its conversation
      // disappear from Sessions, even though it was still saved on disk.
      const proceed = await confirm({ title: 'Start a new session?', message: 'It runs alongside this one, which keeps running; switch back any time from Sessions. Your unsent draft and images stay in the composer.', confirm: 'Start session' });
      // The answer can take a while: check again that nothing else started.
      if (!proceed || !app().connected || sessionStarting() || modelChanging() || sessionState.spawnRequest || sessionState.switchPending || app().sending || app().listening || app().preparingImages) return;
      const request = { id: crypto.randomUUID(), deadline: Date.now() + 45000 };
      sessionState.spawnRequest = request;
      notice('Starting a new session…');
      controls();
      try {
        await api('session/spawn', { method: 'POST', body: { id: request.id } });
        await pollSessions();
      } catch (error) {
        if (sessionState.spawnRequest === request && error.status) {
          sessionState.spawnRequest = undefined;
          notice([404, 501].includes(error.status) ? 'Restart Pi once to run sessions in parallel. Your conversation and draft are kept.' : `${error.message} Your draft is kept.`, true);
        } else if (sessionState.spawnRequest === request) {
          // A lost acknowledgement does not mean the Pi failed to start. Discover
          // its spawn ID; never repeat POST or launch a duplicate automatically.
          notice('Checking whether the new session started…');
          await pollSessions();
        }
      } finally { controls(); }
    }
    function checkSpawn() {
      const request = sessionState.spawnRequest;
      if (!request) return;
      const failed = [...sessionState.sessions, ...sessionState.stopped].find((item) => item.operationId === request.id && ['failed', 'unavailable'].includes(item.status));
      if (failed) { sessionState.spawnRequest = undefined; notice(failed.error || 'Pi did not start. Check its terminal.', true); return; }
      const match = sessionState.sessions.find((item) => item.operationId === request.id && item.status === 'ready');
      if (match) {
        sessionState.spawnRequest = undefined;
        selectTarget(match.handle);
        notice(request.restored ? 'Session restored.' : 'New session ready. The previous one keeps running under Sessions.');
        haptic('confirm');
        void poll();
      } else if (Date.now() >= request.deadline) {
        sessionState.spawnRequest = undefined;
        notice('The new session did not start in time. Check Termux (tmux -L pi-voice-native ls), then try again.', true);
      }
    }
    // Point every later request at another running Pi. Nothing unsent is moved:
    // the draft stays editable and the bridge rejects prompts for a stale session.
    function rememberSelection(handle) {
      selectionWrite = selectionWrite.then(() => api('session/select', { method: 'POST', body: { handle }, handle: null }))
        .catch((error) => { if (sessionState.targetHandle === handle) notice(error.message, true); });
    }
    function finishNotification(opened) {
      const target = sessionState.notificationTarget;
      if (!target) return;
      notificationHandled(target.handle, target.sessionId || '', opened);
      sessionState.notificationTarget = undefined;
    }
    function openNotificationWhenReady() {
      const target = sessionState.notificationTarget;
      // A tap is durable, not a best-effort call to switchTo (which can be busy).
      if (!target || target.started || app().sending || app().preparingImages || sessionState.spawnRequest || sessionStarting()) return;
      target.started = true;
      selectTarget(target.handle, true);
      // Never leave an unrelated reply visible while the notification is loading.
      clearState();
      for (const name of ['sessions', 'activity', 'history', 'settings', 'model', 'confirm']) $(`${name}-dialog`).close();
      notice('Opening the notified conversation…');
      void poll();
    }
    function selectTarget(handle, fromNotification = false) {
      if (!fromNotification && sessionState.notificationTarget?.started) finishNotification(false);
      sessionState.targetHandle = handle || undefined;
      sessionState.selectionVersion++;
      // A notification's conversation identity must be checked before persisting it.
      if (handle && !fromNotification) rememberSelection(handle);
      sessionState.switchPending = true;
      sessionState.unread.delete(handle);
      resetTarget();
    }
    function switchTo(handle) {
      $('sessions-dialog').close();
      // While a switch loads, the session being opened is the one on screen.
      const showing = sessionState.switchPending ? sessionState.targetHandle : currentHandle();
      if ((handle === showing && !sessionState.notificationTarget) || app().sending || app().preparingImages || sessionStarting()) return;
      haptic('tap');
      finishNotification(false);
      selectTarget(handle);
      notice('');
      controls();
      void poll();
    }
    async function restoreSession(item) {
      if ((!app().connected && !sessionState.notificationTarget) || sessionState.spawnRequest || app().sending || app().listening) return;
      finishNotification(false);
      const request = { id: crypto.randomUUID(), deadline: Date.now() + 45000, restored: true };
      sessionState.spawnRequest = request;
      $('sessions-dialog').close();
      notice('Restoring the session…');
      controls();
      try {
        const result = await api('session/restore', { method: 'POST', body: { id: request.id, handle: item.handle }, handle: null });
        // A launch already in flight for this conversation is joined, not repeated.
        if (typeof result?.id === 'string') request.id = result.id;
        sessionState.stopped = sessionState.stopped.filter((other) => other.handle !== item.handle);
        await pollSessions();
      } catch (error) {
        if (sessionState.spawnRequest === request && error.status) { sessionState.spawnRequest = undefined; notice(error.message, true); }
        else if (sessionState.spawnRequest === request) {
          // A lost acknowledgement may still have started Pi: look, never re-post.
          notice('Checking whether the session was restored…');
          await pollSessions();
        }
      } finally { controls(); }
    }
    async function forgetSession(item) {
      try {
        await api('session/forget', { method: 'POST', body: { handle: item.handle }, handle: null });
        sessionState.stopped = sessionState.stopped.filter((other) => other.handle !== item.handle);
        renderSessions();
      } catch (error) { notice(error.message, true); }
      finally { controls(); }
    }
    function ago(time) {
      const minutes = Math.round((Date.now() - time) / 60000);
      if (!(minutes >= 1)) return 'just now';
      if (minutes < 60) return `${minutes} min ago`;
      const hours = Math.round(minutes / 60);
      return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
    }
    function stoppedRow(item) {
      const row = document.createElement('div');
      row.className = 'session-item stopped';
      row.setAttribute('role', 'listitem');
      const info = document.createElement('div');
      info.className = 'session-row';
      const dot = document.createElement('span');
      dot.className = 'status-dot';
      const text = document.createElement('span');
      text.className = 'session-text';
      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = item.title || 'Pi session';
      const sub = document.createElement('span');
      sub.className = 'session-sub';
      sub.textContent = [item.restoring ? 'Restoring…' : 'Stopped', ago(item.updated), folder(item.cwd)].filter(Boolean).join(' · ');
      text.append(title, sub);
      info.append(dot, text);
      const restore = document.createElement('button');
      restore.className = 'icon-button';
      restore.setAttribute('aria-label', `Restore ${title.textContent}`);
      restore.title = 'Restore';
      restore.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/></svg>';
      restore.disabled = Boolean(sessionState.spawnRequest || item.restoring || !item.restorable);
      restore.addEventListener('click', () => { void restoreSession(item); });
      const forget = document.createElement('button');
      forget.className = 'icon-button';
      forget.setAttribute('aria-label', `Dismiss ${title.textContent}`);
      forget.title = 'Dismiss (stays saved in Pi)';
      forget.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      forget.addEventListener('click', () => { void forgetSession(item); });
      row.append(info, restore, forget);
      return row;
    }
    async function closeSession(item) {
      const working = item.busy || item.pending ? 'Pi is still working there; its task will stop. ' : '';
      if (!await confirm({ title: `Close “${item.title || 'this session'}”?`, message: `${working}The conversation stays saved in Pi.`, confirm: 'Close session', danger: true })) return;
      try {
        await api('session/close', { method: 'POST', body: { sessionId: item.sessionId, instanceId: item.instanceId }, handle: item.handle });
        await pollSessions();
        if (item.handle === currentHandle()) selectTarget(undefined);
        sessionState.unread.delete(item.handle);
        renderSessions();
        notice('Closing session… Its conversation stays saved in Pi.');
        void poll();
      } catch (error) { notice(error.message, true); }
      finally { controls(); }
    }
    function renderSessions() {
      const list = sessionState.sessions;
      $('session-list').replaceChildren(...list.map((item) => {
        const current = item.handle === currentHandle();
        const row = document.createElement('div');
        row.className = `session-item${current ? ' current' : ''}`;
        row.setAttribute('role', 'listitem');
        const open = document.createElement('button');
        open.className = 'session-row';
        const dot = document.createElement('span');
        dot.className = `status-dot ${item.busy || item.pending ? 'working' : 'ready'}`;
        const text = document.createElement('span');
        text.className = 'session-text';
        const title = document.createElement('span');
        title.className = 'session-title';
        title.textContent = item.title || item.sessionName || 'Pi session';
        const sub = document.createElement('span');
        sub.className = `session-sub${sessionState.unread.has(item.handle) ? ' fresh' : ''}`;
        const statusLabel = { starting: 'Starting…', closing: 'Closing…', 'close-error': 'Could not close', unavailable: 'Unavailable', incompatible: 'Restart Pi to update' };
        sub.textContent = [current ? 'Viewing' : '', item.status !== 'ready' ? statusLabel[item.status] || item.status : item.busy || item.pending ? 'Working' : sessionState.unread.has(item.handle) ? 'New reply' : 'Ready', folder(item.cwd)].filter(Boolean).join(' · ');
        text.append(title, sub);
        open.append(dot, text);
        open.setAttribute('aria-current', String(current));
        open.disabled = item.status !== 'ready';
        open.addEventListener('click', () => switchTo(item.handle));
        row.append(open);
        if (item.error) { const problem = document.createElement('span'); problem.className = 'session-sub'; problem.textContent = item.error; row.append(problem); }
        if (item.capabilities?.close) {
          const close = document.createElement('button');
          close.className = 'icon-button';
          close.setAttribute('aria-label', `Close ${title.textContent}`);
          close.title = 'Close session';
          close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
          close.addEventListener('click', () => { void closeSession(item); });
          row.append(close);
        }
        return row;
      }));
      $('stopped-section').hidden = !sessionState.stopped.length;
      $('stopped-list').replaceChildren(...sessionState.stopped.map(stoppedRow));
      $('sessions-hint').textContent = !sessionState.sessionsSupported
        ? 'Restart Pi once to run and switch between parallel sessions.'
        : sessionState.sessions.length
          ? 'New sessions always run alongside this one, even while Pi is working. Switch back any time. Up to 4 sessions can run at once.'
          : `No session is running. Start a new one${sessionState.stopped.length ? ' or restore one stopped earlier' : ''} to talk to Pi.`;
    }
    async function pollSessions() {
      // The host's session/restore UI must work even when the notified worker is gone.
      if (sessionsPolling || !sessionState.sessionsSupported) return;
      sessionsPolling = true;
      try {
        const result = await api('sessions', { handle: null });
        const list = Array.isArray(result.sessions) ? result.sessions : [];
        for (const item of list) {
          const working = Boolean(item.status !== 'ready' || item.busy || item.pending);
          // A background session that finishes gets a "new reply" marker.
          if (item.handle !== currentHandle() && sessionBusy.get(item.handle) && !working) { sessionState.unread.add(item.handle); replyArrived(); }
          sessionBusy.set(item.handle, working);
        }
        for (const handle of [...sessionBusy.keys()]) if (!list.some((item) => item.handle === handle)) { sessionState.unread.delete(handle); sessionBusy.delete(handle); }
        sessionState.sessions = list;
        // A list is only a snapshot, never authority to change the displayed Pi.
        // The explicit state request handles a worker that really became unavailable.
        sessionState.stopped = Array.isArray(result.stopped) ? result.stopped : [];
        checkSpawn();
      } catch (error) {
        if ([404, 501].includes(error.status)) sessionState.sessionsSupported = false;
      } finally {
        sessionsPolling = false;
        if ($('sessions-dialog').open) renderSessions();
        controls();
      }
    }

    return { state: sessionState, startNewSession, checkSpawn, rememberSelection, finishNotification,
      openNotificationWhenReady, selectTarget, switchTo, restoreSession, forgetSession, closeSession, renderSessions, pollSessions };
  }
  globalThis.PiVoiceSessions = Object.freeze({ create });
})();
