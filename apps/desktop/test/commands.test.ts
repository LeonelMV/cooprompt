import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expandPrompt, matchCommands, parseSlash } from '../src/shared/commands.ts';
import { claudeCommands, codexCommands, codexPrompt, cursorCommands } from '../src/main/commands.ts';
import type { Catalog } from '../src/shared/types.ts';

let home: string;
const catalog: Catalog = {
  cwd: null,
  skills: [{ name: 'caveman', description: 'Talk like a caveman', path: '/x/SKILL.md', scope: 'personal', source: 'Agents' }],
  agents: [],
  commands: [],
  memory: [],
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'cooprompt-codex-'));
  await mkdir(join(home, 'prompts'), { recursive: true });
  await writeFile(join(home, 'prompts/fix.md'), '---\ndescription: Fix an issue\nargument-hint: <issue> [FILE=path]\n---\nFix issue $1 in $FILE. Notes: $ARGUMENTS. Costs $$5.\n');
  await writeFile(join(home, 'prompts/plain.md'), 'Explain the architecture.');
  await mkdir(join(home, '.cursor/commands'), { recursive: true });
  await writeFile(join(home, '.cursor/commands/ship.md'), '---\ndescription: Ship the branch\n---\nOpen a pull request.');
  await mkdir(join(home, 'repo/.cursor/skills/lint'), { recursive: true });
  await writeFile(join(home, 'repo/.cursor/skills/lint/SKILL.md'), '---\nname: lint\ndescription: Fix lint errors\n---\nRun the linter.');
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('slash commands', () => {
  it('parses a command and its arguments only at the start of the message', () => {
    expect(parseSlash('/prompts:fix 42 FILE=src/a.ts')).toEqual({ name: 'prompts:fix', args: '42 FILE=src/a.ts' });
    expect(parseSlash('  /compact  keep the plan ')).toEqual({ name: 'compact', args: 'keep the plan' });
    expect(parseSlash('hola /compact')).toBeNull();
  });

  it('fills Codex custom prompts like the Codex CLI', () => {
    expect(expandPrompt('---\ndescription: x\n---\nFix issue $1 in $FILE. Notes: $ARGUMENTS. Costs $$5.', '42 "login flow" FILE=src/a.ts')).toBe(
      'Fix issue 42 in src/a.ts. Notes: 42 "login flow" FILE=src/a.ts. Costs $5.',
    );
    expect(expandPrompt('Explain the architecture.', 'focus on sync')).toBe('Explain the architecture.\n\nfocus on sync');
  });

  it('ranks prefix matches first and finds commands by alias', () => {
    const list = [
      { name: 'compact', description: 'Free up context', source: 'builtin' as const },
      { name: 'context', description: 'Show context usage', source: 'builtin' as const },
      { name: 'new', aliases: ['clear', 'reset'], description: 'Start a new session', source: 'cooprompt' as const },
    ];
    expect(matchCommands(list, 'co').map((command) => command.name)).toEqual(['compact', 'context']);
    expect(matchCommands(list, 'cle').map((command) => command.name)).toEqual(['new']);
    expect(matchCommands(list, 'usage').map((command) => command.name)).toEqual(['context']);
  });

  it('turns Codex commands it cannot run headless into prompts', async () => {
    expect(await codexPrompt({ name: 'prompts:fix', args: '7 FILE=b.ts' }, home)).toBe('Fix issue 7 in b.ts. Notes: 7 FILE=b.ts. Costs $5.');
    expect(await codexPrompt({ name: 'review', args: '' }, home)).toMatch(/^Review the current code changes[^\n]*$/);
    expect(await codexPrompt({ name: 'review', args: 'auth' }, home, 'es')).toMatch(/\n\nFocus on: auth\n\nAnswer in Spanish\.$/);
    expect(await codexPrompt({ name: 'unknown', args: '' }, home)).toBeNull();
  });

  it('offers each engine the commands that work in CooPrompt', async () => {
    const codex = await codexCommands(home, catalog);
    expect(codex.map((command) => `${command.trigger ?? '/'}${command.name}`)).toEqual(['/new', '/review', '/init', '/prompts:fix', '/prompts:plain', '$caveman']);
    expect(codex.find((command) => command.name === 'prompts:fix')).toMatchObject({ description: 'Fix an issue', argumentHint: '<issue> [FILE=path]' });

    const claude = claudeCommands(
      [
        { name: 'compact', description: 'Free up context', argumentHint: '<instructions>', builtin: true },
        { name: 'clear', description: 'Clear', argumentHint: '', aliases: ['reset', 'new'], builtin: true },
        { name: 'model', description: 'Set the model', argumentHint: '<model>', builtin: true },
        { name: 'color', description: 'Prompt bar color', argumentHint: '', builtin: true },
        { name: '__remote-workflow', description: 'internal', argumentHint: '', builtin: true },
        { name: 'hello', description: 'Say hello (project)', argumentHint: '<name>' },
      ],
      ['color'],
    );
    expect(claude.map((command) => [command.name, command.source])).toEqual([
      ['new', 'cooprompt'],
      ['compact', 'builtin'],
      ['hello', 'custom'],
    ]);

    const cursor = await cursorCommands(home, join(home, 'repo'), catalog, ['ship', 'deploy', 'clear']);
    expect(cursor.map((command) => [command.name, command.source])).toEqual([
      ['new', 'cooprompt'],
      ['ship', 'custom'],
      ['caveman', 'skill'],
      ['lint', 'skill'],
      ['deploy', 'custom'],
    ]);
    expect(cursor.find((command) => command.name === 'ship')?.description).toBe('Ship the branch');
  });
});
