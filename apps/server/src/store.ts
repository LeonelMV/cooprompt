import { randomUUID } from 'node:crypto';
import type {
  ChatKind,
  ChatMember,
  ChatSummary,
  FileEntry,
  Invitation,
  InvitationStatus,
  ItemKind,
  MemberRole,
  PublicUser,
  TranscriptItem,
  TurnAutomation,
  TurnConfig,
  TurnInfo,
  TurnStatus,
  TurnUsage,
} from '@cooprompt/protocol';
import { orgDomainFromEmail, normalizeEmail } from '@cooprompt/protocol';
import { Database } from './db.ts';
import { tokenHash } from './auth.ts';

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  org_domain: string | null;
  password_hash: string | null;
  google_sub: string | null;
  created_at: number;
}

export interface ChatRow {
  id: string;
  title: string;
  kind: ChatKind;
  owner_id: string;
  org_domain: string | null;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  next_seq: number;
  next_rev: number;
  ws_seq: number;
  deleted_at: number | null;
}

interface MemberRow {
  user_id: string;
  role: MemberRole;
  joined_at: number;
}

interface InvitationRow {
  id: string;
  chat_id: string;
  inviter_id: string;
  invitee_email: string;
  invitee_id: string | null;
  status: InvitationStatus;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  id: string;
  chat_id: string;
  seq: number;
  rev: number;
  turn_id: string | null;
  kind: ItemKind;
  author_id: string | null;
  data: string;
  created_at: number;
  updated_at: number;
}

interface TurnRow {
  id: string;
  chat_id: string;
  requester_id: string;
  device_id: string;
  device_name: string;
  config: string;
  provider_label: string | null;
  status: TurnStatus;
  error: string | null;
  usage: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  parallel: number;
  interrupts: string | null;
  automation: string | null;
}

interface FileRow {
  path: string;
  hash: string | null;
  size: number;
  exec: number;
  seq: number;
  updated_by: string | null;
  updated_at: number;
}

export interface UserRecord extends PublicUser {
  passwordHash: string | null;
  googleSub: string | null;
}

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  name: row.name,
  avatarUrl: row.avatar_url,
  orgDomain: row.org_domain,
  passwordHash: row.password_hash,
  googleSub: row.google_sub,
});

export const publicUser = (user: UserRecord | PublicUser): PublicUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatarUrl: user.avatarUrl,
  orgDomain: user.orgDomain,
});

const toTurn = (row: TurnRow): TurnInfo => ({
  id: row.id,
  chatId: row.chat_id,
  requesterId: row.requester_id,
  deviceId: row.device_id,
  deviceName: row.device_name,
  config: JSON.parse(row.config) as TurnConfig,
  providerLabel: row.provider_label,
  status: row.status,
  error: row.error,
  usage: row.usage ? (JSON.parse(row.usage) as TurnUsage) : null,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  parallel: row.parallel === 1,
  interrupts: row.interrupts,
  ...(row.automation ? { automation: JSON.parse(row.automation) as TurnAutomation } : {}),
});

const toItem = (row: ItemRow): TranscriptItem => ({
  id: row.id,
  chatId: row.chat_id,
  seq: row.seq,
  rev: row.rev,
  turnId: row.turn_id,
  kind: row.kind,
  authorId: row.author_id,
  data: JSON.parse(row.data),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toFile = (row: FileRow): FileEntry => ({
  path: row.path,
  hash: row.hash,
  size: row.size,
  exec: row.exec === 1,
  seq: row.seq,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at,
});

export class Store {
  constructor(readonly db: Database) {}

  // Users and sessions

  createUser(input: { email: string; name: string; passwordHash?: string | null; googleSub?: string | null; avatarUrl?: string | null }): UserRecord {
    const email = normalizeEmail(input.email);
    const id = randomUUID();
    this.db.run(
      'insert into users (id, email, name, avatar_url, org_domain, password_hash, google_sub, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      email,
      input.name.trim() || email.split('@')[0],
      input.avatarUrl ?? null,
      orgDomainFromEmail(email),
      input.passwordHash ?? null,
      input.googleSub ?? null,
      Date.now(),
    );
    this.db.run('update invitations set invitee_id = ? where invitee_email = ? and invitee_id is null', id, email);
    return this.getUser(id)!;
  }

  hasUsers(): boolean {
    return this.db.get('select 1 as ok from users limit 1') !== undefined;
  }

  getUser(id: string): UserRecord | undefined {
    const row = this.db.get<UserRow>('select * from users where id = ?', id);
    return row ? toUser(row) : undefined;
  }

  getUserByEmail(email: string): UserRecord | undefined {
    const row = this.db.get<UserRow>('select * from users where email = ?', normalizeEmail(email));
    return row ? toUser(row) : undefined;
  }

  getUserByGoogleSub(sub: string): UserRecord | undefined {
    const row = this.db.get<UserRow>('select * from users where google_sub = ?', sub);
    return row ? toUser(row) : undefined;
  }

  /** Fields left undefined keep their value; null clears the nullable ones. */
  updateUser(id: string, patch: { name?: string; avatarUrl?: string | null; googleSub?: string | null; passwordHash?: string | null }): UserRecord {
    const current = this.getUser(id);
    if (!current) throw new Error('user not found');
    this.db.run(
      'update users set name = ?, avatar_url = ?, google_sub = ?, password_hash = ? where id = ?',
      patch.name?.trim() || current.name,
      patch.avatarUrl === undefined ? current.avatarUrl : patch.avatarUrl,
      patch.googleSub === undefined ? current.googleSub : patch.googleSub,
      patch.passwordHash === undefined ? current.passwordHash : patch.passwordHash,
      id,
    );
    return this.getUser(id)!;
  }

  searchUsers(query: string, excludeId: string, orgDomain: string | null, limit = 20): PublicUser[] {
    const like = `%${query.trim().toLowerCase().replace(/[%_]/g, '')}%`;
    const rows = this.db.all<UserRow>(
      `select * from users
       where id != ? and (lower(name) like ? or email like ?)
       order by case when org_domain is not null and org_domain = ? then 0 else 1 end, name
       limit ?`,
      excludeId,
      like,
      like,
      orgDomain ?? '',
      limit,
    );
    return rows.map((row) => publicUser(toUser(row)));
  }

  createSession(userId: string, token: string): void {
    const now = Date.now();
    this.db.run('insert into sessions (token_hash, user_id, created_at, last_seen_at) values (?, ?, ?, ?)', tokenHash(token), userId, now, now);
  }

  getUserByToken(token: string): UserRecord | undefined {
    const hash = tokenHash(token);
    const row = this.db.get<UserRow>('select users.* from sessions join users on users.id = sessions.user_id where sessions.token_hash = ?', hash);
    if (!row) return undefined;
    this.db.run('update sessions set last_seen_at = ? where token_hash = ?', Date.now(), hash);
    return toUser(row);
  }

  deleteSession(token: string): void {
    this.db.run('delete from sessions where token_hash = ?', tokenHash(token));
  }

  deleteSessionsOf(userId: string): void {
    this.db.run('delete from sessions where user_id = ?', userId);
  }

  // Chats and members

  createChat(input: { title: string; kind: ChatKind; owner: PublicUser }): ChatRow {
    const now = Date.now();
    const id = randomUUID();
    this.db.tx(() => {
      this.db.run(
        'insert into chats (id, title, kind, owner_id, org_domain, created_at, updated_at, last_activity_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        input.title,
        input.kind,
        input.owner.id,
        input.owner.orgDomain,
        now,
        now,
        now,
      );
      this.addMember(id, input.owner.id, 'owner');
    });
    return this.getChat(id)!;
  }

  getChat(id: string): ChatRow | undefined {
    return this.db.get<ChatRow>('select * from chats where id = ? and deleted_at is null', id);
  }

  updateChatTitle(id: string, title: string): void {
    this.db.run('update chats set title = ?, updated_at = ? where id = ?', title, Date.now(), id);
  }

  touchChat(id: string): void {
    this.db.run('update chats set last_activity_at = ? where id = ?', Date.now(), id);
  }

  deleteChat(id: string): void {
    this.db.run('update chats set deleted_at = ? where id = ?', Date.now(), id);
  }

  setOwner(chatId: string, userId: string): void {
    this.db.tx(() => {
      this.db.run("update chat_members set role = 'member' where chat_id = ? and role = 'owner'", chatId);
      this.db.run("update chat_members set role = 'owner' where chat_id = ? and user_id = ?", chatId, userId);
      this.db.run('update chats set owner_id = ? where id = ?', userId, chatId);
    });
  }

  listChatIdsForUser(user: PublicUser): string[] {
    return this.db
      .all<{ id: string }>(
        `select id from chats
         where deleted_at is null
           and (id in (select chat_id from chat_members where user_id = ?)
                or (kind = 'corporate' and org_domain is not null and org_domain = ?))
         order by last_activity_at desc`,
        user.id,
        user.orgDomain ?? '',
      )
      .map((row) => row.id);
  }

  addMember(chatId: string, userId: string, role: MemberRole = 'member'): void {
    this.db.run('insert or ignore into chat_members (chat_id, user_id, role, joined_at) values (?, ?, ?, ?)', chatId, userId, role, Date.now());
  }

  removeMember(chatId: string, userId: string): void {
    this.db.run('delete from chat_members where chat_id = ? and user_id = ?', chatId, userId);
  }

  memberIds(chatId: string): string[] {
    return this.db.all<{ user_id: string }>('select user_id from chat_members where chat_id = ? order by joined_at', chatId).map((row) => row.user_id);
  }

  isMember(chatId: string, userId: string): boolean {
    return this.db.get('select 1 as ok from chat_members where chat_id = ? and user_id = ?', chatId, userId) !== undefined;
  }

  canView(chat: ChatRow, user: PublicUser): boolean {
    if (this.isMember(chat.id, user.id)) return true;
    return chat.kind === 'corporate' && chat.org_domain !== null && chat.org_domain === user.orgDomain;
  }

  members(chatId: string): ChatMember[] {
    const rows = this.db.all<MemberRow & UserRow>(
      `select chat_members.user_id, chat_members.role, chat_members.joined_at, users.*
       from chat_members join users on users.id = chat_members.user_id
       where chat_members.chat_id = ? order by chat_members.joined_at`,
      chatId,
    );
    return rows.map((row) => ({ user: publicUser(toUser(row)), role: row.role, joinedAt: row.joined_at }));
  }

  summary(chat: ChatRow, viewerId: string): ChatSummary {
    const members = this.members(chat.id);
    const queued = this.db.get<{ n: number }>("select count(*) as n from turns where chat_id = ? and status = 'queued'", chat.id)?.n ?? 0;
    const running = this.runningTurns(chat.id);
    return {
      id: chat.id,
      title: chat.title,
      kind: chat.kind,
      ownerId: chat.owner_id,
      orgDomain: chat.org_domain,
      createdAt: chat.created_at,
      updatedAt: chat.updated_at,
      lastActivityAt: chat.last_activity_at,
      members,
      isMember: members.some((member) => member.user.id === viewerId),
      hasWorkspace: chat.kind !== 'private',
      activeTurn: running[0] ?? null,
      activeTurns: running,
      queuedTurns: queued,
    };
  }

  // Invitations

  createInvitation(input: { chatId: string; inviterId: string; inviteeEmail: string; inviteeId: string | null }): InvitationRow {
    const now = Date.now();
    const id = randomUUID();
    this.db.run(
      "insert into invitations (id, chat_id, inviter_id, invitee_email, invitee_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, 'pending', ?, ?)",
      id,
      input.chatId,
      input.inviterId,
      normalizeEmail(input.inviteeEmail),
      input.inviteeId,
      now,
      now,
    );
    return this.invitationRow(id)!;
  }

  invitationRow(id: string): InvitationRow | undefined {
    return this.db.get<InvitationRow>('select * from invitations where id = ?', id);
  }

  pendingInvitation(chatId: string, email: string): InvitationRow | undefined {
    return this.db.get<InvitationRow>("select * from invitations where chat_id = ? and invitee_email = ? and status = 'pending'", chatId, normalizeEmail(email));
  }

  setInvitationStatus(id: string, status: InvitationStatus): void {
    this.db.run('update invitations set status = ?, updated_at = ? where id = ?', status, Date.now(), id);
  }

  pendingInvitationsForUser(user: PublicUser): Invitation[] {
    const rows = this.db.all<InvitationRow>(
      `select invitations.* from invitations join chats on chats.id = invitations.chat_id
       where invitations.status = 'pending' and chats.deleted_at is null
         and (invitations.invitee_id = ? or invitations.invitee_email = ?)
       order by invitations.created_at desc`,
      user.id,
      user.email,
    );
    return rows.map((row) => this.invitation(row)).filter((invitation): invitation is Invitation => invitation !== null);
  }

  pendingInvitationsForChat(chatId: string): Invitation[] {
    const rows = this.db.all<InvitationRow>("select * from invitations where chat_id = ? and status = 'pending' order by created_at", chatId);
    return rows.map((row) => this.invitation(row)).filter((invitation): invitation is Invitation => invitation !== null);
  }

  invitation(row: InvitationRow): Invitation | null {
    const chat = this.getChat(row.chat_id);
    const inviter = this.getUser(row.inviter_id);
    if (!chat || !inviter) return null;
    return {
      id: row.id,
      chatId: row.chat_id,
      chatTitle: chat.title,
      chatKind: chat.kind,
      inviter: publicUser(inviter),
      inviteeEmail: row.invitee_email,
      inviteeId: row.invitee_id,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  // Transcript items

  upsertItem(chatId: string, input: { id: string; kind: ItemKind; data: unknown; turnId: string | null; authorId: string | null }): TranscriptItem {
    return this.db.tx(() => {
      const now = Date.now();
      const chat = this.db.get<{ next_seq: number; next_rev: number }>('select next_seq, next_rev from chats where id = ?', chatId);
      if (!chat) throw new Error('chat not found');
      const existing = this.db.get<{ chat_id: string; kind: string }>('select chat_id, kind from items where id = ?', input.id);
      const data = JSON.stringify(input.data ?? {});
      if (existing) {
        if (existing.chat_id !== chatId) throw new Error('item belongs to another chat');
        this.db.run('update items set data = ?, kind = ?, rev = ?, updated_at = ? where id = ?', data, input.kind, chat.next_rev, now, input.id);
        this.db.run('update chats set next_rev = next_rev + 1 where id = ?', chatId);
      } else {
        this.db.run(
          'insert into items (id, chat_id, seq, rev, turn_id, kind, author_id, data, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          input.id,
          chatId,
          chat.next_seq,
          chat.next_rev,
          input.turnId,
          input.kind,
          input.authorId,
          data,
          now,
          now,
        );
        this.db.run('update chats set next_seq = next_seq + 1, next_rev = next_rev + 1, last_activity_at = ? where id = ?', now, chatId);
      }
      return toItem(this.db.get<ItemRow>('select * from items where id = ?', input.id)!);
    });
  }

  getItem(id: string): TranscriptItem | undefined {
    const row = this.db.get<ItemRow>('select * from items where id = ?', id);
    return row ? toItem(row) : undefined;
  }

  listItems(chatId: string, options: { afterRev?: number; beforeSeq?: number; limit?: number }): TranscriptItem[] {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 5000);
    if (options.afterRev !== undefined) {
      return this.db.all<ItemRow>('select * from items where chat_id = ? and rev > ? order by seq limit ?', chatId, options.afterRev, limit).map(toItem);
    }
    const rows = this.db.all<ItemRow>(
      'select * from items where chat_id = ? and seq < ? order by seq desc limit ?',
      chatId,
      options.beforeSeq ?? Number.MAX_SAFE_INTEGER,
      limit,
    );
    return rows.reverse().map(toItem);
  }

  // Turns

  /** Queued turns run by priority (interrupting sends first), then in arrival order. */
  createTurn(input: {
    chatId: string;
    requesterId: string;
    deviceId: string;
    deviceName: string;
    config: TurnConfig;
    providerLabel: string | null;
    priority?: number;
    parallel?: boolean;
    interrupts?: string | null;
    automation?: TurnAutomation | null;
  }): TurnInfo {
    const id = randomUUID();
    this.db.run(
      "insert into turns (id, chat_id, requester_id, device_id, device_name, config, provider_label, status, created_at, priority, parallel, interrupts, automation) values (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
      id,
      input.chatId,
      input.requesterId,
      input.deviceId,
      input.deviceName,
      JSON.stringify(input.config),
      input.providerLabel,
      Date.now(),
      input.priority ?? 0,
      input.parallel ? 1 : 0,
      input.interrupts ?? null,
      input.automation ? JSON.stringify(input.automation) : null,
    );
    return this.getTurn(id)!;
  }

  getTurn(id: string): TurnInfo | undefined {
    const row = this.db.get<TurnRow>('select * from turns where id = ?', id);
    return row ? toTurn(row) : undefined;
  }

  runningTurns(chatId: string): TurnInfo[] {
    return this.db.all<TurnRow>("select * from turns where chat_id = ? and status = 'running' order by started_at, created_at, rowid", chatId).map(toTurn);
  }

  /** In the order they may start: by priority (interrupting sends first), then oldest first. */
  queuedTurns(chatId: string): TurnInfo[] {
    return this.db.all<TurnRow>("select * from turns where chat_id = ? and status = 'queued' order by priority desc, created_at, rowid", chatId).map(toTurn);
  }

  activeTurns(chatId: string): TurnInfo[] {
    return this.db.all<TurnRow>("select * from turns where chat_id = ? and status in ('queued', 'running') order by created_at", chatId).map(toTurn);
  }

  recentTurns(chatId: string, limit = 200): TurnInfo[] {
    return this.db.all<TurnRow>('select * from turns where chat_id = ? order by created_at desc limit ?', chatId, limit).map(toTurn).reverse();
  }

  /** Turns that a restart would cut short, in every chat. */
  runningTurnCount(): number {
    return this.db.get<{ n: number }>("select count(*) as n from turns where status = 'running'")?.n ?? 0;
  }

  runningTurnsForDevice(deviceId: string): TurnInfo[] {
    return this.db.all<TurnRow>("select * from turns where device_id = ? and status = 'running'", deviceId).map(toTurn);
  }

  startTurn(id: string): TurnInfo {
    this.db.run("update turns set status = 'running', started_at = ? where id = ? and status = 'queued'", Date.now(), id);
    return this.getTurn(id)!;
  }

  finishTurn(id: string, status: Exclude<TurnStatus, 'queued' | 'running'>, error: string | null, usage: TurnUsage | null = null): TurnInfo {
    this.db.run(
      "update turns set status = ?, error = ?, usage = ?, finished_at = ? where id = ? and status in ('queued', 'running')",
      status,
      error,
      usage ? JSON.stringify(usage) : null,
      Date.now(),
      id,
    );
    return this.getTurn(id)!;
  }

  failInterruptedTurns(reason: string): number {
    return this.db.run("update turns set status = 'failed', error = ?, finished_at = ? where status = 'running'", reason, Date.now()).changes;
  }

  promptForTurn(turnId: string): TranscriptItem<'user'> | undefined {
    const row = this.db.get<ItemRow>("select * from items where turn_id = ? and kind = 'user' order by seq limit 1", turnId);
    return row ? (toItem(row) as TranscriptItem<'user'>) : undefined;
  }

  // Shared workspace files

  getFile(chatId: string, path: string): FileEntry | undefined {
    const row = this.db.get<FileRow>('select * from ws_files where chat_id = ? and path = ?', chatId, path);
    return row ? toFile(row) : undefined;
  }

  writeFileEntry(chatId: string, path: string, entry: { hash: string | null; size: number; exec: boolean }, userId: string): FileEntry {
    return this.db.tx(() => {
      this.db.run('update chats set ws_seq = ws_seq + 1 where id = ?', chatId);
      const seq = this.db.get<{ ws_seq: number }>('select ws_seq from chats where id = ?', chatId)!.ws_seq;
      this.db.run(
        `insert into ws_files (chat_id, path, hash, size, exec, seq, updated_by, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(chat_id, path) do update set hash = excluded.hash, size = excluded.size, exec = excluded.exec,
           seq = excluded.seq, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        chatId,
        path,
        entry.hash,
        entry.size,
        entry.exec ? 1 : 0,
        seq,
        userId,
        Date.now(),
      );
      return this.getFile(chatId, path)!;
    });
  }

  workspaceSeq(chatId: string): number {
    return this.db.get<{ ws_seq: number }>('select ws_seq from chats where id = ?', chatId)?.ws_seq ?? 0;
  }

  fileChanges(chatId: string, since: number, limit: number): FileEntry[] {
    return this.db.all<FileRow>('select * from ws_files where chat_id = ? and seq > ? order by seq limit ?', chatId, since, limit).map(toFile);
  }

  chatReferencesBlob(chatId: string, hash: string): boolean {
    return this.db.get('select 1 as ok from ws_files where chat_id = ? and hash = ? limit 1', chatId, hash) !== undefined;
  }
}
