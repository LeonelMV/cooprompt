import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Stand-ins for the engine binaries. Each run appends what it was asked to `log.jsonl` in `FAKE_ENGINE_DIR`
 * (the session it resumed, forked or started, the prompt, and everything it got: its arguments and stdin),
 * answers with the session and the request's last line, and waits for a file named after `WAIT:<name>` in the
 * request, so a test decides when a turn ends. The Claude stand-in also asks for each `ASK:<tool>` in the
 * request (`AskUserQuestion` asks a question) and logs the answer it got.
 */
const OWN_REQUEST = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_ENGINE_DIR;
const log = (entry) => fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify(entry) + '\\n');
const waitFor = async (request) => {
  const name = /WAIT:(\\w+)/.exec(request)?.[1];
  while (name && !fs.existsSync(path.join(dir, name))) await new Promise((resolve) => setTimeout(resolve, 25));
};
const lastLine = (text) => text.trim().split('\\n').pop();
`;

const FAKE_CODEX = `#!/usr/bin/env node
${OWN_REQUEST}
const args = process.argv.slice(2);
const at = args.indexOf('resume');
const resumed = at >= 0 ? args[at + 1] : null;
const thread = resumed ?? 'thread-' + process.pid;
let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', async () => {
  const request = prompt.includes('</cooprompt_context>') ? prompt.slice(prompt.lastIndexOf('</cooprompt_context>')) : prompt;
  log({ engine: 'codex', session: thread, resumed, request: lastLine(request), prompt, args, stdin: prompt });
  const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  out({ type: 'thread.started', thread_id: thread });
  await waitFor(request);
  out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Answer from ' + thread + ' to ' + lastLine(request) } });
  out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
});
`;

const FAKE_CLAUDE = `#!/usr/bin/env node
${OWN_REQUEST}
const crypto = require('node:crypto');
const readline = require('node:readline');
const args = process.argv.slice(2);
const flag = (name) => {
  const joined = args.find((arg) => arg.startsWith(name + '='));
  return joined ? joined.slice(name.length + 1) : args.includes(name) ? args[args.indexOf(name) + 1] : null;
};
const resumed = flag('--resume');
const forked = args.includes('--fork-session');
const session = resumed && !forked ? resumed : crypto.randomUUID();
const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const asked = new Map();
const ask = (tool) =>
  new Promise((resolve) => {
    const id = 'ask-' + crypto.randomUUID();
    asked.set(id, resolve);
    const input = tool === 'AskUserQuestion' ? { questions: [{ question: '¿Sigo?', header: 'Sigo', multiSelect: false, options: [{ label: 'Sí' }, { label: 'No' }] }] } : { command: 'git push origin main' };
    out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: 'toolu_' + id } });
  });
let preamble = null;
const received = [];
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  received.push(line);
  const message = JSON.parse(line);
  if (message.type === 'control_response') {
    const resolve = asked.get(message.response.request_id);
    asked.delete(message.response.request_id);
    resolve?.(message.response.response ?? message.response);
    return;
  }
  if (message.type === 'control_request') {
    const subtype = message.request.subtype;
    const response = subtype === 'initialize' ? { commands: [], models: [], account: {} } : subtype === 'get_context_usage' ? { totalTokens: 1000, rawMaxTokens: 200000 } : {};
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
    return;
  }
  if (message.type !== 'user') return;
  const content = message.message.content;
  if (message.shouldQuery === false) return void (preamble = content);
  out({ type: 'system', subtype: 'init', session_id: session, model: 'fake', claude_code_version: '0', tools: [], mcp_servers: [], skills: [], slash_commands: [], agents: [], uuid: crypto.randomUUID() });
  const uuid = crypto.randomUUID();
  log({ engine: 'claude', session, resumed, forked, resumeAt: flag('--resume-session-at'), answered: uuid, request: lastLine(content), prompt: (preamble ?? '') + '\\n\\n' + content, args, stdin: received.join('\\n') });
  for (const [, tool] of content.matchAll(/ASK:(\\w+)/g)) log({ engine: 'claude', session, asked: tool, answer: await ask(tool) });
  await waitFor(content);
  out({ type: 'assistant', uuid, session_id: session, parent_tool_use_id: null, message: { id: 'msg_' + uuid, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'Answer from ' + session + ' to ' + lastLine(content) }], usage: { input_tokens: 1, output_tokens: 1 } } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: session, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'ok', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], uuid: crypto.randomUUID() });
});
`;

export interface EngineRun {
  engine: 'codex' | 'claude';
  session: string;
  resumed: string | null;
  forked?: boolean;
  resumeAt?: string | null;
  answered?: string;
  request: string;
  prompt: string;
  args?: string[];
  stdin?: string;
  /** Entries of the Claude stand-in's `ASK:` requests instead of a run. */
  asked?: string;
  answer?: { behavior: string; message?: string };
}

/** Writes the stand-in `codex` and `claude` into `bin`. */
export async function writeFakeEngines(bin: string): Promise<void> {
  await writeFile(join(bin, 'codex'), FAKE_CODEX);
  await writeFile(join(bin, 'claude'), FAKE_CLAUDE);
  await chmod(join(bin, 'codex'), 0o755);
  await chmod(join(bin, 'claude'), 0o755);
}

/** Everything the stand-ins logged in `dir`, in order. */
export async function engineLog(dir: string): Promise<EngineRun[]> {
  if (!existsSync(join(dir, 'log.jsonl'))) return [];
  return (await readFile(join(dir, 'log.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as EngineRun);
}

export const until = async (check: () => Promise<boolean> | boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not reached in time');
};
