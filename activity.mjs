// A bounded, in-memory log of what Pi is doing in the current run: tool calls
// with a tail of their output, reply writing and terminal prompts. Private
// model reasoning is never recorded, only that a thinking step happened.
const maxSteps = 60;
const maxOutput = 4000;
const maxText = 2000;

const tail = (text, max) => (text.length > max ? `…${text.slice(-max)}` : text);
const clip = (value, max = 200) => String(value).replace(/\s+/g, ' ').trim().slice(0, max);
function textOf(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}
// One readable line per tool call: the command, path or first string argument.
export function summarize(args) {
  if (!args || typeof args !== 'object') return typeof args === 'string' ? clip(args) : '';
  for (const key of ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url']) {
    if (typeof args[key] === 'string' && args[key]) return clip(args[key]);
  }
  const first = Object.values(args).find((value) => typeof value === 'string' && value);
  if (first) return clip(first);
  try { return clip(JSON.stringify(args)); } catch { return ''; }
}

export function createActivity(now = Date.now) {
  let version = 0;
  let sequence = 0;
  let steps = [];
  let prompt;
  const tools = new Map();
  let writing;
  let thinking;
  const changed = () => { version++; };
  const add = (step) => {
    const entry = { id: ++sequence, started: now(), status: 'running', ...step };
    steps.push(entry);
    if (steps.length > maxSteps) steps = steps.slice(-maxSteps);
    changed();
    return entry;
  };
  const finish = (entry, status = 'done') => {
    if (!entry || entry.status !== 'running') return;
    entry.status = status;
    entry.ended = now();
    changed();
  };
  return {
    // Each run starts a fresh log: it answers "what is Pi doing now".
    start() {
      steps = [];
      tools.clear();
      writing = thinking = prompt = undefined;
      changed();
    },
    settle() {
      for (const entry of steps) finish(entry);
      prompt = undefined;
      changed();
    },
    stream(event) {
      if (!event || typeof event.type !== 'string') return;
      if (event.type === 'thinking_start') { finish(thinking); thinking = add({ kind: 'thinking' }); }
      else if (event.type === 'thinking_end') { finish(thinking); thinking = undefined; }
      else if (event.type === 'text_start') { finish(writing); writing = add({ kind: 'text', text: '' }); }
      else if (event.type === 'text_delta' && typeof event.delta === 'string') {
        if (!writing) writing = add({ kind: 'text', text: '' });
        writing.text = tail(writing.text + event.delta, maxText);
        changed();
      } else if (event.type === 'text_end') { finish(writing); writing = undefined; }
    },
    toolStart({ toolCallId, toolName, args }) {
      const entry = add({ kind: 'tool', name: clip(toolName || 'tool', 60), summary: summarize(args), output: '' });
      tools.set(toolCallId, entry);
    },
    toolUpdate({ toolCallId, partialResult }) {
      const entry = tools.get(toolCallId);
      const text = textOf(partialResult);
      if (!entry || !text) return;
      entry.output = tail(text, maxOutput);
      changed();
    },
    toolEnd({ toolCallId, result, isError }) {
      const entry = tools.get(toolCallId);
      if (!entry) return;
      const text = textOf(result);
      if (text) entry.output = tail(text, maxOutput);
      tools.delete(toolCallId);
      finish(entry, isError ? 'error' : 'done');
    },
    promptStart({ kind, title }) {
      prompt = { kind: clip(kind || 'input', 20), title: clip(title || '', 160) };
      add({ kind: 'prompt', name: prompt.kind, summary: prompt.title });
    },
    promptEnd() {
      prompt = undefined;
      for (const entry of steps) if (entry.kind === 'prompt') finish(entry);
      changed();
    },
    // Small enough for every state poll: the current step only.
    current() {
      const running = steps.filter((entry) => entry.status === 'running' && entry.kind !== 'text');
      const step = running.at(-1) || steps.filter((entry) => entry.status === 'running').at(-1);
      return { version, prompt, ...(step ? { step: { kind: step.kind, name: step.name, summary: step.summary } } : {}) };
    },
    snapshot() {
      return { version, prompt, steps: steps.map((entry) => ({ ...entry })) };
    },
  };
}
