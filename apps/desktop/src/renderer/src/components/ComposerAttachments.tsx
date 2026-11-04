import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { Loader2, Paperclip, X } from 'lucide-react';
import type { AttachmentLimits } from '@cooprompt/protocol';
import { formatBytes, stagedUrl, type StagedAttachment } from '../../../shared/attachments.ts';
import { call } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { useStore } from '../lib/store.ts';
import { FileIcon } from './Attachments.tsx';

const UNSUPPORTED = "This team server doesn't accept attachments yet: whoever hosts it needs to update CooPrompt.";

/** Each chat keeps its own staged files when you switch chats, so none goes out in the wrong one. */
const drafts = new Map<string, StagedAttachment[]>();
let limitsCache: { at: number; value: AttachmentLimits | null } | null = null;

export interface AttachmentDraft {
  files: StagedAttachment[];
  /** Null when the server predates attachments; undefined while unknown. */
  limits: AttachmentLimits | null | undefined;
  adding: number;
  dragging: boolean;
  add(files: File[]): void;
  remove(id: string): void;
  /** The message went out with these files. */
  sent(ids: string[]): void;
  onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
}

/** Screenshots and copied images arrive as "image.png"; a time tells several of them apart. */
function pastedName(file: File): string {
  const time = new Date().toTimeString().slice(0, 8).replace(/:/g, '.');
  return `Pasted image ${time}.${file.type.split('/')[1] || 'png'}`;
}

export function useAttachmentDraft(chatId: string, enabled: boolean): AttachmentDraft {
  const t = useT();
  const toast = useStore((state) => state.toast);
  const [files, setFiles] = useState<StagedAttachment[]>(() => drafts.get(chatId) ?? []);
  const [limits, setLimits] = useState<AttachmentLimits | null | undefined>(limitsCache?.value);
  const [adding, setAdding] = useState(0);
  const [dragging, setDragging] = useState(false);
  const shownChat = useRef(chatId);
  shownChat.current = chatId;

  useEffect(() => {
    setFiles(drafts.get(chatId) ?? []);
    if (limitsCache && Date.now() - limitsCache.at < 60_000) {
      setLimits(limitsCache.value);
      return;
    }
    let cancelled = false;
    call('attachments.limits')
      .then((value) => {
        limitsCache = { at: Date.now(), value };
        if (!cancelled) setLimits(value);
      })
      .catch(() => {
        if (!cancelled) setLimits(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  const store = (target: string, next: StagedAttachment[]) => {
    drafts.set(target, next);
    if (target === shownChat.current) setFiles(next);
  };

  const add = (list: File[]) => {
    if (!enabled || list.length === 0) return;
    if (limits === null) {
      toast('error', t(UNSUPPORTED));
      return;
    }
    const target = chatId;
    const staged = drafts.get(target) ?? [];
    let count = staged.length;
    let bytes = staged.reduce((sum, file) => sum + file.size, 0);
    for (const file of list) {
      if (limits && count >= limits.maxFiles) {
        toast('error', t('A message can carry up to {count} files', { count: limits.maxFiles }));
        break;
      }
      if (limits && file.size > limits.maxFileBytes) {
        toast('error', t('{name} is larger than {size}', { name: file.name, size: formatBytes(limits.maxFileBytes, t.locale) }));
        continue;
      }
      if (limits && bytes + file.size > limits.maxMessageBytes) {
        toast('error', t('The files of a message can add up to {size}', { size: formatBytes(limits.maxMessageBytes, t.locale) }));
        break;
      }
      count++;
      bytes += file.size;
      setAdding((value) => value + 1);
      void file
        .arrayBuffer()
        .then((buffer) => call('attachments.stage', { name: file.name, data: new Uint8Array(buffer) }))
        .then((file) => store(target, [...(drafts.get(target) ?? []), file]))
        .catch((error) => toast('error', error instanceof Error ? error.message : String(error)))
        .finally(() => setAdding((value) => value - 1));
    }
  };
  const latestAdd = useRef(add);
  latestAdd.current = add;

  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      latestAdd.current(Array.from(event.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);

  return {
    files,
    limits,
    adding,
    dragging,
    add,
    remove: (id) => {
      void call('attachments.discard', id);
      store(chatId, (drafts.get(chatId) ?? []).filter((file) => file.id !== id));
    },
    sent: (ids) => store(chatId, (drafts.get(chatId) ?? []).filter((file) => !ids.includes(file.id))),
    onPaste: (event) => {
      const pasted = Array.from(event.clipboardData.files);
      if (pasted.length === 0) return;
      event.preventDefault();
      add(pasted.map((file) => (!file.name || /^image\.\w+$/.test(file.name) ? new File([file], pastedName(file), { type: file.type }) : file)));
    },
  };
}

export function AttachButton({ draft }: { draft: AttachmentDraft }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const unsupported = draft.limits === null;
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={unsupported}
        title={unsupported ? t(UNSUPPORTED) : t('Attach files (you can also drop or paste them)')}
        className="flex size-7 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-ink disabled:opacity-40 cursor-default"
      >
        <Paperclip className="size-4" />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          draft.add(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
    </>
  );
}

export function StagedFiles({ draft }: { draft: AttachmentDraft }) {
  const t = useT();
  if (draft.files.length === 0 && draft.adding === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3.5 pt-3">
      {draft.files.map((file) => (
        <div key={file.id} className="relative">
          {file.kind === 'image' ? (
            <img src={stagedUrl(file.id)} alt={file.name} title={file.name} className="size-16 rounded-lg border border-line bg-side object-cover" />
          ) : (
            <div className="flex h-16 max-w-[230px] items-center gap-2 rounded-lg border border-line bg-raised px-3" title={file.name}>
              <FileIcon file={file} className="size-5 shrink-0 text-dim" />
              <div className="min-w-0">
                <p className="truncate text-[12.5px] text-ink">{file.name}</p>
                <p className="text-[11px] text-faint">{formatBytes(file.size, t.locale)}</p>
              </div>
            </div>
          )}
          <button
            onClick={() => draft.remove(file.id)}
            title={t('Remove')}
            className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-line bg-panel text-dim hover:text-ink cursor-default"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      {draft.adding > 0 && (
        <div className="flex size-16 items-center justify-center rounded-lg border border-dashed border-line">
          <Loader2 className="size-4 animate-spin text-faint" />
        </div>
      )}
    </div>
  );
}

export function DropOverlay({ draft }: { draft: AttachmentDraft }) {
  const t = useT();
  if (!draft.dragging) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/45">
      <div className="rounded-2xl border-2 border-dashed border-accent/70 bg-panel/95 px-8 py-6 text-[14px] text-ink shadow-2xl">
        {draft.limits === null ? t(UNSUPPORTED) : t('Drop the files to attach them to your message')}
      </div>
    </div>
  );
}
