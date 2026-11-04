import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SendTeamMessageResponse, ShareTeamMessageResponse, TeamItemData, TranscriptItem, UserItemData } from '@cooprompt/protocol';
import { attachmentFallback } from '@cooprompt/protocol';
import type { Attachments } from './attachments.ts';
import { HttpError } from './errors.ts';
import type { Hub } from './hub.ts';
import { bearer, text } from './routes.ts';
import type { ChatRow, Store, UserRecord } from './store.ts';

type Body = Record<string, unknown>;

/**
 * Team-only messages: the chat's members talk without any agent seeing it. Nothing here creates a turn, so the
 * hub never runs one for them, and their content only reaches the apps that take it (see `teamStandIns`).
 */
export function registerTeamRoutes(app: FastifyInstance, ctx: { store: Store; hub: Hub; attachments: Attachments }): void {
  const { store, hub } = ctx;

  const member = (request: FastifyRequest): { user: UserRecord; chat: ChatRow } => {
    const token = bearer(request);
    const user = token ? store.getUserByToken(token) : undefined;
    if (!user) throw new HttpError(401, 'Your session is invalid or expired');
    const chat = store.getChat((request.params as Body).id as string);
    if (!chat || !store.canView(chat, user)) throw new HttpError(404, 'Chat not found or not accessible');
    if (!store.isMember(chat.id, user.id)) throw new HttpError(403, 'Join the chat to do this');
    return { user, chat };
  };

  app.post('/api/chats/:id/team-messages', async (request): Promise<SendTeamMessageResponse> => {
    const { user, chat } = member(request);
    const body = (request.body ?? {}) as Body;
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    const typed = text(body, 'text', { max: 200_000, optional: hasAttachments });
    const attachments = ctx.attachments.forMessage(chat.id, user.id, body.attachments);
    const data: TeamItemData = attachments.length > 0 ? { text: typed, attachments } : { text: typed };
    const item = store.upsertItem(chat.id, { id: `team.${randomUUID()}`, kind: 'team', data, turnId: null, authorId: user.id }) as TranscriptItem<'team'>;
    hub.publishItems(chat.id, [item]);
    hub.publishChat(chat.id);
    hub.sendToMembers(chat.id, { t: 'team.message', chatId: chat.id, chatTitle: chat.title, authorName: user.name, item }, 'team-messages', user.id);
    return { item };
  });

  /** Only its author lets the agents read it; sharing it again changes nothing. */
  app.post('/api/chats/:id/team-messages/:itemId/share', async (request): Promise<ShareTeamMessageResponse> => {
    const { user, chat } = member(request);
    const current = store.getItem((request.params as Body).itemId as string);
    const shared = current?.kind === 'user' && Boolean((current.data as UserItemData).sharedAt);
    if (!current || current.chatId !== chat.id || (current.kind !== 'team' && !shared)) throw new HttpError(404, 'Message not found');
    if (current.authorId !== user.id) throw new HttpError(403, 'Only its author can share a team-only message with the AI');
    if (shared) return { item: current as TranscriptItem<'user'> };
    const { text: typed, attachments } = current.data as TeamItemData;
    // An ordinary message without a turn from now on, where it was: its new revision puts it in every agent's
    // next catch-up, older apps' included.
    const data: UserItemData = attachments?.length ? { text: attachmentFallback(typed, attachments), attachments, sharedAt: Date.now() } : { text: typed, sharedAt: Date.now() };
    const item = store.upsertItem(chat.id, { id: current.id, kind: 'user', data, turnId: null, authorId: user.id }) as TranscriptItem<'user'>;
    hub.publishItems(chat.id, [item]);
    return { item };
  });
}
