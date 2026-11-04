import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** COOPROMPT_PROFILE runs isolated instances (separate data, device and folders) on one computer. */
export const PROFILE = (process.env.COOPROMPT_PROFILE ?? '').replace(/[^a-zA-Z0-9_-]/g, '');

/**
 * Updates are off in development builds and profiles unless COOPROMPT_UPDATES=1; COOPROMPT_UPDATES=0 turns
 * them off anywhere and COOPROMPT_UPDATES=auto also installs them unattended (end-to-end tests).
 */
const UPDATES = process.env.COOPROMPT_UPDATES ?? '';
export const updatesEnabled = (): boolean => process.platform === 'darwin' && (['1', 'on', 'auto'].includes(UPDATES) ? true : ['0', 'off'].includes(UPDATES) ? false : app.isPackaged && !PROFILE);
export const UNATTENDED_UPDATES = UPDATES === 'auto';

/** Development builds keep their data and folders apart from the installed app, as profiles do. */
export function configureUserData(): void {
  if (PROFILE) app.setPath('userData', join(app.getPath('appData'), `CooPrompt-${PROFILE}`));
  else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'CooPrompt Dev'));
}

export const userDataPath = (...parts: string[]): string => join(app.getPath('userData'), ...parts);

export function defaultRoots(): { syncRoot: string; privateRoot: string } {
  const base = join(homedir(), PROFILE ? `CooPrompt-${PROFILE}` : app.isPackaged ? 'CooPrompt' : 'CooPrompt-Dev');
  return { syncRoot: join(base, 'Compartidos'), privateRoot: join(base, 'Privados') };
}

/** The running .app (CooPrompt.app/Contents/MacOS/CooPrompt → CooPrompt.app). */
export const appBundlePath = (): string => resolve(process.execPath, '..', '..', '..');

const moduleRequire = createRequire(import.meta.url);
const platformSuffix = `${process.platform}-${process.arch}`;

function packageDir(name: string): string {
  return dirname(moduleRequire.resolve(`${name}/package.json`));
}

/** Engine binaries live outside the asar archive in packaged builds (see scripts/stage-engines.mjs). */
export function claudeExecutable(): string {
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  if (app.isPackaged) return join(process.resourcesPath, 'engines', 'claude', executable);
  return join(packageDir(`@anthropic-ai/claude-agent-sdk-${platformSuffix}`), executable);
}

export function codexExecutable(): { bin: string; pathDirs: string[] } {
  const triple = process.platform === 'win32'
    ? (process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc')
    : (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');
  const root = app.isPackaged
    ? join(process.resourcesPath, 'engines', 'codex', triple)
    : join(packageDir(`@openai/codex-${platformSuffix}`), 'vendor', triple);
  const pathDir = join(root, 'codex-path');
  return { bin: join(root, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'), pathDirs: existsSync(pathDir) ? [pathDir] : [] };
}
