import type { AttachmentKind, DraftState, ItemUpsert, PermissionModeId, QuestionSpec, TurnUsage } from '@cooprompt/protocol';
import type { EngineInfo } from '../../shared/types.ts';

/** A file sent with the prompt, copied into the working folder. */
export interface EngineAttachment {
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  /** Absolute path of the copy. */
  path: string;
}

/** Media an engine came across, such as a screenshot in a tool result, for the chat to show. */
export type EngineMedia = { name: string; mime: string; data: Uint8Array } | { path: string };

export type McpServerSpec =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string; envVars?: string[] }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string> };

export interface PermissionRequest {
  key: string;
  toolName: string;
  input: unknown;
  title?: string;
  description?: string;
  allowAlways: boolean;
}

export interface PermissionAnswer {
  allow: boolean;
  always?: boolean;
  message?: string;
}

export interface EngineSink {
  /** Upserts a transcript item; `key` is unique within the turn. */
  item(key: string, item: Omit<ItemUpsert, 'id'>): void;
  draft(draft: DraftState | null): void;
  delta(kind: DraftState['kind'], text: string): void;
  info(info: Omit<EngineInfo, 'at'>): void;
  /** Shares media next to the item already published with `key`: best effort, media types only, within the size limits. */
  attach(key: string, media: EngineMedia[]): void;
}

export interface EngineRunInput {
  cwd: string;
  /** Already lists the attachments' paths, so every engine can open them with its tools. */
  prompt: string;
  attachments: EngineAttachment[];
  /** The provider takes images (and PDFs) in the prompt; otherwise attachments only go by path. */
  nativeMedia: boolean;
  /** Context the engine must see before the prompt without it being a separate request. */
  preamble: string | null;
  systemAppend: string;
  model: string | null;
  /** Unvalidated; each engine keeps only the levels it accepts. */
  effort: string | null;
  sessionId: string | null;
  /**
   * Continue `sessionId` in a new session cut at this checkpoint, leaving the original untouched because
   * another turn is using it. Only a checkpoint this engine returned is ever passed back.
   */
  forkAt?: string | null;
  permissionMode: PermissionModeId;
  env: Record<string, string>;
  mcpServers: Record<string, McpServerSpec>;
  signal: AbortSignal;
  sink: EngineSink;
  requestPermission(request: PermissionRequest): Promise<PermissionAnswer>;
  askQuestion(request: { key: string; questions: QuestionSpec[] }): Promise<Record<string, string> | null>;
  log(line: string): void;
}

export interface EngineRunResult {
  sessionId: string | null;
  /**
   * Where the session can be forked to continue from the end of this turn while a later turn is using it
   * (see `forkAt`). Engines that can't fork omit it, and parallel turns then start fresh sessions instead.
   */
  checkpoint?: string;
  status: 'done' | 'failed' | 'cancelled';
  error?: string;
  usage?: TurnUsage;
}

export const MAX_OUTPUT_CHARS = 24_000;

export function clip(value: string, max = MAX_OUTPUT_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}\n… (${value.length - max} more characters)` : value;
}
