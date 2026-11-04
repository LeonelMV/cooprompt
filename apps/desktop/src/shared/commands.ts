export interface SlashCommandInfo {
  /** Without the leading trigger. */
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  source: 'cooprompt' | 'builtin' | 'custom' | 'prompt' | 'skill';
  /** Codex mentions skills as `$name` instead of running them as commands. */
  trigger?: '/' | '$';
}

/** CooPrompt starts a fresh engine session itself: neither engine can do it reliably when driven headless. */
export const NEW_SESSION_COMMANDS = ['new', 'clear', 'reset'];

export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/([^\s/]\S*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], args: (match[2] ?? '').trim() } : null;
}

function splitArgs(args: string): string[] {
  return [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

/**
 * Fills a Codex custom prompt (~/.codex/prompts/<name>.md) the way the Codex CLI does: `$1`…`$9`, `$ARGUMENTS`,
 * `$NAME` from `NAME=value` arguments and `$$` for a literal dollar sign. Arguments for a prompt without
 * placeholders are appended.
 */
export function expandPrompt(template: string, args: string): string {
  const body = template.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  const words = splitArgs(args);
  const named = Object.fromEntries(words.map((word) => /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/.exec(word)).filter((match) => match !== null).map((match) => [match[1], match[2]]));
  const positional = words.filter((word) => !/^[A-Z][A-Z0-9_]*=/.test(word));
  let used = false;
  const filled = body.replace(/\$\$|\$ARGUMENTS|\$([1-9])|\$([A-Z][A-Z0-9_]*)/g, (token, digit: string | undefined, name: string | undefined) => {
    if (token === '$$') return '$';
    used = true;
    if (token === '$ARGUMENTS') return args;
    if (digit) return positional[Number(digit) - 1] ?? '';
    return name && name in named ? named[name] : token;
  });
  return !used && args ? `${filled}\n\n${args}` : filled;
}

/** Prefix matches first, then matches anywhere in a name or alias; descriptions only when no name matches. */
export function matchCommands(commands: SlashCommandInfo[], query: string): SlashCommandInfo[] {
  const needle = query.toLowerCase();
  if (!needle) return commands;
  const rank = (command: SlashCommandInfo) => {
    const names = [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
    if (names.some((name) => name.startsWith(needle))) return 0;
    if (names.some((name) => name.includes(needle))) return 1;
    return command.description.toLowerCase().includes(needle) ? 2 : 3;
  };
  const ranked = commands.map((command) => ({ command, rank: rank(command) })).filter((entry) => entry.rank < 3);
  const cutoff = ranked.some((entry) => entry.rank < 2) ? 2 : 3;
  return ranked
    .filter((entry) => entry.rank < cutoff)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.command);
}
