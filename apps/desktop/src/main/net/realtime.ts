import { EventEmitter } from 'node:events';
import type { AutomationLimits, ClientMessage, PublicUser, ServerMessage, TurnInfo } from '@cooprompt/protocol';
import { log } from '../log.ts';
import type { ConnectionState } from '../../shared/types.ts';
import { tr } from '../i18n.ts';

interface Credentials {
  serverUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
  appVersion: string;
}

const MAX_BUFFER = 20_000;

/**
 * One WebSocket per app instance. Chat subscriptions are restored on reconnect and executor
 * messages are buffered while offline so a running turn survives short network drops.
 */
export class Realtime extends EventEmitter<{
  message: [ServerMessage];
  status: [ConnectionState];
  /** `maxParallelTurns` is null when the server has no multitask, `automations` when it has no automations. */
  ready: [{ user: PublicUser; runningTurns: TurnInfo[]; maxParallelTurns: number | null; automations: AutomationLimits | null; teamMessages: boolean }];
}> {
  private socket: WebSocket | null = null;
  private credentials: Credentials | null = null;
  private readonly subscriptions = new Map<string, number>();
  private readonly buffer: ClientMessage[] = [];
  private ready = false;
  /** The server said it is restarting to update: it comes back soon on the same address. */
  private restarting = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  state: ConnectionState = { status: 'offline' };

  connect(credentials: Credentials): void {
    this.disconnect();
    this.credentials = credentials;
    this.open();
  }

  disconnect(): void {
    this.credentials = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.restarting = false;
    socket?.close();
    this.buffer.length = 0;
    this.setState({ status: 'offline' });
  }

  isOnline(): boolean {
    return this.ready;
  }

  subscribe(chatId: string): void {
    const count = this.subscriptions.get(chatId) ?? 0;
    this.subscriptions.set(chatId, count + 1);
    if (count === 0 && this.ready) this.rawSend({ t: 'subscribe', chatId });
  }

  unsubscribe(chatId: string): void {
    const count = this.subscriptions.get(chatId) ?? 0;
    if (count <= 1) {
      this.subscriptions.delete(chatId);
      if (this.ready) this.rawSend({ t: 'unsubscribe', chatId });
    } else this.subscriptions.set(chatId, count - 1);
  }

  /** Executor traffic is buffered while offline; ephemeral traffic is dropped. */
  send(message: ClientMessage, options: { buffer?: boolean } = {}): void {
    if (this.ready && this.rawSend(message)) return;
    if (options.buffer && this.buffer.length < MAX_BUFFER) this.buffer.push(message);
  }

  private rawSend(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private open(): void {
    const credentials = this.credentials;
    if (!credentials) return;
    this.setState({ status: 'connecting' });
    const url = `${credentials.serverUrl.replace(/^http/, 'ws')}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          t: 'hello',
          token: credentials.token,
          deviceId: credentials.deviceId,
          deviceName: credentials.deviceName,
          appVersion: credentials.appVersion,
          // The runner gives each turn beside another in the same chat a session of its own, runs automation
          // turns unattended (declining what would wait for someone), and never puts team-only messages in an
          // agent's context (it asks for items without them).
          features: ['parallel-turns', 'automations', 'team-messages'],
        } satisfies ClientMessage),
      );
    });
    socket.addEventListener('message', (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.t === 'server.restarting') {
        this.restarting = true;
        this.attempt = 0;
      }
      if (message.t === 'ready') {
        this.ready = true;
        this.restarting = false;
        this.attempt = 0;
        for (const chatId of this.subscriptions.keys()) this.rawSend({ t: 'subscribe', chatId });
        for (const pending of this.buffer.splice(0)) this.rawSend(pending);
        this.startPing();
        this.setState({ status: 'online' });
        this.emit('ready', {
          user: message.user,
          runningTurns: message.runningTurns,
          maxParallelTurns: message.maxParallelTurns ?? null,
          automations: message.automations ?? null,
          teamMessages: message.teamMessages === true,
        });
      }
      this.emit('message', message);
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.stopPing();
      if (event.code === 4401) {
        this.setState({ status: 'offline', error: tr('Session expired: sign in again') });
        this.credentials = null;
        return;
      }
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // close follows
    });
  }

  private scheduleReconnect(): void {
    if (!this.credentials) return;
    const delay = Math.min(this.restarting ? 2_000 : 10_000, 500 * 2 ** this.attempt++);
    this.setState({ status: 'connecting', error: this.restarting ? tr('The server is restarting to update…') : tr('Reconnecting…') });
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.rawSend({ t: 'ping' }), 20_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit('status', state);
    if (state.status === 'offline' && state.error) log('realtime', state.error);
  }
}
