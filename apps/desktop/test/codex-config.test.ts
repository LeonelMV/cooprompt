import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ItemUpsert, PermissionModeId } from '@cooprompt/protocol';
import type { CodexApprovalScope } from '../src/main/connector-sources.ts';
import { runCodex } from '../src/main/engines/codex.ts';
import type { McpServerSpec } from '../src/main/engines/types.ts';
import { translateMessage } from '../src/shared/i18n.ts';

let dir: string;

const mcpServers: Record<string, McpServerSpec> = {
  playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {} },
  'plugin:Notion:notion': { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer t' } },
};

/** What Codex loads on its own, with tools the user approved one by one ("Allow and don't ask me again"). */
const approvalScopes: CodexApprovalScope[] = [
  { path: ['mcp_servers', 'rea'], tools: ['set_comment'] },
  { path: ['plugins', 'reviewer@market', 'mcp_servers', 'review'], tools: ['post_review'] },
  { path: ['apps', '_default'], tools: [] },
  { path: ['apps', 'asdk_app_slack'], tools: ['slack_send_message'] },
  { path: ['apps', 'asdk_app_slack', 'links', 'link_work'], tools: [] },
  { path: ['plugins', 'dotted.name@market', 'mcp_servers', 'helper'], tools: [] },
];

/** The approval mode each flag sets, by the flag's path. */
const approvals = (config: string[]) =>
  Object.fromEntries(config.filter((flag) => /\.(default_tools_approval_mode|approval_mode)=/.test(flag)).map((flag) => flag.split('=') as [string, string]));

/** Stand-in for the Codex binary: it records its arguments and prompt, replays the given events and completes the turn. */
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cooprompt-codex-exec-'));
  await writeFile(
    join(dir, 'codex'),
    `#!/bin/bash
printf '%s\\n' "$@" > "$FAKE_CODEX_ARGS"
cat > "$FAKE_CODEX_PROMPT"
echo '{"type":"thread.started","thread_id":"thread-1"}'
if [ -n "$FAKE_CODEX_EVENTS" ]; then cat "$FAKE_CODEX_EVENTS"; fi
echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
`,
  );
  await chmod(join(dir, 'codex'), 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Runs a turn with CooPrompt's connectors and what Codex loads on its own; returns the result, the --config flags
 * and the prompt Codex got, and the items the turn published.
 */
async function launch(permissionMode: PermissionModeId, options: { events?: unknown[]; sessionId?: string } = {}) {
  const events = join(dir, 'events.jsonl');
  await writeFile(events, (options.events ?? []).map((event) => `${JSON.stringify(event)}\n`).join(''));
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    CODEX_HOME: dir,
    FAKE_CODEX_ARGS: join(dir, 'args'),
    FAKE_CODEX_PROMPT: join(dir, 'prompt'),
    FAKE_CODEX_EVENTS: events,
  };
  const items: (Omit<ItemUpsert, 'id'> & { key: string })[] = [];
  const result = await runCodex({
    cwd: dir,
    prompt: 'hi',
    attachments: [],
    nativeMedia: true,
    preamble: null,
    systemAppend: '',
    model: null,
    effort: null,
    sessionId: options.sessionId ?? null,
    permissionMode,
    env,
    mcpServers,
    signal: new AbortController().signal,
    sink: { item: (key, item) => items.push({ key, ...item }), draft: () => {}, delta: () => {}, info: () => {}, attach: () => {} },
    requestPermission: async () => ({ allow: false }),
    askQuestion: async () => null,
    log: () => {},
    executable: join(dir, 'codex'),
    setup: { config: {}, env },
    nativeMcpServers: [],
    approvalScopes,
  });
  const args = (await readFile(join(dir, 'args'), 'utf8')).trim().split('\n');
  const prompt = await readFile(join(dir, 'prompt'), 'utf8');
  return { result, config: args.filter((_arg, index) => args[index - 1] === '--config'), prompt, items };
}

describe('connectors given to Codex', () => {
  it('gives slow connectors time to start without letting any of them block the turn', async () => {
    const { result, config } = await launch('default');
    expect(result.status).toBe('done');
    expect(config).toEqual(
      expect.arrayContaining([
        'mcp_optional_startup_grace_ms=20000',
        'mcp_servers.playwright.command="npx"',
        'mcp_servers.playwright.args=["-y", "@playwright/mcp@latest"]',
        'mcp_servers.plugin_Notion_notion.url="https://mcp.notion.com/mcp"',
        'mcp_servers.plugin_Notion_notion.http_headers.Authorization="Bearer t"',
      ]),
    );
    expect(config.filter((flag) => flag.includes('.required='))).toEqual([]);
  });

  it('approves the tools of every server and app up front outside Plan mode, keeping what the user set for single tools', async () => {
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      const { config } = await launch(mode);
      expect(approvals(config)).toEqual({
        'mcp_servers.rea.default_tools_approval_mode': '"approve"',
        'plugins.reviewer@market.mcp_servers.review.default_tools_approval_mode': '"approve"',
        'apps._default.default_tools_approval_mode': '"approve"',
        'apps.asdk_app_slack.default_tools_approval_mode': '"approve"',
        'apps.asdk_app_slack.links.link_work.default_tools_approval_mode': '"approve"',
        'mcp_servers.playwright.default_tools_approval_mode': '"approve"',
        'mcp_servers.plugin_Notion_notion.default_tools_approval_mode': '"approve"',
      });
      // Merged into the user's own entries: nothing else of theirs is restated, and names Codex can't address are left alone.
      expect(config.filter((flag) => /^(mcp_servers\.rea|plugins|apps)\./.test(flag))).toHaveLength(5);
      expect(config.filter((flag) => flag.includes('dotted'))).toEqual([]);
    }
  });

  it('keeps Plan mode read-only for every server and app, even for single tools the user approved for good', async () => {
    const { config } = await launch('plan');
    expect(config).toContain('mcp_optional_startup_grace_ms=20000');
    expect(approvals(config)).toEqual({
      'mcp_servers.rea.default_tools_approval_mode': '"writes"',
      'mcp_servers.rea.tools.set_comment.approval_mode': '"writes"',
      'plugins.reviewer@market.mcp_servers.review.default_tools_approval_mode': '"writes"',
      'plugins.reviewer@market.mcp_servers.review.tools.post_review.approval_mode': '"writes"',
      'apps._default.default_tools_approval_mode': '"writes"',
      'apps.asdk_app_slack.default_tools_approval_mode': '"writes"',
      'apps.asdk_app_slack.tools.slack_send_message.approval_mode': '"writes"',
      'apps.asdk_app_slack.links.link_work.default_tools_approval_mode': '"writes"',
      'mcp_servers.playwright.default_tools_approval_mode': '"writes"',
      'mcp_servers.plugin_Notion_notion.default_tools_approval_mode': '"writes"',
    });
  });
});

/** What gh prints inside the sandbox for an account that is signed in, because it can't read the Keychain. */
const ghInSandbox = {
  type: 'item.completed',
  item: {
    id: 'item_1',
    type: 'command_execution',
    command: "/bin/zsh -lc 'gh pr create --fill'",
    aggregated_output: 'github.com\n  X Failed to log in to github.com account ana (default)\n  - The token in default is invalid.\n',
    exit_code: 1,
    status: 'failed',
  },
};

describe('what Codex is told about running inside CooPrompt', () => {
  it("tells a new session what the sandbox can't do and that nobody can answer it mid-turn", async () => {
    const { prompt } = await launch('default');
    expect(prompt).toContain("can't read the macOS Keychain");
    expect(prompt).toContain('request_user_input gets no reply');
    expect(prompt.trimEnd().endsWith('hi')).toBe(true);
  });

  it('leaves out the sandbox limits without a sandbox, and repeats nothing when a session resumes', async () => {
    const unsandboxed = await launch('bypassPermissions');
    expect(unsandboxed.prompt).toContain('request_user_input gets no reply');
    expect(unsandboxed.prompt).not.toContain('Keychain');
    const resumed = await launch('default', { sessionId: 'thread-1' });
    expect(resumed.prompt.trim()).toBe('hi');
  });

  it("explains with a notice that gh can't read its sign-in inside the sandbox, once per turn", async () => {
    const { items } = await launch('default', { events: [ghInSandbox, { ...ghInSandbox, item: { ...ghInSandbox.item, id: 'item_2' } }] });
    expect(items.filter((item) => item.kind === 'tool').map((item) => (item.data as { status: string }).status)).toEqual(['error', 'error']);
    const notices = items.filter((item) => item.kind === 'notice');
    expect(new Set(notices.map((item) => item.key)).size).toBe(1);
    expect(notices[0].data).toEqual({ text: expect.stringContaining('SSH remotes'), level: 'warn' });
    expect(translateMessage('es', (notices[0].data as { text: string }).text)).toContain('remotos SSH');
  });

  it('keeps quiet about the Keychain when gh fails without a sandbox', async () => {
    const { items } = await launch('bypassPermissions', { events: [ghInSandbox] });
    expect(items.filter((item) => item.kind === 'notice')).toEqual([]);
  });
});
