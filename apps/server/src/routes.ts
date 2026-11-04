import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  AppRelease,
  AuthResponse,
  ChatKind,
  EngineId,
  HealthResponse,
  PermissionModeId,
  PublicUser,
  SendMessageResponse,
  TranscriptItem,
  TurnConfig,
  TurnInfo,
} from '@cooprompt/protocol';
import { PROTOCOL_VERSION, attachmentFallback, normalizeEmail } from '@cooprompt/protocol';
import type { Attachments } from './attachments.ts';
import { exchangeGoogleCode, hashPassword, newToken, verifyPassword, type GoogleConfig } from './auth.ts';
import { HttpError } from './errors.ts';
import type { Hub } from './hub.ts';
import { publicUser, type ChatRow, type Store, type UserRecord } from './store.ts';
import { teamStandIns } from './team.ts';

export interface RouteContext {
  store: Store;
  hub: Hub;
  name: string;
  version: string;
  google: GoogleConfig | null;
  passwordAuth: boolean;
  accessCode: string | null;
  /** The build `/download/CooPrompt.zip` serves, announced to clients so they can update. */
  release(): Promise<AppRelease | undefined>;
  attachments: Attachments;
}

const CHAT_KINDS = new Set<ChatKind>(['private', 'multiplayer', 'corporate']);
export const ENGINES = new Set<EngineId>(['claude', 'codex', 'cursor']);
const PERMISSION_MODES = new Set<PermissionModeId>(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);
/** Effort names belong to each engine (and grow with new models); executors validate them. */
export const EFFORT = /^[a-z][a-z0-9_-]{0,19}$/;

type Body = Record<string, unknown>;

export function text(body: Body, key: string, options: { min?: number; max?: number; optional?: boolean } = {}): string {
  const value = body[key];
  if (value === undefined || value === null || value === '') {
    if (options.optional) return '';
    throw new HttpError(400, `Missing field ${key}`);
  }
  if (typeof value !== 'string') throw new HttpError(400, `Field ${key} must be text`);
  const trimmed = value.trim();
  if (trimmed.length < (options.min ?? 1)) throw new HttpError(400, `Field ${key} is too short`);
  if (trimmed.length > (options.max ?? 500)) throw new HttpError(400, `Field ${key} is too long`);
  return trimmed;
}

export function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, hub } = ctx;

  const currentUser = (request: FastifyRequest): UserRecord => {
    const token = bearer(request);
    const user = token ? store.getUserByToken(token) : undefined;
    if (!user) throw new HttpError(401, 'Your session is invalid or expired');
    return user;
  };

  const viewableChat = (chatId: string, user: PublicUser): ChatRow => {
    const chat = store.getChat(chatId);
    if (!chat || !store.canView(chat, user)) throw new HttpError(404, 'Chat not found or not accessible');
    return chat;
  };

  const memberChat = (chatId: string, user: PublicUser): ChatRow => {
    const chat = viewableChat(chatId, user);
    if (!store.isMember(chat.id, user.id)) throw new HttpError(403, 'Join the chat to do this');
    return chat;
  };

  /** Stopping a turn, by cancelling it or by interrupting it with a new message. */
  const assertCanCancel = (turn: TurnInfo, chat: ChatRow, user: PublicUser): void => {
    if (turn.requesterId !== user.id && chat.owner_id !== user.id) {
      throw new HttpError(403, 'Only the requester or the chat owner can cancel this turn');
    }
  };

  /**
   * The running turn an interrupting message stops: the one it names or, from apps that don't name one,
   * the sender's latest running turn, else the latest of all (refused unless the sender owns the chat).
   */
  const interruptTarget = (chat: ChatRow, user: PublicUser, turnId: unknown): TurnInfo | undefined => {
    const running = store.runningTurns(chat.id);
    if (typeof turnId === 'string') return running.find((turn) => turn.id === turnId);
    return running.findLast((turn) => turn.requesterId === user.id) ?? running.at(-1);
  };

  const issueSession = (user: UserRecord): AuthResponse => {
    const token = newToken();
    store.createSession(user.id, token);
    return { token, user: publicUser(user) };
  };

  const notice = (chatId: string, textValue: string): TranscriptItem => {
    const item = store.upsertItem(chatId, { id: `notice.${crypto.randomUUID()}`, kind: 'notice', data: { text: textValue }, turnId: null, authorId: null });
    hub.publishItems(chatId, [item]);
    return item;
  };

  app.get('/api/health', async (): Promise<HealthResponse> => {
    const release = await ctx.release();
    return {
      ok: true,
      name: ctx.name,
      version: ctx.version,
      protocol: PROTOCOL_VERSION,
      firstRun: !store.hasUsers(),
      auth: {
        password: ctx.passwordAuth,
        accessCodeRequired: ctx.passwordAuth && ctx.accessCode !== null,
        google: ctx.google
          ? { enabled: true, clientId: ctx.google.clientId, allowedDomains: ctx.google.allowedDomains }
          : { enabled: false, clientId: null },
      },
      ...(release ? { app: release } : {}),
      attachments: ctx.attachments.limits,
    };
  });

  app.post('/api/auth/register', async (request) => {
    if (!ctx.passwordAuth) throw new HttpError(403, 'Password sign-up is disabled on this server');
    const body = (request.body ?? {}) as Body;
    const email = normalizeEmail(text(body, 'email', { min: 3, max: 200 }));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Invalid email');
    const password = text(body, 'password', { max: 200 });
    if (password.length < 8) throw new HttpError(400, 'The password must have at least 8 characters');
    const name = text(body, 'name', { max: 120, optional: true }) || email.split('@')[0];
    if (ctx.accessCode !== null && text(body, 'accessCode', { optional: true }) !== ctx.accessCode) {
      throw new HttpError(403, 'Wrong access code. Ask whoever runs the server for it.');
    }
    if (store.getUserByEmail(email)) throw new HttpError(409, 'An account with that email already exists');
    const user = store.createUser({ email, name, passwordHash: await hashPassword(password) });
    return issueSession(user);
  });

  app.post('/api/auth/login', async (request) => {
    if (!ctx.passwordAuth) throw new HttpError(403, 'Password sign-in is disabled on this server');
    const body = (request.body ?? {}) as Body;
    const user = store.getUserByEmail(text(body, 'email', { max: 200 }));
    if (user && !user.passwordHash && user.googleSub) throw new HttpError(401, 'This account signs in with Google: use Continue with Google.');
    if (!user || !(await verifyPassword(text(body, 'password', { max: 200 }), user.passwordHash))) {
      throw new HttpError(401, 'Wrong email or password');
    }
    return issueSession(user);
  });

  app.post('/api/auth/google', async (request) => {
    if (!ctx.google) throw new HttpError(403, 'This server does not have Google sign-in configured');
    const body = (request.body ?? {}) as Body;
    const identity = await exchangeGoogleCode(ctx.google, {
      code: text(body, 'code', { max: 2000 }),
      codeVerifier: text(body, 'codeVerifier', { max: 200 }),
      redirectUri: text(body, 'redirectUri', { max: 300 }),
    });
    let user = store.getUserByGoogleSub(identity.sub);
    if (!user) {
      const byEmail = store.getUserByEmail(identity.email);
      if (byEmail && !identity.ownsEmail) {
        throw new HttpError(409, 'An account with this email already exists, and Google cannot confirm the address is yours. Sign in with your password.');
      }
      if (byEmail) {
        // Password accounts never proved their address: whoever set the password (or linked another
        // Google account) loses access, and the person Google vouches for keeps the account.
        store.deleteSessionsOf(byEmail.id);
        hub.disconnectUser(byEmail.id);
        user = store.updateUser(byEmail.id, { googleSub: identity.sub, passwordHash: null, avatarUrl: identity.picture ?? byEmail.avatarUrl });
      } else {
        user = store.createUser({ email: identity.email, name: identity.name, googleSub: identity.sub, avatarUrl: identity.picture });
      }
    } else if (identity.picture && identity.picture !== user.avatarUrl) {
      user = store.updateUser(user.id, { avatarUrl: identity.picture });
    }
    return issueSession(user);
  });

  app.post('/api/auth/logout', async (request) => {
    const token = bearer(request);
    if (token) store.deleteSession(token);
    return { ok: true };
  });

  app.get('/api/me', async (request) => publicUser(currentUser(request)));

  app.patch('/api/me', async (request) => {
    const user = currentUser(request);
    const body = (request.body ?? {}) as Body;
    return publicUser(store.updateUser(user.id, { name: text(body, 'name', { max: 120 }) }));
  });

  app.get('/api/devices', async (request) => hub.devicesFor(currentUser(request).id));

  app.get('/api/users/search', async (request) => {
    const user = currentUser(request);
    const query = String((request.query as Body).q ?? '').trim();
    if (query.length < 1) return [];
    return store.searchUsers(query.slice(0, 100), user.id, user.orgDomain);
  });

  app.get('/api/chats', async (request) => {
    const user = currentUser(request);
    return store.listChatIdsForUser(user).map((id) => store.summary(store.getChat(id)!, user.id));
  });

  app.post('/api/chats', async (request) => {
    const user = currentUser(request);
    const body = (request.body ?? {}) as Body;
    const kind = text(body, 'kind', { max: 20 }) as ChatKind;
    if (!CHAT_KINDS.has(kind)) throw new HttpError(400, 'Invalid chat type');
    if (kind === 'corporate' && !user.orgDomain) {
      throw new HttpError(403, 'Company chats require an account with a company email');
    }
    const chat = store.createChat({ title: text(body, 'title', { max: 120, optional: true }) || 'New chat', kind, owner: user });
    hub.publishChat(chat.id);
    return store.summary(chat, user.id);
  });

  app.get('/api/chats/:id', async (request) => {
    const user = currentUser(request);
    return store.summary(viewableChat((request.params as Body).id as string, user), user.id);
  });

  app.patch('/api/chats/:id', async (request) => {
    const user = currentUser(request);
    const chat = memberChat((request.params as Body).id as string, user);
    store.updateChatTitle(chat.id, text((request.body ?? {}) as Body, 'title', { max: 120 }));
    hub.publishChat(chat.id);
    return store.summary(store.getChat(chat.id)!, user.id);
  });

  app.delete('/api/chats/:id', async (request) => {
    const user = currentUser(request);
    const chat = memberChat((request.params as Body).id as string, user);
    if (chat.owner_id !== user.id) throw new HttpError(403, 'Only the chat owner can delete it');
    const members = store.memberIds(chat.id);
    for (const turn of store.activeTurns(chat.id)) hub.cancelTurn(turn, user, 'cancel', false);
    store.deleteChat(chat.id);
    await ctx.attachments.purgeChat(chat.id);
    hub.removeChatFor(members, chat.id);
    if (chat.kind === 'corporate' && chat.org_domain) hub.removeChatForOrg(chat.org_domain, chat.id);
    return { ok: true };
  });

  app.post('/api/chats/:id/join', async (request) => {
    const user = currentUser(request);
    const chat = viewableChat((request.params as Body).id as string, user);
    if (!store.isMember(chat.id, user.id)) {
      if (chat.kind !== 'corporate') throw new HttpError(403, 'This chat requires an invitation');
      store.addMember(chat.id, user.id);
      notice(chat.id, `${user.name} joined the chat`);
      hub.publishChat(chat.id);
    }
    return store.summary(store.getChat(chat.id)!, user.id);
  });

  app.post('/api/chats/:id/leave', async (request) => {
    const user = currentUser(request);
    const chat = memberChat((request.params as Body).id as string, user);
    const others = store.memberIds(chat.id).filter((id) => id !== user.id);
    if (others.length === 0 && chat.kind !== 'corporate') throw new HttpError(400, 'You are the only participant: delete the chat instead');
    store.removeMember(chat.id, user.id);
    if (chat.owner_id === user.id && others.length > 0) store.setOwner(chat.id, others[0]);
    notice(chat.id, `${user.name} left the chat`);
    hub.publishChat(chat.id);
    if (chat.kind !== 'corporate') hub.removeChatFor([user.id], chat.id);
    return { ok: true };
  });

  app.get('/api/chats/:id/items', async (request) => {
    const user = currentUser(request);
    const chat = viewableChat((request.params as Body).id as string, user);
    const query = request.query as Body;
    const afterRev = query.afterRev !== undefined ? Number(query.afterRev) : undefined;
    const beforeSeq = query.beforeSeq !== undefined ? Number(query.beforeSeq) : undefined;
    const limit = query.limit !== undefined ? Number(query.limit) : undefined;
    const items = store.listItems(chat.id, { afterRev, beforeSeq, limit });
    return query.include === 'team' ? items : teamStandIns(store, items);
  });

  app.get('/api/chats/:id/turns', async (request) => {
    const user = currentUser(request);
    const chat = viewableChat((request.params as Body).id as string, user);
    return store.recentTurns(chat.id);
  });

  app.post('/api/chats/:id/messages', async (request): Promise<SendMessageResponse> => {
    const user = currentUser(request);
    const chat = memberChat((request.params as Body).id as string, user);
    const body = (request.body ?? {}) as Body;
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    const messageText = text(body, 'text', { max: 200_000, optional: hasAttachments });
    const deviceId = text(body, 'deviceId', { max: 100 });
    if (!hub.isDeviceOnline(user.id, deviceId)) throw new HttpError(409, 'The device chosen to run this is not connected');
    const rawConfig = (body.config ?? {}) as Body;
    const engine = rawConfig.engine as EngineId;
    if (!ENGINES.has(engine)) throw new HttpError(400, 'Invalid engine');
    const permissionMode = (rawConfig.permissionMode ?? 'default') as PermissionModeId;
    if (!PERMISSION_MODES.has(permissionMode)) throw new HttpError(400, 'Invalid permission mode');
    const effort = typeof rawConfig.effort === 'string' && EFFORT.test(rawConfig.effort) ? rawConfig.effort : null;
    const config: TurnConfig = {
      engine,
      profileId: typeof rawConfig.profileId === 'string' ? rawConfig.profileId.slice(0, 100) : null,
      model: typeof rawConfig.model === 'string' && rawConfig.model.trim() ? rawConfig.model.trim().slice(0, 200) : null,
      permissionMode,
      ...(effort ? { effort } : {}),
    };
    const providerLabel = typeof body.providerLabel === 'string' ? body.providerLabel.slice(0, 120) : null;
    const interrupted = body.interrupt === true ? interruptTarget(chat, user, body.interruptTurnId) : undefined;
    if (interrupted) assertCanCancel(interrupted, chat, user);
    const parallel = body.parallel === true && hub.runsParallelTurns(user.id, deviceId);
    const attachments = ctx.attachments.forMessage(chat.id, user.id, body.attachments);
    const promptData = attachments.length > 0 ? { text: attachmentFallback(messageText, attachments), attachments } : { text: messageText };
    const { turn, item } = store.db.tx(() => {
      const created = store.createTurn({
        chatId: chat.id,
        requesterId: user.id,
        deviceId,
        deviceName: hub.deviceName(user.id, deviceId) ?? 'Device',
        config,
        providerLabel,
        priority: interrupted ? 1 : 0,
        parallel,
        interrupts: interrupted?.id ?? null,
      });
      const prompt = store.upsertItem(chat.id, { id: `${created.id}.prompt`, kind: 'user', data: promptData, turnId: created.id, authorId: user.id });
      return { turn: created, item: prompt as TranscriptItem<'user'> };
    });
    hub.publishItems(chat.id, [item]);
    hub.publishTurn(turn);
    hub.publishChat(chat.id);
    if (interrupted) hub.cancelTurn(interrupted, user, 'interrupt');
    hub.scheduleChat(chat.id);
    return { item, turn: store.getTurn(turn.id)!, interrupted: interrupted?.id ?? null };
  });

  app.post('/api/turns/:id/cancel', async (request) => {
    const user = currentUser(request);
    const turn = store.getTurn((request.params as Body).id as string);
    if (!turn) throw new HttpError(404, 'Turn not found');
    assertCanCancel(turn, memberChat(turn.chatId, user), user);
    return hub.cancelTurn(turn, user);
  });

  app.get('/api/chats/:id/invitations', async (request) => {
    const user = currentUser(request);
    const chat = memberChat((request.params as Body).id as string, user);
    return store.pendingInvitationsForChat(chat.id);
  });

  app.post('/api/chats/:id/invitations', async (request) => {
    const user = currentUser(request);
    const chat = memberChat((request.params as Body).id as string, user);
    if (chat.kind === 'private') throw new HttpError(400, 'Private chats cannot have guests. Create a multiplayer chat.');
    const body = (request.body ?? {}) as Body;
    let invitee: UserRecord | undefined;
    let email: string;
    if (typeof body.userId === 'string' && body.userId) {
      invitee = store.getUser(body.userId);
      if (!invitee) throw new HttpError(404, 'User not found');
      email = invitee.email;
    } else {
      email = normalizeEmail(text(body, 'email', { max: 200 }));
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Invalid email');
      invitee = store.getUserByEmail(email);
    }
    if (invitee && store.isMember(chat.id, invitee.id)) throw new HttpError(409, `${invitee.name} is already in this chat`);
    const existing = store.pendingInvitation(chat.id, email);
    const row = existing ?? store.createInvitation({ chatId: chat.id, inviterId: user.id, inviteeEmail: email, inviteeId: invitee?.id ?? null });
    const invitation = store.invitation(row)!;
    if (!existing) {
      notice(chat.id, `${user.name} invited ${invitee?.name ?? email}`);
      if (invitee) hub.sendToUser(invitee.id, { t: 'invitation.upsert', invitation });
    }
    return invitation;
  });

  app.get('/api/invitations', async (request) => store.pendingInvitationsForUser(currentUser(request)));

  const respondInvitation = async (request: FastifyRequest, accept: boolean) => {
    const user = currentUser(request);
    const row = store.invitationRow((request.params as Body).id as string);
    if (!row || (row.invitee_id !== user.id && row.invitee_email !== user.email)) throw new HttpError(404, 'Invitation not found');
    if (row.status !== 'pending') throw new HttpError(409, 'The invitation was already answered');
    const chat = store.getChat(row.chat_id);
    if (!chat) throw new HttpError(404, 'The chat no longer exists');
    store.setInvitationStatus(row.id, accept ? 'accepted' : 'declined');
    if (accept) {
      store.addMember(chat.id, user.id);
      notice(chat.id, `${user.name} joined the chat`);
      hub.publishChat(chat.id);
    } else {
      notice(chat.id, `${user.name} declined the invitation`);
    }
    const invitation = store.invitation(store.invitationRow(row.id)!)!;
    hub.sendToUser(user.id, { t: 'invitation.upsert', invitation });
    return { invitation, chat: accept ? store.summary(store.getChat(chat.id)!, user.id) : null };
  };

  app.post('/api/invitations/:id/accept', async (request) => respondInvitation(request, true));
  app.post('/api/invitations/:id/decline', async (request) => respondInvitation(request, false));

  app.post('/api/invitations/:id/revoke', async (request) => {
    const user = currentUser(request);
    const row = store.invitationRow((request.params as Body).id as string);
    if (!row) throw new HttpError(404, 'Invitation not found');
    memberChat(row.chat_id, user);
    if (row.status === 'pending') store.setInvitationStatus(row.id, 'revoked');
    const invitation = store.invitation(store.invitationRow(row.id)!)!;
    if (row.invitee_id) hub.sendToUser(row.invitee_id, { t: 'invitation.upsert', invitation });
    return invitation;
  });
}
