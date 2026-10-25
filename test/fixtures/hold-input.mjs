// Runs a bounded asynchronous Pi extension operation without calling a model.
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export default function (pi) {
  pi.on('input', async (event) => {
    if (event.text !== 'pi-voice-integration-hold') return;
    const root = process.env.PI_CODING_AGENT_DIR;
    for (let count = 1; count <= 200; count++) {
      await writeFile(join(root, 'work-progress'), String(count));
      if (await access(join(root, 'release-work')).then(() => true, () => false)) break;
      await delay(100);
    }
    await writeFile(join(root, 'work-finished'), 'done');
    return { action: 'handled' };
  });
}
