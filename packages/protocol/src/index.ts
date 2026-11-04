import type { AutomationInfo, AutomationLimits, AutomationRun, TurnAutomation } from './automations.ts';

export * from './automations.ts';

export const PROTOCOL_VERSION = 1;

export type ChatKind = 'private' | 'multiplayer' | 'corporate';
/** Apps that predate an engine show its turns with their fallback look; servers that predate it refuse its turns. */
export type EngineId = 'claude' | 'codex' | 'cursor';
export type MemberRole = 'owner' | 'member';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  orgDomain: string | null;
}

export interface ChatMember {
  user: PublicUser;
  role: MemberRole;
  joinedAt: number;
}

export interface ChatSummary {
  id: string;
  title: string;
  kind: ChatKind;
  ownerId: string;
  orgDomain: string | null;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  members: ChatMember[];
  /** False for corporate chats the user can view but has not joined. */
  isMember: boolean;
  /** Multiplayer and corporate chats own a shared, synced workspace. */
  hasWorkspace: boolean;
  /** The running turn that started first; older apps only know about one. */
  activeTurn: TurnInfo | null;
  /** Every running turn, in the order they started; servers that predate multitask omit it. */
  activeTurns?: TurnInfo[];
  queuedTurns: number;
}

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked';

export interface Invitation {
  id: string;
  chatId: string;
  chatTitle: string;
  chatKind: ChatKind;
  inviter: PublicUser;
  inviteeEmail: string;
  inviteeId: string | null;
  status: InvitationStatus;
  createdAt: number;
}

export type PermissionModeId = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';

/** Non-secret run preferences chosen by the requester; resolved on the executor device. */
export interface TurnConfig {
  engine: EngineId;
  profileId: string | null;
  model: string | null;
  permissionMode: PermissionModeId;
  /** Reasoning effort in the engine's own vocabulary; absent means the engine default. */
  effort?: string | null;
}

export type TurnStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  /** Tokens the executor's engine session holds after the turn, out of `contextWindow`. */
  contextTokens?: number;
  contextWindow?: number;
}

export interface TurnInfo {
  id: string;
  chatId: string;
  requesterId: string;
  deviceId: string;
  deviceName: string;
  config: TurnConfig;
  providerLabel: string | null;
  status: TurnStatus;
  error: string | null;
  usage: TurnUsage | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Sent in multitask mode: it runs alongside other turns instead of waiting for them. Older servers omit it. */
  parallel?: boolean;
  /** The turn this one interrupted; it starts once that turn has stopped. Older servers omit it. */
  interrupts?: string | null;
  /** Started by an automation of the requester; absent otherwise and on older servers. */
  automation?: TurnAutomation;
}

export type ItemKind =
  | 'user'
  | 'text'
  | 'thinking'
  | 'tool'
  | 'permission'
  | 'question'
  | 'todo'
  | 'notice'
  | 'error'
  | 'team';

export type AttachmentKind = 'image' | 'pdf' | 'audio' | 'video' | 'file';

/** A file shared in a chat, sent with a message or produced by an agent; the team server keeps its content. */
export interface AttachmentRef {
  id: string;
  /** Sanitized file name (see `sanitizeFileName`). */
  name: string;
  /** Content type the server recognized in the file's bytes (`sniffMedia`); `application/octet-stream` otherwise. */
  mime: string;
  kind: AttachmentKind;
  size: number;
  sha256: string;
}

/** What the server accepts, announced in `/api/health`; servers that predate attachments omit it. */
export interface AttachmentLimits {
  maxFileBytes: number;
  /** Files per message. */
  maxFiles: number;
  /** All the files of one message together. */
  maxMessageBytes: number;
}

export interface UserItemData {
  /** With attachments, ends with a line per file for apps that predate them; `promptText` gives the typed text. */
  text: string;
  attachments?: AttachmentRef[];
  /** A team-only message its author shared with the agents later: it has no turn of its own. */
  sharedAt?: number;
}
/**
 * A team-only message: for the chat's people, never for an agent, so it never becomes a turn. Apps that don't
 * announce `team-messages`, and item requests without `include=team`, get a stand-in whose `text` only says who
 * wrote, without attachments.
 */
export interface TeamItemData {
  text: string;
  attachments?: AttachmentRef[];
}
export interface TextItemData {
  text: string;
  parentToolId?: string | null;
  /** Media files in the working folder that the answer points to. */
  attachments?: AttachmentRef[];
}
export interface ThinkingItemData {
  text: string;
  parentToolId?: string | null;
}
export type ToolStatus = 'running' | 'done' | 'error';
export interface ToolItemData {
  toolUseId: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
  parentToolId?: string | null;
  /** Images and other media in the tool's result, such as a browser screenshot. */
  attachments?: AttachmentRef[];
}
export type DecisionStatus = 'pending' | 'allowed' | 'denied' | 'expired';
export interface PermissionItemData {
  toolName: string;
  title?: string;
  description?: string;
  input: unknown;
  status: DecisionStatus;
  decidedBy?: string | null;
  /** Executor opted in to let other members approve actions on their machine. */
  othersCanDecide: boolean;
  allowAlways: boolean;
}
export interface QuestionOption {
  label: string;
  description?: string;
}
export interface QuestionSpec {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}
export interface QuestionItemData {
  questions: QuestionSpec[];
  status: 'pending' | 'answered' | 'expired';
  answers?: Record<string, string>;
  answeredBy?: string | null;
}
export interface TodoItemData {
  items: { text: string; status: 'pending' | 'in_progress' | 'completed' }[];
}
export interface NoticeItemData {
  /** English text; clients localize it against their message templates. */
  text: string;
  level?: 'info' | 'warn';
}
export interface ErrorItemData {
  message: string;
}

export interface ItemDataByKind {
  user: UserItemData;
  text: TextItemData;
  thinking: ThinkingItemData;
  tool: ToolItemData;
  permission: PermissionItemData;
  question: QuestionItemData;
  todo: TodoItemData;
  notice: NoticeItemData;
  error: ErrorItemData;
  team: TeamItemData;
}

export interface TranscriptItem<K extends ItemKind = ItemKind> {
  id: string;
  chatId: string;
  /** Creation order inside the chat. */
  seq: number;
  /** Change counter: bumps on every insert or update, used for catch-up. */
  rev: number;
  turnId: string | null;
  kind: K;
  authorId: string | null;
  data: ItemDataByKind[K];
  createdAt: number;
  updatedAt: number;
}

export interface ItemUpsert<K extends ItemKind = ItemKind> {
  id: string;
  kind: K;
  data: ItemDataByKind[K];
}

export type Decision =
  | { type: 'permission'; allow: boolean; always?: boolean; message?: string }
  | { type: 'question'; answers: Record<string, string> };

export interface FileEntry {
  path: string;
  /** Null marks a deletion (tombstone). */
  hash: string | null;
  size: number;
  exec: boolean;
  seq: number;
  updatedBy: string | null;
  updatedAt: number;
}

export interface ChangesResponse {
  seq: number;
  entries: FileEntry[];
  hasMore: boolean;
}

export interface DraftState {
  kind: 'text' | 'thinking';
  text: string;
}

/** The desktop build a server hands out at `/download/CooPrompt.zip`. */
export interface AppRelease {
  /** `CFBundleShortVersionString` of the app inside the zip (major.minor.patch). */
  version: string;
  /** Hex SHA-256 and byte size of the exact zip served. */
  sha256: string;
  size: number;
}

export interface HealthResponse {
  ok: true;
  name: string;
  version: string;
  protocol: number;
  /** True until the first account is created, so clients start on sign-up. */
  firstRun: boolean;
  auth: {
    password: boolean;
    accessCodeRequired: boolean;
    google: {
      enabled: boolean;
      clientId: string | null;
      /** Domains whose Google Workspace accounts may sign in; empty means any Google account. Older servers omit it. */
      allowedDomains?: string[];
    };
  };
  /** Build this server distributes; absent when it has none or does not know its version. */
  app?: AppRelease;
  /** Absent on servers that predate attachments. */
  attachments?: AttachmentLimits;
}

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

export interface SendMessageRequest {
  text: string;
  /** Device that will execute the turn; must belong to the requester and be online. */
  deviceId: string;
  config: TurnConfig;
  providerLabel?: string | null;
  /** Stops the running turn and runs this one before anything else queued. */
  interrupt?: boolean;
  /** Which running turn `interrupt` stops; without it the server picks the sender's latest running turn. */
  interruptTurnId?: string;
  /**
   * Multitask: start right away, alongside the running turns, instead of waiting for them (up to the
   * server's `maxParallelTurns`). Servers that predate multitask ignore it and queue the message.
   */
  parallel?: boolean;
  /** Ids returned by `POST /api/chats/:id/attachments`; `text` may then be empty. */
  attachments?: string[];
}

export interface SendMessageResponse {
  item: TranscriptItem<'user'>;
  turn: TurnInfo;
  /** Turn stopped by an `interrupt` request; servers that predate interrupts omit it. */
  interrupted?: string | null;
}

/** `POST /api/chats/:id/team-messages`, which servers that predate team-only messages answer with 404. */
export interface SendTeamMessageRequest {
  text: string;
  /** Ids returned by `POST /api/chats/:id/attachments`; `text` may then be empty. */
  attachments?: string[];
}

export interface SendTeamMessageResponse {
  item: TranscriptItem<'team'>;
}

/** `POST /api/chats/:id/team-messages/:itemId/share`: the message, now one every agent gets as context. */
export interface ShareTeamMessageResponse {
  item: TranscriptItem<'user'>;
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  connectedAt: number;
}

/**
 * What an app can do, announced in `hello`; the server only relies on what the executing device announced, except
 * for `team-messages`: only connections that announce it get the content of team-only messages.
 */
export type ClientFeature = 'parallel-turns' | 'automations' | 'team-messages';

export type ClientMessage =
  | { t: 'hello'; token: string; deviceId: string; deviceName: string; appVersion: string; features?: ClientFeature[] }
  | { t: 'subscribe'; chatId: string }
  | { t: 'unsubscribe'; chatId: string }
  | { t: 'typing'; chatId: string }
  | { t: 'turn.items'; turnId: string; items: ItemUpsert[] }
  | { t: 'turn.draft'; turnId: string; draft: DraftState | null }
  | { t: 'turn.delta'; turnId: string; kind: DraftState['kind']; text: string }
  | { t: 'turn.finish'; turnId: string; status: 'done' | 'failed' | 'cancelled'; error?: string | null; usage?: TurnUsage | null }
  | { t: 'decision'; chatId: string; turnId: string; itemId: string; decision: Decision }
  | { t: 'ping' };

export type ServerMessage =
  /**
   * `maxParallelTurns`: how many turns a chat runs at once in multitask mode; absent when the server has no multitask.
   * `automations`: absent when the server has no automations. `teamMessages`: absent on servers that predate them.
   */
  | { t: 'ready'; user: PublicUser; deviceId: string; runningTurns: TurnInfo[]; maxParallelTurns?: number; automations?: AutomationLimits; teamMessages?: boolean }
  | { t: 'error'; message: string }
  | { t: 'chat.upsert'; chat: ChatSummary }
  | { t: 'chat.remove'; chatId: string }
  | { t: 'invitation.upsert'; invitation: Invitation }
  | { t: 'items'; chatId: string; items: TranscriptItem[] }
  | { t: 'turn.upsert'; turn: TurnInfo }
  /** Replaces the streaming draft of a running turn (null clears it). */
  | { t: 'turn.draft'; chatId: string; turnId: string; draft: DraftState | null }
  /** Appends to the draft; a different kind starts a new draft. */
  | { t: 'turn.delta'; chatId: string; turnId: string; kind: DraftState['kind']; text: string }
  | { t: 'turn.run'; turn: TurnInfo; chat: ChatSummary; prompt: TranscriptItem<'user'> }
  | { t: 'turn.cancel'; turnId: string }
  | { t: 'decision'; chatId: string; turnId: string; itemId: string; decision: Decision; byUserId: string }
  | { t: 'presence'; chatId: string; online: string[]; typing: string[] }
  | { t: 'fs.change'; chatId: string; entries: FileEntry[] }
  | { t: 'devices'; devices: DeviceInfo[] }
  /** Sent right before the server goes down to restart; the connection drops next. */
  | { t: 'server.restarting'; reason: 'update'; version?: string | null }
  /** To the owner and the members of its chat. */
  | { t: 'automation.upsert'; automation: AutomationInfo }
  | { t: 'automation.remove'; automationId: string }
  /** A run of one of the user's own automations changed. */
  | { t: 'automation.run'; run: AutomationRun }
  /** Someone's team-only message, to the other members' apps that announced `team-messages`, whether or not the chat is open. */
  | { t: 'team.message'; chatId: string; chatTitle: string; authorName: string; item: TranscriptItem<'team'> }
  | { t: 'pong' };

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.com.ar',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'yandex.com',
]);

/** Organization is the email domain unless it belongs to a public mail provider. */
export function orgDomainFromEmail(email: string): string | null {
  const domain = email.trim().toLowerCase().split('@')[1];
  if (!domain || PUBLIC_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Workspace paths are POSIX, relative, normalized and never escape the root. */
export function normalizeWorkspacePath(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1024) return null;
  if (input.includes('\0') || input.includes('\\')) return null;
  if (input.startsWith('/')) return null;
  const parts: string[] = [];
  for (const part of input.normalize('NFC').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const MAX_NAME_CHARS = 120;

/**
 * The last path segment of a name, without control or direction-changing characters (which can disguise an
 * extension) nor characters Finder or other systems reject, and at most 120 characters, keeping the extension.
 */
export function sanitizeFileName(input: string): string {
  const last = String(input ?? '').normalize('NFC').split(/[/\\]/).pop() ?? '';
  let name = last.replace(UNSAFE_NAME_CHARS, '').replace(/[:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (!name.replace(/\./g, '')) return 'file';
  if (Array.from(name).length > MAX_NAME_CHARS) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = `${Array.from(name.slice(0, name.length - ext.length)).slice(0, MAX_NAME_CHARS - ext.length).join('').trimEnd()}${ext}`;
  }
  return name;
}

/** Extensions of the formats `sniffMedia` recognizes; the first one is used when a name lacks it. */
const MEDIA_TYPES: Record<string, { kind: AttachmentKind; extensions: string[] }> = {
  'image/png': { kind: 'image', extensions: ['png'] },
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'] },
  'image/gif': { kind: 'image', extensions: ['gif'] },
  'image/webp': { kind: 'image', extensions: ['webp'] },
  'image/avif': { kind: 'image', extensions: ['avif'] },
  'image/svg+xml': { kind: 'image', extensions: ['svg'] },
  'application/pdf': { kind: 'pdf', extensions: ['pdf'] },
  'audio/mpeg': { kind: 'audio', extensions: ['mp3'] },
  'audio/mp4': { kind: 'audio', extensions: ['m4a', 'm4b'] },
  'audio/aac': { kind: 'audio', extensions: ['aac'] },
  'audio/wav': { kind: 'audio', extensions: ['wav'] },
  'audio/ogg': { kind: 'audio', extensions: ['ogg', 'oga', 'opus'] },
  'audio/flac': { kind: 'audio', extensions: ['flac'] },
  'video/mp4': { kind: 'video', extensions: ['mp4', 'm4v'] },
  'video/quicktime': { kind: 'video', extensions: ['mov'] },
  'video/webm': { kind: 'video', extensions: ['webm'] },
};

const extensionOf = (name: string) => (/\.([a-z0-9]{1,10})$/i.exec(name)?.[1] ?? '').toLowerCase();

/**
 * The format of a file from its first bytes (4 KB are enough), never from its name alone: only formats CooPrompt
 * previews or hands to models count as media, and everything else (HTML included) is a plain file.
 */
export function sniffMedia(head: Uint8Array, name: string): { mime: string; kind: AttachmentKind } {
  const ascii = (start: number, length: number) => String.fromCharCode(...head.subarray(start, start + length));
  const startsWith = (bytes: number[]) => bytes.every((byte, index) => head[index] === byte);
  const ext = extensionOf(name);
  const found = (mime: string) => ({ mime, kind: MEDIA_TYPES[mime].kind });
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return found('image/png');
  if (startsWith([0xff, 0xd8, 0xff])) return found('image/jpeg');
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return found('image/gif');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return found('image/webp');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return found('audio/wav');
  if (ascii(0, 5) === '%PDF-') return found('application/pdf');
  if (ascii(0, 4) === 'OggS') return found('audio/ogg');
  if (ascii(0, 4) === 'fLaC') return found('audio/flac');
  if (ascii(0, 3) === 'ID3') return found('audio/mpeg');
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand === 'avif' || brand === 'avis') return found('image/avif');
    if (brand === 'qt  ') return found('video/quicktime');
    if (['M4A ', 'M4B ', 'M4P '].includes(brand) || ext === 'm4a' || ext === 'm4b') return found('audio/mp4');
    if (['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'MSNV', '3gp4', '3gp5'].includes(brand)) return found('video/mp4');
  }
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3]) && ascii(0, head.length).includes('webm')) return found('video/webm');
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && ext === 'mp3') return found('audio/mpeg');
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0 && ext === 'aac') return found('audio/aac');
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head).replace(/^\ufeff/, '');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(text)) return found('image/svg+xml');
  return { mime: 'application/octet-stream', kind: 'file' };
}

/** The name a file is shared under: sanitized, with the extension of the format its bytes show. */
export function attachmentName(name: string, mime: string): string {
  const clean = sanitizeFileName(name);
  const type = MEDIA_TYPES[mime];
  if (!type || type.extensions.includes(extensionOf(clean))) return clean;
  return sanitizeFileName(`${clean}.${type.extensions[0]}`);
}

/** The `text` of a prompt with attachments: what was typed and a line per file, which apps that predate attachments show. */
export function attachmentFallback(text: string, attachments: Pick<AttachmentRef, 'name'>[]): string {
  const lines = attachments.map((attachment) => `📎 ${attachment.name}`).join('\n');
  return text ? `${text}\n\n${lines}` : lines;
}

/** What the person typed, without the lines `attachmentFallback` added. */
export function promptText(data: UserItemData): string {
  if (!data.attachments?.length) return data.text;
  const lines = attachmentFallback('', data.attachments);
  if (data.text === lines) return '';
  return data.text.endsWith(`\n\n${lines}`) ? data.text.slice(0, -(lines.length + 2)) : data.text;
}
