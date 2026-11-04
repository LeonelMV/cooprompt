import type {
  AppRelease,
  AttachmentLimits,
  AutomationInfo,
  AutomationLimits,
  AutomationRun,
  AutomationSchedule,
  ChatKind,
  ChatSummary,
  Decision,
  DeviceInfo,
  EngineId,
  HealthResponse,
  Invitation,
  PermissionModeId,
  PublicUser,
  SendMessageResponse,
  SendTeamMessageResponse,
  ServerMessage,
  ShareTeamMessageResponse,
  TranscriptItem,
  TurnInfo,
} from '@cooprompt/protocol';
import type { StagedAttachment } from './attachments.ts';
import type { SlashCommandInfo } from './commands.ts';
import type { Language } from './i18n.ts';

export type ProviderKind = 'anthropic' | 'anthropic-compatible' | 'claude-login' | 'openai' | 'codex-login' | 'openai-compatible' | 'cursor-login';

export interface ProviderProfile {
  id: string;
  label: string;
  engine: EngineId;
  kind: ProviderKind;
  baseUrl?: string;
  model?: string;
  /** Only for openai-compatible providers driven by Codex. */
  wireApi?: 'responses' | 'chat';
  createdAt: number;
}

export interface ProviderView extends ProviderProfile {
  hasKey: boolean;
  needsKey: boolean;
}

/** The account Claude Code is signed in with on this computer, as `claude auth status` reports it. It never leaves the computer. */
export interface ClaudeSignIn {
  loggedIn: boolean;
  /** `claude.ai` (a Claude subscription), `api_key`, `api_key_helper`, `oauth_token`, `third_party` or `none`. */
  method: string;
  /** The Claude subscription: `pro`, `max`, `team` or `enterprise`. */
  plan?: string;
  /** Where the API key comes from; `/login managed key` is an Anthropic Console sign-in. */
  apiKeySource?: string;
  /** `firstParty`, or the cloud provider Claude Code goes through (`bedrock`, `vertex`…). */
  provider?: string;
  email?: string;
  organization?: string;
}

/** The account the Cursor CLI is signed in with on this computer, as `cursor-agent status` and `about` report it. It never leaves the computer. */
export interface CursorSignIn {
  /** The Cursor CLI (`cursor-agent`) was found on this computer. */
  installed: boolean;
  loggedIn: boolean;
  email?: string;
  /** The Cursor plan, e.g. `Pro`. */
  plan?: string;
}

export interface ProviderPreset {
  id: string;
  label: string;
  engine: EngineId;
  kind: ProviderKind;
  baseUrl?: string;
  model?: string;
  needsKey: boolean;
  keyHint?: string;
  help: string;
}

export type ConnectorTransport = 'stdio' | 'http' | 'sse';

export interface ConnectorConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: ConnectorTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Environment variables handed through to a local server as they are on this computer. */
  envVars?: string[];
  url?: string;
  /** For servers without dynamic client registration (e.g. Slack). */
  oauthClientId?: string;
  oauthCallbackPort?: number;
  source?: string;
  /** Where it was imported from, e.g. "Claude Code · Notion plugin". */
  origin?: string;
  importKey?: string;
}

export interface ConnectorView extends ConnectorConfig {
  envKeys: string[];
  headerKeys: string[];
  oauth: 'none' | 'connected';
}

export type DetectedSource = 'claude-code' | 'claude-desktop' | 'cursor' | 'codex' | 'workspace';

export interface DetectedConnector {
  key: string;
  source: DetectedSource;
  origin: string;
  name: string;
  transport: ConnectorTransport;
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  /** Engines that already load this server on their own. */
  nativeFor: EngineId[];
  enabled: boolean;
  missingEnv: string[];
  imported: boolean;
  /** Included by "Import all". */
  importable: boolean;
}

export interface ChatPrefs {
  profileId?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionModeId;
  /** Working folder for private chats on this device. */
  folder?: string;
  allowOthersToApprove?: boolean;
  /** Multitask: my messages start right away, beside the running turns, instead of waiting for them. */
  multitask?: boolean;
  /** Team only: my messages go to the chat's people, never to an agent. */
  teamOnly?: boolean;
}

export interface EngineInfo {
  engine: EngineId;
  model?: string;
  version?: string;
  tools?: string[];
  mcpServers?: { name: string; status: string }[];
  skills?: string[];
  slashCommands?: string[];
  /** Commands whose UI only exists in a terminal. */
  terminalSlashCommands?: string[];
  agents?: string[];
  at: number;
}

export interface ModelChoice {
  id: string;
  label?: string;
  /** `label` is the engine's own name for a level CooPrompt has no name for. */
  efforts?: { id: string; label?: string; description?: string }[];
  defaultEffort?: string;
  contextWindow?: number;
  /** The engine's own default when no model is chosen. */
  isDefault?: boolean;
}

export interface SyncStatus {
  chatId: string;
  root: string;
  state: 'starting' | 'idle' | 'syncing' | 'error' | 'paused';
  pending: number;
  files: number;
  conflicts: string[];
  lastError?: string;
  lastSyncAt?: number;
}

export interface ChatLocalState {
  chatId: string;
  folder: string | null;
  prefs: ChatPrefs;
  sync: SyncStatus | null;
  engineInfo: EngineInfo | null;
}

export interface ConnectionState {
  status: 'offline' | 'connecting' | 'online';
  error?: string;
}

export interface HostState {
  running: boolean;
  port: number | null;
  urls: string[];
  /** `reconnecting`: the tunnel stopped working and CooPrompt is opening a new one, or waits to try again. */
  tunnelStatus: 'off' | 'starting' | 'on' | 'reconnecting' | 'error';
  tunnelUrl: string | null;
  /** The tunnel's address differs from the one teammates were last given, until the host copies the message or dismisses it. */
  tunnelNotice: { url: string; previousUrl: string } | null;
  error?: string;
  accessCode: string | null;
  googleEnabled: boolean;
}

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'ready' | 'waiting' | 'installing' | 'error';

export interface UpdateResult {
  version: string;
  outcome: 'updated' | 'rolled-back' | 'aborted';
  detail?: string;
}

export interface UpdateState {
  /** Off in development builds and isolated profiles. */
  enabled: boolean;
  status: UpdateStatus;
  /** Newer build the server offers. */
  available: AppRelease | null;
  /** Share downloaded (0–1) while downloading. */
  progress: number | null;
  error: string | null;
  checkedAt: number | null;
  /** How the last update went, reported by the version that ended up running. */
  lastResult: UpdateResult | null;
}

export interface AppState {
  version: string;
  language: Language;
  serverUrl: string | null;
  user: PublicUser | null;
  lastEmail: string | null;
  connection: ConnectionState;
  deviceId: string;
  deviceName: string;
  devices: DeviceInfo[];
  host: HostState;
  profile: string;
  update: UpdateState;
  /** Used by chats that have no permission mode of their own yet. */
  defaultPermissionMode: PermissionModeId;
  /** Turns a chat runs at once in multitask mode on this server; null when it has no multitask. */
  maxParallelTurns: number | null;
  /** What the server allows automations; null when it has none. */
  automations: AutomationLimits | null;
  /** Whether the server takes team-only messages; null until it says, after connecting. */
  teamMessages: boolean | null;
}

/** An automation as the editor saves it; the main process turns the profile into a `TurnConfig`. */
export interface AutomationDraft {
  /** Absent for a new automation. */
  id?: string;
  name: string;
  instructions: string;
  /** An existing chat, or a private chat of its own created when saving, working in `folder` (a new folder when null). */
  target: { kind: 'chat'; chatId: string } | { kind: 'own'; folder: string | null };
  schedule: AutomationSchedule;
  profileId: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: PermissionModeId;
  fresh: boolean;
  timeLimitMinutes: number;
  enabled: boolean;
  /** This computer when absent. */
  deviceId?: string;
}

export interface CatalogEntry {
  name: string;
  description: string;
  path: string;
  scope: 'personal' | 'workspace';
  source: string;
}

export interface MemoryFile {
  label: string;
  path: string;
  exists: boolean;
  scope: 'personal' | 'workspace';
}

export interface Catalog {
  cwd: string | null;
  skills: CatalogEntry[];
  agents: CatalogEntry[];
  commands: CatalogEntry[];
  memory: MemoryFile[];
}

export interface WorkspaceEntry {
  path: string;
  dir: boolean;
  size: number;
}

export interface SettingsView {
  language: Language;
  syncRoot: string;
  privateRoot: string;
  defaultPermissionMode: PermissionModeId;
  redactSecrets: boolean;
  host: {
    port: number;
    name: string;
    googleClientId: string;
    hasGoogleSecret: boolean;
    allowedDomains: string;
    /** Hides email/password sign-up and sign-in while Google sign-in is configured. */
    googleOnly: boolean;
    autoStart: boolean;
    requireAccessCode: boolean;
    /** Folder whose newest `npm run dist` build this server hands out and announces; empty = this app. */
    releaseDir: string;
    /** The computer doesn't sleep on its own while the server runs with the tunnel open. */
    keepAwake: boolean;
  };
}

export type MainEvent =
  | { type: 'server'; message: ServerMessage }
  | { type: 'state'; state: AppState }
  | { type: 'sync'; status: SyncStatus }
  | { type: 'engineInfo'; chatId: string; info: EngineInfo }
  | { type: 'toast'; level: 'info' | 'error'; text: string }
  /** Show a chat (scrolled to a turn), e.g. after clicking a notification. */
  | { type: 'navigate'; chatId: string; turnId?: string | null };

export interface CooPromptApi {
  'app.state'(): AppState;
  'app.openExternal'(url: string): void;
  'app.revealPath'(path: string): void;
  'app.openTerminal'(path: string): void;
  'app.pickFolder'(defaultPath?: string | null): string | null;
  'auth.health'(serverUrl: string): HealthResponse;
  'auth.register'(input: { serverUrl: string; email: string; name: string; password: string; accessCode?: string }): AppState;
  'auth.login'(input: { serverUrl: string; email: string; password: string }): AppState;
  'auth.google'(input: { serverUrl: string }): AppState;
  /** Stops waiting for the browser; the pending `auth.google` call fails. */
  'auth.cancelGoogle'(): void;
  'auth.logout'(): AppState;
  /** Points this device at the server's new address, keeping the session (it lives on the server). */
  'auth.changeServer'(serverUrl: string): AppState;
  'device.rename'(name: string): AppState;
  'chats.list'(): ChatSummary[];
  'chats.create'(input: { title: string; kind: ChatKind; folder?: string | null }): ChatSummary;
  'chats.rename'(chatId: string, title: string): ChatSummary;
  'chats.delete'(chatId: string): void;
  'chats.leave'(chatId: string): void;
  'chats.join'(chatId: string): ChatSummary;
  'chats.open'(chatId: string): { items: TranscriptItem[]; turns: TurnInfo[]; local: ChatLocalState };
  'chats.close'(chatId: string): void;
  /**
   * `interrupt` stops a running turn (`interruptTurnId`, or else the server's pick) so this message runs right
   * away; `parallel` starts it beside the running turns when the server has multitask.
   */
  'chats.send'(input: {
    chatId: string;
    text: string;
    profileId: string | null;
    model: string | null;
    effort?: string | null;
    permissionMode: PermissionModeId;
    deviceId?: string;
    interrupt?: boolean;
    interruptTurnId?: string;
    parallel?: boolean;
    /** Ids from `attachments.stage`, uploaded before the message is sent. */
    attachments?: string[];
  }): SendMessageResponse;
  /** A message for the chat's people only: it never becomes a turn, and fails on a server that predates them. */
  'chats.sendTeam'(input: { chatId: string; text: string; attachments?: string[] }): SendTeamMessageResponse;
  /** Lets every agent in the chat read one of my team-only messages from its next turn on. */
  'chats.shareTeam'(input: { chatId: string; itemId: string }): ShareTeamMessageResponse;
  'chats.typing'(chatId: string): void;
  /** What the team server accepts; null when it predates attachments. */
  'attachments.limits'(): AttachmentLimits | null;
  /** Keeps a file chosen in the composer on this computer until it is sent or discarded. */
  'attachments.stage'(input: { name: string; data: Uint8Array }): StagedAttachment;
  'attachments.discard'(id: string): void;
  /** Opens a chat's image, PDF, audio or video with the computer's default app. */
  'attachments.open'(input: { chatId: string; attachmentId: string }): void;
  'attachments.reveal'(input: { chatId: string; attachmentId: string }): void;
  /** Saves a copy where the person chooses; null when cancelled. */
  'attachments.save'(input: { chatId: string; attachmentId: string }): string | null;
  'chats.local'(chatId: string): ChatLocalState;
  'chats.setPrefs'(chatId: string, prefs: Partial<ChatPrefs>): ChatLocalState;
  'turns.cancel'(turnId: string): void;
  'decisions.respond'(input: { chatId: string; turnId: string; itemId: string; decision: Decision }): void;
  'users.search'(query: string): PublicUser[];
  'invitations.list'(): Invitation[];
  'invitations.forChat'(chatId: string): Invitation[];
  'invitations.create'(input: { chatId: string; userId?: string; email?: string }): Invitation;
  'invitations.accept'(id: string): { chat: ChatSummary | null };
  'invitations.decline'(id: string): void;
  'invitations.revoke'(id: string): void;
  'providers.list'(): { profiles: ProviderView[]; defaultProfileId: string | null; presets: ProviderPreset[] };
  'providers.save'(input: { profile: ProviderProfile; apiKey?: string | null }): ProviderView;
  'providers.delete'(id: string): void;
  'providers.setDefault'(id: string): void;
  'providers.models'(id: string): ModelChoice[];
  'providers.codexStatus'(): { loggedIn: boolean; message: string };
  'providers.codexLogin'(): { loggedIn: boolean; message: string };
  'providers.claudeStatus'(): ClaudeSignIn;
  /** Opens the browser for Claude Code's own sign-in (a Claude subscription by default). */
  'providers.claudeLogin'(): ClaudeSignIn;
  'providers.cursorStatus'(): CursorSignIn;
  /** Opens the browser for the Cursor CLI's own sign-in (`cursor-agent login`). */
  'providers.cursorLogin'(): CursorSignIn;
  'connectors.list'(): { connectors: ConnectorView[]; detected: DetectedConnector[] };
  'connectors.save'(input: { connector: ConnectorConfig; env?: Record<string, string>; headers?: Record<string, string> }): ConnectorView;
  'connectors.delete'(id: string): void;
  'connectors.import'(key: string): ConnectorView;
  /** Imports every usable server not in CooPrompt yet; returns how many were added. */
  'connectors.importAll'(): number;
  'connectors.test'(id: string): { ok: boolean; message: string; tools: string[] };
  'connectors.oauth'(id: string): ConnectorView;
  /** Slash commands (and Codex `$skill` mentions) the chosen profile's engine offers in this chat. */
  'commands.list'(input: { chatId: string; profileId: string | null }): SlashCommandInfo[];
  'catalog.get'(chatId: string | null): Catalog;
  'catalog.read'(path: string): string;
  'catalog.write'(input: { path: string; content: string }): void;
  'catalog.createSkill'(input: { chatId: string | null; scope: 'personal' | 'workspace'; name: string; description: string; body: string }): CatalogEntry;
  'catalog.createAgent'(input: { chatId: string | null; scope: 'personal' | 'workspace'; name: string; description: string; prompt: string; tools?: string; model?: string }): CatalogEntry;
  'workspace.tree'(chatId: string): { root: string; entries: WorkspaceEntry[]; truncated: boolean };
  'workspace.resync'(chatId: string): SyncStatus | null;
  'settings.get'(): SettingsView;
  'settings.update'(patch: Partial<Omit<SettingsView, 'host'>> & { host?: Partial<SettingsView['host']> & { googleClientSecret?: string } }): SettingsView;
  'host.start'(): HostState;
  'host.stop'(): HostState;
  'host.tunnel'(enabled: boolean): HostState;
  /** The host passed on (or ignores) the tunnel's new address: the notice goes away. */
  'host.dismissTunnelNotice'(): HostState;
  'update.check'(): UpdateState;
  /** Starts downloading the available build; progress arrives with the app state. */
  'update.download'(): UpdateState;
  /** Restarts into the downloaded build; while turns run it waits for them unless `now`. */
  'update.install'(input?: { now?: boolean }): UpdateState;
  /** Stops a download or a restart that waits for turns to finish. */
  'update.cancel'(): UpdateState;
  /** Automations the user sees (their own and those of their chats) and the runs of their own, newest first. */
  'automations.list'(): { automations: AutomationInfo[]; runs: AutomationRun[] };
  'automations.save'(draft: AutomationDraft): AutomationInfo;
  'automations.setEnabled'(id: string, enabled: boolean): AutomationInfo;
  'automations.delete'(id: string): void;
  'automations.run'(id: string): AutomationRun;
  'automations.history'(id: string): AutomationRun[];
  'automations.markRead'(ids: string[] | 'all'): void;
}

export type CooPromptMethod = keyof CooPromptApi;
export type CooPromptArgs<M extends CooPromptMethod> = Parameters<CooPromptApi[M]>;
export type CooPromptResult<M extends CooPromptMethod> = ReturnType<CooPromptApi[M]>;
