import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

function runTermux(command) {
  const executable = join(process.env.PREFIX || '/data/data/com.termux/files/usr', 'bin', command);
  return new Promise((resolve, reject) => {
    execFile(executable, [], { timeout: 4000, maxBuffer: 8192 }, (error, _stdout, stderr) => {
      if (!error && !/error|exception|denied|not found/i.test(stderr)) return resolve();
      reject(new Error(error?.code === 'ENOENT' ? `${command} is not installed.` : `${command} failed: ${(stderr || error?.message || 'Android refused the request').trim()}`));
    });
  });
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export async function processIdentity(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const start = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
    const boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '');
    return `${boot.trim()}:${start}`;
  } catch { return null; }
}

// Android has ONE wake lock for all of Termux, not one per Pi process. Track
// cooperating Pi Voice sessions so stopping one does not unlock another's CPU.
// A manually acquired Termux lock cannot be distinguished; see README.md.
export function createWakeLock({ directory, pid = process.pid, run = runTermux, alive = processAlive, identity = processIdentity } = {}) {
  let active = false;
  let shared = false;
  let error = null;
  let queue = Promise.resolve();
  const ownFile = join(directory, `${pid}.json`);
  const guard = join(directory, '.guard');
  const status = () => ({ active, shared, error });

  async function withGuard(operation) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 7000;
    for (;;) {
      try {
        await mkdir(guard, { mode: 0o700 });
        try { await writeFile(join(guard, 'owner'), String(pid), { mode: 0o600 }); }
        catch (problem) { await rm(guard, { recursive: true, force: true }); throw problem; }
        break;
      } catch (problem) {
        if (problem.code !== 'EEXIST') throw problem;
        const owner = Number(await readFile(join(guard, 'owner'), 'utf8').catch(() => ''));
        const info = await stat(guard).catch(() => null);
        if ((owner && !alive(owner)) || (!owner && info && Date.now() - info.mtimeMs > 15000)) {
          await rm(guard, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error('Stay-awake management is busy. Try again.');
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }
    try { return await operation(); }
    finally { await rm(guard, { recursive: true, force: true }); }
  }
  async function otherSessions() {
    const others = [];
    for (const name of await readdir(directory)) {
      if (!/^\d+\.json$/.test(name) || name === `${pid}.json`) continue;
      const file = join(directory, name);
      const owner = Number(name.slice(0, -5));
      let lease;
      try { lease = JSON.parse(await readFile(file, 'utf8')); } catch {}
      const currentIdentity = lease && alive(owner) ? await identity(owner) : null;
      if (!lease || !alive(owner) || (lease.identity && currentIdentity && lease.identity !== currentIdentity)) {
        await rm(file, { force: true });
      } else others.push(owner);
    }
    return others;
  }
  function setEnabled(enabled, { refresh = false } = {}) {
    const operation = async () => {
      if (enabled === active && !(enabled && refresh)) { error = null; return status(); }
      try {
        return await withGuard(async () => {
          const others = await otherSessions();
          if (enabled) {
            await run('termux-wake-lock');
            try { await writeFile(ownFile, JSON.stringify({ pid, identity: await identity(pid) }), { mode: 0o600 }); }
            catch (problem) { if (!others.length) await run('termux-wake-unlock').catch(() => {}); throw problem; }
            active = true;
            shared = others.length > 0;
          } else {
            if (!others.length) await run('termux-wake-unlock');
            await rm(ownFile, { force: true });
            active = false;
            shared = others.length > 0;
          }
          error = null;
          return status();
        });
      } catch (problem) {
        error = problem.message;
        throw problem;
      }
    };
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  return { status, setEnabled, close: () => setEnabled(false) };
}
