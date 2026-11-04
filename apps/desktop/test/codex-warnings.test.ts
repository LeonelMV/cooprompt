import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@cooprompt/protocol';
import { deduplicateCodexWarnings, isCodexWarning } from '../src/renderer/src/lib/codex-warnings.ts';

describe('Codex diagnostics', () => {
  const config = 'Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\nuser: `features.rmcp_client` is ignored.';
  const metadata = 'Model metadata for `gpt-6.1-terra` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';
  const item = (id: string, message: string): TranscriptItem => ({ id, kind: 'error', data: { message } } as TranscriptItem);

  it('distinguishes advisory diagnostics from actual errors', () => {
    expect(isCodexWarning(config)).toBe(true);
    expect(isCodexWarning(metadata)).toBe(true);
    expect(isCodexWarning('The model request failed.')).toBe(false);
  });

  it('keeps one instance of a repeated advisory without removing real errors', () => {
    const items = [item('a', config), item('b', config), item('c', metadata), item('d', 'The model request failed.'), item('e', 'The model request failed.')];
    expect(deduplicateCodexWarnings(items).map((entry) => entry.id)).toEqual(['a', 'c', 'd', 'e']);
  });
});
