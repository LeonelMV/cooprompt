import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ItemUpsert } from '@cooprompt/protocol';
import { runClaude } from '../src/main/engines/claude.ts';
import { runCodex } from '../src/main/engines/codex.ts';
import type { EngineAttachment, EngineMedia, EngineRunInput } from '../src/main/engines/types.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

let dir: string;
let files: Record<'png' | 'pdf' | 'big' | 'svg', EngineAttachment>;

/**
 * Stand-in for Claude Code: answers the SDK's control requests, records the prompt messages it gets and ends the
 * turn; with FAKE_CLAUDE_SCREENSHOT it first runs a tool whose result carries an image, like a browser screenshot.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf('\\n'); index >= 0; index = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], models: [], agents: [], account: {} } } });
      continue;
    }
    if (message.type !== 'user' || message.shouldQuery === false) continue;
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(message.message.content) + '\\n');
    out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake', claude_code_version: '0', tools: [], mcp_servers: [], skills: [], slash_commands: [], agents: [], uuid: 'u0' });
    if (process.env.FAKE_CLAUDE_SCREENSHOT) {
      const tool = { type: 'tool_use', id: 'toolu_1', name: 'mcp__playwright__browser_take_screenshot', input: {} };
      out({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [tool] }, parent_tool_use_id: null, session_id: 's1', uuid: 'u1' });
      const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: process.env.FAKE_CLAUDE_SCREENSHOT } };
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Took a screenshot' }, image] }] }, parent_tool_use_id: null, session_id: 's1', uuid: 'u2' });
    }
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', duration_ms: 1, num_turns: 1, result: 'ok', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, uuid: 'u3' });
  }
});
`;

/** Stand-in for the Codex binary: records its arguments, replays the given events and completes the turn. */
const FAKE_CODEX = `#!/bin/bash
printf '%s\\n' "$@" > "$FAKE_CODEX_ARGS"
cat > /dev/null
echo '{"type":"thread.started","thread_id":"thread-1"}'
if [ -n "$FAKE_CODEX_EVENTS" ]; then cat "$FAKE_CODEX_EVENTS"; fi
echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cooprompt-engine-media-'));
  await writeFile(join(dir, 'claude'), FAKE_CLAUDE);
  await writeFile(join(dir, 'codex'), FAKE_CODEX);
  await chmod(join(dir, 'claude'), 0o755);
  await chmod(join(dir, 'codex'), 0o755);
  const file = async (name: string, content: Buffer, mime: string, kind: EngineAttachment['kind']): Promise<EngineAttachment> => {
    await writeFile(join(dir, name), content);
    return { name, mime, kind, size: content.length, path: join(dir, name) };
  };
  files = {
    png: await file('pantalla.png', PNG, 'image/png', 'image'),
    pdf: await file('informe.pdf', PDF, 'application/pdf', 'pdf'),
    big: await file('enorme.png', Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]), 'image/png', 'image'),
    svg: await file('logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'image'),
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sink() {
  const items: (Omit<ItemUpsert, 'id'> & { key: string })[] = [];
  const attached: { key: string; media: EngineMedia[] }[] = [];
  return {
    items,
    attached,
    sink: { item: (key: string, item: Omit<ItemUpsert, 'id'>) => items.push({ key, ...item }), draft: () => {}, delta: () => {}, info: () => {}, attach: (key: string, media: EngineMedia[]) => attached.push({ key, media }) },
  };
}

const base = (attachments: EngineAttachment[], nativeMedia: boolean, sinkValue: EngineRunInput['sink']): Omit<EngineRunInput, 'env'> => ({
  cwd: dir,
  prompt: 'What do you see?',
  attachments,
  nativeMedia,
  preamble: null,
  systemAppend: '',
  model: null,
  effort: null,
  sessionId: null,
  permissionMode: 'default',
  mcpServers: {},
  signal: new AbortController().signal,
  sink: sinkValue,
  requestPermission: async () => ({ allow: false }),
  askQuestion: async () => null,
  log: () => {},
});

describe('what Claude receives', () => {
  const launch = async (attachments: EngineAttachment[], nativeMedia: boolean, screenshot?: Buffer) => {
    const log = join(dir, `claude-${Math.random()}.log`);
    const recorder = sink();
    const env: Record<string, string> = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CLAUDE_LOG: log, ...(screenshot ? { FAKE_CLAUDE_SCREENSHOT: screenshot.toString('base64') } : {}) };
    const result = await runClaude({ ...base(attachments, nativeMedia, recorder.sink), env, executable: join(dir, 'claude') });
    const content = JSON.parse((await readFile(log, 'utf8')).trim().split('\n').pop()!);
    return { result, content, ...recorder };
  };

  it('gets images and PDFs in the message itself, before the text, and the rest only by path', async () => {
    const { result, content } = await launch(Object.values(files), true);
    expect(result.status).toBe('done');
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') }, title: 'informe.pdf' },
      { type: 'text', text: 'What do you see?' },
    ]);
  });

  it('gets only text when its provider may not take images', async () => {
    const { content } = await launch([files.png], false);
    expect(content).toBe('What do you see?');
  });

  it('shares the images in tool results, such as screenshots', async () => {
    const { attached, items } = await launch([], true, PNG);
    expect(items.findLast((item) => item.key === 'tool.toolu_1')?.data).toMatchObject({ status: 'done', output: expect.stringContaining('Took a screenshot') });
    expect(attached).toHaveLength(1);
    expect(attached[0].key).toBe('tool.toolu_1');
    expect(attached[0].media).toEqual([{ name: 'browser_take_screenshot-2.png', mime: 'image/png', data: PNG }]);
  });
});

describe('what Codex receives', () => {
  const launch = async (attachments: EngineAttachment[], nativeMedia: boolean, events: unknown[] = []) => {
    const eventsFile = join(dir, 'events.jsonl');
    await writeFile(eventsFile, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', CODEX_HOME: dir, FAKE_CODEX_ARGS: join(dir, 'args'), FAKE_CODEX_EVENTS: eventsFile };
    const recorder = sink();
    const result = await runCodex({ ...base(attachments, nativeMedia, recorder.sink), env, executable: join(dir, 'codex'), setup: { config: {}, env }, nativeMcpServers: [], approvalScopes: [] });
    const args = (await readFile(join(dir, 'args'), 'utf8')).trim().split('\n');
    return { result, images: args.filter((_arg, index) => args[index - 1] === '--image'), ...recorder };
  };

  it('attaches the images it supports and leaves PDFs and SVG to their paths', async () => {
    const { result, images } = await launch(Object.values(files), true);
    expect(result.status).toBe('done');
    expect(images).toEqual([files.png.path, files.big.path]);
    expect((await launch([files.png], false)).images).toEqual([]);
  });

  it('shares the images an MCP tool returns', async () => {
    const screenshot = {
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'mcp_tool_call',
        server: 'chrome-devtools',
        tool: 'take_screenshot',
        arguments: {},
        status: 'completed',
        result: { content: [{ type: 'text', text: 'Took a screenshot' }, { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }], structured_content: null },
      },
    };
    const { attached, items } = await launch([], true, [screenshot]);
    expect(items.find((item) => item.key === 'item_1')?.data).toMatchObject({ name: 'mcp__chrome-devtools__take_screenshot', output: 'Took a screenshot\n[image]' });
    expect(attached).toEqual([{ key: 'item_1', media: [{ name: 'take_screenshot-2.png', mime: 'image/png', data: PNG }] }]);
  });
});
