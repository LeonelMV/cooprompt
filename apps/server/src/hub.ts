import type { WebSocket } from 'ws';
import type {
  AutomationLimits,
  ClientFeature,
  ClientMessage,
  DeviceInfo,
  DraftState,
  FileEntry,
  ItemKind,
  PermissionItemData,
  PublicUser,
  ServerMessage,
  TranscriptItem,
  TurnInfo,
} from '@cooprompt/protocol';
import { withServerAttachments } from './attachments.ts';
import { publicUser, type Store } from './store.ts';
import { teamStandIns } from './team.ts';

interface Conn {
  id: number;
  socket: WebSocket;
  user: PublicUser | null;
  deviceId: string | null;
  deviceName: string;
  /** What the app said it can do in `hello`; apps that predate features announce nothing. */
  features: Set<ClientFeature>;
  subs: Set<string>;
  alive: boolean;
  connectedAt: number;
}

/** Executors may publish every kind except user prompts and team-only messages, which only the HTTP API creates. */
const EXECUTOR_ITEM_KINDS = new Set<ItemKind>(['text', 'thinking', 'tool', 'permission', 'question', 'todo', 'notice', 'error']);
const MAX_ITEM_BYTES = 512 * 1024;
const MAX_DRAFT_CHARS = 400_000;
const DEVICE_GRACE_MS = 30_000;
const CANCEL_GRACE_MS = 15_000;
const TYPING_MS = 4_000;
const FEATURES = new Set<ClientFeature>(['parallel-turns', 'automations', 'team-messages']);

const deviceKey = (userId: string, deviceId: string) => `${userId}:${deviceId}`;

export class Hub {
  private readonly store: Store;
  private readonly log: (message: string) => void;
  /** Turns a chat runs at once when they were sent in multitask mode; 1 turns multitask off. */
  readonly maxParallelTurns: number;
  private nextConnId = 1;
  private readonly conns = new Set<Conn>();
  private readonly byDevice = new Map<string, Conn>();
  private readonly chatSubs = new Map<string, Set<Conn>>();
  private readonly typing = new Map<string, Map<string, number>>();
  private readonly drafts = new Map<string, { chatId: string; draft: DraftState }>();
  private readonly deviceTimers = new Map<string, NodeJS.Timeout>();
  private readonly cancelTimers = new Map<string, NodeJS.Timeout>();
  /** Who stopped a running turn and how, recorded as its error once the executor confirms. */
  private readonly cancelReasons = new Map<string, string>();
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;
  /** Announced in `ready` when the server runs automations. */
  automationLimits: AutomationLimits | null = null;
  /** A device said hello (connected or reconnected). */
  onDeviceReady: ((userId: string, deviceId: string) => void) | null = null;
  /** A turn was created or changed status. */
  onTurn: ((turn: TurnInfo) => void) | null = null;

  constructor(store: Store, log: (message: string) => void, maxParallelTurns = 1) {
    this.store = store;
    this.log = log;
    this.maxParallelTurns = Math.max(1, Math.floor(maxParallelTurns));
    this.heartbeat = setInterval(() => this.sweep(), 25_000);
    this.heartbeat.unref();
  }

  attach(socket: WebSocket): void {
    const conn: Conn = { id: this.nextConnId++, socket, user: null, deviceId: null, deviceName: '', features: new Set(), subs: new Set(), alive: true, connectedAt: Date.now() };
    this.conns.add(conn);
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('message', (raw) => {
      conn.alive = true;
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        this.send(conn, { t: 'error', message: 'Invalid JSON message' });
        return;
      }
      try {
        this.onMessage(conn, message);
      } catch (error) {
        this.send(conn, { t: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on('close', () => this.onClose(conn));
    socket.on('error', () => socket.terminate());
    setTimeout(() => {
      if (!conn.user && socket.readyState === socket.OPEN) socket.close(4001, 'hello timeout');
    }, 10_000).unref();
  }

  private onMessage(conn: Conn, message: ClientMessage): void {
    if (message.t === 'hello') return this.onHello(conn, message);
    if (message.t === 'ping') return this.send(conn, { t: 'pong' });
    const user = conn.user;
    if (!user) throw new Error('Send hello first');
    switch (message.t) {
      case 'subscribe': {
        const chat = this.store.getChat(message.chatId);
        if (!chat || !this.store.canView(chat, user)) throw new Error('You do not have access to this chat');
        conn.subs.add(chat.id);
        this.subsFor(chat.id).add(conn);
        for (const running of this.store.runningTurns(chat.id)) {
          const draft = this.drafts.get(running.id);
          if (draft) this.send(conn, { t: 'turn.draft', chatId: chat.id, turnId: running.id, draft: draft.draft });
        }
        this.publishPresence(chat.id);
        return;
      }
      case 'unsubscribe': {
        conn.subs.delete(message.chatId);
        this.chatSubs.get(message.chatId)?.delete(conn);
        this.publishPresence(message.chatId);
        return;
      }
      case 'typing': {
        if (!this.store.isMember(message.chatId, user.id)) return;
        let chatTyping = this.typing.get(message.chatId);
        if (!chatTyping) this.typing.set(message.chatId, (chatTyping = new Map()));
        chatTyping.set(user.id, Date.now() + TYPING_MS);
        this.publishPresence(message.chatId);
        setTimeout(() => this.publishPresence(message.chatId), TYPING_MS + 100).unref();
        return;
      }
      case 'turn.items': {
        const turn = this.executorTurn(conn, message.turnId);
        const saved: TranscriptItem[] = [];
        for (const item of Array.isArray(message.items) ? message.items.slice(0, 200) : []) {
          if (!item || typeof item.id !== 'string' || item.id.length > 300 || !item.id.startsWith(`${turn.id}.`)) continue;
          if (!EXECUTOR_ITEM_KINDS.has(item.kind)) continue;
          if (JSON.stringify(item.data ?? {}).length > MAX_ITEM_BYTES) continue;
          const existing = this.store.getItem(item.id);
          if (existing && existing.turnId !== turn.id) continue;
          const data = withServerAttachments(this.store, turn.chatId, item.data);
          saved.push(this.store.upsertItem(turn.chatId, { id: item.id, kind: item.kind, data, turnId: turn.id, authorId: turn.requesterId }));
        }
        if (saved.length > 0) this.publishItems(turn.chatId, saved);
        return;
      }
      case 'turn.draft': {
        const turn = this.executorTurn(conn, message.turnId);
        if (message.draft) {
          const draft: DraftState = { kind: message.draft.kind === 'thinking' ? 'thinking' : 'text', text: String(message.draft.text).slice(0, MAX_DRAFT_CHARS) };
          this.drafts.set(turn.id, { chatId: turn.chatId, draft });
          this.sendToChat(turn.chatId, { t: 'turn.draft', chatId: turn.chatId, turnId: turn.id, draft });
        } else {
          this.drafts.delete(turn.id);
          this.sendToChat(turn.chatId, { t: 'turn.draft', chatId: turn.chatId, turnId: turn.id, draft: null });
        }
        return;
      }
      case 'turn.delta': {
        const turn = this.executorTurn(conn, message.turnId);
        const kind = message.kind === 'thinking' ? 'thinking' : 'text';
        const text = String(message.text ?? '');
        const current = this.drafts.get(turn.id);
        if (!current || current.draft.kind !== kind) this.drafts.set(turn.id, { chatId: turn.chatId, draft: { kind, text } });
        else if (current.draft.text.length < MAX_DRAFT_CHARS) current.draft.text += text;
        this.sendToChat(turn.chatId, { t: 'turn.delta', chatId: turn.chatId, turnId: turn.id, kind, text });
        return;
      }
      case 'turn.finish': {
        const turn = this.store.getTurn(message.turnId);
        if (!turn || turn.requesterId !== user.id || turn.deviceId !== conn.deviceId || turn.status !== 'running') return;
        const status = message.status === 'done' || message.status === 'cancelled' ? message.status : 'failed';
        const reason = status === 'cancelled' ? this.cancelReasons.get(turn.id) : undefined;
        const error = reason ?? (message.error ? String(message.error).slice(0, 4000) : null);
        this.endTurn(this.store.finishTurn(turn.id, status, error, message.usage ?? null));
        return;
      }
      case 'decision': {
        const turn = this.store.getTurn(message.turnId);
        if (!turn || turn.chatId !== message.chatId || turn.status !== 'running') throw new Error('The turn is no longer active');
        if (!this.store.isMember(turn.chatId, user.id)) throw new Error('Only participants can answer');
        const item = this.store.getItem(message.itemId);
        if (!item || item.turnId !== turn.id || (item.kind !== 'permission' && item.kind !== 'question')) throw new Error('Request not found');
        const data = item.data as { status?: string };
        if (data.status !== 'pending') throw new Error('That request was already resolved');
        if (item.kind === 'permission' && user.id !== turn.requesterId && !(item.data as PermissionItemData).othersCanDecide) {
          throw new Error('Only the person running the turn can approve actions on their computer');
        }
        const target = this.byDevice.get(deviceKey(turn.requesterId, turn.deviceId));
        if (!target) throw new Error('The device running the turn is not connected');
        this.send(target, { t: 'decision', chatId: turn.chatId, turnId: turn.id, itemId: item.id, decision: message.decision, byUserId: user.id });
        return;
      }
      default:
        throw new Error('Unknown message');
    }
  }

  private onHello(conn: Conn, message: Extract<ClientMessage, { t: 'hello' }>): void {
    const record = this.store.getUserByToken(String(message.token ?? ''));
    if (!record) {
      this.send(conn, { t: 'error', message: 'Your session is invalid or expired' });
      conn.socket.close(4401, 'unauthorized');
      return;
    }
    const deviceId = String(message.deviceId ?? '');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(deviceId)) {
      conn.socket.close(4400, 'invalid device');
      return;
    }
    const user = publicUser(record);
    conn.user = user;
    conn.deviceId = deviceId;
    conn.deviceName = String(message.deviceName ?? 'Device').slice(0, 80) || 'Device';
    conn.features = new Set((Array.isArray(message.features) ? message.features : []).filter((feature): feature is ClientFeature => FEATURES.has(feature)));
    const key = deviceKey(user.id, deviceId);
    const previous = this.byDevice.get(key);
    this.byDevice.set(key, conn);
    if (previous && previous !== conn) previous.socket.close(4000, 'replaced');
    const timer = this.deviceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.deviceTimers.delete(key);
    }
    const runningTurns = this.store.runningTurnsForDevice(deviceId).filter((turn) => turn.requesterId === user.id);
    this.send(conn, {
      t: 'ready',
      user,
      deviceId,
      runningTurns,
      ...(this.maxParallelTurns > 1 ? { maxParallelTurns: this.maxParallelTurns } : {}),
      ...(this.automationLimits ? { automations: this.automationLimits } : {}),
      teamMessages: true,
    });
    this.publishDevices(user.id);
    this.log(`ws: ${user.email} connected from ${conn.deviceName}`);
    this.onDeviceReady?.(user.id, deviceId);
  }

  private onClose(conn: Conn): void {
    this.conns.delete(conn);
    if (this.closed) return;
    for (const chatId of conn.subs) {
      this.chatSubs.get(chatId)?.delete(conn);
      this.publishPresence(chatId);
    }
    const user = conn.user;
    if (!user || !conn.deviceId) return;
    const key = deviceKey(user.id, conn.deviceId);
    if (this.byDevice.get(key) === conn) {
      this.byDevice.delete(key);
      const deviceId = conn.deviceId;
      if (this.store.runningTurnsForDevice(deviceId).some((turn) => turn.requesterId === user.id)) {
        this.deviceTimers.set(
          key,
          setTimeout(() => {
            this.deviceTimers.delete(key);
            if (this.byDevice.has(key)) return;
            for (const turn of this.store.runningTurnsForDevice(deviceId).filter((t) => t.requesterId === user.id)) {
              this.endTurn(this.store.finishTurn(turn.id, 'failed', 'The device running the turn disconnected'));
            }
          }, DEVICE_GRACE_MS),
        );
      }
    }
    this.publishDevices(user.id);
  }

  private executorTurn(conn: Conn, turnId: string): TurnInfo {
    const turn = this.store.getTurn(turnId);
    if (!turn || turn.status !== 'running') throw new Error('The turn is not running');
    if (turn.requesterId !== conn.user?.id || turn.deviceId !== conn.deviceId) throw new Error('This device is not running that turn');
    return turn;
  }

  private subsFor(chatId: string): Set<Conn> {
    let subs = this.chatSubs.get(chatId);
    if (!subs) this.chatSubs.set(chatId, (subs = new Set()));
    return subs;
  }

  private send(conn: Conn, message: ServerMessage): void {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(message));
  }

  sendToUser(userId: string, message: ServerMessage): void {
    for (const conn of this.conns) if (conn.user?.id === userId) this.send(conn, message);
  }

  /** Closes a user's connections after their sessions were revoked; apps then ask to sign in again. */
  disconnectUser(userId: string): void {
    for (const conn of this.conns) if (conn.user?.id === userId) conn.socket.close(4401, 'unauthorized');
  }

  private sendToChat(chatId: string, message: ServerMessage): void {
    for (const conn of this.chatSubs.get(chatId) ?? []) this.send(conn, message);
  }

  isDeviceOnline(userId: string, deviceId: string): boolean {
    return this.byDevice.has(deviceKey(userId, deviceId));
  }

  deviceName(userId: string, deviceId: string): string | null {
    return this.byDevice.get(deviceKey(userId, deviceId))?.deviceName ?? null;
  }

  /** Older apps resume one engine session per chat, so two of their turns must never run at once. */
  runsParallelTurns(userId: string, deviceId: string): boolean {
    return this.maxParallelTurns > 1 && this.hasFeature(userId, deviceId, 'parallel-turns');
  }

  /** The device is connected and announced `feature`. */
  hasFeature(userId: string, deviceId: string, feature: ClientFeature): boolean {
    return this.byDevice.get(deviceKey(userId, deviceId))?.features.has(feature) ?? false;
  }

  devicesFor(userId: string): DeviceInfo[] {
    const devices: DeviceInfo[] = [];
    for (const conn of this.byDevice.values()) {
      if (conn.user?.id === userId && conn.deviceId) devices.push({ deviceId: conn.deviceId, deviceName: conn.deviceName, connectedAt: conn.connectedAt });
    }
    return devices;
  }

  private publishDevices(userId: string): void {
    this.sendToUser(userId, { t: 'devices', devices: this.devicesFor(userId) });
  }

  publishItems(chatId: string, items: TranscriptItem[]): void {
    const full: ServerMessage = { t: 'items', chatId, items };
    const withoutTeam: ServerMessage = items.some((item) => item.kind === 'team') ? { t: 'items', chatId, items: teamStandIns(this.store, items) } : full;
    for (const conn of this.chatSubs.get(chatId) ?? []) this.send(conn, conn.features.has('team-messages') ? full : withoutTeam);
  }

  publishTurn(turn: TurnInfo): void {
    this.sendToChat(turn.chatId, { t: 'turn.upsert', turn });
    this.onTurn?.(turn);
  }

  /** Sends the per-viewer chat summary to members and, for corporate chats, to the online org. */
  publishChat(chatId: string): void {
    const chat = this.store.getChat(chatId);
    if (!chat) return;
    const audience = new Set(this.store.memberIds(chatId));
    if (chat.kind === 'corporate' && chat.org_domain) {
      for (const conn of this.conns) if (conn.user?.orgDomain === chat.org_domain) audience.add(conn.user.id);
    }
    const summary = this.store.summary(chat, '');
    for (const conn of this.conns) {
      const viewer = conn.user;
      if (!viewer || !audience.has(viewer.id)) continue;
      this.send(conn, { t: 'chat.upsert', chat: { ...summary, isMember: summary.members.some((member) => member.user.id === viewer.id) } });
    }
  }

  removeChatFor(userIds: Iterable<string>, chatId: string): void {
    for (const userId of userIds) this.sendToUser(userId, { t: 'chat.remove', chatId });
  }

  /** Corporate chats are removed for the whole online org. */
  removeChatForOrg(orgDomain: string, chatId: string): void {
    for (const conn of this.conns) if (conn.user?.orgDomain === orgDomain) this.send(conn, { t: 'chat.remove', chatId });
  }

  publishPresence(chatId: string): void {
    const subs = this.chatSubs.get(chatId);
    const online = [...new Set([...(subs ?? [])].map((conn) => conn.user?.id).filter((id): id is string => Boolean(id)))];
    const now = Date.now();
    const typing = [...(this.typing.get(chatId) ?? new Map<string, number>()).entries()]
      .filter(([userId, until]) => until > now && online.includes(userId))
      .map(([userId]) => userId);
    this.sendToChat(chatId, { t: 'presence', chatId, online, typing });
  }

  notifyFiles(chatId: string, entries: FileEntry[]): void {
    const members = new Set(this.store.memberIds(chatId));
    for (const conn of this.conns) if (conn.user && members.has(conn.user.id)) this.send(conn, { t: 'fs.change', chatId, entries });
  }

  /** To the apps of the chat's members, but `exceptUserId`'s, that announced `feature`, whether or not they have it open. */
  sendToMembers(chatId: string, message: ServerMessage, feature: ClientFeature, exceptUserId?: string): void {
    const members = new Set(this.store.memberIds(chatId));
    for (const conn of this.conns) {
      if (conn.user && conn.user.id !== exceptUserId && members.has(conn.user.id) && conn.features.has(feature)) this.send(conn, message);
    }
  }

  /**
   * Starts what the chat can run now. Queued turns start in order (priority, then arrival) and none skips
   * the line: an interrupting turn waits for the turn it stops, a turn sent without multitask waits until
   * nothing runs, and a multitask turn starts while fewer than `maxParallelTurns` run. Turns whose executor
   * is offline fail fast.
   */
  scheduleChat(chatId: string): void {
    const running = this.store.runningTurns(chatId);
    for (const next of this.store.queuedTurns(chatId)) {
      if (running.length >= this.maxParallelTurns) return;
      if (next.interrupts && running.some((turn) => turn.id === next.interrupts)) return;
      if (!next.parallel && running.length > 0) return;
      const conn = this.byDevice.get(deviceKey(next.requesterId, next.deviceId));
      const prompt = this.store.promptForTurn(next.id);
      const chat = this.store.getChat(chatId);
      if (!conn || !prompt || !chat) {
        this.endTurn(this.store.finishTurn(next.id, 'failed', 'The executing device is not connected'), false);
        continue;
      }
      const turn = this.store.startTurn(next.id);
      running.push(turn);
      this.publishTurn(turn);
      this.publishChat(chatId);
      this.send(conn, { t: 'turn.run', turn, chat: this.store.summary(chat, next.requesterId), prompt });
    }
  }

  /**
   * `interrupt` means the turn was stopped so a newer message runs right away. Cancelling a queued turn can
   * let the ones behind it start, unless `schedule` is off (the whole chat is going away).
   */
  cancelTurn(turn: TurnInfo, by: PublicUser, how: 'cancel' | 'interrupt' = 'cancel', schedule = true): TurnInfo {
    return this.stopTurn(turn, how === 'interrupt' ? `Interrupted by ${by.name}` : `Cancelled by ${by.name}`, schedule);
  }

  /** Cancels a queued turn or stops a running one; `reason` becomes its error. */
  stopTurn(turn: TurnInfo, reason: string, schedule = true): TurnInfo {
    turn = this.store.getTurn(turn.id) ?? turn;
    if (turn.status === 'queued') {
      const cancelled = this.store.finishTurn(turn.id, 'cancelled', reason);
      this.publishTurn(cancelled);
      this.publishChat(turn.chatId);
      if (schedule) this.scheduleChat(turn.chatId);
      return cancelled;
    }
    if (turn.status === 'running') {
      if (!this.cancelReasons.has(turn.id)) this.cancelReasons.set(turn.id, reason);
      const target = this.byDevice.get(deviceKey(turn.requesterId, turn.deviceId));
      if (target) this.send(target, { t: 'turn.cancel', turnId: turn.id });
      if (!this.cancelTimers.has(turn.id)) {
        this.cancelTimers.set(
          turn.id,
          setTimeout(
            () => {
              this.cancelTimers.delete(turn.id);
              if (this.store.getTurn(turn.id)?.status === 'running') {
                this.endTurn(this.store.finishTurn(turn.id, 'cancelled', this.cancelReasons.get(turn.id) ?? reason));
              }
            },
            target ? CANCEL_GRACE_MS : 0,
          ),
        );
      }
    }
    return turn;
  }

  private endTurn(turn: TurnInfo, schedule = true): void {
    const timer = this.cancelTimers.get(turn.id);
    if (timer) {
      clearTimeout(timer);
      this.cancelTimers.delete(turn.id);
    }
    this.cancelReasons.delete(turn.id);
    if (this.drafts.delete(turn.id)) this.sendToChat(turn.chatId, { t: 'turn.draft', chatId: turn.chatId, turnId: turn.id, draft: null });
    this.publishTurn(turn);
    this.publishChat(turn.chatId);
    if (schedule) this.scheduleChat(turn.chatId);
  }

  private sweep(): void {
    for (const conn of this.conns) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.socket.ping();
      } catch {
        conn.socket.terminate();
      }
    }
  }

  announceRestart(version: string | null): void {
    for (const conn of this.conns) if (conn.user) this.send(conn, { t: 'server.restarting', reason: 'update', version });
  }

  close(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const timer of [...this.deviceTimers.values(), ...this.cancelTimers.values()]) clearTimeout(timer);
    for (const conn of this.conns) conn.socket.close(1001, 'server shutting down');
  }
}
