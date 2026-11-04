import { execFile } from 'node:child_process';
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type McpServerConfig,
  type ModelInfo,
  type ModelUsage,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import type { QuestionSpec, TurnUsage } from '@cooprompt/protocol';
import { engineEffort } from '../../shared/effort.ts';
import type { ClaudeSignIn, ModelChoice } from '../../shared/types.ts';
import { clip, type EngineMedia, type EngineRunInput, type EngineRunResult } from './types.ts';

const INTERRUPT_GRACE_MS = 8_000;
/** The image types Anthropic's API takes, up to 5 MB once in base64; PDFs go as documents. Anything else, by path. */
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_IMAGE = 3_750_000;
const MAX_INLINE_PDF = 10 * 1024 * 1024;

type UserContent = Exclude<Extract<SDKUserMessage['message'], { role: 'user' }>['content'], string>;

/** Images and PDFs ride in the message itself, before the text, as the API recommends; the text lists their paths anyway. */
async function promptContent(input: EngineRunInput): Promise<string | UserContent> {
  if (!input.nativeMedia) return input.prompt;
  const blocks: UserContent = [];
  for (const file of input.attachments) {
    const image = file.kind === 'image' && INLINE_IMAGES.has(file.mime) && file.size <= MAX_INLINE_IMAGE;
    if (!image && !(file.kind === 'pdf' && file.size <= MAX_INLINE_PDF)) continue;
    const data = (await readFile(file.path).catch(() => null))?.toString('base64');
    if (!data) continue;
    if (image) blocks.push({ type: 'image', source: { type: 'base64', media_type: file.mime as 'image/png', data } });
    else blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: file.name });
  }
  return blocks.length > 0 ? [...blocks, { type: 'text', text: input.prompt }] : input.prompt;
}

/** Images in a tool's result, such as a browser screenshot, named after the tool. */
function toolImages(content: unknown, tool: string): EngineMedia[] {
  if (!Array.isArray(content)) return [];
  const base = (tool.split('__').pop() || 'image').replace(/[^\w-]+/g, '-');
  return content.flatMap((part: Block, index) => {
    const source = part.type === 'image' ? (part.source as { type?: string; media_type?: string; data?: unknown } | undefined) : undefined;
    if (source?.type !== 'base64' || typeof source.data !== 'string') return [];
    const mime = String(source.media_type ?? 'image/png');
    return [{ name: `${base}-${index + 1}.${mime.split('/')[1] ?? 'png'}`, mime, data: Buffer.from(source.data, 'base64') }];
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type MessageUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

/** Claude Code's own /context numbers; falls back to the last main-loop response when unavailable. */
async function contextUsage(stream: Query, last: MessageUsage | null, models: Record<string, ModelUsage>): Promise<Pick<TurnUsage, 'contextTokens' | 'contextWindow'>> {
  try {
    const context = await withTimeout(stream.getContextUsage({ detail: 'summary' }), 4000);
    if (context.rawMaxTokens > 0) return { contextTokens: context.totalTokens, contextWindow: context.rawMaxTokens };
  } catch {
    // older CLIs or a session that is shutting down
  }
  const window = Math.max(0, ...Object.values(models).map((model) => model.contextWindow ?? 0));
  if (!last || !window) return {};
  const tokens = (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.output_tokens ?? 0);
  return { contextTokens: tokens, contextWindow: window };
}

type Block = { type: string; [key: string]: unknown };

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: Block) => (part.type === 'text' ? String(part.text ?? '') : part.type === 'image' ? '[imagen]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

function normalizeQuestions(raw: unknown): QuestionSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: Record<string, unknown>) => ({
    question: String(entry.question ?? ''),
    header: entry.header ? String(entry.header) : undefined,
    multiSelect: Boolean(entry.multiSelect),
    options: Array.isArray(entry.options)
      ? entry.options.map((option: Record<string, unknown>) => ({ label: String(option.label ?? ''), description: option.description ? String(option.description) : undefined }))
      : [],
  }));
}

function mcpConfig(input: EngineRunInput): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, spec] of Object.entries(input.mcpServers)) {
    if (spec.type !== 'stdio') {
      servers[name] = { type: spec.type, url: spec.url, headers: spec.headers };
      continue;
    }
    // Claude's stdio config has no working folder, so a shell enters it before starting the server.
    servers[name] = spec.cwd
      ? { type: 'stdio', command: '/bin/sh', args: ['-c', 'cd "$1" && shift && exec "$@"', 'cooprompt-mcp', spec.cwd, spec.command, ...spec.args], env: spec.env }
      : { type: 'stdio', command: spec.command, args: spec.args, env: spec.env };
  }
  return servers;
}

export async function runClaude(input: EngineRunInput & { executable: string }): Promise<EngineRunResult> {
  if (input.signal.aborted) return { sessionId: input.sessionId, status: 'cancelled', error: 'Cancelled' };
  let finishInput!: () => void;
  const inputClosed = new Promise<void>((resolve) => {
    finishInput = resolve;
  });

  // Streaming input keeps stdin open so permission prompts and questions reach canUseTool.
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    if (input.preamble) {
      yield { type: 'user', message: { role: 'user', content: input.preamble }, parent_tool_use_id: null, shouldQuery: false };
    }
    yield { type: 'user', message: { role: 'user', content: await promptContent(input) }, parent_tool_use_id: null };
    await inputClosed;
  }

  const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
    if (toolName === 'AskUserQuestion') {
      const answers = await input.askQuestion({ key: options.toolUseID, questions: normalizeQuestions(toolInput.questions) });
      if (!answers) return { behavior: 'deny', message: 'Nobody answered the question' };
      return { behavior: 'allow', updatedInput: { ...toolInput, answers } };
    }
    const answer = await input.requestPermission({
      key: options.toolUseID,
      toolName,
      input: toolInput,
      title: options.title,
      description: options.description ?? options.decisionReason,
      allowAlways: !options.suppressAlwaysAllowRule,
    });
    if (answer.allow) return { behavior: 'allow', updatedInput: toolInput };
    return { behavior: 'deny', message: answer.message ?? 'The user denied this action' };
  };

  const abortController = new AbortController();
  const mode = input.permissionMode as PermissionMode;
  const stream = query({
    prompt: messages(),
    options: {
      cwd: input.cwd,
      model: input.model ?? undefined,
      effort: engineEffort('claude', input.effort) as EffortLevel | undefined,
      resume: input.sessionId ?? undefined,
      ...(input.sessionId && input.forkAt ? { forkSession: true, resumeSessionAt: input.forkAt } : {}),
      permissionMode: mode,
      allowDangerouslySkipPermissions: mode === 'bypassPermissions',
      canUseTool,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      skills: 'all',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemAppend },
      mcpServers: mcpConfig(input),
      env: input.env,
      pathToClaudeCodeExecutable: input.executable,
      abortController,
      stderr: (data) => input.log(data.trimEnd()),
    },
  });

  // Interrupting (instead of killing) lets Claude Code record the stop, so the next turn resumes knowing it.
  let hardStop: NodeJS.Timeout | undefined;
  const onAbort = () => {
    hardStop = setTimeout(() => abortController.abort(), INTERRUPT_GRACE_MS);
    stream.interrupt().catch(() => abortController.abort());
  };
  input.signal.addEventListener('abort', onAbort, { once: true });

  let sessionId: string | null = input.sessionId;
  const blockCounts = new Map<string, number>();
  const toolNames = new Map<string, string>();
  let lastUsage: MessageUsage | null = null;
  let result: EngineRunResult | null = null;
  /** The newest entry of the session's main chain: forking there keeps this whole turn and nothing after it. */
  let lastEntry: string | undefined;

  const blockKey = (messageId: string) => {
    const index = blockCounts.get(messageId) ?? 0;
    blockCounts.set(messageId, index + 1);
    return `${messageId}.${index}`;
  };

  try {
    for await (const message of stream as AsyncIterable<SDKMessage>) {
      switch (message.type) {
        case 'system': {
          if (message.subtype === 'init') {
            sessionId = message.session_id;
            input.sink.info({
              engine: 'claude',
              model: message.model,
              version: message.claude_code_version,
              tools: message.tools,
              mcpServers: message.mcp_servers.map((server) => ({ name: server.name, status: server.status })),
              skills: message.skills,
              slashCommands: message.slash_commands,
              terminalSlashCommands: message.terminal_slash_commands,
              agents: message.agents,
            });
          } else if (message.subtype === 'api_retry') {
            input.sink.item(`retry.${message.attempt}`, {
              kind: 'notice',
              data: { text: `Retrying the model call (${message.attempt}/${message.max_retries})…`, level: 'warn' },
            });
          } else if (message.subtype === 'local_command_output' && message.content.trim()) {
            input.sink.item(`local.${message.uuid}`, { kind: 'text', data: { text: message.content } });
          } else if (message.subtype === 'compact_boundary') {
            input.sink.item(`compact.${message.uuid}`, { kind: 'notice', data: { text: 'Conversation compacted to free up context' } });
          }
          break;
        }
        case 'stream_event': {
          if (message.parent_tool_use_id) break;
          const event = message.event as { type: string; content_block?: Block; delta?: Block };
          if (event.type === 'content_block_start') {
            const kind = event.content_block?.type;
            if (kind === 'text' || kind === 'thinking') input.sink.draft({ kind, text: '' });
          } else if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta') input.sink.delta('text', String(event.delta.text ?? ''));
            else if (event.delta?.type === 'thinking_delta') input.sink.delta('thinking', String(event.delta.thinking ?? ''));
          }
          break;
        }
        case 'assistant': {
          const parentToolId = message.parent_tool_use_id;
          if (!parentToolId) lastEntry = message.uuid;
          if (!parentToolId && message.message.usage) lastUsage = message.message.usage as MessageUsage;
          for (const block of message.message.content as unknown as Block[]) {
            const key = blockKey(message.message.id);
            if (block.type === 'text' && String(block.text ?? '').trim()) {
              input.sink.item(key, { kind: 'text', data: { text: String(block.text), parentToolId } });
              if (!parentToolId) input.sink.draft(null);
            } else if (block.type === 'thinking' && String(block.thinking ?? '').trim()) {
              input.sink.item(key, { kind: 'thinking', data: { text: String(block.thinking), parentToolId } });
              if (!parentToolId) input.sink.draft(null);
            } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
              const id = String(block.id);
              const name = String(block.name ?? 'tool');
              toolNames.set(id, name);
              input.sink.item(`tool.${id}`, { kind: 'tool', data: { toolUseId: id, name, input: block.input, status: 'running', parentToolId } });
              if (name === 'TodoWrite' && Array.isArray((block.input as { todos?: unknown[] })?.todos)) {
                const todos = (block.input as { todos: { content?: string; status?: string }[] }).todos;
                input.sink.item('todos', {
                  kind: 'todo',
                  data: {
                    items: todos.map((todo) => ({
                      text: String(todo.content ?? ''),
                      status: todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'in_progress' : 'pending',
                    })),
                  },
                });
              }
            }
          }
          if (message.error && !parentToolId) {
            input.sink.item(`error.${message.uuid}`, { kind: 'error', data: { message: `Model error: ${message.error}` } });
          }
          break;
        }
        case 'user': {
          if (!message.parent_tool_use_id && message.uuid) lastEntry = message.uuid;
          const content = message.message.content;
          if (!Array.isArray(content)) break;
          for (const block of content as unknown as Block[]) {
            if (block.type !== 'tool_result') continue;
            const id = String(block.tool_use_id);
            input.sink.item(`tool.${id}`, {
              kind: 'tool',
              data: {
                toolUseId: id,
                name: toolNames.get(id) ?? 'tool',
                input: undefined,
                status: block.is_error ? 'error' : 'done',
                output: clip(toolResultText(block.content)),
                parentToolId: message.parent_tool_use_id,
              },
            });
            const images = toolImages(block.content, toolNames.get(id) ?? 'tool');
            if (images.length > 0) input.sink.attach(`tool.${id}`, images);
          }
          break;
        }
        case 'result': {
          sessionId = message.session_id;
          const usage: TurnUsage = {
            inputTokens: message.usage?.input_tokens,
            outputTokens: message.usage?.output_tokens,
            costUsd: message.total_cost_usd,
            durationMs: message.duration_ms,
            ...(await contextUsage(stream, lastUsage, message.modelUsage ?? {})),
          };
          if (message.subtype === 'success' && !message.is_error) {
            // A stopped or failed turn can end mid tool call, which is no place to continue from.
            result = { sessionId, status: 'done', usage, ...(lastEntry ? { checkpoint: lastEntry } : {}) };
          } else {
            const errors = 'errors' in message && Array.isArray(message.errors) ? message.errors : [];
            const detail = errors.join('\n') || ('result' in message ? String(message.result ?? '') : '') || message.subtype;
            result = { sessionId, status: 'failed', error: detail, usage };
          }
          finishInput();
          break;
        }
        default:
          break;
      }
    }
  } catch (error) {
    if (input.signal.aborted) return { sessionId, status: 'cancelled', error: 'Cancelled', usage: result?.usage };
    return { sessionId, status: 'failed', error: error instanceof Error ? error.message : String(error) };
  } finally {
    finishInput();
    clearTimeout(hardStop);
    input.signal.removeEventListener('abort', onAbort);
  }
  if (input.signal.aborted) return { sessionId, status: 'cancelled', error: 'Cancelled', usage: result?.usage };
  return result ?? { sessionId, status: 'failed', error: 'The engine finished without a result' };
}

export interface ClaudeProbe {
  commands: SlashCommand[];
  models: ModelChoice[];
}

/** `default` is the model Claude Code picks by itself, which CooPrompt expresses by choosing none. */
function modelChoices(models: ModelInfo[]): ModelChoice[] {
  return models
    .filter((model) => model.value !== 'default')
    .map((model) => ({ id: model.value, label: model.displayName, efforts: model.supportedEffortLevels?.map((id) => ({ id })) }));
}

/**
 * Starts Claude Code without sending a prompt: its initialize answer lists the slash commands this setup offers
 * (built-ins that work headless, custom and plugin commands, skills) and the models its account can use. No model call is made.
 */
export async function probeClaude(input: { cwd: string; env: Record<string, string>; executable: string; log(line: string): void }): Promise<ClaudeProbe> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await released;
  }
  const stream = query({
    prompt: idle(),
    options: {
      cwd: input.cwd,
      env: input.env,
      pathToClaudeCodeExecutable: input.executable,
      settingSources: ['user', 'project', 'local'],
      skills: 'all',
      strictMcpConfig: true,
      mcpServers: {},
      stderr: (data) => input.log(data.trimEnd()),
    },
  });
  try {
    const init = await withTimeout(stream.initializationResult(), 30_000);
    return { commands: init.commands, models: modelChoices(init.models) };
  } finally {
    release();
    stream.close();
  }
}

function claudeCli(executable: string, args: string[], env: Record<string, string>, timeout: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(executable, args, { env, timeout }, (_error, stdout) => resolve(stdout ?? ''));
  });
}

/** Asks Claude Code which account it uses (`claude auth status`), so CooPrompt never reads its credentials. */
export async function claudeSignIn(input: { executable: string; env: Record<string, string> }): Promise<ClaudeSignIn> {
  // It exits with 1 when nobody is signed in, and still prints the status.
  const output = await claudeCli(input.executable, ['auth', 'status', '--json'], input.env, 15_000);
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
  } catch {
    return { loggedIn: false, method: 'none' };
  }
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return {
    loggedIn: status.loggedIn === true,
    method: text(status.authMethod) ?? 'none',
    plan: text(status.subscriptionType),
    apiKeySource: text(status.apiKeySource),
    provider: text(status.apiProvider),
    email: text(status.email),
    organization: text(status.orgName),
  };
}

/** Claude Code's own browser sign-in (`claude auth login`); the account it ends up with replaces the previous one. */
export async function claudeLogin(input: { executable: string; env: Record<string, string> }): Promise<ClaudeSignIn> {
  await claudeCli(input.executable, ['auth', 'login'], input.env, 5 * 60_000);
  return claudeSignIn(input);
}
