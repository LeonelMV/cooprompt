import type { AttachmentRef, ClientMessage, DraftState, ItemUpsert, TurnUsage } from '@cooprompt/protocol';
import type { EngineMedia, EngineSink } from '../engines/types.ts';
import { publishableLength, redactDeep } from './redact.ts';

/** How long the end of a turn waits for media still uploading. */
const SHARE_GRACE_MS = 60_000;

export interface PublisherDeps {
  /** Delivers a message to the server; executor traffic is buffered while offline. */
  send(message: ClientMessage): void;
  redact(text: string): string;
  shouldRedact(): boolean;
  info: EngineSink['info'];
  /** Uploads media for the chat; null when it isn't shared. */
  share(media: EngineMedia): Promise<AttachmentRef | null>;
}

export interface TurnOutcome {
  status: 'done' | 'failed' | 'cancelled';
  error?: string | null;
  usage?: TurnUsage | null;
}

export interface Publisher {
  sink: EngineSink;
  /** Waits for media still uploading, flushes what is pending, clears the streaming draft and reports how the turn ended. */
  finish(outcome: TurnOutcome): Promise<void>;
}

function mergeData(previous: unknown, next: unknown): unknown {
  if (!previous || typeof previous !== 'object' || !next || typeof next !== 'object') return next;
  const merged: Record<string, unknown> = { ...(previous as Record<string, unknown>) };
  for (const [key, value] of Object.entries(next as Record<string, unknown>)) if (value !== undefined) merged[key] = value;
  return merged;
}

/**
 * Everything a turn publishes leaves the computer here, redacted when enabled. Item upserts are batched and
 * streaming text is throttled so a fast model doesn't flood the socket.
 */
export function createPublisher(turnId: string, deps: PublisherDeps): Publisher {
  const known = new Map<string, ItemUpsert>();
  const pending = new Map<string, ItemUpsert>();
  /** `raw` is everything the engine streamed in the current block; `sent` is what others have of it. */
  let stream: { kind: DraftState['kind']; raw: string; sent: string; dirty: boolean } | null = null;
  let timer: NodeJS.Timeout | null = null;
  const sharing = new Set<Promise<void>>();
  let finished = false;

  const redactText = (text: string) => (deps.shouldRedact() ? deps.redact(text) : text);
  // Redacting chunk by chunk would miss a secret split between two of them, so the whole block is
  // redacted each time and only what can no longer change goes out.
  const visible = (raw: string) => (deps.shouldRedact() ? deps.redact(raw.slice(0, publishableLength(raw))) : raw);

  const flushStream = () => {
    if (!stream?.dirty) return;
    stream.dirty = false;
    const next = visible(stream.raw);
    if (next === stream.sent) return;
    if (next.startsWith(stream.sent)) deps.send({ t: 'turn.delta', turnId, kind: stream.kind, text: next.slice(stream.sent.length) });
    else deps.send({ t: 'turn.draft', turnId, draft: { kind: stream.kind, text: next } });
    stream.sent = next;
  };

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    flushStream();
    if (pending.size > 0) {
      deps.send({ t: 'turn.items', turnId, items: [...pending.values()] });
      pending.clear();
    }
  };
  const soon = (ms: number) => {
    if (!timer) timer = setTimeout(flush, ms);
  };

  const sink: EngineSink = {
    item: (key, item) => {
      const id = `${turnId}.${key}`;
      const merged = { id, kind: item.kind, data: mergeData(known.get(id)?.data, item.data) } as ItemUpsert;
      known.set(id, merged);
      pending.set(id, deps.shouldRedact() ? redactDeep(merged, deps.redact) : merged);
      soon(60);
    },
    draft: (draft) => {
      flush();
      stream = draft ? { kind: draft.kind, raw: draft.text, sent: visible(draft.text), dirty: false } : null;
      deps.send({ t: 'turn.draft', turnId, draft: stream ? { kind: stream.kind, text: stream.sent } : null });
    },
    delta: (kind, text) => {
      if (stream && stream.kind !== kind) {
        flush();
        stream = null;
      }
      stream ??= { kind, raw: '', sent: '', dirty: false };
      stream.raw += text;
      stream.dirty = true;
      soon(70);
    },
    info: deps.info,
    // The file goes up over HTTP; only its reference travels in the item, redacted like the rest of it.
    attach: (key, media) => {
      const id = `${turnId}.${key}`;
      for (const file of media) {
        const task = deps.share(file).then(
          (ref) => {
            const current = known.get(id);
            if (!ref || !current || finished) return;
            const attachments = (current.data as { attachments?: AttachmentRef[] }).attachments ?? [];
            if (attachments.some((entry) => entry.id === ref.id || entry.sha256 === ref.sha256)) return;
            sink.item(key, { kind: current.kind, data: { attachments: [...attachments, ref] } } as Omit<ItemUpsert, 'id'>);
          },
          () => {},
        );
        sharing.add(task);
        void task.finally(() => sharing.delete(task));
      }
    },
  };

  return {
    sink,
    finish: async (outcome) => {
      if (sharing.size > 0) await Promise.race([Promise.allSettled([...sharing]), new Promise((resolve) => setTimeout(resolve, SHARE_GRACE_MS).unref())]);
      finished = true;
      flush();
      stream = null;
      deps.send({ t: 'turn.draft', turnId, draft: null });
      deps.send({ t: 'turn.finish', turnId, status: outcome.status, error: outcome.error ? redactText(outcome.error) : null, usage: outcome.usage ?? null });
    },
  };
}
