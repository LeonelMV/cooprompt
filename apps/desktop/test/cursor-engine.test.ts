import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DraftState, ItemUpsert, PermissionModeId } from '@cooprompt/protocol';
import {
  CURSOR_LEFT_PLAN,
  CURSOR_NEW_SESSION,
  CURSOR_NOT_SIGNED_IN,
  CURSOR_REFUSED,
  CURSOR_STOPPED_EARLY,
  cursorModels,
  cursorSignIn,
  findCursorAgent,
  runCursor,
  stopCursorAgents,
} from '../src/main/engines/cursor.ts';
import { cursorEnv } from '../src/main/engines/providers.ts';
import type { EngineInfo } from '../src/shared/types.ts';
import type { EngineAttachment, PermissionAnswer, PermissionRequest } from '../src/main/engines/types.ts';
import { translateMessage } from '../src/shared/i18n.ts';

let dir: string;
let agent: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cooprompt-cursor-'));
  agent = join(dir, 'bin', 'cursor-agent');
  await mkdir(join(dir, 'bin'));
  await writeFile(agent, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL('./fake-cursor-agent.mjs', import.meta.url))}" "$@"\n`);
  await chmod(agent, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Logged = { args?: string[]; method?: string; params?: Record<string, any>; answer?: string; result?: Record<string, any> };

const permission = (toolCall: Record<string, unknown>) => ({
  request: {
    method: 'session/request_permission',
    params: {
      sessionId: 's-new',
      toolCall: { status: 'pending', ...toolCall },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  },
});

const MODEL_OPTIONS = [
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'agent', options: [{ value: 'agent' }, { value: 'plan' }] },
  { id: 'model', category: 'model', type: 'select', currentValue: 'composer-2.5', options: [{ value: 'composer-2.5', name: 'Composer 2.5' }, { value: 'gpt-5.5', name: 'GPT-5.5' }] },
  { id: 'reasoning', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
];

/** Plays a scenario through the fake CLI; returns the result, what the turn published and what the CLI received. */
async function launch(
  scenario: Record<string, unknown>,
  options: Partial<{
    permissionMode: PermissionModeId;
    sessionId: string;
    prompt: string;
    model: string;
    effort: string;
    abortOn: (item: Omit<ItemUpsert, 'id'>) => boolean;
    abortOnInfo: boolean;
    onItem: (item: Omit<ItemUpsert, 'id'>) => void;
    answer: (request: PermissionRequest) => PermissionAnswer;
    answers: Record<string, string> | null;
    attachments: EngineAttachment[];
  }> = {},
) {
  const name = `run-${Math.random().toString(36).slice(2)}`;
  const log = join(dir, `${name}.log`);
  await writeFile(join(dir, `${name}.json`), JSON.stringify({ configOptions: MODEL_OPTIONS, ...scenario }));
  const items: (Omit<ItemUpsert, 'id'> & { key: string })[] = [];
  const deltas: string[] = [];
  const infos: Omit<EngineInfo, 'at'>[] = [];
  const asked: PermissionRequest[] = [];
  const questions: unknown[] = [];
  const controller = new AbortController();
  const result = await runCursor({
    cwd: dir,
    prompt: options.prompt ?? '[Ana]: hola',
    attachments: options.attachments ?? [],
    nativeMedia: true,
    preamble: '<cooprompt_context>\nEarlier: Leo asked for tests\n</cooprompt_context>',
    systemAppend: 'You are working inside CooPrompt.',
    model: options.model ?? null,
    effort: options.effort ?? null,
    sessionId: options.sessionId ?? null,
    permissionMode: options.permissionMode ?? 'acceptEdits',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_CURSOR_LOG: log, FAKE_CURSOR_SCENARIO: join(dir, `${name}.json`), NO_OPEN_BROWSER: '1' },
    mcpServers: {
      notion: { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer t' } },
      playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'], env: { DEBUG: '1' }, cwd: '/tmp', envVars: ['PATH'] },
    },
    signal: controller.signal,
    sink: {
      item: (key, item) => {
        items.push({ key, ...item });
        options.onItem?.(item);
        if (options.abortOn?.(item)) controller.abort();
      },
      draft: () => {},
      delta: (_kind: DraftState['kind'], text: string) => deltas.push(text),
      info: (info) => {
        infos.push(info);
        if (options.abortOnInfo) controller.abort();
      },
      attach: () => {},
    },
    requestPermission: async (request) => {
      asked.push(request);
      return options.answer?.(request) ?? { allow: true };
    },
    askQuestion: async (request) => {
      questions.push(request.questions);
      return options.answers === undefined ? null : options.answers;
    },
    log: () => {},
    executable: agent,
    nativeMcpServers: ['atlassian'],
    appVersion: '9.9.9',
  });
  const received = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Logged);
  const calls = (method: string) => received.filter((entry) => entry.method === method);
  const latest = (key: string) => items.filter((item) => item.key === key).at(-1);
  return { result, items, latest, deltas, infos, asked, questions, received, calls };
}

describe('Cursor turns', () => {
  it("streams Cursor's reply, reasoning and tools into CooPrompt's items", async () => {
    const run = await launch({
      turn: [
        { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Pensando' } } },
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hola' } } },
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ', Ana' } } },
        { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: '`ls src`', kind: 'execute', status: 'pending', rawInput: { command: 'ls src' } } },
        { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { exitCode: 0, stdout: 'app.ts\n', stderr: '' } } },
        { update: { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Edit `src/app.ts`', kind: 'edit', status: 'pending', rawInput: { path: 'src/app.ts' } } },
        {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 't2',
            status: 'completed',
            content: [{ type: 'diff', path: 'src/app.ts', oldText: 'a\nb\nc\nd\ne\nf', newText: 'a\nb\nc\nD\ne\nf' }],
          },
        },
        { update: { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'notion: search', kind: 'other', status: 'completed', rawInput: { providerIdentifier: 'notion', toolName: 'search', args: { query: 'roadmap' } }, rawOutput: { success: true } } },
        { update: { sessionUpdate: 'tool_call', toolCallId: 't4', title: 'grep "TODO"', kind: 'search', status: 'completed', rawInput: { pattern: 'TODO' }, rawOutput: { error: 'rg failed' } } },
        { update: { sessionUpdate: 'plan', entries: [{ content: 'Leer', priority: 'high', status: 'completed' }, { content: 'Editar', priority: 'high', status: 'in_progress' }] } },
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Listo.' } } },
      ],
    });
    expect(run.result).toMatchObject({ status: 'done', sessionId: 's-new' });
    expect(run.result.usage?.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.items.filter((item) => item.kind === 'text' || item.kind === 'thinking').map((item) => [item.kind, (item.data as { text: string }).text])).toEqual([
      ['thinking', 'Pensando'],
      ['text', 'Hola, Ana'],
      ['text', 'Listo.'],
    ]);
    expect(run.deltas.join('')).toBe('PensandoHola, AnaListo.');
    expect(run.latest('tool.t1')?.data).toEqual({ toolUseId: 't1', name: 'Bash', input: { command: 'ls src' }, status: 'done', output: 'app.ts\n' });
    expect(run.latest('tool.t2')?.data).toMatchObject({ name: 'Edit', input: { file_path: 'src/app.ts', old_string: 'd', new_string: 'D' }, status: 'done' });
    expect(run.latest('tool.t3')?.data).toEqual({ toolUseId: 't3', name: 'mcp__notion__search', input: { query: 'roadmap' }, status: 'done' });
    expect(run.latest('tool.t4')?.data).toMatchObject({ name: 'Grep', input: { pattern: 'TODO' }, status: 'error', output: 'rg failed' });
    expect(run.latest('todos')?.data).toEqual({ items: [{ text: 'Leer', status: 'completed' }, { text: 'Editar', status: 'in_progress' }] });
    expect(run.infos.at(-1)).toMatchObject({ engine: 'cursor', model: 'Composer 2.5', slashCommands: ['deploy'], mcpServers: [{ name: 'atlassian' }, { name: 'notion' }, { name: 'playwright' }] });
  });

  it("uses the CLI's own sign-in, without a browser or ambient keys, and hands over CooPrompt's connectors in memory", async () => {
    const profile = { id: 'p', label: 'Cursor', engine: 'cursor' as const, kind: 'cursor-login' as const, createdAt: 0 };
    expect(cursorEnv(profile, { PATH: '/bin', CURSOR_API_KEY: 'key_from_shell', HOME: '/Users/ana' })).toEqual({ PATH: '/bin', HOME: '/Users/ana', NO_OPEN_BROWSER: '1' });
    const run = await launch({});
    expect(run.received[0]).toMatchObject({ args: ['acp'], env: { NO_OPEN_BROWSER: '1' } });
    expect(run.calls('authenticate')).toEqual([]);
    expect(run.calls('initialize')[0].params).toMatchObject({ clientCapabilities: { terminal: false, fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: 'CooPrompt', version: '9.9.9' } });
    expect(run.calls('session/new')[0].params).toEqual({
      cwd: dir,
      mcpServers: [
        { type: 'http', name: 'notion', url: 'https://mcp.notion.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
        { name: 'playwright', command: 'npx', args: ['@playwright/mcp'], env: [{ name: 'PATH', value: process.env.PATH ?? '/usr/bin:/bin' }, { name: 'DEBUG', value: '1' }], cwd: '/tmp' },
      ],
    });
    expect(run.calls('session/set_mode')[0].params).toEqual({ sessionId: 's-new', modeId: 'agent' });
    const prompt = run.calls('session/prompt')[0].params!.prompt;
    expect(prompt).toEqual([{ type: 'text', text: 'You are working inside CooPrompt.\n\n<cooprompt_context>\nEarlier: Leo asked for tests\n</cooprompt_context>\n\n[Ana]: hola' }]);
  });

  it('asks before what Cursor wants approved, and keeps "always" to CooPrompt', async () => {
    const scenario = { turn: [permission({ toolCallId: 'c1', title: '`rm -rf build`', kind: 'execute' })] };
    const allowed = await launch(scenario);
    expect(allowed.asked).toEqual([{ key: 'c1', toolName: 'Bash', input: { command: 'rm -rf build' }, description: undefined, allowAlways: true }]);
    expect(allowed.received.find((entry) => entry.answer)?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    const denied = await launch(scenario, { answer: () => ({ allow: false }) });
    expect(denied.received.find((entry) => entry.answer)?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
  });

  it('asks before connector tools like any other action, and refuses them in Plan mode', async () => {
    const send = permission({ toolCallId: 's1', title: 'slack: slack_send_message', kind: 'other', content: [{ type: 'content', content: { type: 'text', text: '```json\n{"channel_id":"U1","message":"hola"}\n```' } }] });
    const allowed = await launch({ turn: [send] });
    expect(allowed.asked).toEqual([{ key: 's1', toolName: 'mcp__slack__slack_send_message', input: { channel_id: 'U1', message: 'hola' }, description: undefined, allowAlways: true }]);
    expect(allowed.received.find((entry) => entry.answer)?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    const planned = await launch({ turn: [send] }, { permissionMode: 'plan' });
    expect(planned.asked).toEqual([]);
    expect(planned.received.find((entry) => entry.answer)?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
  });

  it('runs everything without asking only with "No restrictions"', async () => {
    expect((await launch({})).received[0].args).toEqual(['acp']);
    expect((await launch({}, { permissionMode: 'bypassPermissions' })).received[0].args).toEqual(['--force', 'acp']);
  });

  it('keeps Plan mode read-only: changes are refused and leaving plan mode stops the turn', async () => {
    const run = await launch(
      {
        turn: [
          permission({ toolCallId: 'w1', title: 'Edit `src/app.ts`', kind: 'edit' }),
          permission({ toolCallId: 'r1', title: 'Read `/etc/hosts`', kind: 'read' }),
          { update: { sessionUpdate: 'tool_call', toolCallId: 'm1', title: 'Switch Mode: agent', kind: 'switch_mode', status: 'pending', rawInput: { targetModeId: 'agent' } } },
          { waitCancel: true },
        ],
      },
      { permissionMode: 'plan' },
    );
    expect(run.calls('session/set_mode')[0].params).toEqual({ sessionId: 's-new', modeId: 'plan' });
    expect(run.received.filter((entry) => entry.answer).map((entry) => entry.result)).toEqual([
      { outcome: { outcome: 'selected', optionId: 'reject-once' } },
      { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    ]);
    expect(run.asked.map((request) => request.toolName)).toEqual(['Read']);
    expect(run.calls('session/cancel')).toHaveLength(1);
    expect(run.result).toMatchObject({ status: 'failed', error: CURSOR_LEFT_PLAN });
    expect(translateMessage('es', CURSOR_LEFT_PLAN)).toContain('modo Plan');

    // A CLI that goes on editing after the cancel is ended.
    const edit = { sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'Edit `src/app.ts`', kind: 'edit', status: 'pending', rawInput: { path: 'src/app.ts' } };
    const stubborn = await launch({ turn: [{ update: edit }, { sleep: 5000 }] }, { permissionMode: 'plan' });
    expect(stubborn.result).toMatchObject({ status: 'failed', error: CURSOR_LEFT_PLAN });
  });

  it("passes Cursor's questions to the chat and their answers back", async () => {
    const ask = {
      request: {
        method: 'cursor/ask_question',
        params: { toolCallId: 'q1', title: 'Antes de seguir', questions: [{ id: 'db', prompt: '¿Qué base?', options: [{ id: 'pg', label: 'Postgres' }, { id: 'my', label: 'MySQL' }] }] },
      },
    };
    const answered = await launch({ turn: [ask] }, { answers: { '¿Qué base?': 'Postgres' } });
    expect(answered.questions).toEqual([[{ question: '¿Qué base?', options: [{ label: 'Postgres' }, { label: 'MySQL' }], multiSelect: false }]]);
    expect(answered.received.find((entry) => entry.answer)?.result).toEqual({ outcome: { outcome: 'answered', answers: [{ questionId: 'db', selectedOptionIds: ['pg'] }] } });
    const ownWords = await launch({ turn: [ask] }, { answers: { '¿Qué base?': 'SQLite' } });
    expect(ownWords.received.find((entry) => entry.answer)?.result).toEqual({ outcome: { outcome: 'skipped', reason: 'The user answered: "¿Qué base?": SQLite' } });
  });

  it('fails the turn with what the CLI wrote as its reply when the run broke', async () => {
    const run = await launch({
      turn: [
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Empiezo' } } },
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nError: [resource_exhausted] You are out of usage' } } },
      ],
    });
    expect(run.result).toMatchObject({ status: 'failed', error: 'Error: [resource_exhausted] You are out of usage' });
    expect(run.items.filter((item) => item.kind === 'text').map((item) => (item.data as { text: string }).text)).toEqual(['Empiezo']);
  });

  it('stops a running turn with ACP cancel and reports it cancelled', async () => {
    const run = await launch(
      { turn: [{ update: { sessionUpdate: 'tool_call', toolCallId: 'long', title: '`sleep 60`', kind: 'execute', status: 'pending', rawInput: { command: 'sleep 60' } } }, { waitCancel: true }] },
      { abortOn: (item) => item.kind === 'tool' },
    );
    expect(run.calls('session/cancel')[0].params).toEqual({ sessionId: 's-new' });
    expect(run.result).toMatchObject({ status: 'cancelled', sessionId: 's-new' });
  });

  it('never sends the prompt of a turn stopped while its session was being prepared', async () => {
    const run = await launch({}, { abortOnInfo: true });
    expect(run.result).toMatchObject({ status: 'cancelled' });
    expect(run.calls('session/prompt')).toEqual([]);
  });

  it('ends the CLIs still running when CooPrompt quits', async () => {
    const run = await launch(
      { turn: [{ update: { sessionUpdate: 'tool_call', toolCallId: 'long', title: '`sleep 60`', kind: 'execute', status: 'pending', rawInput: { command: 'sleep 60' } } }, { waitCancel: true }] },
      { onItem: (item) => item.kind === 'tool' && stopCursorAgents() },
    );
    expect(run.result).toMatchObject({ status: 'failed', error: expect.stringContaining('The Cursor CLI was stopped') });
  });

  it("reports a refusal as a failure and a reply cut short with a notice", async () => {
    expect((await launch({ stopReason: 'refusal' })).result).toMatchObject({ status: 'failed', error: CURSOR_REFUSED });
    const cut = await launch({ stopReason: 'max_tokens' });
    expect(cut.result.status).toBe('done');
    expect(cut.latest('cursor-stopped')?.data).toEqual({ text: CURSOR_STOPPED_EARLY, level: 'warn' });
  });

  it('leaves out remote connectors the CLI says it cannot take', async () => {
    const run = await launch({ mcpCapabilities: { http: false } });
    expect(run.calls('session/new')[0].params!.mcpServers.map((server: { name: string }) => server.name)).toEqual(['playwright']);
  });

  it('resumes its own session without republishing the history Cursor replays', async () => {
    const run = await launch(
      {
        sessions: ['s-old'],
        replay: [
          { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'antes' } },
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'respuesta vieja' } },
        ],
        turn: [{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'nueva' } } }],
      },
      { sessionId: 's-old' },
    );
    expect(run.calls('session/load')[0].params).toMatchObject({ sessionId: 's-old', cwd: dir });
    expect(run.calls('session/new')).toEqual([]);
    expect(run.items.map((item) => item.kind === 'text' && (item.data as { text: string }).text).filter(Boolean)).toEqual(['nueva']);
    expect(run.result).toMatchObject({ status: 'done', sessionId: 's-old' });
    expect(run.calls('session/prompt')[0].params!.prompt[0].text).not.toContain('You are working inside CooPrompt.');
  });

  it("starts a new session, and says so, when Cursor no longer has the one to resume", async () => {
    const run = await launch({}, { sessionId: 'gone' });
    expect(run.latest('cursor-new-session')?.data).toEqual({ text: CURSOR_NEW_SESSION, level: 'warn' });
    expect(run.result).toMatchObject({ status: 'done', sessionId: 's-new' });
    expect(run.calls('session/prompt')[0].params!.prompt[0].text).toContain('You are working inside CooPrompt.');
  });

  it('explains how to sign in when the Cursor CLI is signed out', async () => {
    const run = await launch({ authenticated: false });
    expect(run.result).toMatchObject({ status: 'failed', error: CURSOR_NOT_SIGNED_IN });
    expect(translateMessage('es', CURSOR_NOT_SIGNED_IN)).toContain('cursor-agent login');
  });

  it('applies the model and the reasoning level chosen in the composer', async () => {
    const run = await launch({}, { model: 'gpt-5.5', effort: 'high' });
    expect(run.calls('session/set_config_option').map((entry) => entry.params)).toEqual([
      { sessionId: 's-new', configId: 'model', value: 'gpt-5.5' },
      { sessionId: 's-new', configId: 'reasoning', value: 'high' },
    ]);
    expect(run.infos.at(-1)?.model).toBe('GPT-5.5');
    expect((await launch({}, { model: 'composer-2.5', effort: 'ultra' })).calls('session/set_config_option')).toEqual([]);
  });

  it('sends attached images in the prompt and leaves the other files to their paths', async () => {
    await writeFile(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const run = await launch(
      {},
      {
        attachments: [
          { name: 'shot.png', mime: 'image/png', kind: 'image', size: 4, path: join(dir, 'shot.png') },
          { name: 'notes.pdf', mime: 'application/pdf', kind: 'pdf', size: 10, path: join(dir, 'notes.pdf') },
        ],
      },
    );
    const prompt = run.calls('session/prompt')[0].params!.prompt;
    expect(prompt.slice(1)).toEqual([{ type: 'image', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') }]);
  });

  it('sends a slash command alone so Cursor runs it, with the context attached', async () => {
    const run = await launch({}, { prompt: '/deploy staging' });
    const [command, context] = run.calls('session/prompt')[0].params!.prompt;
    expect(command).toEqual({ type: 'text', text: '/deploy staging' });
    expect(context).toMatchObject({ type: 'resource', resource: { uri: 'cooprompt://context', text: expect.stringContaining('Leo asked for tests') } });
  });
});

describe('the Cursor account on this Mac', () => {
  const env = (scenario: Record<string, unknown>) => {
    const file = join(dir, `account-${Math.random().toString(36).slice(2)}.json`);
    return writeFile(file, JSON.stringify(scenario)).then(() => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_CURSOR_SCENARIO: file }));
  };

  it('shows who is signed in and on which plan, as the CLI reports it', async () => {
    expect(await cursorSignIn({ executable: agent, env: await env({}) })).toEqual({ installed: true, loggedIn: true, email: 'ana@example.com', plan: 'Pro' });
    expect(await cursorSignIn({ executable: agent, env: await env({ authenticated: false }) })).toEqual({ installed: true, loggedIn: false });
    expect(await cursorSignIn({ executable: null, env: {} })).toEqual({ installed: false, loggedIn: false });
  });

  it("lists the account's models with their reasoning levels", async () => {
    const models = [
      { value: 'gpt-5.5', name: 'GPT-5.5', configOptions: [{ id: 'reasoning', category: 'thought_level', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'Weird.Value', name: 'Nope' }] }] },
      { value: 'composer-2.5', name: 'Composer 2.5', configOptions: [{ id: 'fast', category: 'model_config', currentValue: 'false', options: [{ value: 'false' }, { value: 'true' }] }] },
    ];
    expect(await cursorModels({ executable: agent, cwd: dir, env: await env({ models }), appVersion: '1', log: () => {} })).toEqual([
      { id: 'gpt-5.5', label: 'GPT-5.5', efforts: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }], defaultEffort: 'medium' },
      { id: 'composer-2.5', label: 'Composer 2.5' },
    ]);
    await expect(cursorModels({ executable: agent, cwd: dir, env: await env({ authenticated: false }), appVersion: '1', log: () => {} })).rejects.toThrow(CURSOR_NOT_SIGNED_IN);
  });

  it('finds the CLI where its installer puts it, or where COOPROMPT_CURSOR_AGENT says', () => {
    expect(findCursorAgent({ PATH: ['/nowhere', join(dir, 'bin')].join(delimiter), HOME: dir })).toBe(agent);
    expect(findCursorAgent({ PATH: '/nowhere', HOME: dir })).toBeNull();
    expect(findCursorAgent({ PATH: '/nowhere', HOME: dir, COOPROMPT_CURSOR_AGENT: agent })).toBe(agent);
  });
});
