import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { expandPrompt, NEW_SESSION_COMMANDS, type SlashCommandInfo } from '../shared/commands.ts';
import type { Language } from '../shared/i18n.ts';
import type { Catalog } from '../shared/types.ts';
import { markdownEntries, parseFrontmatter, skillsIn } from './catalog.ts';

const NEW_SESSION: SlashCommandInfo = {
  name: 'new',
  aliases: NEW_SESSION_COMMANDS.filter((name) => name !== 'new'),
  description: 'Start a new agent session on this computer (the chat stays as it is)',
  source: 'cooprompt',
};

/** Codex offers /review and /init only in its terminal UI; CooPrompt sends the same requests as prompts. */
const CODEX_TEMPLATES: Record<string, { description: string; argumentHint?: string; prompt: string }> = {
  review: {
    description: 'Review the current code changes and list prioritized findings',
    argumentHint: '[focus]',
    prompt: 'Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.',
  },
  init: {
    description: 'Create an AGENTS.md with instructions for working in this repository',
    prompt:
      'Create an AGENTS.md file at the root of this repository with concise instructions for coding agents: project layout, how to build, test and run it, coding conventions and anything a newcomer must know. Read the code first and keep it short and accurate. If AGENTS.md already exists, improve it instead of replacing what is useful.',
  },
};

/** CooPrompt owns these in Claude: a fresh session, and the model and effort chosen in the composer for each turn. */
const CLAUDE_HIDDEN = new Set([...NEW_SESSION_COMMANDS, 'model', 'effort']);

export function claudeCommands(commands: SlashCommand[], terminalOnly: string[] = []): SlashCommandInfo[] {
  const hidden = new Set([...CLAUDE_HIDDEN, ...terminalOnly]);
  return [
    NEW_SESSION,
    ...commands
      .filter((command) => !command.name.startsWith('__') && !hidden.has(command.name))
      .map((command): SlashCommandInfo => ({
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint || undefined,
        aliases: command.aliases?.length ? command.aliases : undefined,
        source: command.builtin ? 'builtin' : 'custom',
      })),
  ];
}

/** Without a running engine to ask: custom commands and skills from disk, plus names a past turn reported. */
export function claudeFallback(catalog: Catalog, reported: string[] = []): SlashCommandInfo[] {
  const fromDisk: SlashCommandInfo[] = [
    ...catalog.commands.map((entry) => ({ name: entry.name, description: entry.description, source: 'custom' as const })),
    ...catalog.skills.map((entry) => ({ name: entry.name, description: entry.description, source: 'skill' as const })),
  ];
  const known = new Set(fromDisk.map((command) => command.name));
  const others = reported.filter((name) => !known.has(name) && !name.startsWith('__') && !CLAUDE_HIDDEN.has(name));
  return [NEW_SESSION, ...fromDisk, ...others.map((name) => ({ name, description: '', source: 'builtin' as const }))];
}

/**
 * Cursor runs its custom commands and skills when the prompt starts with `/name`; the built-in commands of its
 * terminal don't exist headless. It reads Claude Code's commands and skills too, plus its own under .cursor.
 */
export async function cursorCommands(home: string, cwd: string | null, catalog: Catalog, reported: string[] = []): Promise<SlashCommandInfo[]> {
  const roots = [join(home, '.cursor'), ...(cwd ? [join(cwd, '.cursor')] : [])];
  const commands = [...catalog.commands, ...(await Promise.all(roots.map((root) => markdownEntries(join(root, 'commands'), 'personal', 'Cursor')))).flat()];
  const skills = [...catalog.skills, ...(await Promise.all(roots.map((root) => skillsIn(join(root, 'skills'), 'personal', 'Cursor')))).flat()];
  const listed = new Map<string, SlashCommandInfo>();
  for (const entry of commands) if (!listed.has(entry.name)) listed.set(entry.name, { name: entry.name, description: entry.description, source: 'custom' });
  for (const entry of skills) if (!listed.has(entry.name)) listed.set(entry.name, { name: entry.name, description: entry.description, source: 'skill' });
  const others = reported.filter((name) => !listed.has(name) && !NEW_SESSION_COMMANDS.includes(name));
  return [NEW_SESSION, ...listed.values(), ...others.map((name): SlashCommandInfo => ({ name, description: '', source: 'custom' }))];
}

async function codexPromptFiles(home: string): Promise<{ name: string; file: string; content: string }[]> {
  const dir = join(home, 'prompts');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.md')).sort();
  return Promise.all(names.map(async (name) => ({ name: name.slice(0, -3), file: join(dir, name), content: await readFile(join(dir, name), 'utf8').catch(() => '') })));
}

export async function codexCommands(home: string, catalog: Catalog): Promise<SlashCommandInfo[]> {
  const prompts = (await codexPromptFiles(home)).map(({ name, content }): SlashCommandInfo => {
    const meta = parseFrontmatter(content);
    return { name: `prompts:${name}`, description: meta.description ?? '', argumentHint: meta['argument-hint'] || undefined, source: 'prompt' };
  });
  const skills = [...new Map(catalog.skills.map((entry) => [entry.name, entry])).values()].map(
    (entry): SlashCommandInfo => ({ name: entry.name, description: entry.description, source: 'skill', trigger: '$' }),
  );
  const templates = Object.entries(CODEX_TEMPLATES).map(([name, template]): SlashCommandInfo => ({ name, description: template.description, argumentHint: template.argumentHint, source: 'cooprompt' }));
  return [NEW_SESSION, ...templates, ...prompts, ...skills];
}

const LANGUAGE_NAME: Record<Language, string> = { en: 'English', es: 'Spanish' };

/** What Codex receives for a slash command it cannot run headless; null leaves the text as it is. */
export async function codexPrompt(command: { name: string; args: string }, home: string, language: Language = 'en'): Promise<string | null> {
  const template = CODEX_TEMPLATES[command.name];
  if (template) {
    const parts = [template.prompt, ...(command.args ? [`Focus on: ${command.args}`] : []), ...(language !== 'en' ? [`Answer in ${LANGUAGE_NAME[language]}.`] : [])];
    return parts.join('\n\n');
  }
  if (!command.name.startsWith('prompts:')) return null;
  const file = (await codexPromptFiles(home)).find((entry) => entry.name === command.name.slice('prompts:'.length));
  return file ? expandPrompt(file.content, command.args) : null;
}
