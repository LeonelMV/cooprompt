import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claudeLogin, claudeSignIn } from '../src/main/engines/claude.ts';
import { claudeBaseEnv, claudeEnv } from '../src/main/engines/providers.ts';
import type { ProviderProfile } from '../src/shared/types.ts';

let dir: string;
let shellEnv: Record<string, string>;

/**
 * Stand-in for Claude Code: `auth status --json` prints the status in $FAKE_CLAUDE_STATUS and, like Claude Code,
 * exits with 1 when nobody is signed in; `auth login` finishes the browser sign-in with $FAKE_CLAUDE_ACCOUNT. Every
 * call records its arguments and the names of the model credentials it was given.
 */
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cooprompt-claude-auth-'));
  await writeFile(
    join(dir, 'claude'),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_CLAUDE_CALLS"
env | grep -E '^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=' | cut -d= -f1 >> "$FAKE_CLAUDE_CREDENTIALS"
case "$*" in
  'auth status --json') cat "$FAKE_CLAUDE_STATUS"; grep -q '"loggedIn": true' "$FAKE_CLAUDE_STATUS" ;;
  'auth login') cp "$FAKE_CLAUDE_ACCOUNT" "$FAKE_CLAUDE_STATUS"; echo 'Login successful.' ;;
  *) exit 2 ;;
esac
`,
  );
  await chmod(join(dir, 'claude'), 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  shellEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    FAKE_CLAUDE_CALLS: join(dir, 'calls'),
    FAKE_CLAUDE_CREDENTIALS: join(dir, 'credentials'),
    FAKE_CLAUDE_STATUS: join(dir, 'status.json'),
    FAKE_CLAUDE_ACCOUNT: join(dir, 'account.json'),
  };
  await writeFile(shellEnv.FAKE_CLAUDE_CALLS, '');
  await writeFile(shellEnv.FAKE_CLAUDE_CREDENTIALS, '');
});

const SUBSCRIPTION = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'ana@acme.com', orgId: 'org-1', orgName: 'Acme', subscriptionType: 'max' };
const CONSOLE = { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: '/login managed key', email: 'ana@acme.com', orgId: 'org-1', orgName: 'Acme' };
const SIGNED_OUT = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' };

async function signedIn(status: object): Promise<void> {
  await writeFile(shellEnv.FAKE_CLAUDE_STATUS, JSON.stringify(status, null, 2));
}

const claude = () => ({ executable: join(dir, 'claude'), env: claudeBaseEnv(shellEnv, '1.0.0') });
const calls = async () => (await readFile(shellEnv.FAKE_CLAUDE_CALLS, 'utf8')).trim().split('\n');

describe('the Claude Code sign-in on this Mac', () => {
  it('reports the Claude subscription Claude Code is signed in with', async () => {
    await signedIn(SUBSCRIPTION);
    expect(await claudeSignIn(claude())).toEqual({ loggedIn: true, method: 'claude.ai', plan: 'max', provider: 'firstParty', email: 'ana@acme.com', organization: 'Acme' });
    expect(await calls()).toEqual(['auth status --json']);
  });

  it('tells an Anthropic Console sign-in apart from a subscription', async () => {
    await signedIn(CONSOLE);
    expect(await claudeSignIn(claude())).toEqual({
      loggedIn: true,
      method: 'api_key',
      apiKeySource: '/login managed key',
      provider: 'firstParty',
      email: 'ana@acme.com',
      organization: 'Acme',
    });
  });

  it('reports a Mac where Claude Code is not signed in, or cannot be asked', async () => {
    await signedIn(SIGNED_OUT);
    expect(await claudeSignIn(claude())).toEqual({ loggedIn: false, method: 'none', provider: 'firstParty' });
    expect(await claudeSignIn({ ...claude(), executable: join(dir, 'missing') })).toEqual({ loggedIn: false, method: 'none' });
  });

  it("signs in with Claude Code's own browser sign-in and reports the account it ends up with", async () => {
    await signedIn(SIGNED_OUT);
    await writeFile(shellEnv.FAKE_CLAUDE_ACCOUNT, JSON.stringify(SUBSCRIPTION, null, 2));
    expect(await claudeLogin(claude())).toMatchObject({ loggedIn: true, method: 'claude.ai', plan: 'max' });
    expect(await calls()).toEqual(['auth login', 'auth status --json']);
  });

  it('leaves the model credentials of the shell out, so Claude Code uses its own sign-in', async () => {
    await signedIn(SUBSCRIPTION);
    Object.assign(shellEnv, { ANTHROPIC_API_KEY: 'from-the-shell', ANTHROPIC_AUTH_TOKEN: 'from-the-shell', CLAUDE_CODE_OAUTH_TOKEN: 'from-the-shell' });
    const profile: ProviderProfile = { id: 'claude', label: 'Claude', engine: 'claude', kind: 'claude-login', createdAt: 0 };
    expect(claudeEnv(profile, null, shellEnv, '1.0.0')).toEqual(claude().env);
    await claudeSignIn(claude());
    expect((await readFile(shellEnv.FAKE_CLAUDE_CREDENTIALS, 'utf8')).trim()).toBe('');
  });
});
