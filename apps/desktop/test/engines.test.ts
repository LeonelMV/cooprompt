import { describe, expect, it } from 'vitest';
import { engineName, ENGINE_PERMISSION_MODES, permissionModeFor } from '../src/shared/engines.ts';
import { engineBadge } from '../src/renderer/src/lib/format.ts';

describe('engines', () => {
  it('shows turns of engines this app does not know yet instead of failing', () => {
    expect(engineName('cursor')).toBe('Cursor');
    expect(engineName('gemini')).toBe('gemini');
    expect(engineBadge('cursor').text).toBe('Cu');
    expect(engineBadge('gemini')).toEqual(engineBadge('claude'));
  });

  it('offers each engine only the permission modes it honors', () => {
    expect(ENGINE_PERMISSION_MODES.claude).toHaveLength(5);
    expect(ENGINE_PERMISSION_MODES.cursor).toEqual(['acceptEdits', 'plan', 'bypassPermissions']);
    expect(permissionModeFor('cursor', 'default')).toBe('acceptEdits');
    expect(permissionModeFor('cursor', 'auto')).toBe('acceptEdits');
    expect(permissionModeFor('cursor', 'plan')).toBe('plan');
    expect(permissionModeFor('codex', 'auto')).toBe('auto');
  });
});
