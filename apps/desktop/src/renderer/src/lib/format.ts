import type { ChatKind, EngineId, PermissionModeId, TurnUsage } from '@cooprompt/protocol';
import type { T } from './i18n.ts';

const ENGINE_BADGE: Record<EngineId, { text: string; className: string }> = {
  claude: { text: 'C', className: 'bg-accent text-on-accent' },
  codex: { text: 'Cx', className: 'bg-[#3d6fd1] text-white' },
  cursor: { text: 'Cu', className: 'bg-[#e8e6e1] text-[#14120b]' },
};

/** The initials and colors of an engine's avatar; engines this app doesn't know look like Claude's. */
export const engineBadge = (engine: string | undefined) => ENGINE_BADGE[engine as EngineId] ?? ENGINE_BADGE.claude;

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

const PALETTE = ['#d97757', '#6f9fd8', '#7bb37f', '#c58ad6', '#d6b15a', '#5fb8b0', '#e07c9c', '#9a8cf0'];

export function colorFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function timeAgo(timestamp: number, t: T): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 45) return t('just now');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('{n} min ago', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('{n} h ago', { n: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return t('{n} d ago', { n: days });
  return new Date(timestamp).toLocaleDateString(t.locale, { day: 'numeric', month: 'short' });
}

export function clock(timestamp: number, t: T): string {
  return new Date(timestamp).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' });
}

/** The one-line installer: the script talks to the teammate in the language of whoever sends it. */
export function installCommand(url: string, t: T): string {
  return `curl -fsSL ${url}/${t.language === 'es' ? 'instalar' : 'install'} | bash`;
}

export const KIND_LABEL: Record<ChatKind, string> = {
  private: 'Private',
  multiplayer: 'Multiplayer',
  corporate: 'Company',
};

export const PERMISSION_LABEL: Record<PermissionModeId, string> = {
  default: 'Ask before acting',
  acceptEdits: 'Accept edits',
  auto: 'Automatic (classifier)',
  plan: 'Plan only',
  bypassPermissions: 'No restrictions',
};

/** Rounded share of the context window in use, or null when the executor did not report it. */
export function contextShare(usage: TurnUsage | null | undefined): number | null {
  if (!usage || typeof usage.contextTokens !== 'number') return null;
  if (!usage.contextWindow) return usage.contextTokens === 0 ? 0 : null;
  return Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100));
}

export function tokens(count: number, t: T): string {
  return count.toLocaleString(t.locale);
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Short human summary of a tool call input for compact rows. */
export function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const value = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) if (typeof value[key] === 'string' && value[key]) return String(value[key]);
    return '';
  };
  if (name === 'Bash') return pick('command');
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return pick('file_path', 'notebook_path');
  if (name === 'Grep' || name === 'Glob') return pick('pattern');
  if (name === 'WebFetch') return pick('url');
  if (name === 'WebSearch') return pick('query');
  if (name === 'Agent' || name === 'Task') return pick('description', 'prompt');
  if (name === 'Skill') return pick('skill', 'command', 'name');
  if (name === 'ApplyPatch' && Array.isArray(value.changes)) return (value.changes as { path: string }[]).map((change) => change.path).join(', ');
  return pick('description', 'path', 'query', 'command', 'name') || JSON.stringify(input).slice(0, 120);
}

export function toolLabel(name: string): string {
  if (name.startsWith('mcp__')) {
    const [, server, ...tool] = name.split('__');
    return `${server} · ${tool.join('__')}`;
  }
  return name;
}
