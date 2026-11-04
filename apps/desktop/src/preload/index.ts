import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { MainEvent } from '../shared/types.ts';

contextBridge.exposeInMainWorld('cooprompt', {
  async invoke(method: string, ...args: unknown[]) {
    const result = (await ipcRenderer.invoke('cooprompt:invoke', method, args)) as { ok: true; value: unknown } | { ok: false; error: string };
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  on(listener: (event: MainEvent) => void) {
    const handler = (_event: IpcRendererEvent, payload: MainEvent) => listener(payload);
    ipcRenderer.on('cooprompt:event', handler);
    return () => ipcRenderer.removeListener('cooprompt:event', handler);
  },
});
