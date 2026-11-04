import { app, BrowserWindow, ipcMain, Menu, protocol, shell } from 'electron';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MEDIA_SCHEME } from '../shared/attachments.ts';
import type { MainEvent } from '../shared/types.ts';
import { AppCore } from './core.ts';
import { log, setLogFile } from './log.ts';
import { appBundlePath, configureUserData, PROFILE, userDataPath } from './paths.ts';
import { confirmLaunch, relocatedCopy } from './updater.ts';

const here = dirname(fileURLToPath(import.meta.url));

// Development builds get their own name (and Keychain item, "<name> Safe Storage"): macOS asks for
// permission when a binary with a different signature reads another build's item.
if (!app.isPackaged) app.setName('CooPrompt Dev');
configureUserData();
// Before anything slow (the Keychain prompt included), so the update helper does not roll back.
confirmLaunch(userDataPath('updates'), app.getVersion());
const relocated = app.isPackaged && process.platform === 'darwin' ? relocatedCopy(userDataPath('updates'), appBundlePath(), app.getVersion()) : null;
if (relocated) {
  spawn('/usr/bin/open', [relocated], { detached: true, stdio: 'ignore' }).unref();
  app.exit(0);
} else if (!PROFILE && !app.requestSingleInstanceLock()) app.quit();

// Attachments reach the renderer only through this scheme, never as file:// URLs; `stream` lets players seek.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } }]);

let core: AppCore | null = null;

function broadcast(event: MainEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('cooprompt:event', event);
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: PROFILE ? `CooPrompt (${PROFILE})` : 'CooPrompt',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 17 } } : {}),
    backgroundColor: '#171a21',
    show: false,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Only the app's own pages: never a local file, whatever a link or a drop points to.
  const appPages = pathToFileURL(join(here, '../renderer/')).href;
  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if ((devUrl && url.startsWith(devUrl)) || url.startsWith(appPages)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(here, '../renderer/index.html'));
  return window;
}

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

void app.whenReady().then(async () => {
  if (relocated) return;
  setLogFile(userDataPath('logs', 'main.log'));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  core = new AppCore(broadcast);
  protocol.handle(MEDIA_SCHEME, (request) => core!.attachments.serve(request));
  ipcMain.handle('cooprompt:invoke', async (_event, method: string, args: unknown[]) => {
    try {
      return { ok: true, value: await core!.invoke(method, Array.isArray(args) ? args : []) };
    } catch (error) {
      log('ipc', `${method} failed`, error instanceof Error ? error.message : String(error));
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  createWindow();
  await core.init();
  broadcast({ type: 'state', state: core.state() });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the window keeps CooPrompt running so this computer stays available to run its turns.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !core) return;
  quitting = true;
  event.preventDefault();
  const deadline = new Promise((resolve) => setTimeout(resolve, 3000));
  void Promise.race([core.shutdown().catch(() => {}), deadline]).finally(() => app.exit(0));
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => app.quit());
