import { ES, ES_MESSAGES } from './i18n-es.ts';

export type Language = 'en' | 'es';

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
];

export const isLanguage = (value: unknown): value is Language => value === 'en' || value === 'es';

export const LOCALE: Record<Language, string> = { en: 'en-US', es: 'es-AR' };

type Vars = Record<string, string | number | null | undefined>;

const fill = (template: string, vars: Vars) =>
  template.replace(/\{(\w+)\}/g, (placeholder, key: string) => (vars[key] === undefined || vars[key] === null ? placeholder : String(vars[key])));

/** English source strings are the keys; missing translations fall back to English. */
export function translate(language: Language, text: string, vars?: Vars): string {
  const template = language === 'es' ? (ES[text] ?? ES_MESSAGES[text] ?? text) : text;
  return vars ? fill(template, vars) : template;
}

/** Keep shortcut labels aligned with the keys accepted on each platform. */
export function keyboardShortcuts(text: string, mac: boolean): string {
  return mac ? text : text.replaceAll('⇧⌘E', 'Ctrl+Shift+E').replaceAll('⌘↩', 'Ctrl+Enter');
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PATTERNS = Object.entries(ES_MESSAGES)
  .filter(([source]) => source.includes('{'))
  .map(([source, target]) => {
    const names: string[] = [];
    const body = source
      .split(/\{(\w+)\}/)
      .map((part, index) => {
        if (index % 2 === 0) return escape(part);
        names.push(part);
        return '(.+?)';
      })
      .join('');
    return { regex: new RegExp(`^${body}$`, 's'), names, target };
  });

/**
 * Localizes an already-filled English message from the server, an engine or another participant's
 * app by matching it against the message templates, e.g. "Ana joined the chat" → "Ana se unió al chat".
 */
export function translateMessage(language: Language, text: string): string {
  if (language === 'en' || !text) return text;
  const exact = ES_MESSAGES[text] ?? ES[text];
  if (exact) return exact;
  for (const pattern of PATTERNS) {
    const match = pattern.regex.exec(text);
    if (!match) continue;
    const vars: Vars = {};
    pattern.names.forEach((name, index) => {
      vars[name] = match[index + 1];
    });
    return fill(pattern.target, vars);
  }
  return text;
}
