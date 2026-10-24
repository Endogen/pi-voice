// Test-only interceptor: prove native Pi receives images without any model call.
// Loaded explicitly by integration.mjs in an isolated --no-extensions RPC process.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export default function captureInput(pi) {
  let count = 0;
  pi.on('input', async (event) => {
    await writeFile(join(process.env.PI_CODING_AGENT_DIR, 'captured-input.json'), JSON.stringify({ count: ++count, text: event.text, images: event.images, source: event.source }), { mode: 0o600 });
    return { action: 'handled' };
  });
}
