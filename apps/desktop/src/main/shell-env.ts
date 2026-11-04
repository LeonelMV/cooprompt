import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from './log.ts';

const MARKER = '__COOPROMPT_SHELL_ENV__';

/**
 * GUI apps on macOS start with a minimal PATH. Agents must see the same tools and credentials
 * as the user's terminal (git, gh, nvm, aws, gcloud…), so we read the login shell environment.
 */
export function loadShellEnv(): Promise<Record<string, string>> {
  if (process.platform === 'win32') {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
    if (pathKey && pathKey !== 'PATH') {
      env.PATH = env[pathKey];
      delete env[pathKey];
    }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS']) delete env[key];
    return Promise.resolve(env);
  }
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${MARKER}'; env -0; printf '${MARKER}'`],
      { timeout: 10_000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_DISABLE_COMPFIX: 'true' } },
      (error, stdout) => {
        const parsed: Record<string, string> = {};
        const start = stdout?.indexOf(MARKER) ?? -1;
        const end = stdout?.lastIndexOf(MARKER) ?? -1;
        if (!error && start >= 0 && end > start) {
          for (const entry of stdout.slice(start + MARKER.length, end).split('\0')) {
            const index = entry.indexOf('=');
            if (index > 0) parsed[entry.slice(0, index)] = entry.slice(index + 1);
          }
        } else {
          log('shell-env', 'could not read the login shell environment, using the default PATH', error?.message ?? '');
        }
        const base: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
        const merged = { ...base, ...parsed };
        const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
        const path = (merged.PATH ?? '').split(':').filter(Boolean);
        for (const dir of extra) if (!path.includes(dir)) path.push(dir);
        merged.PATH = path.join(':');
        for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', '_', 'SHLVL', 'OLDPWD', 'PWD']) delete merged[key];
        resolve(merged);
      },
    );
  });
}
