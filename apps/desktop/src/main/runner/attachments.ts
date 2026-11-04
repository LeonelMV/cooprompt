import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AttachmentRef, TranscriptItem } from '@cooprompt/protocol';
import { formatBytes } from '../../shared/attachments.ts';
import type { EngineAttachment } from '../engines/types.ts';

/** Catch-ups bring copies of the most recent files only; older ones are mentioned by name. */
const MAX_CATCH_UP_FILES = 20;
const MAX_REFERENCED = 10;
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|avif|svg|pdf|mp3|m4a|m4b|aac|wav|ogg|oga|opus|flac|mp4|m4v|mov|webm)$/i;
const MENTIONS = [
  /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
  /`([^`\n]+)`/g,
  /(?:^|[\s(["'])((?:~|\.{1,2})?\/?[^\s()[\]"'`<>]+?)(?=$|[\s)\]"'`]|[,;:!?.](?:\s|$))/gm,
];

/** What the agent is told after the prompt: where the files sent with it are. */
export function attachmentNote(files: EngineAttachment[], cwd: string): string {
  if (files.length === 0) return '';
  const lines = files.map((file) => `- ${relative(cwd, file.path)} (${file.kind === 'file' ? 'file' : file.mime}, ${formatBytes(file.size)})`);
  return `Attached files, saved in the working folder:\n${lines.join('\n')}`;
}

/** The files in what a catch-up covers, newest first, that this computer's agent gets copies of. */
export function catchUpAttachments(items: TranscriptItem[]): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  for (const item of [...items].reverse()) {
    if (item.kind !== 'user' && item.kind !== 'text' && item.kind !== 'tool') continue;
    for (const ref of (item.data as { attachments?: AttachmentRef[] }).attachments ?? []) {
      if (refs.length >= MAX_CATCH_UP_FILES) return refs;
      if (!refs.some((known) => known.id === ref.id)) refs.push(ref);
    }
  }
  return refs;
}

async function inside(candidate: string, cwd: string, root: string): Promise<string | null> {
  let path = candidate.trim();
  try {
    if (/^file:\/\//i.test(path)) path = fileURLToPath(path);
    else if (/%[0-9a-f]{2}/i.test(path)) path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  const real = await realpath(isAbsolute(path) ? path : resolve(cwd, path)).catch(() => null);
  if (!real) return null;
  const rel = relative(root, real);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts[0] === '.cooprompt' || parts.includes('.git') || parts.includes('node_modules')) return null;
  return (await lstat(real).catch(() => null))?.isFile() ? real : null;
}

/**
 * Media files inside the working folder that an answer points to (a Markdown link or image, a path in backticks
 * or a bare path), such as a screenshot the agent saved. Paths that resolve outside the folder, through symbolic
 * links included, don't count, nor do the copies of attachments, `.git` and `node_modules`.
 */
export async function referencedMedia(text: string, cwd: string): Promise<string[]> {
  const root = await realpath(cwd).catch(() => null);
  if (!root) return [];
  const candidates = new Set<string>();
  for (const pattern of MENTIONS) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1].trim();
      const url = /^[a-z][a-z0-9+.-]*:/i.test(candidate) && !candidate.startsWith('file://') && !isAbsolute(candidate);
      if (MEDIA_FILE.test(candidate) && !url) candidates.add(candidate);
    }
  }
  const found: string[] = [];
  for (const candidate of candidates) {
    const path = await inside(candidate, cwd, root);
    if (path && !found.includes(path)) found.push(path);
    if (found.length >= MAX_REFERENCED) break;
  }
  return found;
}
