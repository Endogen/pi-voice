import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, chmod, readFile, writeFile } from 'node:fs/promises';

export const stateDir = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'voice');
export const protocolVersion = 1;
export const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(id);

export async function loadToken(directory = stateDir) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = join(directory, 'token');
  try { await writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(file, 0o600);
  const token = (await readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid Pi Voice token file.');
  return token;
}
