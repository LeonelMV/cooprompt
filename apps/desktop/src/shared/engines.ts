import type { EngineId, PermissionModeId } from '@cooprompt/protocol';

export const ENGINE_NAME: Record<EngineId, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

/** Turns can come from apps that know engines this one doesn't. */
export const engineName = (engine: string | undefined): string => ENGINE_NAME[engine as EngineId] ?? engine ?? ENGINE_NAME.claude;

const ALL_MODES: readonly PermissionModeId[] = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];

/**
 * The permission modes each engine can honor. Cursor applies edits inside the working folder without asking and has
 * no classifier mode, so it offers neither "Ask before acting" nor "Automatic".
 */
export const ENGINE_PERMISSION_MODES: Record<EngineId, readonly PermissionModeId[]> = {
  claude: ALL_MODES,
  codex: ALL_MODES,
  cursor: ['acceptEdits', 'plan', 'bypassPermissions'],
};

/** A chat's mode for an engine that lacks it becomes that engine's everyday mode. */
export function permissionModeFor(engine: EngineId, mode: PermissionModeId): PermissionModeId {
  return (ENGINE_PERMISSION_MODES[engine] ?? ALL_MODES).includes(mode) ? mode : 'acceptEdits';
}
