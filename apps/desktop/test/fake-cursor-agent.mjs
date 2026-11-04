// Stand-in for the Cursor CLI: answers `status`, `about` and `login`, and speaks enough of its ACP server
// (`acp`) to play a scenario. Everything it receives is appended to $FAKE_CURSOR_LOG.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CURSOR_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_CURSOR_SCENARIO, 'utf8')) : {};
const record = (entry) => process.env.FAKE_CURSOR_LOG && appendFileSync(process.env.FAKE_CURSOR_LOG, `${JSON.stringify(entry)}\n`);
record({ args, env: { NO_OPEN_BROWSER: process.env.NO_OPEN_BROWSER ?? null, CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? null } });

const authenticated = scenario.authenticated !== false;
if (args[0] === 'status') {
  console.log(JSON.stringify({ status: authenticated ? 'authenticated' : 'unauthenticated', isAuthenticated: authenticated, message: authenticated ? 'Logged in' : 'Not logged in' }, null, 2));
  process.exit(0);
}
if (args[0] === 'about') {
  console.log(JSON.stringify({ cliVersion: 'fake', model: 'Auto', userEmail: authenticated ? 'ana@example.com' : null, subscriptionTier: authenticated ? 'Pro' : null }, null, 2));
  process.exit(0);
}
if (args[0] === 'login') process.exit(0);

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
const authError = { code: -32000, message: "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'." };
let options = structuredClone(scenario.configOptions ?? []);
let nextId = 1000;
const waiting = new Map();
let cancelled = () => {};
let cancelledAlready = false;

/** Like the CLI, right after answering a new or loaded session. */
const announceCommands = (sessionId) =>
  setTimeout(() => update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'copy-request-id', description: '' }, { name: 'deploy', description: 'Ship it' }] }), 0);

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

/** `byPrompt` picks the steps for prompts that contain its `match`; `turn` is for the rest. */
async function play(sessionId, prompt) {
  const text = (prompt ?? []).map((block) => block.text ?? '').join('\n');
  const steps = (scenario.byPrompt ?? []).find((entry) => text.includes(entry.match))?.turn ?? scenario.turn ?? [];
  for (const step of steps) {
    if (step.sleep) await new Promise((resolve) => setTimeout(resolve, step.sleep));
    if (step.update) update(sessionId, step.update);
    if (step.request) record({ answer: step.request.method, result: await request(step.request.method, step.request.params) });
    if (step.waitCancel) {
      await new Promise((resolve) => {
        cancelled = resolve;
        if (cancelledAlready) resolve();
      });
      return 'cancelled';
    }
  }
  return scenario.stopReason ?? 'end_turn';
}

async function handle(message) {
  const { id, method, params } = message;
  if (!method) {
    waiting.get(id)?.(message.result ?? message.error);
    waiting.delete(id);
    return;
  }
  record({ method, params });
  if (method === 'session/cancel') {
    cancelledAlready = true;
    cancelled();
    return;
  }
  const reply = (result) => send({ id, result });
  const fail = (error) => send({ id, error });
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: scenario.mcpCapabilities ?? { http: true, sse: true } }, authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }] });
    case 'session/new':
      if (!authenticated) return fail(authError);
      announceCommands('s-new');
      return reply({ sessionId: 's-new', modes: { currentModeId: 'agent', availableModes: [] }, configOptions: options });
    case 'session/load':
      if (!(scenario.sessions ?? []).includes(params.sessionId)) return fail({ code: -32602, message: `Session "${params.sessionId}" not found` });
      for (const value of scenario.replay ?? []) update(params.sessionId, value);
      announceCommands(params.sessionId);
      return reply({ modes: { currentModeId: 'agent', availableModes: [] }, configOptions: options });
    case 'session/set_config_option': {
      const option = options.find((entry) => entry.id === params.configId);
      if (!option || !option.options.some((entry) => entry.value === params.value)) return fail({ code: -32602, message: `Invalid model value: ${params.value}` });
      option.currentValue = params.value;
      return reply({ configOptions: options });
    }
    case 'session/set_mode':
      update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
      return reply({});
    case 'session/prompt':
      return reply({ stopReason: await play(params.sessionId, params.prompt) });
    case 'cursor/list_available_models':
      if (!authenticated) return fail(authError);
      return reply({ models: scenario.models ?? [] });
    default:
      return fail({ code: -32601, message: `Method not found: ${method}` });
  }
}

createInterface({ input: process.stdin })
  .on('line', (line) => void handle(JSON.parse(line)))
  .on('close', () => process.exit(0));
