import type { AttachmentKind, AttachmentRef } from '@cooprompt/protocol';

/** The renderer loads attachments only through this scheme, served by the main process (see `AttachmentStore.serve`). */
export const MEDIA_SCHEME = 'cooprompt-media';

/** A file chosen in the composer, kept on this computer until the message is sent. */
export interface StagedAttachment {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
}

export const attachmentUrl = (chatId: string, attachmentId: string): string => `${MEDIA_SCHEME}://attachment/${chatId}/${attachmentId}`;
export const stagedUrl = (id: string): string => `${MEDIA_SCHEME}://staged/${id}`;

/**
 * What CooPrompt opens with the computer's default app. Other files could be programs, and SVG opens in a browser where
 * its scripts run, so those are only shown in Finder or saved.
 */
export const canOpen = (file: Pick<AttachmentRef, 'kind' | 'mime'>): boolean => file.kind !== 'file' && file.mime !== 'image/svg+xml';

export function formatBytes(bytes: number, locale = 'en-US'): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit > 0 && value < 10 ? 1 : 0 }).format(value)} ${units[unit]}`;
}
