import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ModelChoice, ProviderPreset, ProviderProfile } from '../../shared/types.ts';
import { tr } from '../i18n.ts';

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Claude · Anthropic API key',
    engine: 'claude',
    kind: 'anthropic',
    needsKey: true,
    keyHint: 'sk-ant-…',
    help: 'Claude Code engine: skills, subagents, hooks, slash commands, CLAUDE.md/AGENTS.md and MCP. Create the key at console.anthropic.com.',
  },
  {
    id: 'claude-login',
    label: 'Claude · Claude Code sign-in on this computer',
    engine: 'claude',
    kind: 'claude-login',
    needsKey: false,
    help: 'Uses the account Claude Code is signed in with on this computer: a Claude subscription (Pro, Max, Team or Enterprise) or an Anthropic Console account. If you are not signed in, use the button below: it opens the browser.',
  },
  {
    id: 'codex-login',
    label: 'Codex · ChatGPT sign-in on this computer',
    engine: 'codex',
    kind: 'codex-login',
    needsKey: false,
    help: 'Uses the Codex ChatGPT sign-in stored on this computer (~/.codex). If you are not signed in, use the button below: it opens the browser.',
  },
  {
    id: 'openai',
    label: 'Codex · OpenAI API key',
    engine: 'codex',
    kind: 'openai',
    needsKey: true,
    keyHint: 'sk-…',
    help: 'Codex engine (AGENTS.md, MCP, sandbox) with an API key from platform.openai.com.',
  },
  {
    id: 'cursor-login',
    label: 'Cursor · Cursor sign-in on this computer',
    engine: 'cursor',
    kind: 'cursor-login',
    needsKey: false,
    help: 'Cursor’s agent through the Cursor CLI, with the account and plan it is signed in with on this computer. Install the CLI using the guide at https://cursor.com/docs/cli/installation; if it is not signed in, use the button below: it opens the browser.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter · any model',
    engine: 'claude',
    kind: 'anthropic-compatible',
    baseUrl: 'https://openrouter.ai/api',
    needsKey: true,
    keyHint: 'sk-or-…',
    help: 'Models from OpenAI, Google, Meta, DeepSeek, Qwen and more on the Claude Code engine (Anthropic-compatible endpoint).',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    engine: 'claude',
    kind: 'anthropic-compatible',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-chat',
    needsKey: true,
    help: 'DeepSeek Anthropic-compatible endpoint on the Claude Code engine.',
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    engine: 'claude',
    kind: 'anthropic-compatible',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    needsKey: true,
    help: 'Moonshot Anthropic-compatible endpoint on the Claude Code engine.',
  },
  {
    id: 'glm',
    label: 'GLM (Z.ai)',
    engine: 'claude',
    kind: 'anthropic-compatible',
    baseUrl: 'https://api.z.ai/api/anthropic',
    needsKey: true,
    help: 'Z.ai Anthropic-compatible endpoint on the Claude Code engine.',
  },
  {
    id: 'ollama',
    label: 'Ollama · local models',
    engine: 'claude',
    kind: 'anthropic-compatible',
    baseUrl: 'http://localhost:11434',
    needsKey: false,
    help: 'Local Ollama models (0.14 or later, Anthropic-compatible API). Nothing leaves your computer.',
  },
  {
    id: 'custom-anthropic',
    label: 'Custom · Anthropic-compatible',
    engine: 'claude',
    kind: 'anthropic-compatible',
    needsKey: true,
    help: 'Any Anthropic-compatible gateway (LiteLLM, corporate proxies, etc.).',
  },
  {
    id: 'custom-openai',
    label: 'Custom · OpenAI-compatible',
    engine: 'codex',
    kind: 'openai-compatible',
    needsKey: true,
    help: 'Any OpenAI-compatible endpoint (Responses or Chat Completions) on the Codex engine. The URL usually ends in /v1.',
  },
];

export const needsKey = (profile: ProviderProfile): boolean =>
  profile.kind === 'anthropic' || profile.kind === 'openai' || (profile.kind === 'anthropic-compatible' && !isLocal(profile.baseUrl)) || (profile.kind === 'openai-compatible' && !isLocal(profile.baseUrl));

const isLocal = (url?: string) => Boolean(url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url));

/** Images and PDFs go in the prompt for the vendors' own models; compatible endpoints may serve text-only ones, so they get paths. */
export const nativeMedia = (profile: ProviderProfile): boolean => !profile.kind.endsWith('-compatible');

const STRIPPED_AUTH_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
  'CURSOR_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'CURSOR_API_ENDPOINT',
];

/** The selected profile fully determines model credentials; ambient keys never leak in. */
export function baseEngineEnv(shellEnv: Record<string, string>): Record<string, string> {
  const env = { ...shellEnv };
  for (const key of STRIPPED_AUTH_ENV) delete env[key];
  return env;
}

/** Without credentials of its own, Claude Code uses the account it is signed in with on this computer. */
export function claudeBaseEnv(shellEnv: Record<string, string>, appVersion: string): Record<string, string> {
  const env = baseEngineEnv(shellEnv);
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `cooprompt/${appVersion}`;
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

export function claudeEnv(profile: ProviderProfile, key: string | null, shellEnv: Record<string, string>, appVersion: string): Record<string, string> {
  const env = claudeBaseEnv(shellEnv, appVersion);
  if (profile.kind === 'claude-login') return env;
  if (profile.kind === 'anthropic') {
    if (!key) throw new Error(`The API key for "${profile.label}" is missing. Add it in Settings → Models & keys.`);
    env.ANTHROPIC_API_KEY = key;
    if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl;
    return env;
  }
  if (profile.kind !== 'anthropic-compatible') throw new Error(`Profile "${profile.label}" does not work with the Claude engine`);
  if (!profile.baseUrl) throw new Error(`Profile "${profile.label}" needs a base URL`);
  if (!key && needsKey(profile)) throw new Error(`The API key for "${profile.label}" is missing. Add it in Settings → Models & keys.`);
  env.ANTHROPIC_BASE_URL = profile.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = key || 'cooprompt-local';
  env.ANTHROPIC_API_KEY = '';
  return env;
}

/** Third-party models must also serve Claude Code's background and subagent calls. */
export function claudeModelEnv(profile: ProviderProfile, model: string | null): Record<string, string> {
  if (profile.kind !== 'anthropic-compatible' || !model) return {};
  return {
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

/** The Cursor CLI uses the account it is signed in with on this computer, and never opens a browser in the middle of a turn. */
export function cursorBaseEnv(shellEnv: Record<string, string>): Record<string, string> {
  return { ...baseEngineEnv(shellEnv), NO_OPEN_BROWSER: '1' };
}

export function cursorEnv(profile: ProviderProfile, shellEnv: Record<string, string>): Record<string, string> {
  if (profile.kind !== 'cursor-login') throw new Error(`Profile "${profile.label}" does not work with the Cursor engine`);
  return cursorBaseEnv(shellEnv);
}

export interface CodexSetup {
  apiKey?: string;
  baseUrl?: string;
  config: Record<string, unknown>;
  env: Record<string, string>;
}

export function codexSetup(profile: ProviderProfile, key: string | null, shellEnv: Record<string, string>, pathDirs: string[]): CodexSetup {
  const env = baseEngineEnv(shellEnv);
  if (pathDirs.length > 0) env.PATH = [...pathDirs, env.PATH ?? ''].filter(Boolean).join(delimiter);
  const config: Record<string, unknown> = {};
  switch (profile.kind) {
    case 'codex-login':
      return { config, env };
    case 'openai':
      if (!key) throw new Error(`The API key for "${profile.label}" is missing. Add it in Settings → Models & keys.`);
      return { apiKey: key, baseUrl: profile.baseUrl || undefined, config, env };
    case 'openai-compatible': {
      if (!profile.baseUrl) throw new Error(`Profile "${profile.label}" needs a base URL`);
      if (!key && needsKey(profile)) throw new Error(`The API key for "${profile.label}" is missing. Add it in Settings → Models & keys.`);
      env.COOPROMPT_PROVIDER_API_KEY = key || 'cooprompt-local';
      config.model_provider = 'cooprompt';
      config.model_providers = {
        cooprompt: { name: profile.label, base_url: profile.baseUrl, env_key: 'COOPROMPT_PROVIDER_API_KEY', wire_api: profile.wireApi ?? 'responses' },
      };
      return { config, env };
    }
    default:
      throw new Error(`Profile "${profile.label}" does not work with the Codex engine`);
  }
}

export type ModelOption = ModelChoice;

interface CodexCachedModel {
  slug: string;
  display_name?: string;
  visibility?: string;
  supported_reasoning_levels?: { effort: string; description?: string }[];
  default_reasoning_level?: string;
  context_window?: number;
}

/** `model` and `model_reasoning_effort` in ~/.codex/config.toml: the defaults Codex uses when CooPrompt sets none. */
async function codexDefaults(): Promise<{ model?: string; effort?: string }> {
  const raw = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8').catch(() => null);
  if (!raw) return {};
  try {
    const config = parseToml(raw) as { model?: unknown; model_reasoning_effort?: unknown };
    return {
      model: typeof config.model === 'string' ? config.model : undefined,
      effort: typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : undefined,
    };
  } catch {
    return {};
  }
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<any> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

/** For the Claude Code and Cursor sign-ins, `engineModels` asks the engine itself which models its account offers. */
export async function listModels(profile: ProviderProfile, key: string | null, engineModels: () => Promise<ModelOption[]>): Promise<ModelOption[]> {
  switch (profile.kind) {
    case 'claude-login':
    case 'cursor-login':
      return engineModels();
    case 'anthropic': {
      if (!key) throw new Error(tr('Save the API key first'));
      const json = await fetchJson(`${profile.baseUrl || 'https://api.anthropic.com'}/v1/models?limit=100`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
      return (json.data ?? []).map((model: { id: string; display_name?: string }) => ({ id: model.id, label: model.display_name }));
    }
    case 'anthropic-compatible': {
      const base = (profile.baseUrl ?? '').replace(/\/$/, '');
      if (/openrouter\.ai/.test(base)) {
        const json = await fetchJson('https://openrouter.ai/api/v1/models', {});
        return (json.data ?? []).map((model: { id: string; name?: string }) => ({ id: model.id, label: model.name }));
      }
      if (/:11434$/.test(base)) {
        const json = await fetchJson(`${base}/api/tags`, {});
        return (json.models ?? []).map((model: { name: string }) => ({ id: model.name }));
      }
      const json = await fetchJson(`${base}/v1/models`, key ? { authorization: `Bearer ${key}`, 'x-api-key': key, 'anthropic-version': '2023-06-01' } : {});
      return (json.data ?? []).map((model: { id: string; display_name?: string }) => ({ id: model.id, label: model.display_name }));
    }
    case 'openai': {
      if (!key) throw new Error(tr('Save the API key first'));
      const json = await fetchJson(`${profile.baseUrl || 'https://api.openai.com/v1'}/models`, { authorization: `Bearer ${key}` });
      return (json.data ?? [])
        .map((model: { id: string }) => ({ id: model.id }))
        .filter((model: ModelOption) => /^(gpt|o\d|codex)/.test(model.id))
        .sort((a: ModelOption, b: ModelOption) => b.id.localeCompare(a.id));
    }
    case 'openai-compatible': {
      const json = await fetchJson(`${(profile.baseUrl ?? '').replace(/\/$/, '')}/models`, key ? { authorization: `Bearer ${key}` } : {});
      return (json.data ?? []).map((model: { id: string }) => ({ id: model.id }));
    }
    case 'codex-login': {
      const raw = await readFile(join(homedir(), '.codex', 'models_cache.json'), 'utf8').catch(() => null);
      if (!raw) return [];
      const json = JSON.parse(raw) as { models?: CodexCachedModel[] };
      const configured = await codexDefaults();
      return (json.models ?? [])
        .filter((model) => model.visibility !== 'hide')
        .map((model) => {
          const efforts = (model.supported_reasoning_levels ?? []).map((level) => ({ id: level.effort, description: level.description }));
          const defaultEffort = configured.effort && efforts.some((level) => level.id === configured.effort) ? configured.effort : model.default_reasoning_level;
          return { id: model.slug, label: model.display_name, efforts, defaultEffort, contextWindow: model.context_window, ...(model.slug === configured.model ? { isDefault: true } : {}) };
        });
    }
  }
}
