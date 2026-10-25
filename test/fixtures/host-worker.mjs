// Real extension and HTTP server in a separate process; a deterministic Pi
// adapter exercises a running task without provider calls or user settings.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import install from '../../extension.mjs';
const events = new Map();
let busy = false;
let timer;
let progress = 0;
const sessionId = process.env.TEST_SESSION_ID || `conversation-${process.env.PI_VOICE_MANAGED_ID}`;
const file = process.env.TEST_SESSION_FILE || join(process.env.PI_CODING_AGENT_DIR, `${sessionId}.jsonl`);
await writeFile(file, JSON.stringify({ sessionId }) + '\n');
const branch = [];
const ctx = {
  mode: 'rpc', cwd: process.env.PI_CODING_AGENT_DIR, model: { provider: 'test', id: 'deterministic', input: ['text'] },
  isIdle: () => !busy, hasPendingMessages: () => false,
  abort() { busy = false; clearInterval(timer); },
  shutdown() { setImmediate(async () => { clearInterval(timer); await events.get('session_shutdown')({ reason: 'quit' }, ctx); process.exit(0); }); },
  ui: { notify() {}, setStatus() {} },
  sessionManager: { getSessionId: () => sessionId, getSessionName: () => 'Test worker', getSessionFile: () => file, getBranch: () => branch },
};
install({ on: (name, handler) => events.set(name, handler), registerCommand() {},
  sendUserMessage(text) {
    branch.push({ type: 'message', id: 'question', message: { role: 'user', content: text } });
    busy = true; events.get('agent_start')({}, ctx);
    timer = setInterval(() => { progress++; process.send?.({ progress }); }, 20);
  },
}, { wakeLock: { status: () => ({ active: false }), setEnabled: async () => ({ active: false }), close: async () => {} } });
await events.get('session_start')({ reason: 'startup' }, ctx);
process.send?.({ ready: true });
process.on('message', (message) => {
  if (message === 'finish') {
    busy = false; clearInterval(timer);
    branch.push({ type: 'message', id: 'answer', message: { role: 'assistant', content: `Completed ${progress} steps` } });
    events.get('agent_settled')({}, ctx);
  }
});
