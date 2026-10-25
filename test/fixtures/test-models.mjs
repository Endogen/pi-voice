// An isolated, unreachable provider. Integration input hooks consume prompts,
// so these exercise Pi's real registry without credentials or inference calls.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function configureTestModels(directory) {
  // Termux workers default to staying awake. Keep both integrations isolated
  // from Android's real, shared wake lock, including at cold startup.
  const voice = join(directory, 'voice');
  await mkdir(voice, { recursive: true, mode: 0o700 });
  await writeFile(join(voice, 'wake-settings.json'), JSON.stringify({ enabled: false }), { mode: 0o600 });
  await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { 'pi-voice-test': {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'test-only-no-inference',
    models: [
      { id: 'vision', name: 'Integration vision', input: ['text', 'image'], contextWindow: 128000, maxTokens: 1024 },
      { id: 'text', name: 'Integration text', input: ['text'], contextWindow: 8192, maxTokens: 1024 },
    ],
  } } }), { mode: 0o600 });
}
