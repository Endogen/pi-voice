import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

// "Pi replied" alerts for Pi Voice on Android. The app's receiver shows a
// notification only while the app is in the background, and only for
// broadcasts signed with this bridge's token (see native/ReplyReceiver.java).
const limits = { title: 120, text: 400 };
const plain = (value) => String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Short plain text from a Markdown reply: no code blocks, link targets or syntax. */
export function excerpt(markdown, max = 240) {
  const text = plain(String(markdown || '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^ {0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*{1,3}|_{1,3}|~~)(\S(?:.*?\S)?)\1/g, '$2'));
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function replySignature(token, { pid, handle, sessionId, time, title, text }) {
  const identity = sessionId ? `3\n${handle}\n${sessionId}` : `2\n${handle}`;
  return createHmac('sha256', token).update(`${identity}\n${pid}\n${time}\n${title}\n${text}`).digest('hex');
}

/** Sends the broadcast through Termux's `am`. Returns false off Android. */
export function sendReplyAlert({ token, pid, handle, sessionId, title, text, time = Date.now(), env = process.env, run = execFile }) {
  const prefix = env.PREFIX || '';
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(handle || '') || !prefix.includes('com.termux') || !/^[a-f0-9]{64}$/.test(token || '')) return false;
  if (sessionId !== undefined && !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId || '')) return false;
  const fields = { pid, handle, sessionId, time, title: plain(title).slice(0, limits.title), text: excerpt(text, limits.text) || 'Reply ready.' };
  const args = ['broadcast', '-f', '32', '-n', 'com.pivoice.app/.ReplyReceiver', '-a', 'com.pivoice.app.REPLY',
    '--ei', 'version', sessionId ? '3' : '2', '--es', 'handle', handle, ...(sessionId ? ['--es', 'sessionId', sessionId] : []), '--ei', 'pid', String(pid), '--el', 'time', String(time), '--es', 'title', fields.title, '--es', 'text', fields.text,
    '--es', 'signature', replySignature(token, fields)];
  // No shell; failures (no app installed, older app) are not Pi's problem.
  run(join(prefix, 'bin', 'am'), args, { timeout: 15000 }, () => {});
  return true;
}
