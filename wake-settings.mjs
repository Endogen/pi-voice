import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON } from './storage.mjs';

// The page can be paused or gone when a worker starts. Remember its preference
// in Termux too; terminal-only /voice sleep remains a per-worker override.
export function createWakeSettings(directory, defaultEnabled = process.env.PREFIX === '/data/data/com.termux/files/usr') {
  const file = join(directory, 'wake-settings.json');
  return {
    async load() {
      try {
        const value = JSON.parse(await readFile(file, 'utf8'));
        if (typeof value?.enabled !== 'boolean') throw new Error('Invalid stay-awake preference.');
        return value.enabled;
      } catch (error) {
        if (error.code === 'ENOENT') return defaultEnabled;
        throw new Error('Could not read the saved stay-awake preference. Set it again in Settings.');
      }
    },
    save: (enabled) => atomicJSON(file, { enabled }),
  };
}
