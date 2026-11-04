import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { Catalog, CatalogEntry, MemoryFile } from '../shared/types.ts';
import { tr } from './i18n.ts';

/** Minimal YAML frontmatter reader: `key: value`, quoted values and folded/literal blocks. */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const result: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
    if (!line) continue;
    let value = line[2].trim();
    if (value === '|' || value === '>' || value === '>-' || value === '|-') {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) block.push(lines[++index].trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n');
    }
    result[line[1]] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function mdFiles(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function skillsIn(root: string, scope: CatalogEntry['scope'], source: string): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  for (const name of await dirs(root)) {
    const file = join(root, name, 'SKILL.md');
    const content = await readFile(file, 'utf8').catch(() => null);
    if (content === null) continue;
    const meta = parseFrontmatter(content);
    entries.push({ name: meta.name || name, description: meta.description ?? '', path: file, scope, source });
  }
  return entries;
}

export async function markdownEntries(root: string, scope: CatalogEntry['scope'], source: string): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  for (const name of await mdFiles(root)) {
    const file = join(root, name);
    const meta = parseFrontmatter(await readFile(file, 'utf8').catch(() => ''));
    entries.push({ name: meta.name || name.replace(/\.md$/, ''), description: meta.description ?? '', path: file, scope, source });
  }
  return entries;
}

const home = () => homedir();

export async function buildCatalog(cwd: string | null): Promise<Catalog> {
  const h = home();
  const skillRoots: [string, CatalogEntry['scope'], string][] = [
    [join(h, '.claude/skills'), 'personal', 'Claude Code'],
    [join(h, '.agents/skills'), 'personal', 'Agents'],
    [join(h, '.codex/skills'), 'personal', 'Codex'],
  ];
  const agentRoots: [string, CatalogEntry['scope'], string][] = [[join(h, '.claude/agents'), 'personal', 'Claude Code']];
  const commandRoots: [string, CatalogEntry['scope'], string][] = [[join(h, '.claude/commands'), 'personal', 'Claude Code']];
  const memory: MemoryFile[] = [
    { label: 'Personal CLAUDE.md', path: join(h, '.claude/CLAUDE.md'), exists: false, scope: 'personal' },
    { label: 'Personal AGENTS.md (Codex)', path: join(h, '.codex/AGENTS.md'), exists: false, scope: 'personal' },
  ];
  if (cwd) {
    skillRoots.push([join(cwd, '.claude/skills'), 'workspace', 'Workspace'], [join(cwd, '.agents/skills'), 'workspace', 'Workspace'], [join(cwd, '.codex/skills'), 'workspace', 'Workspace']);
    agentRoots.push([join(cwd, '.claude/agents'), 'workspace', 'Workspace']);
    commandRoots.push([join(cwd, '.claude/commands'), 'workspace', 'Workspace']);
    memory.push(
      { label: 'Workspace AGENTS.md', path: join(cwd, 'AGENTS.md'), exists: false, scope: 'workspace' },
      { label: 'Workspace CLAUDE.md', path: join(cwd, 'CLAUDE.md'), exists: false, scope: 'workspace' },
    );
  }
  const collect = async (roots: typeof skillRoots, reader: typeof skillsIn) => (await Promise.all(roots.map(([root, scope, source]) => reader(root, scope, source)))).flat();
  return {
    cwd,
    skills: await collect(skillRoots, skillsIn),
    agents: await collect(agentRoots, markdownEntries),
    commands: await collect(commandRoots, markdownEntries),
    memory: memory.map((file) => ({ ...file, exists: existsSync(file.path) })),
  };
}

/** Editing is limited to agent configuration files under the personal or workspace roots. */
export function assertEditable(path: string, cwd: string | null): string {
  const target = resolve(path);
  const h = home();
  const allowedRoots = [join(h, '.claude'), join(h, '.agents'), join(h, '.codex')].map((root) => root + sep);
  const allowedFiles = [join(h, '.claude/CLAUDE.md'), join(h, '.codex/AGENTS.md')];
  if (cwd) {
    allowedRoots.push(...['.claude', '.agents', '.codex'].map((dir) => join(cwd, dir) + sep));
    allowedFiles.push(join(cwd, 'AGENTS.md'), join(cwd, 'CLAUDE.md'));
  }
  const ok = target.endsWith('.md') && (allowedFiles.includes(target) || allowedRoots.some((root) => target.startsWith(root)));
  if (!ok) throw new Error(tr('Only agent configuration .md files can be edited'));
  return target;
}

export async function writeCatalogFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const slug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'item';

const yamlString = (value: string) => JSON.stringify(value.replace(/\s+/g, ' ').trim());

export async function createSkill(root: string, input: { name: string; description: string; body: string }): Promise<CatalogEntry> {
  const name = slug(input.name);
  const file = join(root, name, 'SKILL.md');
  if (existsSync(file)) throw new Error(tr('A skill named {name} already exists', { name }));
  await writeCatalogFile(file, `---\nname: ${name}\ndescription: ${yamlString(input.description)}\n---\n\n${input.body.trim()}\n`);
  return { name, description: input.description, path: file, scope: 'personal', source: '' };
}

export async function createAgent(root: string, input: { name: string; description: string; prompt: string; tools?: string; model?: string }): Promise<CatalogEntry> {
  const name = slug(input.name);
  const file = join(root, `${name}.md`);
  if (existsSync(file)) throw new Error(tr('An agent named {name} already exists', { name }));
  const lines = [`name: ${name}`, `description: ${yamlString(input.description)}`];
  if (input.tools?.trim()) lines.push(`tools: ${input.tools.trim()}`);
  if (input.model?.trim()) lines.push(`model: ${input.model.trim()}`);
  await writeCatalogFile(file, `---\n${lines.join('\n')}\n---\n\n${input.prompt.trim()}\n`);
  return { name, description: input.description, path: file, scope: 'personal', source: '' };
}
