import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexSetup } from '../src/main/engines/providers.ts';
import { codexNotes } from '../src/main/engines/codex.ts';
import { findCursorAgent } from '../src/main/engines/cursor.ts';
import { loadShellEnv } from '../src/main/shell-env.ts';

describe('agent environment', () => {
  it('adds the bundled executable directory using the platform path separator', () => {
    const profile = { id: 'codex', label: 'Codex', engine: 'codex' as const, kind: 'codex-login' as const, createdAt: 0 };
    const setup = codexSetup(profile, null, { PATH: 'existing-path' }, ['bundled-tools']);
    expect(setup.env.PATH).toBe(['bundled-tools', 'existing-path'].join(delimiter));
  });

  it.skipIf(process.platform !== 'win32')('keeps the inherited Windows path under a single key', async () => {
    const env = await loadShellEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['PATH']);
  });

  it('finds Cursor in a path containing platform-separated directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cooprompt-cursor-path-'));
    try {
      const executable = join(dir, process.platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent');
      await writeFile(executable, '');
      await chmod(executable, 0o755);
      expect(findCursorAgent({ PATH: ['missing-directory', dir].join(delimiter) })).toBe(executable);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('only tells Codex about the macOS keychain limitation on macOS', () => {
    expect(codexNotes('workspace-write', 'win32')).not.toContain('macOS Keychain');
    expect(codexNotes('workspace-write', 'darwin')).toContain('macOS Keychain');
    expect(codexNotes('danger-full-access', 'darwin')).not.toContain('macOS Keychain');
  });
});
