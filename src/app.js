'use strict';
const $ = (id) => document.getElementById(id);
function setText(id, text) { const node = $(id); if (node.textContent !== text) node.textContent = text; }
const storage = {
  get(key) { try { return localStorage.getItem(`pi-voice-${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`pi-voice-${key}`, value); } catch {} },
};
let token = location.hash.slice(1) || storage.get('token') || '';
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
let newSessionRequest;
let attachments = [];
let preparingImages = false;
let attachmentButtons = [];
let readingSourceKey;
const playback = globalThis.PiVoicePlayback.create({
  onState: () => readingControls(),
  onError: (code) => {
    const hints = {
      upgrade: 'Update Pi Voice Native to APK 0.1.2 or newer to read replies aloud.',
      unsupported: 'Read aloud is unavailable here. Try Chrome or update the native app.',
      language: 'No voice for this language. Check Read-aloud language in Settings and install a matching Android voice.',
      'text-limit': 'This reply is too long to read aloud (maximum 32000 characters).',
      'audio-busy': 'Audio is busy. Stop other playback and try Read aloud again.',
      interrupted: 'Read aloud stopped.',
    };
    notice(hints[code] || 'Could not read the reply. Check your text-to-speech engine/installed voices and try again.', true);
  },
});
const imageLimits = globalThis.PiVoiceImageLimits;
const sessionStarting = () => Boolean(newSessionRequest || state?.newSessionAction?.status === 'starting');
const nativeSpeech = Boolean(globalThis.PiVoiceNativeRecognition);
const SpeechRecognition = globalThis.PiVoiceNativeRecognition || window.SpeechRecognition || window.webkitSpeechRecognition;
if (nativeSpeech) {
  setText('speech-primary', 'Android speech (native)');
  setText('speech-language-label', 'Speech language');
  setText('home-launch-hint', 'You are using the native app. Tap its icon to reconnect; Termux starts in the background and the chat stays here. Your existing Pi Voice shortcut still works separately in Chrome.');
}
$('autosend').checked = storage.get('autosend') === 'true';
$('language').value = storage.get('language') || navigator.language || 'en-US';
$('engine').value = storage.get('engine') || (SpeechRecognition ? 'browser' : 'termux');
$('awake').checked = storage.get('awake') !== 'false';
$('read-language').value = storage.get('read-language') || navigator.language || 'en-US';
$('read-language').disabled = !playback.supported;
setText('read-support', playback.supported ? 'Tap Read aloud beside Pi’s completed reply to listen. Replies never play automatically.' : playback.needsUpgrade ? 'Update Pi Voice Native to APK 0.1.2 or newer to enable Read aloud.' : 'This browser does not provide speech playback. Try Chrome or the updated native app.');
function speechHint() {
  return attachments.length ? 'Review images, then send' : $('autosend').checked ? 'Auto-send is on' : 'Review, then send';
}

function notice(text, error = false) {
  setText('notice', text);
  $('notice').classList.toggle('error', error);
}
function controls() {
  const switching = sessionStarting();
  $('new-session').disabled = !connected || switching || sending || listening || preparingImages || Boolean(state?.busy || state?.pending || optimisticQuestion);
  setText('new-session-label', switching ? 'Starting…' : 'New');
  $('send').disabled = switching || !connected || sending || listening || preparingImages || (!$('draft').value.trim() && !attachments.length);
  $('attach').disabled = switching || !connected || sending || listening || preparingImages;
  $('image-input').disabled = $('attach').disabled;
  for (const button of attachmentButtons) button.disabled = switching || sending || listening || preparingImages;
  $('microphone').disabled = switching || sending || preparingImages || (!connected && !listening);
  $('clear').disabled = switching || sending || listening || preparingImages;
  $('engine').disabled = listening;
  $('language').disabled = listening;
  $('draft').readOnly = switching || listening || sending || preparingImages;
  $('microphone').setAttribute('aria-pressed', String(listening));
  $('microphone-label').textContent = listening ? 'Stop listening' : 'Speak';
  $('microphone').classList.toggle('active', listening);
  if (!listening) setText('listening', speechHint());
  const working = Boolean(connected && (state?.busy || state?.pending || sending || optimisticQuestion));
  $('thinking').hidden = !working;
  setText('thinking-label', sending ? 'Sending…' : state?.pending ? 'Follow-up queued' : 'Pi is thinking…');
  $('latest-answer').setAttribute('aria-busy', String(Boolean(working)));
  $('abort').hidden = !working;
  $('abort').disabled = !working || sending;
  renderLatest(state?.messages || []);
  readingControls();
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
      if (sending || listening || preparingImages || sessionStarting()) return;
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
    if (!context) throw new Error('Image processing is unavailable in this browser. Try Chrome.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Re-encoding strips original metadata and keeps uploads small. Transparent
    // pixels become white; JPEG/PNG/WebP inputs all use JPEG on the wire.
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob || blob.type !== 'image/jpeg') throw new Error('Could not prepare this image. Try Chrome or a smaller file.');
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
  if (!connected || sending || listening || preparingImages || sessionStarting()) return;
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
async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(`/api/${path}`, {
    method, signal: signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined), cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
      pane.className = 'answer-pane empty-answer';
      pane.textContent = busy ? 'Working on your request…' : questionText ? 'No reply yet. Ask Pi to continue, or send your next question.' : 'Tap Speak or type a question below.';
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
  if (!connected || wakeSyncing) return;
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
function checkNewSession(next) {
  const request = newSessionRequest;
  if (!request) return false;
  if (next && next.sessionId !== request.sessionId) {
    newSessionRequest = undefined;
    pendingMessage = undefined;
    optimisticQuestion = undefined;
    $('draft').value = '';
    setAttachments([]);
    $('autosend').checked = false;
    storage.set('autosend', 'false');
    notice(request.persistent ? 'New session ready. Your previous conversation remains saved in Pi.' : 'New session ready. The previous session was ephemeral (--no-session) and was not saved.');
    return true;
  }
  const action = next?.newSessionAction;
  if (action?.id === request.id && action.status === 'error') {
    newSessionRequest = undefined;
    notice(action.error || 'Could not start a new session. Your draft is kept.', true);
    return true;
  }
  if (Date.now() >= request.deadline) {
    newSessionRequest = undefined;
    notice('New session not confirmed. Your draft is kept. Check the connected session before trying again.', true);
    return true;
  }
  return false;
}
async function startNewSession() {
  if (!connected || sessionStarting() || sending || listening || preparingImages || state?.busy || state?.pending || optimisticQuestion) return;
  const persistent = state.sessionPersistent !== false;
  const saved = persistent ? 'Your current conversation stays saved in Pi.' : 'WARNING: Pi was started with --no-session. This conversation will not be saved.';
  if (!confirm(`Start a new session? ${saved} Any unsent draft and attached images will be cleared once the new session is ready.`)) return;
  const request = { id: crypto.randomUUID(), sessionId: state.sessionId, persistent, deadline: Date.now() + 30000 };
  newSessionRequest = request;
  notice('Starting a new session…');
  controls();
  try {
    await api('session/new', { method: 'POST', body: { id: request.id, sessionId: request.sessionId } });
    await poll();
  } catch (error) {
    if (newSessionRequest === request && error.status && error.status !== 503) {
      newSessionRequest = undefined;
      notice([404, 501].includes(error.status) ? 'Restart Pi once to enable the New session button. Your conversation and draft are kept.' : `${error.message} Your draft is kept.`, true);
    } else if (newSessionRequest === request) {
      // The old bridge may close before its acknowledgement reaches this tab.
      // Reconnect and observe the session ID, never automatically repeat POST.
      notice('Reconnecting while Pi starts the new session…');
    }
  } finally { controls(); }
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const next = await api('state');
    const wasConnected = connected;
    const changed = state && state.sessionId !== next.sessionId;
    if (optimisticQuestion) {
      const latest = latestExchange(next.messages);
      const isOurQuestion = latest.question?.text === optimisticQuestion.text && (latest.question?.imageCount || 0) === optimisticQuestion.imageCount && JSON.stringify(latest.question) !== optimisticQuestion.baseline;
      if (changed || (isOurQuestion && (next.busy || latest.answer))) optimisticQuestion = undefined;
    }
    state = next;
    connected = true;
    setText('connection', next.busy || next.pending ? 'Connected · working' : 'Connected · ready');
    $('session').textContent = `${next.sessionName} · ${next.sessionId.slice(0, 8)}`;
    $('directory').textContent = next.cwd;
    $('model').textContent = next.model;
    $('connection').classList.toggle('disconnected', false);
    if (changed) wakeInitialized = false;
    if (!wakeSyncing && next.wakeLock) showWakeStatus(next.wakeLock);
    if (!wakeInitialized) void syncWakeLock();
    if (changed) {
      pendingMessage = undefined;
      $('autosend').checked = false;
      storage.set('autosend', 'false');
      // Do not automatically send a recording into a newly selected session.
      cancelRecording();
      notice('Pi switched sessions. Auto-send is off. Review the connected session before sending.', true);
    } else if (!wasConnected) notice('Connected. Ready when you are.');
    checkNewSession(next);
    if ($('history-dialog').open) renderMessages(next.messages);
  } catch (error) {
    connected = false;
    setText('connection', 'Disconnected');
    $('connection').classList.toggle('disconnected', true);
    if (error.status !== 401) wakeInitialized = false;
    if (newSessionRequest) {
      if (!checkNewSession()) notice('Reconnecting while Pi starts the new session…');
    } else notice(error.status === 401 ? error.message : nativeSpeech
      ? 'Pi is not reachable. Tap the Pi Voice Native home-screen icon to reconnect. Your existing Pi Voice shortcut is also available as a fallback.'
      : 'Pi is not reachable. Tap the Termux:Widget Pi Voice icon to start/reconnect, or run pi-voice --app in Termux. A Chrome-only shortcut cannot start Pi.', true);
  } finally {
    polling = false;
    controls();
  }
}
async function send() {
  const text = $('draft').value.trim();
  if ((!text && !attachments.length) || !connected || sending || listening || preparingImages || sessionStarting()) return;
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
    await poll();
  } catch (error) {
    optimisticQuestion = undefined;
    notice(`Not confirmed: ${error.message} Your text and images are kept. Check the conversation before retrying.`, true);
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
  if (!connected || sending || preparingImages || sessionStarting()) return;
  playback.stop(); // Never record Pi's own spoken answer into a new prompt.
  const base = $('draft').value;
  cancelSpeech = false;
  const originalSession = state.sessionId;
  let transcript = '';
  let error = false;
  listening = true;
  $('listening').textContent = 'Listening… Pause when done';
  controls();
  const finish = async () => {
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
      if ($('autosend').checked && !attachments.length) await send();
      else notice(attachments.length ? 'Transcript and images ready. Review them, then tap Send.' : 'Transcript ready. Review it, then tap Send to Pi.');
    } else if (!error) notice('No speech detected. Try again.', true);
  };
  if ($('engine').value === 'browser') {
    if (!SpeechRecognition) {
      error = true;
      notice('This browser has no speech recognition. Open in Chrome, use Android fallback, or your keyboard’s microphone.', true);
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
      const final = [];
      const interim = [];
      for (const result of event.results) (result.isFinal ? final : interim).push(result[0].transcript);
      transcript = final.join(' ');
      $('draft').value = appendSpeech(base, [...final, ...interim].join(' '));
    };
    engine.onerror = (event) => {
      error = true;
      const hints = {
        'not-allowed': nativeSpeech ? 'Allow microphone permission for Pi Voice Native in Android app settings.' : 'Allow microphone permission for Chrome in Android settings and this site.',
        'audio-capture': 'Microphone unavailable. Close other apps using it.',
        'network': 'Speech service network error. Check internet or try Android fallback.',
        'no-speech': 'No speech detected. Try again.',
        'language-not-supported': 'Try another speech language in settings.',
        'service-not-allowed': 'Speech service is unavailable. Try Android fallback.',
        'aborted': 'Listening cancelled.',
      };
      notice(hints[event.error] || `Speech error: ${event.error}. Try Android fallback.`, true);
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
  if (!connected || sending || listening || preparingImages || sessionStarting()) return;
  const unsupported = imageSupportError();
  if (unsupported) notice(unsupported, true);
  else $('image-input').click();
});
$('image-input').addEventListener('change', () => {
  const files = Array.from($('image-input').files || []);
  $('image-input').value = ''; // Picking the same file again must still fire change.
  void addImages(files);
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
$('draft').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); }
});
$('clear').addEventListener('click', () => { $('draft').value = ''; setAttachments([]); controls(); });
$('abort').addEventListener('click', async () => {
  const sessionId = state?.sessionId;
  if (!connected || !sessionId || !confirm('Stop Pi’s current task? Already completed actions cannot be undone.')) return;
  try { await api('abort', { method: 'POST', body: { sessionId } }); optimisticQuestion = undefined; notice('Stop requested.'); await poll(); }
  catch (err) { notice(err.message, true); }
});
for (const id of ['autosend', 'engine', 'language']) {
  $(id).addEventListener('change', () => {
    storage.set(id, id === 'autosend' ? String($(id).checked) : $(id).value);
    if (!listening) $('listening').textContent = speechHint();
  });
}
$('awake').addEventListener('change', () => { storage.set('awake', String($('awake').checked)); void syncWakeLock(); });
for (const name of ['history', 'settings']) {
  const dialog = $(`${name}-dialog`);
  $(`open-${name}`).addEventListener('click', () => {
    if (name === 'history') renderMessages(state?.messages || []);
    dialog.showModal();
  });
  $(`close-${name}`).addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void poll();
  // Never auto-send a recording that was interrupted by switching apps.
  else { cancelRecording(); playback.stop(); }
});
window.addEventListener?.('pagehide', () => playback.stop());
setInterval(() => { if (!document.hidden) void poll(); }, 1500);
setAttachments([]);
void poll();
controls();
