import type { MainEvent, CooPromptApi, CooPromptMethod } from '../../../shared/types.ts';

declare global {
  interface Window {
    cooprompt: {
      invoke(method: string, ...args: unknown[]): Promise<unknown>;
      on(listener: (event: MainEvent) => void): () => void;
    };
  }
}

export function call<M extends CooPromptMethod>(method: M, ...args: Parameters<CooPromptApi[M]>): Promise<Awaited<ReturnType<CooPromptApi[M]>>> {
  return window.cooprompt.invoke(method, ...args) as Promise<Awaited<ReturnType<CooPromptApi[M]>>>;
}

export function onMainEvent(listener: (event: MainEvent) => void): () => void {
  return window.cooprompt.on(listener);
}
