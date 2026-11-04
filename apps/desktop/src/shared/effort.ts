import type { EngineId } from '@cooprompt/protocol';

/** Engines with a fixed set of levels: the Claude Agent SDK `EffortLevel` and the Codex SDK `ModelReasoningEffort`. Cursor models list their own. */
export type FixedEffortEngine = Exclude<EngineId, 'cursor'>;

export const ENGINE_EFFORTS: Record<FixedEffortEngine, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
};

/** Offered when the model does not list its own levels; none for Cursor, whose models without levels have no effort to choose. */
export const DEFAULT_EFFORT_CHOICES: Record<EngineId, readonly string[]> = {
  claude: ENGINE_EFFORTS.claude,
  codex: ['low', 'medium', 'high', 'xhigh'],
  cursor: [],
};

export const EFFORT_LABEL: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
  persistent: 'Persistent',
};

export function engineEffort(engine: FixedEffortEngine, effort: string | null | undefined): string | undefined {
  return effort && ENGINE_EFFORTS[engine].includes(effort) ? effort : undefined;
}
