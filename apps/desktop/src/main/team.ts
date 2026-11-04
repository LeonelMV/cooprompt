import type { SendTeamMessageRequest, SendTeamMessageResponse } from '@cooprompt/protocol';
import type { AttachmentStore } from './attachments.ts';
import { tr } from './i18n.ts';
import { ApiError, type ApiClient } from './net/api.ts';

export const TEAM_UNSUPPORTED = 'This team server can’t take team-only messages yet: whoever hosts it has to update CooPrompt.';

/**
 * Sends a team-only message through its own endpoint, never as a message an agent would run: a server that
 * doesn't announce them (`supported` false) is refused before anything is uploaded, and one that predates them
 * answers the endpoint with 404, which fails the same way.
 */
export async function sendTeamMessage(
  deps: { api: ApiClient; attachments: Pick<AttachmentStore, 'uploadStaged' | 'commit'>; supported: boolean | null },
  input: { chatId: string; text: string; attachments?: string[] },
): Promise<SendTeamMessageResponse> {
  if (deps.supported === false) throw new Error(tr(TEAM_UNSUPPORTED));
  const staged = input.attachments ?? [];
  const uploaded = staged.length > 0 ? await deps.attachments.uploadStaged(input.chatId, staged) : [];
  const body: SendTeamMessageRequest = { text: input.text, ...(uploaded.length > 0 ? { attachments: uploaded.map((file) => file.id) } : {}) };
  const sent = await deps.api.post<SendTeamMessageResponse>(`/api/chats/${input.chatId}/team-messages`, body).catch((error: unknown) => {
    // Fastify's answer for a route it doesn't have, unlike the server's own 404s ("Chat not found…").
    if (error instanceof ApiError && error.status === 404 && error.body.error === 'Not Found') throw new Error(tr(TEAM_UNSUPPORTED));
    throw error;
  });
  if (staged.length > 0) await deps.attachments.commit(input.chatId, staged);
  return sent;
}
