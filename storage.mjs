import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// A crash leaves either the previous complete record or the next complete one.
export async function atomicJSON(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = await open(temp, 'wx', 0o600);
  try {
    try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); }
    finally { await fd.close(); }
    await rename(temp, file);
    const dir = await open(dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await rm(temp, { force: true }); }
}
