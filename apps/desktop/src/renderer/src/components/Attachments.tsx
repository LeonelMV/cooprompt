import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, ExternalLink, File, FileArchive, FileAudio, FileText, FileVideo, FolderOpen, X } from 'lucide-react';
import type { AttachmentRef } from '@cooprompt/protocol';
import { attachmentUrl, canOpen, formatBytes } from '../../../shared/attachments.ts';
import { call } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { useStore } from '../lib/store.ts';
import { IconButton } from './ui.tsx';

type Action = 'attachments.open' | 'attachments.reveal' | 'attachments.save';

function useAction(chatId: string): (method: Action, file: AttachmentRef) => void {
  const toast = useStore((state) => state.toast);
  return (method, file) => void call(method, { chatId, attachmentId: file.id }).catch((error) => toast('error', error instanceof Error ? error.message : String(error)));
}

export function FileIcon({ file, className = '' }: { file: Pick<AttachmentRef, 'kind' | 'name'>; className?: string }) {
  const Icon = file.kind === 'pdf' ? FileText : file.kind === 'audio' ? FileAudio : file.kind === 'video' ? FileVideo : /\.(zip|tar|gz|tgz|7z|rar)$/i.test(file.name) ? FileArchive : File;
  return <Icon className={className} />;
}

function Actions({ chatId, file, compact }: { chatId: string; file: AttachmentRef; compact?: boolean }) {
  const t = useT();
  const act = useAction(chatId);
  const size = compact ? 'size-6' : 'size-7';
  return (
    <span className="flex shrink-0 items-center">
      {canOpen(file) && (
        <IconButton title={t('Open')} className={size} onClick={() => act('attachments.open', file)}>
          <ExternalLink className="size-3.5" />
        </IconButton>
      )}
      <IconButton title={t('Show in folder')} className={size} onClick={() => act('attachments.reveal', file)}>
        <FolderOpen className="size-3.5" />
      </IconButton>
      <IconButton title={t('Save…')} className={size} onClick={() => act('attachments.save', file)}>
        <Download className="size-3.5" />
      </IconButton>
    </span>
  );
}

function FileChip({ chatId, file, member }: { chatId: string; file: AttachmentRef; member: boolean }) {
  const t = useT();
  return (
    <div className="flex max-w-[340px] items-center gap-2.5 rounded-xl border border-line-soft bg-panel py-1.5 pl-3 pr-1.5">
      <FileIcon file={file} className="size-5 shrink-0 text-dim" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink" title={file.name}>
          {file.name}
        </p>
        <p className="text-[11.5px] text-faint">{formatBytes(file.size, t.locale)}</p>
      </div>
      {member && <Actions chatId={chatId} file={file} />}
    </div>
  );
}

function Player({ chatId, file, onFail }: { chatId: string; file: AttachmentRef; onFail(): void }) {
  const t = useT();
  const caption = (
    <div className="flex items-center gap-2 py-1 pl-3 pr-1 text-[12.5px] text-dim">
      <FileIcon file={file} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={file.name}>
        {file.name}
      </span>
      <span className="shrink-0 text-[11.5px] text-faint">{formatBytes(file.size, t.locale)}</span>
      <Actions chatId={chatId} file={file} compact />
    </div>
  );
  return file.kind === 'video' ? (
    <div className="w-full max-w-[520px] overflow-hidden rounded-xl border border-line-soft bg-panel">
      <video controls preload="metadata" src={attachmentUrl(chatId, file.id)} onError={onFail} className="block max-h-80 w-full bg-black" />
      {caption}
    </div>
  ) : (
    <div className="w-full max-w-[440px] rounded-xl border border-line-soft bg-panel pb-2">
      {caption}
      <audio controls preload="metadata" src={attachmentUrl(chatId, file.id)} onError={onFail} className="block h-9 w-full px-2" />
    </div>
  );
}

function Lightbox({ chatId, images, index, onIndex, onClose }: { chatId: string; images: AttachmentRef[]; index: number; onIndex(index: number): void; onClose(): void }) {
  const t = useT();
  const act = useAction(chatId);
  const file = images[index];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (event.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onClose, onIndex]);
  if (!file) return null;
  const step = (delta: number) => (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    onIndex(index + delta);
  };
  return (
    <div className="no-drag fixed inset-0 z-50 flex flex-col bg-black/85" onMouseDown={onClose}>
      {/* The window's traffic lights sit at the top left, over this bar. */}
      <div className="flex items-center gap-2 pb-2 pl-24 pr-5 pt-3 text-[13px]" onMouseDown={(event) => event.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate font-medium text-ink" title={file.name}>
          {file.name}
        </span>
        <span className="shrink-0 text-[12px] text-faint">{images.length > 1 ? `${index + 1} / ${images.length}` : formatBytes(file.size, t.locale)}</span>
        {canOpen(file) && (
          <IconButton title={t('Open')} onClick={() => act('attachments.open', file)}>
            <ExternalLink className="size-4" />
          </IconButton>
        )}
        <IconButton title={t('Save…')} onClick={() => act('attachments.save', file)}>
          <Download className="size-4" />
        </IconButton>
        <IconButton title={t('Close')} onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-14 pb-8">
        <img src={attachmentUrl(chatId, file.id)} alt={file.name} className="max-h-full max-w-full rounded-lg object-contain" onMouseDown={(event) => event.stopPropagation()} />
        {index > 0 && (
          <button className="absolute left-3 rounded-full bg-raised/80 p-2 text-dim hover:text-ink cursor-default" title={t('Previous')} onMouseDown={step(-1)}>
            <ChevronLeft className="size-5" />
          </button>
        )}
        {index < images.length - 1 && (
          <button className="absolute right-3 rounded-full bg-raised/80 p-2 text-dim hover:text-ink cursor-default" title={t('Next')} onMouseDown={step(1)}>
            <ChevronRight className="size-5" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The files of a message, an answer or a tool result: thumbnails that open a lightbox, players for audio and
 * video, and chips for the rest. People who haven't joined the chat see names only, as the server serves members.
 */
export function AttachmentList({ chatId, files, compact = false }: { chatId: string; files: AttachmentRef[] | undefined; compact?: boolean }) {
  const t = useT();
  const member = useStore((state) => state.chats[chatId]?.isMember ?? true);
  const [shown, setShown] = useState<number | null>(null);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  if (!files?.length) return null;
  const fail = (id: string) => setFailed((current) => new Set(current).add(id));
  const loads = (file: AttachmentRef) => member && !failed.has(file.id) && (file.kind === 'image' || file.kind === 'audio' || file.kind === 'video');
  const images = files.filter((file) => file.kind === 'image' && loads(file));
  const players = files.filter((file) => file.kind !== 'image' && loads(file));
  const chips = files.filter((file) => !loads(file));
  return (
    <div className="space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((file, index) => (
            <button key={file.id} title={file.name} onClick={() => setShown(index)} className="overflow-hidden rounded-xl border border-line-soft bg-side cursor-default">
              <img src={attachmentUrl(chatId, file.id)} alt={file.name} loading="lazy" onError={() => fail(file.id)} className={`block object-contain ${compact ? 'max-h-28 max-w-[220px]' : 'max-h-64 max-w-[420px]'}`} />
            </button>
          ))}
        </div>
      )}
      {players.map((file) => (
        <Player key={file.id} chatId={chatId} file={file} onFail={() => fail(file.id)} />
      ))}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {chips.map((file) => (
            <FileChip key={file.id} chatId={chatId} file={file} member={member} />
          ))}
        </div>
      )}
      {!member && <p className="text-[11.5px] text-faint">{t('Join the chat to see its files.')}</p>}
      {shown !== null && <Lightbox chatId={chatId} images={images} index={shown} onIndex={setShown} onClose={() => setShown(null)} />}
    </div>
  );
}
