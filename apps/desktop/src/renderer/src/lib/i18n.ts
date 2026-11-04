import { useMemo } from 'react';
import { keyboardShortcuts, LOCALE, translate, translateMessage, type Language } from '../../../shared/i18n.ts';
import { useStore } from './store.ts';

type Vars = Record<string, string | number | null | undefined>;

export type T = ((text: string, vars?: Vars) => string) & {
  /** Localizes a filled English message coming from the server, an engine or another participant. */
  message(text: string): string;
  language: Language;
  locale: string;
};

export function useLanguage(): Language {
  return useStore((state) => state.app?.language ?? 'en');
}

export function useT(): T {
  const language = useLanguage();
  return useMemo(() => {
    const t = ((text: string, vars?: Vars) => keyboardShortcuts(translate(language, text, vars), navigator.userAgent.includes('Macintosh'))) as T;
    t.message = (text: string) => translateMessage(language, text);
    t.language = language;
    t.locale = LOCALE[language];
    return t;
  }, [language]);
}
