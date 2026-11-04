import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IgnoreRules } from '../src/main/sync/ignore-rules.ts';

describe('workspace sync exclusions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cooprompt-ignore-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps hidden attachment copies and temporary files local without excluding git data', () => {
    const rules = new IgnoreRules(dir);
    expect(rules.isIgnored('.cache/attachments/private.txt', false)).toBe(true);
    expect(rules.isIgnored('.cache-tmp-123', false)).toBe(true);
    expect(rules.isIgnored('.cooprompt/attachments/private.txt', false)).toBe(true);
    expect(rules.isIgnored('.git/config', false)).toBe(false);
    expect(rules.isIgnored('attachments/shared.txt', false)).toBe(false);
  });
});
