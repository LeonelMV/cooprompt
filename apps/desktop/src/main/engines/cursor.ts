import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { QuestionSpec, TodoItemData, TurnUsage } from '@cooprompt/protocol';
import type { CursorSignIn, ModelChoice } from '../../shared/types.ts';
import { clip, type EngineRunInput, type EngineRunResult, type McpServerSpec } from './types.ts';

/**
 * Cursor runs through its CLI's Agent Client Protocol server (`cursor-agent acp`): JSON-RPC over stdio, with the
 * CLI's own sign-in on this computer. CooPrompt never sees Cursor's credentials.
 */

export const CURSOR_NOT_INSTALLED = "The Cursor CLI isn't installed on this computer. Follow the installation guide at https://cursor.com/docs/cli/installation.";
export const CURSOR_NOT_SIGNED_IN = 'Cursor is not signed in on this computer. Sign in from Settings → Models & keys, or run "cursor-agent login" in Terminal.';
export const CURSOR_LEFT_PLAN = 'Cursor tried to leave Plan mode, so CooPrompt stopped the turn. To let it make changes, send the message with another permission mode.';
export const CURSOR_NEW_SESSION = 'Could not resume the Cursor session, so this turn starts a new one without the earlier conversation.';
export const CURSOR_REFUSED = 'The model refused to go on with this request.';
export const CURSOR_STOPPED_EARLY = 'Cursor stopped before finishing: the reply reached its length or step limit.';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The CLI installs itself as `cursor-agent` (and `agent`, a name too generic to trust) in ~/.local/bin. `COOPROMPT_CURSOR_AGENT` points at another one. */
export function findCursorAgent(env: Record<string, string>): string | null {
  const names = process.platform === 'win32' ? ['cursor-agent.exe', 'cursor-agent'] : ['cursor-agent'];
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(env.HOME || homedir(), '.local/bin')];
  const candidates = [
    ...(env.COOPROMPT_CURSOR_AGENT ? [env.COOPROMPT_CURSOR_AGENT] : []),
    ...dirs.flatMap((dir) => names.map((name) => join(dir, name))),
  ];
  for (const file of candidates) {
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // try the next one
    }
  }
  return null;
}

export function requireCursorAgent(env: Record<string, string>): string {
  const executable = findCursorAgent(env);
  if (!executable) throw new Error(CURSOR_NOT_INSTALLED);
  return executable;
}

class AcpError extends Error {
  readonly code: number;
  constructor(error: { code?: unknown; message?: unknown }) {
    super(typeof error.message === 'string' ? error.message : 'Cursor CLI error');
    this.code = typeof error.code === 'number' ? error.code : -32603;
  }
}

/** The ACP SDK's `authRequired` error. */
const AUTH_REQUIRED = -32000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** Runs before later lines are read, so a reply can change how the messages right behind it are handled. */
  settled?: () => void;
}

/** CLIs still running, so quitting CooPrompt doesn't leave them behind: they outlive their closed input. */
const running = new Set<AcpConnection>();

export function stopCursorAgents(): void {
  for (const connection of running) connection.kill();
}

/** A JSON-RPC 2.0 connection to `cursor-agent acp`, one message per line in each direction. */
class AcpConnection {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderr = '';
  private exitError: Error | null = null;
  private killTimer: NodeJS.Timeout | undefined;
  readonly exited: Promise<void>;
  onNotification: (method: string, params: Json) => void = () => {};
  onRequest: (method: string, params: Json) => Promise<unknown> = async () => {
    throw new AcpError({ code: -32601, message: 'Method not found' });
  };

  constructor(executable: string, args: string[], options: { cwd: string; env: Record<string, string>; log(line: string): void }) {
    this.child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    running.add(this);
    this.child.stdin!.on('error', () => {});
    createInterface({ input: this.child.stdout! }).on('line', (line) => this.handle(line));
    createInterface({ input: this.child.stderr! }).on('line', (line) => {
      this.stderr = `${this.stderr}\n${line}`.slice(-4000);
      options.log(line);
    });
    this.exited = new Promise((resolve) => {
      const fail = (error: Error) => {
        this.exitError ??= error;
        for (const pending of this.pending.values()) pending.reject(this.exitError);
        this.pending.clear();
        running.delete(this);
        clearTimeout(this.killTimer);
        resolve();
      };
      this.child.once('error', (error) => fail(new Error(`Could not start the Cursor CLI: ${error.message}`)));
      // `close` comes after the output is read to the end, so its last replies still count.
      this.child.once('close', (code, signal) => {
        const detail = this.stderr.trim().split('\n').slice(-5).join('\n');
        const status = code === null ? `was stopped (${signal ?? 'signal'})` : `exited with code ${code}`;
        fail(new Error(detail ? `The Cursor CLI ${status}: ${detail}` : `The Cursor CLI ${status}`));
      });
    });
  }

  private write(message: Json): void {
    if (this.exitError || !this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  request<T = Json>(method: string, params: Json, settled?: () => void): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, settled });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    this.write({ method, params });
  }

  private handle(line: string): void {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const params = isObject(message.params) ? message.params : {};
    if (typeof message.method === 'string') {
      if (message.id === undefined || message.id === null) {
        this.onNotification(message.method, params);
        return;
      }
      const id = message.id;
      this.onRequest(message.method, params).then(
        (result) => this.write({ id, result: result ?? {} }),
        (error: unknown) => this.write({ id, error: { code: error instanceof AcpError ? error.code : -32603, message: error instanceof Error ? error.message : String(error) } }),
      );
      return;
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    this.pending.delete(message.id as number);
    pending.settled?.();
    if (isObject(message.error)) pending.reject(new AcpError(message.error));
    else pending.resolve(message.result ?? {});
  }

  /** The CLI keeps running after its input closes, so after a moment to finish writing its session it is stopped. */
  async close(): Promise<void> {
    this.child.stdin?.end();
    const stop = setTimeout(() => this.kill(), 1000);
    await this.exited;
    clearTimeout(stop);
  }

  /** What is still waiting for an answer fails with `reason` at once, and a CLI that ignores SIGTERM gets SIGKILL. */
  kill(reason?: Error): void {
    if (reason) {
      this.exitError ??= reason;
      for (const pending of this.pending.values()) pending.reject(this.exitError);
      this.pending.clear();
    }
    if (this.killTimer || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
  }
}

function initializeParams(appVersion: string): Json {
  return {
    protocolVersion: 1,
    // Without a client file system or terminal the CLI reads, writes and runs commands itself.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } },
    clientInfo: { name: 'CooPrompt', version: appVersion },
  };
}

function signInError(error: unknown): Error {
  if (error instanceof AcpError && error.code === AUTH_REQUIRED) return new Error(CURSOR_NOT_SIGNED_IN);
  return error instanceof Error ? error : new Error(String(error));
}

/** ACP passes environment variables and headers as name/value lists; remote transports go only where the CLI said it takes them. */
function acpServers(servers: Record<string, McpServerSpec>, env: Record<string, string>, supported: Json, log: (line: string) => void): Json[] {
  const pairs = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }));
  return Object.entries(servers).flatMap(([name, spec]): Json[] => {
    if (spec.type !== 'stdio' && supported[spec.type] !== true) {
      log(`leaving out ${name}: this Cursor CLI takes no ${spec.type} MCP servers`);
      return [];
    }
    if (spec.type !== 'stdio') return [{ type: spec.type, name, url: spec.url, headers: pairs(spec.headers) }];
    const passed = Object.fromEntries((spec.envVars ?? []).filter((variable) => variable in env).map((variable) => [variable, env[variable]]));
    return [{ name, command: spec.command, args: spec.args, env: pairs({ ...passed, ...spec.env }), ...(spec.cwd ? { cwd: spec.cwd } : {}) }];
  });
}

/** Cursor keeps only the first 20,000 characters of an attachment. */
const ATTACHMENT_LIMIT = 20_000;

/** What Cursor takes as images in the prompt; the other files go by the paths the prompt lists. */
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_IMAGE = 3_750_000;

async function imageBlocks(input: EngineRunInput): Promise<Json[]> {
  if (!input.nativeMedia) return [];
  const images = input.attachments.filter((file) => file.kind === 'image' && INLINE_IMAGES.has(file.mime) && file.size <= MAX_INLINE_IMAGE);
  const blocks = await Promise.all(
    images.map(async (file) => {
      const data = await readFile(file.path).catch(() => null);
      return data ? { type: 'image', mimeType: file.mime, data: data.toString('base64') } : null;
    }),
  );
  return blocks.filter((block) => block !== null);
}

/**
 * ACP has no system prompt, so a new session gets CooPrompt's instructions with its first prompt. Cursor runs a slash
 * command only when the prompt is the command line alone, so then the context travels as an attachment.
 */
async function promptBlocks(input: EngineRunInput, fresh: boolean): Promise<Json[]> {
  const system = fresh ? input.systemAppend : '';
  const preamble = input.preamble ?? '';
  const images = await imageBlocks(input);
  if (!input.prompt.trim().startsWith('/')) {
    return [{ type: 'text', text: [system, preamble, input.prompt].filter(Boolean).join('\n\n') }, ...images];
  }
  const blocks: Json[] = [{ type: 'text', text: input.prompt.trim() }];
  if (system || preamble) {
    const room = Math.max(0, ATTACHMENT_LIMIT - system.length - 200);
    const history = preamble.length > room ? `… (history trimmed)\n${preamble.slice(-room)}` : preamble;
    blocks.push({ type: 'resource', resource: { uri: 'cooprompt://context', mimeType: 'text/plain', text: [system, history].filter(Boolean).join('\n\n') } });
  }
  return [...blocks, ...images];
}

/** What the CLI writes as a reply when a run fails before or while it streams; the prompt still ends normally. */
const FAILURE_CHUNK = /^\n\n(Error: [\s\S]+|Please sign in to continue|Upgrade your plan to continue|Add a payment method to continue|Check your settings to continue)$/;

interface ConfigOption {
  id: string;
  category?: string;
  currentValue?: string;
  options?: { value: string; name?: string }[];
}

const configOptions = (value: unknown): ConfigOption[] =>
  Array.isArray(value) ? value.filter((option): option is ConfigOption => isObject(option) && typeof option.id === 'string') : [];

const optionName = (option: ConfigOption | undefined) => option?.options?.find((entry) => entry.value === option.currentValue)?.name ?? option?.currentValue;

interface CursorToolCall {
  id: string;
  kind: string;
  title: string;
  status: string;
  rawInput?: Json;
  rawOutput?: Json;
  content?: Json[];
}

/** Cursor reports whole files; CooPrompt shows edits as Claude's are, by the lines that changed (first to last). */
function changedRegion(before: string, after: string): { old: string; new: string } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { old: a.slice(start, a.length - end).join('\n'), new: b.slice(start, b.length - end).join('\n') };
}

/** Cursor's tools under the names CooPrompt (and apps that predate Cursor) already know how to show. */
function describeCall(call: CursorToolCall): { name: string; input: Json } {
  const raw = call.rawInput ?? {};
  const value = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined);
  switch (raw._toolName) {
    case 'task':
      return { name: 'Task', input: { description: value('description'), prompt: value('prompt'), subagent_type: value('subagentType') } };
    case 'updateTodos':
      return { name: 'TodoWrite', input: { todos: raw.todos } };
    case 'askQuestion':
      return { name: 'AskUserQuestion', input: { title: value('title'), questions: raw.questions } };
    case 'createPlan':
      return { name: 'CreatePlan', input: { name: value('name') } };
  }
  switch (call.kind) {
    case 'execute':
      if (value('command') !== undefined) return { name: 'Bash', input: { command: value('command') } };
      break;
    case 'read':
      if (value('path')) return { name: 'Read', input: { file_path: value('path') } };
      break;
    case 'edit':
      if (value('path')) return { name: 'Edit', input: { file_path: value('path') } };
      break;
    case 'delete':
      if (value('path')) return { name: 'ApplyPatch', input: { changes: [{ path: value('path'), kind: 'delete' }] } };
      break;
    case 'search':
      if (value('searchTerm') !== undefined) return { name: 'WebSearch', input: { query: value('searchTerm') } };
      if (value('query') !== undefined) return { name: 'SemanticSearch', input: { query: value('query') } };
      if (call.title.startsWith('grep')) return { name: 'Grep', input: { pattern: value('pattern'), path: value('path') } };
      if (value('pattern') !== undefined) return { name: 'Glob', input: { pattern: value('pattern') } };
      if (value('path') !== undefined || call.title.startsWith('List ')) return { name: 'LS', input: { path: value('path') } };
      break;
    case 'fetch':
      if (value('url')) return { name: 'WebFetch', input: { url: value('url') } };
      break;
  }
  if (value('providerIdentifier') && value('toolName')) return { name: `mcp__${value('providerIdentifier')}__${value('toolName')}`, input: isObject(raw.args) ? raw.args : {} };
  return { name: call.title || 'Tool', input: raw };
}

const contentText = (content: Json[] | undefined) =>
  (content ?? [])
    .map((block) => (block.type === 'content' && isObject(block.content) && block.content.type === 'text' ? String(block.content.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');

function toolItem(call: CursorToolCall): { name: string; input: Json; status: 'running' | 'done' | 'error'; output?: string } {
  let { name, input } = describeCall(call);
  const out = call.rawOutput ?? {};
  let failed = call.status === 'failed' || typeof out.error === 'string' || out.rejected === true || out.permissionDenied === true;
  let output: string | undefined;
  if (typeof out.error === 'string') output = out.error;
  else if (typeof out.exitCode === 'number' || typeof out.stdout === 'string') {
    const code = typeof out.exitCode === 'number' ? out.exitCode : 0;
    failed ||= code !== 0;
    output = [out.stdout, out.stderr].filter((part) => typeof part === 'string' && part).join('\n') + (code !== 0 ? `\n(exit ${code})` : '');
  } else if (typeof out.content === 'string') output = out.content;
  // Cursor reports little more than success for some tools (MCP calls among them).
  else if (Object.keys(out).some((key) => key !== 'success')) output = JSON.stringify(out);
  const diff = (call.content ?? []).find((block) => block.type === 'diff');
  if (diff && name === 'Edit') {
    const before = typeof diff.oldText === 'string' ? diff.oldText : null;
    const after = String(diff.newText ?? '');
    if (before === null) {
      name = 'Write';
      input = { file_path: input.file_path, content: clip(after, 12_000) };
    } else {
      const region = changedRegion(before, after);
      input = { file_path: input.file_path, old_string: clip(region.old, 12_000), new_string: clip(region.new, 12_000) };
    }
  }
  output ??= contentText(call.content) || undefined;
  const done = call.status === 'completed' || call.status === 'failed';
  return { name, input, status: done ? (failed ? 'error' : 'done') : 'running', ...(output ? { output: clip(output) } : {}) };
}

/** A permission request for a call Cursor hasn't shown yet carries only a title, such as "`npm test`" or "notion: search". */
function describeRequest(id: string, call: Json): { name: string; input: Json } {
  const kind = text(call.kind) ?? 'other';
  const title = text(call.title) ?? '';
  const quoted = /`([^`]+)`$/.exec(title)?.[1] ?? /^Write (.+)$/.exec(title)?.[1];
  if (kind === 'execute') return { name: 'Bash', input: { command: title.replace(/^`|`$/g, '').replaceAll('\\`', '`') } };
  if ((kind === 'read' || kind === 'edit') && quoted) return { name: kind === 'read' ? 'Read' : title.startsWith('Write ') ? 'Write' : 'Edit', input: { file_path: quoted } };
  if (kind === 'delete' && quoted) return { name: 'ApplyPatch', input: { changes: [{ path: quoted, kind: 'delete' }] } };
  if (kind === 'fetch') return { name: 'WebFetch', input: { url: title.replace(/^Fetch /, '') } };
  if (kind === 'search') return { name: 'WebSearch', input: { query: title.replace(/^Web search: /, '') } };
  const mcp = /^([^:\s]+): (\S+)$/.exec(title);
  if (mcp) {
    const args = /```json\n([\s\S]*)\n```/.exec(contentText(Array.isArray(call.content) ? call.content.filter(isObject) : undefined))?.[1];
    let input: Json = {};
    try {
      input = args ? (JSON.parse(args) as Json) : {};
    } catch {
      // shown without its arguments
    }
    return { name: `mcp__${mcp[1]}__${mcp[2]}`, input };
  }
  return describeCall({ id, kind, title, status: 'pending' });
}

/** CooPrompt approves "always" itself: Cursor's own "Allow always" would write the rule into ~/.cursor/cli-config.json. */
function chosen(options: unknown, allow: boolean): Json {
  const list = Array.isArray(options) ? options.filter(isObject) : [];
  const option = list.find((entry) => entry.kind === (allow ? 'allow_once' : 'reject_once')) ?? list.find((entry) => entry.optionId === (allow ? 'allow-once' : 'reject-once'));
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
}

/** Kinds of requests that can't change anything, the only ones Plan mode passes on. */
const READ_ONLY_KINDS = new Set(['read', 'search', 'fetch', 'think']);

/** Calls that change files, which Cursor's plan mode never makes; seeing one means the agent got out of it. */
const WRITE_KINDS = new Set(['edit', 'delete', 'move', 'switch_mode']);

const TODO_STATUS: Record<string, TodoItemData['items'][number]['status']> = { pending: 'pending', in_progress: 'in_progress', completed: 'completed' };

export async function runCursor(input: EngineRunInput & { executable: string; nativeMcpServers: string[]; appVersion: string }): Promise<EngineRunResult> {
  if (input.signal.aborted) return { sessionId: input.sessionId, status: 'cancelled', error: 'Cancelled' };
  const started = Date.now();
  const plan = input.permissionMode === 'plan';
  const args = input.permissionMode === 'bypassPermissions' ? ['--force', 'acp'] : ['acp'];
  const acp = new AcpConnection(input.executable, args, { cwd: input.cwd, env: input.env, log: input.log });

  let sessionId: string | null = null;
  let replaying = false;
  let modeSet = false;
  let prompting = false;
  let leftPlan = false;
  let context: Pick<TurnUsage, 'contextTokens' | 'contextWindow'> = {};
  let segment: { kind: 'text' | 'thinking'; key: string; text: string } | null = null;
  let segments = 0;
  let heldFailure: string | null = null;
  const calls = new Map<string, CursorToolCall>();
  const todos = new Map<string, { content: string; status: string }>();
  const info = { engine: 'cursor' as const, model: undefined as string | undefined, mcpServers: [...new Set([...input.nativeMcpServers, ...Object.keys(input.mcpServers)])].map((name) => ({ name, status: 'configured' })), slashCommands: undefined as string[] | undefined };

  const flush = () => {
    if (!segment) return;
    if (segment.text.trim()) input.sink.item(segment.key, { kind: segment.kind, data: { text: segment.text } });
    input.sink.draft(null);
    segment = null;
  };
  const stream = (kind: 'text' | 'thinking', chunk: string) => {
    if (segment && segment.kind !== kind) flush();
    segment ??= { kind, key: `${kind}.${++segments}`, text: '' };
    segment.text += chunk;
    input.sink.delta(kind, chunk);
  };
  // A failure arrives as the reply's last chunk; anything after it shows it was text after all.
  const release = () => {
    if (heldFailure === null) return;
    const held = heldFailure;
    heldFailure = null;
    stream('text', held);
  };
  const publishTodos = () => {
    input.sink.item('todos', {
      kind: 'todo',
      data: { items: [...todos.values()].filter((todo) => todo.status in TODO_STATUS).map((todo) => ({ text: todo.content, status: TODO_STATUS[todo.status] })) },
    });
  };
  const setTodos = (list: unknown, merge: boolean) => {
    if (!merge) todos.clear();
    for (const [index, todo] of (Array.isArray(list) ? list.filter(isObject) : []).entries()) {
      const id = text(todo.id) ?? String(index);
      todos.set(id, { content: String(todo.content ?? ''), status: String(todo.status ?? 'pending') });
    }
    publishTodos();
  };
  // Cancelling alone could let calls already under way through, so the CLI is also ended right after.
  const stopForPlan = () => {
    if (leftPlan || !sessionId) return;
    leftPlan = true;
    acp.notify('session/cancel', { sessionId });
    setTimeout(() => acp.kill(new Error(CURSOR_LEFT_PLAN)), 500);
  };

  acp.onNotification = (method, params) => {
    if (method !== 'session/update' || replaying || !isObject(params.update)) return;
    const update = params.update;
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const chunk = isObject(update.content) && update.content.type === 'text' ? String(update.content.text ?? '') : '';
      if (!chunk) return;
      release();
      if (kind === 'agent_message_chunk' && FAILURE_CHUNK.test(chunk)) heldFailure = chunk;
      else stream(kind === 'agent_message_chunk' ? 'text' : 'thinking', chunk);
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      release();
      flush();
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      const call = calls.get(id) ?? { id, kind: 'other', title: '', status: 'pending' };
      if (typeof update.kind === 'string') call.kind = update.kind;
      if (typeof update.title === 'string') call.title = update.title;
      if (typeof update.status === 'string') call.status = update.status;
      if (isObject(update.rawInput)) call.rawInput = update.rawInput;
      if (isObject(update.rawOutput)) call.rawOutput = update.rawOutput;
      if (Array.isArray(update.content)) call.content = update.content.filter(isObject);
      calls.set(id, call);
      if (plan && WRITE_KINDS.has(call.kind)) stopForPlan();
      input.sink.item(`tool.${id}`, { kind: 'tool', data: { toolUseId: id, ...toolItem(call) } });
      return;
    }
    if (kind === 'plan' && Array.isArray(update.entries)) {
      setTodos(update.entries.filter(isObject).map((entry, index) => ({ id: `plan.${index}`, content: entry.content, status: entry.status })), false);
      return;
    }
    if (kind === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      info.slashCommands = update.availableCommands.filter(isObject).map((command) => String(command.name ?? '')).filter((name) => name && name !== 'copy-request-id');
      input.sink.info(info);
      return;
    }
    if (kind === 'current_mode_update' && plan && modeSet && update.currentModeId !== 'plan') {
      stopForPlan();
      return;
    }
    if (kind === 'usage_update' && typeof update.used === 'number' && typeof update.size === 'number') {
      context = { contextTokens: update.used, contextWindow: update.size };
    }
  };

  let permissions = 0;
  acp.onRequest = async (method, params) => {
    if (method === 'session/request_permission') {
      const call = isObject(params.toolCall) ? params.toolCall : {};
      const id = text(call.toolCallId) ?? `request.${++permissions}`;
      const kind = text(call.kind) ?? 'other';
      if (input.signal.aborted) return { outcome: { outcome: 'cancelled' } };
      if (plan && !READ_ONLY_KINDS.has(kind)) return chosen(params.options, false);
      const known = calls.get(id);
      const described = known?.rawInput ? describeCall(known) : describeRequest(id, call);
      const reason = contentText(Array.isArray(call.content) ? call.content.filter(isObject) : undefined);
      const answer = await input.requestPermission({
        key: id,
        toolName: described.name,
        input: described.input,
        description: reason && !reason.startsWith('```') ? reason : undefined,
        allowAlways: true,
      });
      if (input.signal.aborted) return { outcome: { outcome: 'cancelled' } };
      return chosen(params.options, answer.allow);
    }
    if (method === 'cursor/ask_question') {
      const questions = (Array.isArray(params.questions) ? params.questions.filter(isObject) : []).map((question) => ({
        id: String(question.id ?? ''),
        prompt: String(question.prompt ?? ''),
        multiple: question.allowMultiple === true,
        options: (Array.isArray(question.options) ? question.options.filter(isObject) : []).map((option) => ({ id: String(option.id ?? ''), label: String(option.label ?? '') })),
      }));
      const specs: QuestionSpec[] = questions.map((question) => ({ question: question.prompt, options: question.options.map((option) => ({ label: option.label })), multiSelect: question.multiple }));
      const answers = await input.askQuestion({ key: text(params.toolCallId) ?? `question.${questions[0]?.id ?? ''}`, questions: specs });
      if (!answers) return { outcome: { outcome: input.signal.aborted ? 'cancelled' : 'skipped', reason: 'Nobody answered the questions' } };
      const picked = questions.map((question) => {
        const given = (answers[question.prompt] ?? '').split(', ').filter(Boolean);
        return { question, given, ids: question.options.filter((option) => given.includes(option.label)).map((option) => option.id) };
      });
      // Cursor takes only option ids, so answers in the person's own words reach the agent as the reason.
      if (picked.some((entry) => entry.given.length > entry.ids.length)) {
        return { outcome: { outcome: 'skipped', reason: `The user answered: ${picked.map((entry) => `"${entry.question.prompt}": ${entry.given.join(', ')}`).join('; ')}` } };
      }
      return { outcome: { outcome: 'answered', answers: picked.map((entry) => ({ questionId: entry.question.id, selectedOptionIds: entry.ids })) } };
    }
    if (method === 'cursor/create_plan') {
      release();
      flush();
      const body = [text(params.name) ? `## ${params.name}` : '', text(params.overview), text(params.plan)].filter(Boolean).join('\n\n');
      if (body) input.sink.item(`plan.${text(params.toolCallId) ?? segments}`, { kind: 'text', data: { text: body } });
      if (Array.isArray(params.todos) && params.todos.length > 0) setTodos(params.todos, false);
      // Accepting keeps Plan mode: the CLI saves the plan in ~/.cursor/plans and the agent stops there.
      return { outcome: { outcome: 'accepted' } };
    }
    if (method === 'cursor/update_todos') {
      setTodos(params.todos, params.merge === true);
      return { outcome: { outcome: 'accepted', todos: Array.isArray(params.todos) ? params.todos : [] } };
    }
    if (method === 'cursor/task' || method === 'cursor/generate_image') return {};
    throw new AcpError({ code: -32601, message: `Method not found: ${method}` });
  };

  let abortTimer: NodeJS.Timeout | undefined;
  const cancelled = new Error('Cancelled');
  const onAbort = () => {
    // Only a prompt in progress can be cancelled; before it, or when the CLI doesn't stop, it is ended.
    if (!prompting || !sessionId) return acp.kill(cancelled);
    acp.notify('session/cancel', { sessionId });
    abortTimer = setTimeout(() => acp.kill(cancelled), 10_000);
  };
  input.signal.addEventListener('abort', onAbort, { once: true });

  const outcome = (status: EngineRunResult['status'], error?: string): EngineRunResult => {
    const usage: TurnUsage = { durationMs: Date.now() - started, ...context };
    if (leftPlan) return { sessionId: sessionId ?? input.sessionId, status: 'failed', error: CURSOR_LEFT_PLAN, usage };
    if (input.signal.aborted) return { sessionId: sessionId ?? input.sessionId, status: 'cancelled', error: 'Cancelled', usage };
    return { sessionId: sessionId ?? input.sessionId, status, ...(error ? { error } : {}), usage };
  };

  try {
    const init = await acp.request('initialize', initializeParams(input.appVersion));
    const capabilities = isObject(init.agentCapabilities) && isObject(init.agentCapabilities.mcpCapabilities) ? init.agentCapabilities.mcpCapabilities : {};
    const mcpServers = acpServers(input.mcpServers, input.env, capabilities, input.log);
    let session: Json | null = null;
    if (input.sessionId) {
      // Loading replays the conversation as updates before answering; this turn has already published it.
      replaying = true;
      try {
        session = await acp.request<Json>('session/load', { sessionId: input.sessionId, cwd: input.cwd, mcpServers }, () => {
          replaying = false;
        });
        sessionId = input.sessionId;
      } catch (error) {
        if (!(error instanceof AcpError) || error.code === AUTH_REQUIRED) throw error;
        input.log(`could not resume ${input.sessionId}: ${error.message}`);
        input.sink.item('cursor-new-session', { kind: 'notice', data: { text: CURSOR_NEW_SESSION, level: 'warn' } });
      }
    }
    if (!session) {
      session = await acp.request<Json>('session/new', { cwd: input.cwd, mcpServers });
      sessionId = String(session.sessionId ?? '');
    }
    const fresh = sessionId !== input.sessionId;

    // Choosing a model or effort here also makes it the Cursor CLI's default, as /model does in its terminal.
    let options = configOptions(session.configOptions);
    const model = options.find((option) => option.id === 'model');
    if (input.model && input.model !== model?.currentValue) {
      options = configOptions((await acp.request('session/set_config_option', { sessionId, configId: 'model', value: input.model })).configOptions);
    }
    const effort = options.find((option) => option.category === 'thought_level');
    if (input.effort && effort && input.effort !== effort.currentValue && effort.options?.some((option) => option.value === input.effort)) {
      options = configOptions((await acp.request('session/set_config_option', { sessionId, configId: effort.id, value: input.effort })).configOptions);
    }
    await acp.request('session/set_mode', { sessionId, modeId: plan ? 'plan' : 'agent' });
    modeSet = true;
    info.model = optionName(options.find((option) => option.id === 'model')) ?? input.model ?? undefined;
    input.sink.info(info);

    const prompt = await promptBlocks(input, fresh);
    if (input.signal.aborted) return outcome('cancelled', 'Cancelled');
    prompting = true;
    const reply = await acp.request<{ stopReason?: string }>('session/prompt', { sessionId, prompt });
    prompting = false;
    flush();
    if (reply.stopReason === 'cancelled') return outcome('cancelled', 'Cancelled');
    if (heldFailure !== null) return outcome('failed', (heldFailure as string).trim());
    if (reply.stopReason === 'refusal') return outcome('failed', CURSOR_REFUSED);
    if (reply.stopReason === 'max_tokens' || reply.stopReason === 'max_turn_requests') {
      input.sink.item('cursor-stopped', { kind: 'notice', data: { text: CURSOR_STOPPED_EARLY, level: 'warn' } });
    }
    return outcome('done');
  } catch (error) {
    release();
    flush();
    return outcome('failed', signInError(error).message);
  } finally {
    clearTimeout(abortTimer);
    input.signal.removeEventListener('abort', onAbort);
    await acp.close();
  }
}

interface ListedModel {
  value?: unknown;
  name?: unknown;
  configOptions?: unknown;
}

/** The team server keeps only effort names in lowercase letters, digits, `-` and `_`. */
const EFFORT_NAME = /^[a-z][a-z0-9_-]{0,19}$/;

/** The models the signed-in account offers, with each one's reasoning levels; asking makes no model call. */
export async function cursorModels(input: { executable: string; cwd: string; env: Record<string, string>; appVersion: string; log(line: string): void }): Promise<ModelChoice[]> {
  const acp = new AcpConnection(input.executable, ['acp'], input);
  const timer = setTimeout(() => acp.kill(new Error('Timed out')), 30_000);
  try {
    await acp.request('initialize', initializeParams(input.appVersion));
    const listed = await acp.request<{ models?: ListedModel[] }>('cursor/list_available_models', {});
    return (Array.isArray(listed.models) ? listed.models : []).flatMap((model): ModelChoice[] => {
      const id = text(model.value);
      if (!id) return [];
      const effort = configOptions(model.configOptions).find((option) => option.category === 'thought_level');
      const efforts = (effort?.options ?? []).filter((option) => EFFORT_NAME.test(option.value)).map((option) => ({ id: option.value, label: option.name }));
      return [{ id, label: text(model.name), ...(efforts.length ? { efforts, defaultEffort: effort?.currentValue } : {}) }];
    });
  } catch (error) {
    throw signInError(error);
  } finally {
    clearTimeout(timer);
    await acp.close();
  }
}

function cli(executable: string, args: string[], env: Record<string, string>, timeout: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(executable, args, { env, timeout }, (_error, stdout) => resolve(stdout ?? ''));
  });
}

async function cliJson(executable: string, args: string[], env: Record<string, string>): Promise<Json | null> {
  const output = await cli(executable, args, env, 20_000);
  try {
    const value: unknown = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Asks the Cursor CLI who is signed in and on which plan, so CooPrompt never reads its credentials. */
export async function cursorSignIn(input: { executable: string | null; env: Record<string, string> }): Promise<CursorSignIn> {
  if (!input.executable) return { installed: false, loggedIn: false };
  const [status, about] = await Promise.all([cliJson(input.executable, ['status', '--format', 'json'], input.env), cliJson(input.executable, ['about', '--format', 'json'], input.env)]);
  const loggedIn = status?.isAuthenticated === true;
  return { installed: true, loggedIn, ...(loggedIn ? { email: text(about?.userEmail), plan: text(about?.subscriptionTier) } : {}) };
}

/** The Cursor CLI's own browser sign-in; the account it ends up with replaces the previous one. */
export async function cursorLogin(input: { executable: string | null; env: Record<string, string> }): Promise<CursorSignIn> {
  if (!input.executable) throw new Error(CURSOR_NOT_INSTALLED);
  const { NO_OPEN_BROWSER: _quiet, ...env } = input.env;
  await cli(input.executable, ['login'], env, 5 * 60_000);
  return cursorSignIn(input);
}
