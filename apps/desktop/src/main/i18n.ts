import { translate, type Language } from '../shared/i18n.ts';

let current: Language = 'en';

export function setLanguage(language: Language): void {
  current = language;
}

export function language(): Language {
  return current;
}

/** Translates main-process messages shown to the user into the configured language. */
export function tr(text: string, vars?: Record<string, string | number | null | undefined>): string {
  return translate(current, text, vars);
}
