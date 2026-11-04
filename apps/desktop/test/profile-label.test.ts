import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Settings } from '../src/main/settings.ts';
import { currentProfileLabel } from '../src/shared/profile-label.ts';

describe('built-in profile labels', () => {
  it('updates old labels in saved settings without changing custom labels', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cooprompt-profiles-'));
    const file = join(dir, 'settings.json');
    const old = 'Codex · ChatGPT sign-in on this Mac';
    const custom = 'My Mac research profile';
    try {
      await writeFile(file, JSON.stringify({ profiles: [
        { id: 'one', label: old, engine: 'codex', kind: 'codex-login', createdAt: 1 },
        { id: 'two', label: custom, engine: 'codex', kind: 'codex-login', createdAt: 2 },
      ] }));
      const settings = new Settings(file, { syncRoot: dir, privateRoot: dir });
      expect(settings.data.profiles.map((profile) => profile.label)).toEqual(['Codex · ChatGPT sign-in on this computer', custom]);
      const saved = JSON.parse(await readFile(file, 'utf8')) as { profiles: { label: string }[] };
      expect(saved.profiles[0].label).toBe('Codex · ChatGPT sign-in on this computer');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('updates earlier turn labels and Spanish preset labels for display', () => {
    expect(currentProfileLabel('Codex · ChatGPT sign-in on this Mac · gpt-6.1-terra')).toBe('Codex · ChatGPT sign-in on this computer · gpt-6.1-terra');
    expect(currentProfileLabel('Codex · sesión de ChatGPT de esta Mac')).toBe('Codex · sesión de ChatGPT de esta computadora');
    expect(currentProfileLabel('Custom Mac label')).toBe('Custom Mac label');
  });
});
