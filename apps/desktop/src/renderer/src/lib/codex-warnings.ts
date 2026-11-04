import type { TranscriptItem } from '@cooprompt/protocol';

/** These Codex diagnostics are advisory: a turn can still complete successfully. */
export function isCodexWarning(message: string): boolean {
  return /^Codex is ignoring \d+ unrecognized configuration settings?\./.test(message)
    || /^Model metadata for .+ not found\. Defaulting to fallback metadata/.test(message);
}

/** Keep one copy of identical diagnostics, without hiding distinct errors or other items. */
export function deduplicateCodexWarnings(items: TranscriptItem[]): TranscriptItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const message = item.kind === 'error' ? (item.data as { message?: unknown }).message : null;
    if (typeof message !== 'string' || !isCodexWarning(message)) return true;
    if (seen.has(message)) return false;
    seen.add(message);
    return true;
  });
}
