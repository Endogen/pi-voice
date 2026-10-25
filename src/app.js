'use strict';
const $ = (id) => document.getElementById(id);
function setText(id, text) { const node = $(id); if (node.textContent !== text) node.textContent = text; }
const storage = {
  get(key) { try { return localStorage.getItem(`pi-voice-${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`pi-voice-${key}`, value); window.PiVoiceAndroid?.setUiPreference?.(key, value); } catch {} },
};
const token = location.hash.slice(1) || storage.get('token') || '';
if (location.hash) {
  storage.set('token', token);
  history.replaceState(null, '', location.pathname);
}
let state;
let connected = false;
let sending = false;
let listening = false;
let recognition;
let listenRequest;
let cancelSpeech = false;
let pendingMessage;
let polling = false;
let lastMessages = '';
let lastFocus = '';
let optimisticQuestion;
let wakeInitialized = false;
let wakeSyncing = false;
let attachments = [];
let preparingImages = false;
let attachmentButtons = [];
let readingSourceKey;
// The independent host owns the connection; every conversation has an explicit handle.
let targetHandle;
let selectionVersion = 0;
let selectionWrite = Promise.resolve();
let sessions = [];
let sessionsSupported = true;
let sessionsPolling = false;
let notificationTarget;
let spawnRequest;
let switchPending = false;
let pollCount = 0;
let noticeTimer;
let stopped = [];
let replyBaseline = null;
let reconnectOnFailure = false;
let offline = false;
let activityData;
let activitySupported = true;
let activityPolling = false;
const expandedSteps = new Set();
const sessionBusy = new Map();
const unread = new Set();
// The native shell pads its WebView by the system bars; never pad twice.
document.documentElement?.classList.toggle('native', Boolean(window.PiVoiceAndroid));
const playback = globalThis.PiVoicePlayback.create({
  onState: () => readingControls(),
  onError: (code) => {
    const hints = {
      upgrade: 'Update the Pi Voice app to read replies aloud.',
      unsupported: 'Read aloud is unavailable here. Update the Pi Voice app.',
      language: 'No voice for this language. Check Read-aloud language in Settings and install a matching Android voice.',
      'text-limit': 'This reply is too long to read aloud (maximum 32000 characters).',
      'audio-busy': 'Audio is busy. Stop other playback and try Read aloud again.',
      interrupted: 'Read aloud stopped.',
    };
    notice(hints[code] || 'Could not read the reply. Check your text-to-speech engine/installed voices and try again.', true);
  },
});
const imageLimits = globalThis.PiVoiceImageLimits;
const sessionStarting = () => state?.newSessionAction?.status === 'starting';
const SpeechRecognition = globalThis.PiVoiceNativeRecognition || window.SpeechRecognition || window.webkitSpeechRecognition;
$('language').value = storage.get('language') || navigator.language || 'en-US';
$('engine').value = storage.get('engine') || (SpeechRecognition ? 'browser' : 'termux');
$('awake').checked = storage.get('awake') !== 'false';
$('read-language').value = storage.get('read-language') || navigator.language || 'en-US';
for (const id of ['notify', 'sound', 'haptics']) $(id).checked = storage.get(id) !== 'false';
// Light feedback through Android's haptics (no permission; follows the system
// touch-vibration setting). Older apps fall back to the Vibration API.
function haptic(kind) {
  if (!$('haptics').checked) return;
  const bridge = window.PiVoiceAndroid;
  if (typeof bridge?.haptic === 'function') bridge.haptic(kind);
  else navigator.vibrate?.(kind === 'reject' ? [30, 60, 30] : kind === 'confirm' ? 25 : 10);
}
// A two-note chime, synthesized: no audio file, nothing fetched. Android only
// lets audio start after a tap, so the context is created on the first one.
let audio;
function unlockAudio() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!audio && Context) { try { audio = new Context(); } catch {} }
  if (audio?.state === 'suspended') void audio.resume().catch(() => {});
}
function chime() {
  if (!audio || audio.state !== 'running') return;
  const start = audio.currentTime + 0.02;
  for (const [index, frequency] of [659.25, 987.77].entries()) {
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    const at = start + index * 0.13;
    tone.type = 'sine';
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    tone.connect(gain).connect(audio.destination);
    tone.start(at);
    tone.stop(at + 0.4);
  }
}
// A reply finished while the app is open. In the background, the app's
// notification takes over (the page is paused there).
function replyArrived() {
  if (document.hidden) return;
  if ($('sound').checked) chime();
  haptic('confirm');
}
const alertsCapable = () => typeof window.PiVoiceAndroid?.setReplyAlerts === 'function';
function alertHint() {
  const bridge = window.PiVoiceAndroid;
  let text = 'Shows a notification when a reply finishes while Pi Voice is in the background. Tap it to open that session.';
  if (!alertsCapable()) text = bridge ? 'Update the Pi Voice app to get reply notifications.' : 'Reply notifications need the Pi Voice app.';
  else if ($('notify').checked && bridge.replyAlertStatus?.() === 'off') text = 'Notifications are blocked. Allow them for Pi Voice in Android’s app settings.';
  setText('notify-status', text);
  $('notify-status').classList.toggle('error', text.startsWith('Notifications are blocked'));
}
// Keep the native receiver's preferences in step with Settings. Android 13+
// asks for permission the first time, or when the user turns notifications on.
function syncAlerts(ask = false) {
  if (alertsCapable()) {
    const first = storage.get('notify-asked') !== 'true';
    window.PiVoiceAndroid.setReplyAlerts($('notify').checked, $('sound').checked, Boolean(ask || first) && $('notify').checked);
    storage.set('notify-asked', 'true');
  }
  alertHint();
}
window.__piVoiceAlerts = alertHint;
// Native preferences survive the one-time move from a worker origin to the
// independent host. The allowlist excludes tokens and session selection.
window.__piVoiceRestorePreferences = (values) => {
  const booleans = ['awake', 'notify', 'sound', 'haptics'];
  const strings = ['language', 'engine', 'read-language'];
  for (const key of [...booleans, ...strings, 'notify-asked', 'terminal-warned']) {
    const value = values?.[key];
    if (typeof value !== 'string' || value.length > 128) continue;
    try { localStorage.setItem(`pi-voice-${key}`, value); } catch {}
    if (booleans.includes(key)) $(key).checked = value === 'true';
    if (strings.includes(key)) $(key).value = value;
  }
  syncAlerts(); controls();
};

$('read-language').disabled = !playback.supported;
setText('read-support', playback.supported ? 'Tap the speaker beside Pi’s completed reply to listen. Replies never play automatically.' : playback.needsUpgrade ? 'Update the Pi Voice app to enable Read aloud.' : 'Read aloud needs the Pi Voice app.');
function speechHint() {
  return attachments.length ? 'Review images, then send' : 'Review, then send';
}

function notice(text, error = false) {
  clearTimeout(noticeTimer);
  setText('notice', text);
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !text;
  // Confirmations fade out; errors stay until the next action replaces them.
  if (text && !error) noticeTimer = setTimeout(() => { if ($('notice').textContent === text) notice(''); }, 6000);
}
const sessionReady = () => connected && !switchPending && Boolean(state?.handle) && !state?.empty;
const busyHere = () => Boolean(state?.busy || state?.pending || optimisticQuestion);
const currentHandle = () => state?.handle;
const modelPicker = globalThis.PiVoiceModelPicker.create({
  element: $, createElement: (tag) => document.createElement(tag), request: api,
  target: () => ({ key: JSON.stringify([selectionVersion, targetHandle, state?.instanceId, state?.sessionId]), handle: state?.handle, sessionId: state?.sessionId }),
  state: () => state,
  blockedReason: () => !sessionReady() ? 'Connect a ready Pi session before changing models.'
    : state.modelSwitching ? 'A model change is in progress. Wait for Pi to confirm it.'
      : sessionStarting() || spawnRequest ? 'Wait for the new session to be ready.'
        : busyHere() || sending ? 'Finish or stop the current task before changing models.'
          : listening || preparingImages ? 'Finish recording or preparing images before changing models.' : '',
  changed: controls, refresh: poll, notify: notice, confirm: (text) => confirm(text), hasImages: () => attachments.length > 0,
});
const modelChanging = () => Boolean(state?.modelSwitching || modelPicker.busy);
const folder = (path) => String(path || '').split('/').filter(Boolean).at(-1) || path || '';
function header() {
  const working = connected && (busyHere() || sending || modelChanging());
  const dot = $('status-dot');
  dot.classList.toggle('ready', connected && !working);
  dot.classList.toggle('working', working);
  dot.classList.toggle('offline', !connected);
  setText('session-title', state?.title || (state?.sessionName && state.sessionName !== 'Pi session' ? state.sessionName : 'Pi Voice'));
  if (connected) setText('connection', [state?.empty ? 'Connected · No active conversation' : working ? 'Working' : 'Ready', folder(state?.cwd)].filter(Boolean).join(' · '));
  const others = sessions.filter((item) => item.handle !== currentHandle());
  const fresh = others.some((item) => unread.has(item.handle));
  $('sessions-badge').hidden = !others.length;
  setText('sessions-badge', String(sessions.length));
  $('sessions-badge').classList.toggle('unread', fresh);
  $('open-sessions').setAttribute('aria-label', `Switch session (${sessions.length || 1} running${fresh ? ', new reply' : ''})`);
}
// The Pi Voice app (0.1.4+) can restart Pi from the page, resuming the session.
const canReconnect = () => typeof window.PiVoiceAndroid?.reconnect === 'function';
function reconnect() {
  if (!canReconnect()) return;
  cancelRecording();
  playback.stop();
  notice('Starting Pi and resuming your conversation…');
  window.PiVoiceAndroid.reconnect();
}
function versions() {
  const page = globalThis.PiVoiceVersion || 'Unknown';
  setText('voice-version', page);
  // Versions describe the connected Pi; backends before 1.8.0 report none.
  setText('pi-version', state?.piVersion || (!state ? '—' : state.voiceVersion ? 'Unknown' : 'Restart Pi to show'));
  const backend = state?.voiceVersion;
  $('version-hint').hidden = !state || backend === page;
  if (state && backend !== page) setText('version-hint', `This Pi still runs ${backend ? `the Pi Voice ${backend}` : 'an older Pi Voice'} backend. Restart Pi after its current task to finish updating.`);
}
function controls() {
  openNotificationWhenReady();
  modelPicker.sync();
  const starting = sessionStarting() || Boolean(spawnRequest) || switchPending;
  const switching = starting || modelChanging();
  $('new-session').disabled = !connected || switching || sending || listening || preparingImages;
  $('sessions-new').disabled = $('new-session').disabled;
  $('new-session').classList.toggle('busy', starting);
  setText('new-session-label', starting ? 'Starting…' : 'New');
  const hasDraft = Boolean($('draft').value.trim() || attachments.length);
  $('prompt-box').classList.toggle('has-draft', hasDraft);
  $('prompt-box').classList.toggle('listening', listening);
  $('clear').hidden = !hasDraft || listening;
  $('listening').classList.toggle('subtle', !listening && !attachments.length);
  $('listening').classList.toggle('live', listening);
  header();
  versions();
  $('reconnect').hidden = !offline || !canReconnect();
  $('restore-banner').hidden = (!connected && !notificationTarget) || !stopped.length;
  setText('restore-label', `${stopped.length} earlier session${stopped.length === 1 ? '' : 's'} stopped · Restore`);
  $('send').disabled = switching || !sessionReady() || sending || listening || preparingImages || (attachments.length > 0 && state?.modelSupportsImages === false) || (!$('draft').value.trim() && !attachments.length);
  $('attach').disabled = switching || !sessionReady() || sending || listening || preparingImages;
  $('image-input').disabled = $('attach').disabled;
  for (const button of attachmentButtons) button.disabled = switching || sending || listening || preparingImages;
  $('microphone').disabled = switching || sending || preparingImages || (!sessionReady() && !listening);
  $('clear').disabled = switching || sending || listening || preparingImages;
  $('engine').disabled = listening;
  $('language').disabled = listening;
  $('draft').readOnly = switching || listening || sending || preparingImages;
  $('microphone').setAttribute('aria-pressed', String(listening));
  $('microphone-label').textContent = listening ? 'Stop listening' : 'Speak';
  $('microphone').setAttribute('aria-label', listening ? 'Stop listening' : 'Speak');
  $('microphone').title = listening ? 'Stop listening' : 'Speak';
  $('draft').placeholder = listening ? 'Listening…' : 'Ask Pi anything…';
  $('microphone').classList.toggle('active', listening);
  if (!listening) setText('listening', speechHint());
  const working = Boolean(connected && (state?.busy || state?.pending || sending || optimisticQuestion));
  $('thinking').hidden = !working;
  setText('thinking-label', activityLabel());
  $('thinking').classList.toggle('waiting', Boolean(state?.activity?.prompt) && !sending);
  $('thinking').classList.toggle('clickable', true);
  $('open-activity').hidden = !sessionReady();
  $('stop-host').hidden = !connected || sessions.some((item) => item.managed);
  $('latest-answer').setAttribute('aria-busy', String(Boolean(working)));
  $('abort').hidden = !working;
  $('abort').disabled = !working || sending;
  renderLatest(state?.messages || []);
  readingControls();
  terminalControls();
}
function activityLabel() {
  if (sending) return 'Sending…';
  const now = state?.activity;
  if (now?.prompt) return `Waiting for you in Termux${now.prompt.title ? `: ${now.prompt.title}` : ''}`;
  if (state?.pending) return 'Follow-up queued';
  const step = now?.step;
  if (step?.kind === 'tool') return [step.name, step.summary].filter(Boolean).join(' · ');
  if (step?.kind === 'thinking') return 'Thinking…';
  if (step?.kind === 'text') return 'Writing the reply…';
  return 'Pi is thinking…';
}
const terminalSession = () => {
  const session = activityData?.terminal?.session || state?.terminal?.session || '';
  return /^pi-voice(-[a-f0-9]{8})?$/.test(session) ? session : '';
};
function elapsed(step) {
  const seconds = Math.max(0, ((step.ended || Date.now()) - step.started) / 1000);
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}
function stepElement(step) {
  const open = expandedSteps.has(step.id);
  const item = document.createElement('div');
  item.className = `step ${step.kind} ${step.status}${open ? ' open' : ''}`;
  const row = document.createElement('button');
  row.className = 'step-row';
  row.setAttribute('aria-expanded', String(open));
  const icon = document.createElement('span');
  icon.className = 'step-icon';
  icon.textContent = step.status === 'done' ? '✓' : step.status === 'error' ? '!' : '';
  const main = document.createElement('span');
  main.className = 'step-main';
  const name = document.createElement('span');
  name.className = 'step-name';
  name.textContent = { tool: step.name, thinking: 'Thinking', text: 'Writing the reply', prompt: 'Waiting for you in Termux' }[step.kind] || step.kind;
  main.append(name);
  if (step.summary) {
    const summary = document.createElement('span');
    summary.className = 'step-summary';
    summary.textContent = step.summary;
    main.append(summary);
  }
  const time = document.createElement('span');
  time.className = 'step-time';
  time.textContent = elapsed(step);
  row.append(icon, main, time);
  row.addEventListener('click', () => {
    if (expandedSteps.has(step.id)) expandedSteps.delete(step.id);
    else expandedSteps.add(step.id);
    renderActivity();
  });
  item.append(row);
  // Finished steps stay one line until tapped; running or failed ones show output.
  if (step.kind === 'tool' && step.output && (open || step.status !== 'done')) {
    const output = document.createElement('pre');
    output.className = 'step-output';
    // Collapsed: the last lines only, like a terminal's live tail.
    output.textContent = open ? step.output : step.output.split('\n').slice(-6).join('\n');
    item.append(output);
  } else if (step.kind === 'text' && step.text) {
    const text = document.createElement('div');
    text.className = 'step-text';
    text.textContent = step.text;
    item.append(text);
  }
  return item;
}
function emptyActivity(text) {
  const empty = document.createElement('p');
  empty.className = 'activity-empty';
  empty.textContent = text;
  return empty;
}
function renderActivity() {
  const body = $('activity-body');
  // Follow new steps like a terminal, unless the user scrolled up to read.
  const following = !(body.scrollHeight - body.scrollTop - body.clientHeight > 48);
  const steps = activityData?.steps || [];
  if (!activitySupported) $('activity-list').replaceChildren(emptyActivity('Restart Pi once to see its live activity here.'));
  else if (!steps.length) $('activity-list').replaceChildren(emptyActivity(busyHere() ? 'Waiting for Pi’s first step…' : 'Nothing is running. The steps of Pi’s next task appear here: tools, their output and the reply being written.'));
  else $('activity-list').replaceChildren(...steps.map(stepElement));
  if (following) body.scrollTop = body.scrollHeight;
  terminalControls();
}
function terminalControls() {
  const session = terminalSession();
  const bridge = window.PiVoiceAndroid;
  const capable = typeof bridge?.openTerminal === 'function';
  let hint;
  if (bridge && !capable) hint = 'Update the Pi Voice app to open Pi’s terminal from here.';
  else if (bridge && session) hint = 'Opens this Pi’s live terminal in Termux. To leave it running, press Ctrl+B then D. Ctrl+C or Ctrl+D would stop Pi.';
  else if (bridge && !state?.voiceVersion) hint = 'Restart Pi after its current task to identify this session’s terminal.';
  else if (bridge) hint = 'The app could not identify this session’s terminal. It will keep checking; you can also open Termux manually.';
  else hint = 'Open this page in the Pi Voice app to switch to Pi’s terminal.';
  $('open-terminal').hidden = !bridge;
  $('open-terminal').disabled = !connected || switchPending || !session || !capable;
  setText('terminal-hint', hint);
}
function openTerminal() {
  const session = terminalSession();
  const bridge = window.PiVoiceAndroid;
  if (connected && !switchPending && session && typeof bridge?.openTerminal === 'function') {
    if (storage.get('terminal-warned') !== 'true') {
      if (!confirm('Termux will show Pi’s live terminal. Keys go straight to Pi: Ctrl+C or Ctrl+D would stop it. Press Ctrl+B then D to leave it running.')) return;
      storage.set('terminal-warned', 'true');
    }
    cancelRecording();
    playback.stop();
    bridge.openTerminal(session);
  }
}
async function pollActivity() {
  if (activityPolling || !connected) return;
  activityPolling = true;
  const requested = targetHandle;
  try {
    const next = await api('activity');
    if (requested !== targetHandle) return;
    activitySupported = true;
    activityData = next;
  } catch (error) {
    if (requested !== targetHandle) return;
    if ([404, 501].includes(error.status)) { activitySupported = false; activityData = undefined; }
  } finally {
    activityPolling = false;
    if ($('activity-dialog').open) renderActivity();
  }
}
function readingTarget() {
  if (!state || state.busy || state.pending || sending || optimisticQuestion || sessionStarting()) return;
  const { question, answer } = latestExchange(state.messages || []);
  if (!answer?.text?.trim()) return;
  return { text: answer.text, key: JSON.stringify([state.sessionId, question, answer]) };
}
function readingControls() {
  const target = readingTarget();
  if (playback.active && (!target || target.key !== readingSourceKey || listening)) playback.stop();
  if (!playback.active) readingSourceKey = undefined;
  $('read-aloud').hidden = !target && !playback.active;
  $('read-aloud').disabled = !playback.supported || listening || (!target && !playback.active);
  $('read-aloud').setAttribute('aria-pressed', String(playback.active));
  $('read-aloud').setAttribute('aria-label', playback.active ? 'Stop reading Pi’s reply' : 'Read Pi’s latest reply aloud');
  $('read-aloud').title = playback.active ? 'Stop reading' : 'Read aloud';
  $('read-aloud').classList.toggle('active', playback.active);
  setText('read-label', playback.active ? 'Stop reading' : 'Read aloud');
}
function readReply() {
  if (playback.active) { playback.stop(); return; }
  const target = readingTarget();
  if (!target || listening || document.hidden) return;
  readingSourceKey = target.key;
  playback.speak(globalThis.PiVoiceMarkdown.speechText(target.text), $('read-language').value.trim());
}
function imageSupportError() {
  if (!state?.imageAttachments) return 'Restart Pi once to enable image attachments, then refresh this page.';
  if (!state.modelSupportsImages) return 'The connected model does not support images. Select a vision-capable model in Pi first.';
}
function setAttachments(next) {
  attachments = next;
  pendingMessage = undefined;
  attachmentButtons = [];
  $('attachments').replaceChildren(...attachments.map((item) => {
    const card = document.createElement('div');
    card.className = 'attachment';
    const image = document.createElement('img');
    image.src = item.preview;
    image.alt = item.name;
    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = item.name;
    const remove = document.createElement('button');
    remove.className = 'attachment-remove quiet';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.addEventListener('click', () => {
      if (sending || listening || preparingImages || sessionStarting() || modelChanging()) return;
      setAttachments(attachments.filter((other) => other !== item));
      controls();
    });
    attachmentButtons.push(remove);
    card.append(image, name, remove);
    return card;
  }));
  $('attachments').hidden = !attachments.length;
  $('image-hint').hidden = !attachments.length;
}
async function prepareImage(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error(`Could not decode ${file.name || 'image'}. Choose a valid JPEG, PNG or WebP.`); }
  const canvas = document.createElement('canvas');
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > imageLimits.maxPixels) throw new Error('Image is too large to process safely (maximum 40 megapixels).');
    const scale = Math.min(1, imageLimits.maxEdge / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Image processing is unavailable. Update Android System WebView.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Re-encoding strips original metadata and keeps uploads small. Transparent
    // pixels become white; JPEG/PNG/WebP inputs all use JPEG on the wire.
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob || blob.type !== 'image/jpeg') throw new Error('Could not prepare this image. Try a smaller file.');
    if (blob.size > imageLimits.maxImageBytes) throw new Error('Prepared image exceeds 3 MiB. Crop it or choose a smaller image.');
    const preview = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read this image. Try selecting it again.'));
      reader.readAsDataURL(blob);
    });
    if (typeof preview !== 'string' || !preview.startsWith('data:image/jpeg;base64,')) throw new Error('Could not encode this image.');
    return { name: String(file.name || 'Image').slice(0, 120), size: blob.size, mimeType: 'image/jpeg', data: preview.slice(preview.indexOf(',') + 1), preview };
  } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
}
async function addImages(selection) {
  if (!connected || sending || listening || preparingImages || sessionStarting() || modelChanging()) return;
  const files = Array.from(selection || []);
  if (!files.length) return;
  const unsupported = imageSupportError();
  if (unsupported) { notice(unsupported, true); return; }
  if (files.length + attachments.length > imageLimits.maxCount) { notice('Attach at most 4 images per message.', true); return; }
  if (files.some((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > imageLimits.maxOriginalBytes)) {
    notice('Choose JPEG, PNG or WebP files up to 15 MiB each. SVG, GIF and HEIC are not supported.', true);
    return;
  }
  const sessionId = state.sessionId;
  preparingImages = true;
  controls();
  notice('Preparing image previews…');
  try {
    const ready = [];
    let total = attachments.reduce((sum, image) => sum + image.size, 0);
    for (const file of files) {
      const image = await prepareImage(file);
      total += image.size;
      if (total > imageLimits.maxTotalBytes) throw new Error('Prepared images exceed 8 MiB total. Attach fewer or smaller images.');
      ready.push(image);
    }
    if (sessionId !== state?.sessionId) throw new Error('Pi switched sessions while images were preparing. Review the session and select them again.');
    setAttachments([...attachments, ...ready]);
    notice(`${attachments.length} image${attachments.length === 1 ? '' : 's'} attached. Add a question by typing or speaking, then tap Send.`);
  } catch (error) { notice(error.message, true); }
  finally { preparingImages = false; controls(); }
}
async function api(path, { method = 'GET', body, signal, handle = targetHandle } = {}) {
  const response = await fetch(`/api/${path}`, {
    method, signal: signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined), cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(handle ? { 'X-Pi-Voice-Session': String(handle), 'X-Pi-Voice-Instance': (state?.handle === handle ? state.instanceId : sessions.find((item) => item.handle === handle)?.instanceId) || '' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}
function renderBody(element, text, markdown, prefix = '') {
  element.className = `${prefix}message-body plain-text`;
  if (markdown) {
    try {
      element.innerHTML = globalThis.PiVoiceMarkdown.render(text);
      element.className = `${prefix}message-body markdown-body`;
      return;
    } catch { /* Keep replies visible even if rendering fails. */ }
  }
  element.textContent = text;
}
function latestExchange(messages) {
  let questionIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { questionIndex = i; break; }
  }
  const question = messages[questionIndex];
  const answer = messages.slice(questionIndex + 1).filter((message) => message.role === 'assistant').at(-1);
  return { question, answer };
}
function displayQuestion(message) {
  if (!message) return '';
  const count = message.imageCount || 0;
  return [message.text, count ? `[${count} image${count === 1 ? '' : 's'} attached]` : ''].filter(Boolean).join('\n');
}
function renderLatest(messages) {
  const { question, answer } = latestExchange(messages);
  const waiting = Boolean(optimisticQuestion);
  const questionText = displayQuestion(optimisticQuestion || question);
  const answerText = waiting ? '' : answer?.text || '';
  const busy = connected && (state?.busy || state?.pending || sending || waiting);
  const key = JSON.stringify([questionText, answerText, Boolean(busy)]);
  if (key === lastFocus) return;
  lastFocus = key;
  $('question-card').hidden = !questionText;
  if ($('latest-question').textContent !== questionText) $('latest-question').textContent = questionText;
  const pane = $('latest-answer');
  // Leave the DOM and scroll position untouched on ordinary, unchanged polls.
  if (pane.dataset.content !== answerText || pane.dataset.question !== questionText || !answerText) {
    if (answerText) renderBody(pane, answerText, true, 'answer-pane ');
    else {
      pane.className = `answer-pane empty-answer${busy || questionText ? '' : ' idle-empty'}`;
      pane.textContent = state?.empty ? (state.error || (state.status === 'starting' ? 'Starting Pi…' : state.status === 'closing' ? 'Closing the conversation…' : 'Start a new session or restore one from Sessions.')) : busy ? 'Working on your request… Tap the line above to watch live.' : questionText ? 'No reply yet. Ask Pi to continue, or send your next question.' : 'Tap the microphone or type a question below.';
    }
    pane.dataset.content = answerText;
    pane.dataset.question = questionText;
    pane.scrollTop = 0;
  }
}
function showWakeStatus(status) {
  if (!status) return;
  setText('wake-status', status.error || (status.active ? 'Stay awake is on while this voice session runs.' : status.shared ? 'Off for this session; other Pi sessions may still keep Termux awake.' : 'Stay awake is off. Android may suspend Termux.'));
}
async function syncWakeLock() {
  if (!sessionReady() || wakeSyncing) return;
  wakeInitialized = true;
  wakeSyncing = true;
  $('awake').disabled = true;
  try {
    const result = await api('awake', { method: 'POST', body: { enabled: $('awake').checked } });
    showWakeStatus(result.wakeLock);
  } catch (error) {
    $('wake-status').textContent = [404, 501].includes(error.status) ? 'Restart Pi once to enable automatic stay-awake controls.' : `Stay-awake request failed: ${error.message}`;
  } finally { wakeSyncing = false; $('awake').disabled = false; }
}
function renderMessages(messages) {
  const key = JSON.stringify(messages);
  if (key === lastMessages) return;
  lastMessages = key;
  // Pi stores messages oldest-first. Reverse a copy for display, never the session data.
  // Do not force-scroll: new replies must not pull the user away from older messages.
  $('messages').replaceChildren(...[...messages].reverse().map((message) => {
    const article = document.createElement('article');
    article.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
    const name = document.createElement('strong');
    name.className = 'message-role';
    name.textContent = message.role === 'user' ? 'You' : 'Pi';
    const text = document.createElement('div');
    renderBody(text, message.role === 'user' ? displayQuestion(message) : message.text, message.role === 'assistant');
    article.append(name, text);
    return article;
  }));
}
async function startNewSession() {
  if (!connected || sessionStarting() || modelChanging() || spawnRequest || switchPending || sending || listening || preparingImages) return;
  if (!sessionsSupported) { notice('Restart Pi once to run sessions in parallel. Your conversation and draft are kept.', true); return; }
  // Always keep the current Pi: replacing an idle runtime made its conversation
  // disappear from Sessions, even though it was still saved on disk.
  if (!confirm('Start a new session alongside this one? This one keeps running; switch back any time from Sessions. Your unsent draft and images stay in the composer.')) return;
  const request = { id: crypto.randomUUID(), deadline: Date.now() + 45000 };
  spawnRequest = request;
  notice('Starting a new session…');
  controls();
  try {
    await api('session/spawn', { method: 'POST', body: { id: request.id } });
    await pollSessions();
  } catch (error) {
    if (spawnRequest === request && error.status) {
      spawnRequest = undefined;
      notice([404, 501].includes(error.status) ? 'Restart Pi once to run sessions in parallel. Your conversation and draft are kept.' : `${error.message} Your draft is kept.`, true);
    } else if (spawnRequest === request) {
      // A lost acknowledgement does not mean the Pi failed to start. Discover
      // its spawn ID; never repeat POST or launch a duplicate automatically.
      notice('Checking whether the new session started…');
      await pollSessions();
    }
  } finally { controls(); }
}
function checkSpawn() {
  const request = spawnRequest;
  if (!request) return;
  const failed = [...sessions, ...stopped].find((item) => item.operationId === request.id && ['failed', 'unavailable'].includes(item.status));
  if (failed) { spawnRequest = undefined; notice(failed.error || 'Pi did not start. Check its terminal.', true); return; }
  const match = sessions.find((item) => item.operationId === request.id && item.status === 'ready');
  if (match) {
    spawnRequest = undefined;
    selectTarget(match.handle);
    notice(request.restored ? 'Session restored.' : 'New session ready. The previous one keeps running under Sessions.');
    haptic('confirm');
    void poll();
  } else if (Date.now() >= request.deadline) {
    spawnRequest = undefined;
    notice('The new session did not start in time. Check Termux (tmux -L pi-voice-native ls), then try again.', true);
  }
}
// Point every later request at another running Pi. Nothing unsent is moved:
// the draft stays editable and the bridge rejects prompts for a stale session.
function rememberSelection(handle) {
  selectionWrite = selectionWrite.then(() => api('session/select', { method: 'POST', body: { handle }, handle: null }))
    .catch((error) => { if (targetHandle === handle) notice(error.message, true); });
}
function finishNotification(opened) {
  const target = notificationTarget;
  if (!target) return;
  window.PiVoiceAndroid?.notificationHandled?.(target.handle, target.sessionId || '', opened);
  notificationTarget = undefined;
}
function openNotificationWhenReady() {
  const target = notificationTarget;
  // A tap is durable, not a best-effort call to switchTo (which can be busy).
  if (!target || target.started || sending || preparingImages || spawnRequest || sessionStarting()) return;
  target.started = true;
  selectTarget(target.handle, true);
  // Never leave an unrelated reply visible while the notification is loading.
  state = undefined;
  for (const name of ['sessions', 'activity', 'history', 'settings']) $(`${name}-dialog`).close();
  notice('Opening the notified conversation…');
  void poll();
}
function selectTarget(handle, fromNotification = false) {
  if (!fromNotification && notificationTarget?.started) finishNotification(false);
  targetHandle = handle || undefined;
  selectionVersion++;
  // A notification's conversation identity must be checked before persisting it.
  if (handle && !fromNotification) rememberSelection(handle);
  switchPending = true;
  pendingMessage = undefined;
  optimisticQuestion = undefined;
  lastFocus = '';
  lastMessages = '';
  unread.delete(handle);
  activityData = undefined;
  activitySupported = true;
  expandedSteps.clear();
  cancelRecording();
  playback.stop();
}
function switchTo(handle) {
  $('sessions-dialog').close();
  // While a switch loads, the session being opened is the one on screen.
  const showing = switchPending ? targetHandle : currentHandle();
  if ((handle === showing && !notificationTarget) || sending || preparingImages || sessionStarting()) return;
  haptic('tap');
  finishNotification(false);
  selectTarget(handle);
  notice('');
  controls();
  void poll();
}
async function restoreSession(item) {
  if ((!connected && !notificationTarget) || spawnRequest || sending || listening) return;
  finishNotification(false);
  const request = { id: crypto.randomUUID(), deadline: Date.now() + 45000, restored: true };
  spawnRequest = request;
  $('sessions-dialog').close();
  notice('Restoring the session…');
  controls();
  try {
    const result = await api('session/restore', { method: 'POST', body: { id: request.id, handle: item.handle }, handle: null });
    // A launch already in flight for this conversation is joined, not repeated.
    if (typeof result?.id === 'string') request.id = result.id;
    stopped = stopped.filter((other) => other.handle !== item.handle);
    await pollSessions();
  } catch (error) {
    if (spawnRequest === request && error.status) { spawnRequest = undefined; notice(error.message, true); }
    else if (spawnRequest === request) {
      // A lost acknowledgement may still have started Pi: look, never re-post.
      notice('Checking whether the session was restored…');
      await pollSessions();
    }
  } finally { controls(); }
}
async function forgetSession(item) {
  try {
    await api('session/forget', { method: 'POST', body: { handle: item.handle }, handle: null });
    stopped = stopped.filter((other) => other.handle !== item.handle);
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
  restore.disabled = Boolean(spawnRequest || item.restoring || !item.restorable);
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
  if (!confirm(`Close “${item.title || 'this session'}”? ${working}The conversation stays saved in Pi.`)) return;
  try {
    await api('session/close', { method: 'POST', body: { sessionId: item.sessionId, instanceId: item.instanceId }, handle: item.handle });
    await pollSessions();
    if (item.handle === currentHandle()) selectTarget(undefined);
    unread.delete(item.handle);
    renderSessions();
    notice('Closing session… Its conversation stays saved in Pi.');
    void poll();
  } catch (error) { notice(error.message, true); }
  finally { controls(); }
}
function renderSessions() {
  const list = sessions;
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
    sub.className = `session-sub${unread.has(item.handle) ? ' fresh' : ''}`;
    const statusLabel = { starting: 'Starting…', closing: 'Closing…', 'close-error': 'Could not close', unavailable: 'Unavailable', incompatible: 'Restart Pi to update' };
    sub.textContent = [current ? 'Viewing' : '', item.status !== 'ready' ? statusLabel[item.status] || item.status : item.busy || item.pending ? 'Working' : unread.has(item.handle) ? 'New reply' : 'Ready', folder(item.cwd)].filter(Boolean).join(' · ');
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
  $('stopped-section').hidden = !stopped.length;
  $('stopped-list').replaceChildren(...stopped.map(stoppedRow));
  $('sessions-hint').textContent = sessionsSupported
    ? 'New sessions always run alongside this one, even while Pi is working. Switch back any time. Up to 4 sessions can run at once.'
    : 'Restart Pi once to run and switch between parallel sessions.';
}
async function pollSessions() {
  // The host's session/restore UI must work even when the notified worker is gone.
  if (sessionsPolling || !sessionsSupported) return;
  sessionsPolling = true;
  try {
    const result = await api('sessions', { handle: null });
    const list = Array.isArray(result.sessions) ? result.sessions : [];
    for (const item of list) {
      const working = Boolean(item.status !== 'ready' || item.busy || item.pending);
      // A background session that finishes gets a "new reply" marker.
      if (item.handle !== currentHandle() && sessionBusy.get(item.handle) && !working) { unread.add(item.handle); replyArrived(); }
      sessionBusy.set(item.handle, working);
    }
    for (const handle of [...sessionBusy.keys()]) if (!list.some((item) => item.handle === handle)) { unread.delete(handle); sessionBusy.delete(handle); }
    sessions = list;
    // A list is only a snapshot, never authority to change the displayed Pi.
    // The explicit state request handles a worker that really became unavailable.
    stopped = Array.isArray(result.stopped) ? result.stopped : [];
    checkSpawn();
  } catch (error) {
    if ([404, 501].includes(error.status)) sessionsSupported = false;
  } finally {
    sessionsPolling = false;
    if ($('sessions-dialog').open) renderSessions();
    controls();
  }
}
async function poll() {
  if (polling) return;
  polling = true;
  const requested = targetHandle;
  const version = selectionVersion;
  let stale = false;
  let openedNotification = false;
  const superseded = () => version !== selectionVersion;
  try {
    let next;
    try { next = await api('state', { handle: requested }); }
    catch (error) {
      // A worker stopped. The host stays available, including with zero workers.
      if (requested && [410, 502].includes(error.status) && !superseded() && !notificationTarget) {
        selectTarget(undefined);
        stale = true;
        notice('That session is unavailable. Choose another session or Restore.', true);
        return;
      }
      throw error;
    }
    if (superseded()) { stale = true; return; }
    if (notificationTarget?.started && (next.handle !== notificationTarget.handle || (notificationTarget.sessionId && next.sessionId !== notificationTarget.sessionId))) {
      throw new Error('That notification belongs to a different conversation. Open Sessions to find or restore the original.');
    }
    if (!targetHandle && next.handle) targetHandle = next.handle;
    const userSwitch = switchPending;
    switchPending = false;
    const wasConnected = connected;
    const changed = state && (state.sessionId !== next.sessionId || state.instanceId !== next.instanceId);
    if (optimisticQuestion) {
      const latest = latestExchange(next.messages);
      const isOurQuestion = latest.question?.text === optimisticQuestion.text && (latest.question?.imageCount || 0) === optimisticQuestion.imageCount && JSON.stringify(latest.question) !== optimisticQuestion.baseline;
      // Once Pi persists our question, its busy/pending state is authoritative.
      // A stopped or failed task may settle without any assistant reply.
      if (changed || isOurQuestion) optimisticQuestion = undefined;
    }
    // A reply counts once the session is idle again with a different answer
    // than when it was last idle. Pi may store the final message while still
    // busy, so consecutive polls are not compared. Switches only set a baseline.
    const answer = latestExchange(next.messages).answer?.id ?? null;
    const sameSession = state && !changed && !userSwitch && state.handle === next.handle;
    const idle = !next.busy && !next.pending;
    const replied = Boolean(sameSession && idle && answer && answer !== replyBaseline);
    if (!sameSession || idle) replyBaseline = answer;
    state = next;
    connected = true;
    offline = false;
    if (replied) replyArrived();
    reconnectOnFailure = false;
    unread.delete(next.handle);
    $('session').textContent = next.empty ? 'No active conversation' : `${next.sessionName} · ${next.sessionId.slice(0, 8)}`;
    $('directory').textContent = next.cwd || '';
    $('model').textContent = next.model || '';
    $('connection').classList.toggle('disconnected', false);
    if (changed) wakeInitialized = false;
    if (!wakeSyncing && next.wakeLock) showWakeStatus(next.wakeLock);
    if (!wakeInitialized && !next.empty) void syncWakeLock();
    if (changed && userSwitch) {
      // A session the user picked: keep its unsent draft for review.
      pendingMessage = undefined;
      cancelRecording();
    } else if (changed) {
      pendingMessage = undefined;
      // Do not automatically send a recording into a newly selected session.
      cancelRecording();
      notice('Pi switched sessions. Review the connected session before sending.', true);
    } else if (!wasConnected) {
      notice('Connected. Ready when you are.');
      void pollSessions();
    }
    if ($('history-dialog').open) renderMessages(next.messages);
    if (notificationTarget?.started) {
      rememberSelection(next.handle);
      notice('');
      openedNotification = true;
    }
  } catch (error) {
    if (superseded()) { stale = true; return; }
    connected = false;
    offline = true;
    setText('connection', 'Disconnected');
    $('connection').classList.toggle('disconnected', true);
    if (error.status !== 401) wakeInitialized = false;
    if (notificationTarget) {
      reconnectOnFailure = false;
      notice(error.status === 401 ? error.message : error.status === 410 || error.status === 502
        ? 'The notified conversation is unavailable. Open Sessions to restore it or choose another session.'
        : error.status ? 'Could not open the notified conversation. Try again or open Sessions.' : error.message || 'Could not reach the notified conversation. Try again or open Sessions.', true);
    } else if (error.status === 401) notice(error.message, true);
    else if (reconnectOnFailure && canReconnect()) { reconnectOnFailure = false; reconnect(); }
    else notice(canReconnect() ? 'Pi isn’t running. Tap Reconnect to start it and resume your conversation.'
      : window.PiVoiceAndroid ? 'Pi isn’t running. Update the Pi Voice app to reconnect from here, or close the app and tap its icon.'
        : 'Pi is not reachable. Open the Pi Voice app to start it.', true);
  } finally {
    polling = false;
    controls();
    if (openedNotification) finishNotification(true);
    if (stale) void poll();
  }
}
async function send() {
  const text = $('draft').value.trim();
  if ((!text && !attachments.length) || !sessionReady() || sending || listening || preparingImages || sessionStarting() || modelChanging()) return;
  if (attachments.length && imageSupportError()) { notice(imageSupportError(), true); return; }
  if (text.length > 16000) { notice('Message is too long (maximum 16000 characters).', true); return; }
  // Reuse the ID on a manual retry: a lost HTTP response must not duplicate a prompt.
  if (!pendingMessage || pendingMessage.text !== text || pendingMessage.sessionId !== state.sessionId) {
    pendingMessage = { id: crypto.randomUUID(), text, sessionId: state.sessionId, ...(attachments.length ? { images: attachments.map(({ mimeType, data }) => ({ mimeType, data })) } : {}) };
  }
  sending = true;
  if (!state.busy) optimisticQuestion = { text, imageCount: attachments.length, baseline: JSON.stringify(latestExchange(state.messages).question) };
  controls();
  try {
    const result = await api('prompt', { method: 'POST', body: pendingMessage });
    $('draft').value = '';
    setAttachments([]);
    pendingMessage = undefined;
    if (result.queued) optimisticQuestion = undefined;
    notice(result.queued ? 'Sent — queued after Pi’s current task.' : 'Sent to Pi.');
    haptic('confirm');
    await poll();
  } catch (error) {
    optimisticQuestion = undefined;
    notice(`Not confirmed: ${error.message} Your text and images are kept. Check the conversation before retrying.`, true);
    haptic('reject');
  } finally {
    sending = false;
    controls();
  }
}
function appendSpeech(base, text) {
  return [base.trim(), text.trim()].filter(Boolean).join('\n');
}
function cancelRecording() {
  if (!listening) return;
  cancelSpeech = true;
  recognition?.abort();
  // Closing this response cancels only its own server-side recognizer. A
  // session-global cancel could accidentally stop another tab's recording.
  listenRequest?.abort();
}
async function startSpeech() {
  if (listening) {
    if (recognition) recognition.stop();
    else cancelRecording();
    return;
  }
  if (!connected || sending || preparingImages || sessionStarting() || modelChanging()) return;
  playback.stop(); // Never record Pi's own spoken answer into a new prompt.
  const base = $('draft').value;
  cancelSpeech = false;
  const originalSession = state.sessionId;
  let transcript = '';
  let error = false;
  let finished = false;
  listening = true;
  haptic('toggle');
  $('listening').textContent = 'Listening… Pause when done';
  controls();
  const finish = async () => {
    if (finished) return;
    finished = true;
    listening = false;
    recognition = undefined;
    listenRequest = undefined;
    $('listening').textContent = speechHint();
    controls();
    if (cancelSpeech || originalSession !== state?.sessionId) {
      notice('Listening cancelled. Nothing was sent.');
    } else if (!error && transcript.trim()) {
      $('draft').value = appendSpeech(base, transcript);
      controls();
      notice(attachments.length ? 'Transcript and images ready. Review them, then tap Send.' : 'Transcript ready. Review it, then tap Send to Pi.');
    } else if (!error) notice('No speech detected. Try again.', true);
  };
  if ($('engine').value === 'browser') {
    if (!SpeechRecognition) {
      error = true;
      notice('Speech recognition is unavailable. Use the Termux:API engine in Settings or your keyboard’s microphone.', true);
      await finish();
      return;
    }
    const engine = new SpeechRecognition();
    recognition = engine;
    engine.lang = $('language').value.trim() || 'en-US';
    engine.continuous = false;
    engine.interimResults = true;
    engine.maxAlternatives = 1;
    engine.onresult = (event) => {
      if (finished || cancelSpeech) return;
      const final = [];
      const interim = [];
      for (const result of event.results) (result.isFinal ? final : interim).push(result[0].transcript);
      transcript = final.join(' ');
      $('draft').value = appendSpeech(base, [...final, ...interim].join(' '));
    };
    engine.onerror = (event) => {
      if (finished) return;
      error = true;
      const hints = {
        'not-allowed': 'Allow microphone permission for Pi Voice in Android app settings.',
        'audio-capture': 'Microphone unavailable. Close other apps using it.',
        'network': 'Speech service network error. Check internet or try the Termux:API engine.',
        'no-speech': 'No speech detected. Try again.',
        'language-not-supported': 'Try another speech language in settings.',
        'service-not-allowed': 'Speech service is unavailable. Try the Termux:API engine.',
        'aborted': 'Listening cancelled.',
      };
      notice(hints[event.error] || `Speech error: ${event.error}. Try the Termux:API engine.`, true);
    };
    engine.onend = () => { void finish(); };
    try { engine.start(); } catch (err) {
      error = true;
      notice(`Could not start speech: ${err.message}`, true);
      await finish();
    }
  } else {
    listenRequest = new AbortController();
    try {
      const result = await api('listen', { method: 'POST', signal: listenRequest.signal });
      transcript = result.text;
    } catch (err) {
      error = true;
      if (err.name !== 'AbortError') notice(err.message, true);
    } finally { await finish(); }
  }
}
$('attach').addEventListener('click', () => {
  if (!connected || sending || listening || preparingImages || sessionStarting() || modelChanging()) return;
  const unsupported = imageSupportError();
  if (unsupported) notice(unsupported, true);
  else $('image-input').click();
});
$('image-input').addEventListener('change', () => {
  const files = Array.from($('image-input').files || []);
  $('image-input').value = ''; // Picking the same file again must still fire change.
  void addImages(files);
});
$('stop-host').addEventListener('click', async () => {
  if (!confirm('Stop the Pi Voice service? Reconnect starts it again.')) return;
  try { await api('host/stop', { method: 'POST', body: {}, handle: null }); connected = false; offline = true; notice('Pi Voice service stopped.'); controls(); }
  catch (error) { notice(error.message, true); }
});
$('new-session').addEventListener('click', () => { void startNewSession(); });
$('microphone').addEventListener('click', () => { void startSpeech(); });
$('read-aloud').addEventListener('click', readReply);
$('read-language').addEventListener('change', () => {
  playback.stop();
  storage.set('read-language', $('read-language').value.trim());
});
$('send').addEventListener('click', () => { void send(); });
$('draft').addEventListener('input', controls);
$('clear').addEventListener('click', () => { $('draft').value = ''; setAttachments([]); controls(); });
$('abort').addEventListener('click', async () => {
  const sessionId = state?.sessionId;
  if (!connected || !sessionId || !confirm('Stop Pi’s current task? Already completed actions cannot be undone.')) return;
  try { await api('abort', { method: 'POST', body: { sessionId } }); optimisticQuestion = undefined; notice('Stop requested.'); haptic('tap'); await poll(); }
  catch (err) { notice(err.message, true); }
});
for (const id of ['notify', 'sound', 'haptics']) {
  $(id).addEventListener('change', () => {
    storage.set(id, String($(id).checked));
    if (id === 'haptics' && $(id).checked) haptic('toggle');
    if (id !== 'haptics') syncAlerts(id === 'notify' && $(id).checked);
  });
}
// From a reply notification: show the session it came from.
window.__piVoiceOpenSession = (handle, sessionId = '') => {
  if (typeof handle !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(handle) || typeof sessionId !== 'string' || (sessionId && !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId))) return false;
  if (notificationTarget?.handle === handle && notificationTarget.sessionId === sessionId) return true;
  notificationTarget = { handle, sessionId, started: false };
  reconnectOnFailure = false;
  controls();
  return true; // Accepted, not yet opened: Android waits for notificationHandled.
};
document.addEventListener('pointerdown', unlockAudio, { capture: true });
for (const id of ['engine', 'language']) {
  $(id).addEventListener('change', () => {
    storage.set(id, $(id).value);
    if (!listening) $('listening').textContent = speechHint();
    controls();
  });
}
$('awake').addEventListener('change', () => { storage.set('awake', String($('awake').checked)); void syncWakeLock(); });
for (const name of ['sessions', 'activity', 'history', 'settings']) {
  const dialog = $(`${name}-dialog`);
  $(`open-${name}`).addEventListener('click', () => {
    if (name === 'history') renderMessages(state?.messages || []);
    if (name === 'sessions') { renderSessions(); void pollSessions(); }
    if (name === 'activity') { renderActivity(); void pollActivity(); }
    dialog.showModal();
    if (name === 'settings') void modelPicker.open();
  });
  $(`close-${name}`).addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
}
document.addEventListener('visibilitychange', () => {
  // Coming back to a stopped Pi: the native app restarts it once by itself.
  if (!document.hidden) { reconnectOnFailure = true; alertHint(); void poll(); }
  // Never auto-send a recording that was interrupted by switching apps.
  else { cancelRecording(); playback.stop(); }
});
window.addEventListener?.('pagehide', () => playback.stop());
// Pull down on the conversation (scrolled to the top) to re-sync with Pi, or
// to restart it when it has stopped. Built in the page: the native shell has
// no AndroidX swipe-refresh widget, and Chrome's own is unavailable here.
const pullThreshold = 64;
const pull = { start: undefined, distance: 0, active: false };
let refreshing = false;
const sheetOpen = () => ['sessions', 'activity', 'history', 'settings'].some((name) => $(`${name}-dialog`).open);
const atTop = () => !($('latest-answer').scrollTop > 0) && !($('latest-question').scrollTop > 0);
function showPull(distance, settle = false) {
  const indicator = $('pull-indicator');
  indicator.classList.toggle('settle', settle);
  indicator.classList.toggle('ready', distance >= pullThreshold);
  // CSSOM, not a style attribute: the page's CSP blocks inline styles.
  indicator.style?.setProperty('--pull', `${distance}px`);
  indicator.style?.setProperty('--pull-opacity', String(Math.min(1, distance / pullThreshold)));
  indicator.style?.setProperty('--pull-turn', `${distance * 4}deg`);
}
async function refresh() {
  if (refreshing) return;
  if (!connected && canReconnect()) { showPull(0, true); reconnect(); return; }
  refreshing = true;
  showPull(52, true);
  $('pull-indicator').classList.toggle('refreshing', true);
  const shown = new Promise((resolve) => setTimeout(resolve, 500));
  try {
    await poll();
    await Promise.all([pollSessions(), $('activity-dialog').open ? pollActivity() : undefined, shown]);
  } finally {
    refreshing = false;
    $('pull-indicator').classList.toggle('refreshing', false);
    showPull(0, true);
  }
}
$('exchange').addEventListener('touchstart', (event) => {
  pull.start = undefined;
  if (event.touches.length !== 1 || refreshing || sheetOpen() || !atTop()) return;
  pull.start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  pull.distance = 0;
  pull.active = false;
}, { passive: true });
$('exchange').addEventListener('touchmove', (event) => {
  if (!pull.start || event.touches.length !== 1) return;
  const dx = event.touches[0].clientX - pull.start.x;
  const dy = event.touches[0].clientY - pull.start.y;
  if (!pull.active) {
    // Leave sideways swipes (code blocks, tables) and upward scrolling alone.
    if (dy < -6 || Math.abs(dx) > 12 && Math.abs(dx) > dy) { pull.start = undefined; return; }
    if (dy < 10) return;
    pull.active = true;
  }
  event.preventDefault();
  const was = pull.distance;
  pull.distance = Math.min(110, Math.max(0, (dy - 10) * 0.5));
  if (was < pullThreshold && pull.distance >= pullThreshold) haptic('tick');
  showPull(pull.distance);
}, { passive: false });
const endPull = () => {
  if (!pull.start) return;
  const go = pull.active && pull.distance >= pullThreshold;
  pull.start = undefined;
  pull.active = false;
  pull.distance = 0;
  if (go) void refresh();
  else showPull(0, true);
};
$('exchange').addEventListener('touchend', endPull);
$('exchange').addEventListener('touchcancel', () => { pull.active = false; endPull(); });
$('thinking').addEventListener('click', () => $('open-activity').click());
$('reconnect').addEventListener('click', reconnect);
$('restore-banner').addEventListener('click', () => $('open-sessions').click());
$('open-terminal').addEventListener('click', openTerminal);
$('sessions-new').addEventListener('click', () => { $('sessions-dialog').close(); void startNewSession(); });
setInterval(() => {
  if (document.hidden) return;
  void poll();
  // Other sessions change less often; check them every few seconds.
  if (spawnRequest || $('sessions-dialog').open || ++pollCount % 4 === 0) void pollSessions();
  if ($('activity-dialog').open) void pollActivity();
}, 1500);
setAttachments([]);
// The current APK restores native preferences at onPageFinished before syncing
// notifications. Older APKs have no preference migration callback.
if (typeof window.PiVoiceAndroid?.setUiPreference !== 'function') syncAlerts();
void poll();
controls();
