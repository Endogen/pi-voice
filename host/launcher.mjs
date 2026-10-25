import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
export function createLauncher({ socket = 'pi-voice-native', pi = join(homedir(), '.pi/agent/bin/pi'), args = [], env = process.env,
  tmux = env.PREFIX ? join(env.PREFIX, 'bin/tmux') : 'tmux' } = {}) {
  const command = (...args) => exec(tmux, ['-L', socket, ...args], { env, timeout: 10000 });
  return {
    async present(entry) {
      try { await command('has-session', '-t', `=${entry.terminal}`); return true; }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error('Install tmux to run Pi Voice sessions.');
        if (error.code === 1) return false; // has-session: no matching session/server.
        throw error; // A timeout or execution failure cannot confirm process exit.
      }
    },
    async launch(entry) {
      if (await this.present(entry)) return;
      const vars = { PI_VOICE_MANAGED_ID: entry.handle, PI_VOICE_INSTANCE_ID: entry.instanceId, PI_VOICE_OPERATION_ID: entry.operationId,
        ...(env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR } : {}) };
      await command('new-session', '-d', '-s', entry.terminal, '-x', '100', '-y', '36', '-c', entry.cwd,
        ...Object.entries(vars).flatMap(([key, value]) => ['-e', `${key}=${value}`]), pi, ...args,
        ...(entry.sessionFile ? ['--session', entry.sessionFile] : []));
    },
  };
}
