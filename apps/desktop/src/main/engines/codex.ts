import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Codex, type Input, type ModelReasoningEffort, type SandboxMode, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk';
import type { PermissionModeId, TurnUsage } from '@cooprompt/protocol';
import { engineEffort } from '../../shared/effort.ts';
import type { CodexApprovalScope } from '../connector-sources.ts';
import type { CodexSetup } from './providers.ts';
import { clip, type EngineMedia, type EngineRunInput, type EngineRunResult } from './types.ts';

/** Codex attaches these as images (`--image`, resized by Codex itself); PDFs and the rest go by path. */
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const codexHome = (env: Record<string, string>): string => env.CODEX_HOME || join(homedir(), '.codex');

const rollouts = new Map<string, string>();

/** Codex persists each thread as sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl. */
async function findRollout(root: string, threadId: string): Promise<string | null> {
  const known = rollouts.get(threadId);
  if (known) return known;
  const newestFirst = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort().reverse();
  for (const year of await newestFirst(root)) {
    for (const month of await newestFirst(join(root, year))) {
      for (const day of await newestFirst(join(root, year, month))) {
        const name = (await newestFirst(join(root, year, month, day))).find((entry) => entry.endsWith(`${threadId}.jsonl`));
        if (!name) continue;
        const file = join(root, year, month, day, name);
        rollouts.set(threadId, file);
        return file;
      }
    }
  }
  return null;
}

/** The thread's last token_count event: what it holds now and the model's usable window, as Codex reports them. */
async function contextUsage(home: string, threadId: string): Promise<Pick<TurnUsage, 'contextTokens' | 'contextWindow'>> {
  const file = await findRollout(join(home, 'sessions'), threadId);
  if (!file) return {};
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index].includes('"token_count"')) continue;
      try {
        const info = JSON.parse(lines[index]).payload?.info;
        const tokens = info?.last_token_usage?.total_tokens;
        if (typeof tokens === 'number' && typeof info.model_context_window === 'number') return { contextTokens: tokens, contextWindow: info.model_context_window };
      } catch {
        // the first line of the window may be cut
      }
    }
    return {};
  } finally {
    await handle.close();
  }
}

const SANDBOX: Record<PermissionModeId, SandboxMode> = {
  plan: 'read-only',
  default: 'workspace-write',
  acceptEdits: 'workspace-write',
  auto: 'workspace-write',
  bypassPermissions: 'danger-full-access',
};

/** Codex config keys only accept simple identifiers for MCP server names. */
const serverKey = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Codex starts the turn without waiting for its MCP servers and silently leaves out any still starting, as
 * npx servers often are. The grace makes the first model call wait for them. Servers that fail or need
 * sign-in don't hold it up and are just left out, so no connector can block a turn; one that hangs delays
 * the turn by the grace.
 */
const MCP_STARTUP_GRACE_MS = 20_000;

/** `-c` overrides name tables by dotted paths that Codex splits at every dot without reading quotes. */
const CONFIG_SEGMENT = /^[^.=\s]+$/;

function setPath(config: Record<string, unknown>, path: string[], value: unknown): void {
  let table = config;
  for (const segment of path.slice(0, -1)) {
    const next = table[segment];
    table = (typeof next === 'object' && next !== null && !Array.isArray(next) ? next : (table[segment] = {})) as Record<string, unknown>;
  }
  table[path[path.length - 1]] = value;
}

/**
 * CooPrompt can't answer Codex's approval prompts, and Codex refuses any MCP tool call that needs one when it can't
 * ask. So the permission mode decides for every server and app Codex uses: those CooPrompt passes and, merged into
 * the user's own settings for this turn only, those of their config.toml, their plugins and their ChatGPT apps.
 * Outside Plan mode their tools are approved up front, while a tool's own approval stays as the user set it.
 * In Plan mode only tools marked read-only run, even where the user's settings approve more.
 */
function mcpOverrides(input: Pick<EngineRunInput, 'mcpServers' | 'permissionMode'>, scopes: CodexApprovalScope[]): Record<string, unknown> {
  const plan = input.permissionMode === 'plan';
  const mode = plan ? 'writes' : 'approve';
  const config: Record<string, unknown> = { mcp_optional_startup_grace_ms: MCP_STARTUP_GRACE_MS };
  for (const scope of scopes) {
    if (!scope.path.every((segment) => CONFIG_SEGMENT.test(segment))) continue;
    setPath(config, [...scope.path, 'default_tools_approval_mode'], mode);
    if (plan) for (const tool of scope.tools.filter((name) => CONFIG_SEGMENT.test(name))) setPath(config, [...scope.path, 'tools', tool, 'approval_mode'], mode);
  }
  for (const [name, spec] of Object.entries(input.mcpServers)) {
    const fields =
      spec.type === 'stdio'
        ? {
            command: spec.command,
            args: spec.args,
            ...(Object.keys(spec.env).length ? { env: spec.env } : {}),
            ...(spec.cwd ? { cwd: spec.cwd } : {}),
            ...(spec.envVars?.length ? { env_vars: spec.envVars } : {}),
          }
        : { url: spec.url, ...(Object.keys(spec.headers).length ? { http_headers: spec.headers } : {}) };
    for (const [key, value] of Object.entries({ ...fields, default_tools_approval_mode: mode })) setPath(config, ['mcp_servers', serverKey(name), key], value);
  }
  return config;
}

/**
 * Limits the agent can't see from inside a CooPrompt turn and tends to misreport, such as telling the user
 * that a GitHub sign-in that works in their terminal has expired. Sent once, when a session starts.
 */
export function codexNotes(sandbox: SandboxMode, platform = process.platform): string {
  const notes = [
    'Nobody can answer approval prompts or questions during your turn here: Browser Use and Computer Use origin approvals are declined automatically and request_user_input gets no reply. Use other tools (such as the browser connectors) and ask your questions in your final message.',
  ];
  if (sandbox !== 'danger-full-access' && platform === 'darwin') {
    notes.push(
      "Codex's sandbox can't read the macOS Keychain, so gh and git over HTTPS fail as if signed out even when the user is signed in: don't ask them to sign in again. Use SSH remotes for git and the GitHub connector when you have it; when gh is required, ask the user to resend the message with the “No restrictions” permission mode.",
      'The sandbox also blocks servers that need shared memory (such as a local PostgreSQL) and listing or stopping processes started by earlier commands (ps, kill).',
    );
  }
  return notes.join('\n');
}

/** How gh, git's credential helper and `security` fail when the sandbox keeps them from the Keychain. */
const KEYCHAIN_FAILURE = /token in default is invalid|gh: Requires authentication \(HTTP 401\)|could not read Username for 'https:\/\/|Module Directory Service error/;
const KEYCHAIN_NOTICE = "Codex's sandbox can't read the macOS Keychain, so gh and git over HTTPS fail as if signed out. Use SSH remotes for git, or resend the message with the “No restrictions” permission mode.";

function publish(input: EngineRunInput, item: ThreadItem, sandboxed: boolean): void {
  switch (item.type) {
    case 'agent_message':
      if (item.text.trim()) input.sink.item(item.id, { kind: 'text', data: { text: item.text } });
      return;
    case 'reasoning':
      if (item.text.trim()) input.sink.item(item.id, { kind: 'thinking', data: { text: item.text } });
      return;
    case 'command_execution': {
      const failed = item.status !== 'in_progress' && (item.status === 'failed' || (item.exit_code ?? 0) !== 0);
      input.sink.item(item.id, {
        kind: 'tool',
        data: {
          toolUseId: item.id,
          name: 'Bash',
          input: { command: item.command },
          status: item.status === 'in_progress' ? 'running' : failed ? 'error' : 'done',
          output: clip(item.aggregated_output + (typeof item.exit_code === 'number' && item.exit_code !== 0 ? `\n(exit ${item.exit_code})` : '')),
        },
      });
      if (process.platform === 'darwin' && sandboxed && failed && KEYCHAIN_FAILURE.test(item.aggregated_output)) {
        input.sink.item('sandbox-keychain', { kind: 'notice', data: { text: KEYCHAIN_NOTICE, level: 'warn' } });
      }
      return;
    }
    case 'file_change':
      input.sink.item(item.id, {
        kind: 'tool',
        data: {
          toolUseId: item.id,
          name: 'ApplyPatch',
          input: { changes: item.changes },
          status: item.status === 'completed' ? 'done' : 'error',
          output: item.changes.map((change) => `${change.kind === 'add' ? '+' : change.kind === 'delete' ? '-' : '~'} ${change.path}`).join('\n'),
        },
      });
      return;
    case 'mcp_tool_call': {
      input.sink.item(item.id, {
        kind: 'tool',
        data: {
          toolUseId: item.id,
          name: `mcp__${item.server}__${item.tool}`,
          input: item.arguments,
          status: item.status === 'in_progress' ? 'running' : item.status === 'completed' ? 'done' : 'error',
          output: clip(
            item.error?.message ??
              (item.result?.content ?? [])
                .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
                .join('\n'),
          ),
        },
      });
      const images: EngineMedia[] = (item.result?.content ?? []).flatMap((part, index) =>
        part.type === 'image' && typeof part.data === 'string'
          ? [{ name: `${item.tool.replace(/[^\w-]+/g, '-')}-${index + 1}.${part.mimeType.split('/')[1] ?? 'png'}`, mime: part.mimeType, data: Buffer.from(part.data, 'base64') }]
          : [],
      );
      if (images.length > 0) input.sink.attach(item.id, images);
      return;
    }
    case 'web_search':
      input.sink.item(item.id, { kind: 'tool', data: { toolUseId: item.id, name: 'WebSearch', input: { query: item.query }, status: 'done' } });
      return;
    case 'todo_list':
      input.sink.item('todos', {
        kind: 'todo',
        data: { items: item.items.map((todo) => ({ text: todo.text, status: todo.completed ? 'completed' : 'pending' })) },
      });
      return;
    case 'error':
      input.sink.item(item.id, { kind: 'error', data: { message: item.message } });
      return;
  }
}

export async function runCodex(
  input: EngineRunInput & { executable: string; setup: CodexSetup; nativeMcpServers: string[]; approvalScopes: CodexApprovalScope[] },
): Promise<EngineRunResult> {
  const codex = new Codex({
    codexPathOverride: input.executable,
    apiKey: input.setup.apiKey,
    baseUrl: input.setup.baseUrl,
    env: input.setup.env,
    config: { ...input.setup.config, ...mcpOverrides(input, input.approvalScopes) } as never,
  });
  const threadOptions = {
    model: input.model ?? undefined,
    modelReasoningEffort: engineEffort('codex', input.effort) as ModelReasoningEffort | undefined,
    workingDirectory: input.cwd,
    skipGitRepoCheck: true,
    sandboxMode: SANDBOX[input.permissionMode],
    approvalPolicy: 'never' as const,
    networkAccessEnabled: true,
  };
  const thread = input.sessionId ? codex.resumeThread(input.sessionId, threadOptions) : codex.startThread(threadOptions);
  const sandboxed = threadOptions.sandboxMode !== 'danger-full-access';
  const prompt = input.preamble ? `${input.preamble}\n\n${input.prompt}` : input.prompt;
  const system = [input.systemAppend, codexNotes(threadOptions.sandboxMode)].filter(Boolean).join('\n');
  const fullPrompt = input.sessionId ? prompt : `${system}\n\n${prompt}`;
  const images = input.nativeMedia ? input.attachments.filter((file) => file.kind === 'image' && INLINE_IMAGES.has(file.mime)) : [];
  const turnInput: Input = images.length > 0 ? [{ type: 'text', text: fullPrompt }, ...images.map((file) => ({ type: 'local_image' as const, path: file.path }))] : fullPrompt;

  let sessionId = input.sessionId;
  let result: EngineRunResult | null = null;
  input.sink.info({
    engine: 'codex',
    model: input.model ?? undefined,
    mcpServers: [...new Set([...input.nativeMcpServers, ...Object.keys(input.mcpServers)])].map((name) => ({ name, status: 'configured' })),
  });
  try {
    const { events } = await thread.runStreamed(turnInput, { signal: input.signal });
    for await (const event of events as AsyncIterable<ThreadEvent>) {
      switch (event.type) {
        case 'thread.started':
          sessionId = event.thread_id;
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          publish(input, event.item, sandboxed);
          break;
        case 'turn.completed':
          result = {
            sessionId,
            status: 'done',
            usage: { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens },
          };
          break;
        case 'turn.failed':
          result = { sessionId, status: 'failed', error: event.error.message };
          break;
        case 'error':
          result = { sessionId, status: 'failed', error: event.message };
          break;
      }
    }
  } catch (error) {
    if (!input.signal.aborted) return { sessionId, status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  const context = sessionId ? await contextUsage(codexHome(input.setup.env), sessionId).catch(() => ({})) : {};
  if (input.signal.aborted) return { sessionId, status: 'cancelled', error: 'Cancelled', usage: context };
  if (!result) return { sessionId, status: 'failed', error: 'Codex finished without a result' };
  return { ...result, usage: { ...result.usage, ...context } };
}
