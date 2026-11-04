import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type {
  ChatSummary,
  Decision,
  EngineId,
  PermissionItemData,
  PublicUser,
  QuestionItemData,
  TextItemData,
  TranscriptItem,
  TurnInfo,
} from '@cooprompt/protocol';
import { promptText } from '@cooprompt/protocol';
import { NEW_SESSION_COMMANDS, parseSlash } from '../../shared/commands.ts';
import { ENGINE_NAME } from '../../shared/engines.ts';
import type { EngineInfo, ProviderProfile } from '../../shared/types.ts';
import type { AttachmentStore } from '../attachments.ts';
import { codexPrompt } from '../commands.ts';
import type { Connectors } from '../connectors.ts';
import { runClaude } from '../engines/claude.ts';
import { codexHome, runCodex } from '../engines/codex.ts';
import { runCursor } from '../engines/cursor.ts';
import { claudeEnv, claudeModelEnv, codexSetup, cursorEnv, nativeMedia } from '../engines/providers.ts';
import type { EngineRunInput, EngineRunResult, EngineSink, PermissionAnswer, PermissionRequest } from '../engines/types.ts';
import { log } from '../log.ts';
import type { ApiClient } from '../net/api.ts';
import type { Realtime } from '../net/realtime.ts';
import type { Secrets } from '../secrets.ts';
import type { EngineSession, Settings } from '../settings.ts';
import { folderSlug, type SyncManager } from '../sync/manager.ts';
import { attachmentNote, catchUpAttachments, referencedMedia } from './attachments.ts';
import { automationNote, PARALLEL_NOTE, renderAlongside, renderCatchUp, systemAppend, UNATTENDED_DENIAL } from './context.ts';
import { createPublisher, type TurnOutcome } from './publisher.ts';
import { tr } from '../i18n.ts';

interface PendingDecision {
  kind: 'permission' | 'question';
  othersCanDecide: boolean;
  resolve(decision: Decision | null, byUserId: string | null): void;
}

interface ActiveTurn {
  turn: TurnInfo;
  chat: ChatSummary;
  controller: AbortController;
  pending: Map<string, PendingDecision>;
}

/** What an engine session has seen of the chat's transcript (see `EngineSession`). */
interface Knowledge {
  seenRev: number;
  deferred: { turnId: string; rev: number }[];
  turnIds: string[];
  originRev: number;
}

/** Records written before multitask only know the prompt of their last turn and, after /new, its boundary. */
function knowledge(record: EngineSession): Knowledge {
  return {
    seenRev: record.seenRev ?? record.lastRev,
    deferred: record.deferred ?? [],
    turnIds: record.turnIds ?? (record.lastTurnId ? [record.lastTurnId] : []),
    originRev: record.originRev ?? (record.sessionId ? 0 : record.lastRev),
  };
}

interface SessionPlan {
  /** Null for a session that starts knowing nothing, which gets the whole history. */
  knows: Knowledge | null;
  resume: string | null;
  forkAt: string | null;
  interrupted: boolean;
  /** The turn continues the chat's main session: what that record was when it started, to store its own over it. */
  main: { startedFrom: EngineSession | undefined } | null;
}

const HISTORY_LIMIT = 5000;
const MAX_OWN_TURNS = 20;
const MAX_SIDE_SESSIONS = 20;

/**
 * An automation run that starts a new agent session knows nothing of the chat before its own request, and
 * leaves the chat's main session alone: later turns get what it did as context, like a parallel turn's.
 */
const freshSession = (rev: number): SessionPlan => ({ knows: { seenRev: rev, deferred: [], turnIds: [], originRev: rev }, resume: null, forkAt: null, interrupted: false, main: null });

export interface RunnerDeps {
  api: ApiClient;
  realtime: Realtime;
  settings: Settings;
  secrets: Pick<Secrets, 'get'>;
  connectors: Pick<Connectors, 'serversFor' | 'nativeNames' | 'codexApprovalScopes'>;
  sync: Pick<SyncManager, 'activate' | 'get'>;
  attachments: Pick<AttachmentStore, 'materialize' | 'sharer'>;
  appVersion: string;
  /** Engine binaries, found differently in development and packaged builds. */
  executables: {
    claude(): string;
    codex(): { bin: string; pathDirs: string[] };
    /** The Cursor CLI isn't bundled: it is the one installed on this computer, found through the login shell's `PATH`. */
    cursor(shellEnv: Record<string, string>): string;
  };
  shellEnv(): Record<string, string>;
  user(): PublicUser | null;
  redact(text: string): string;
  engineInfo(chatId: string, info: EngineInfo): void;
  notify(title: string, body: string): void;
}

/** Bash approvals remember the command's first two words; other tools are remembered by name. */
function permissionKey(toolName: string, input: unknown): string {
  if (toolName === 'Bash' && input && typeof (input as { command?: unknown }).command === 'string') {
    return `Bash:${(input as { command: string }).command.trim().split(/\s+/).slice(0, 2).join(' ')}`;
  }
  return toolName;
}

export class Runner {
  private readonly deps: RunnerDeps;
  private readonly active = new Map<string, ActiveTurn>();
  /**
   * The turn that continues each chat's main engine session on this computer. Turns that start beside it can't
   * share that session: they fork it where its last turn ended, or start a new one.
   */
  private readonly mainTurns = new Map<string, string>();
  /** Sessions of the turns that ran beside the main one, kept so a message interrupting one continues it. */
  private readonly sideSessions = new Map<string, EngineSession>();

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  isExecuting(turnId: string): boolean {
    return this.active.has(turnId);
  }

  /** Some turn runs on this computer right now. */
  busy(): boolean {
    return this.active.size > 0;
  }

  /** After a reconnect, turns the server thinks we run but we don't know are failed explicitly. */
  reconcile(runningTurns: TurnInfo[]): void {
    for (const turn of runningTurns) {
      if (!this.active.has(turn.id)) {
        this.deps.realtime.send({ t: 'turn.finish', turnId: turn.id, status: 'failed', error: 'The app was closed or restarted during the turn' });
      }
    }
  }

  cancel(turnId: string): void {
    const active = this.active.get(turnId);
    if (!active) return;
    active.controller.abort();
    for (const pending of active.pending.values()) pending.resolve(null, null);
  }

  cancelAll(): void {
    for (const turnId of this.active.keys()) this.cancel(turnId);
  }

  /** Applies an approval or answer coming from this device's UI or forwarded by the server. */
  respond(turnId: string, itemId: string, decision: Decision, byUserId: string): boolean {
    const pending = this.active.get(turnId)?.pending.get(itemId);
    if (!pending) return false;
    const me = this.deps.user()?.id;
    if (pending.kind === 'permission') {
      if (decision.type !== 'permission') return false;
      if (byUserId !== me && !pending.othersCanDecide) return false;
    } else if (decision.type !== 'question') return false;
    pending.resolve(decision, byUserId);
    return true;
  }

  async run(turn: TurnInfo, chat: ChatSummary, prompt: TranscriptItem<'user'>): Promise<void> {
    if (this.active.has(turn.id)) return;
    const active: ActiveTurn = { turn, chat, controller: new AbortController(), pending: new Map() };
    this.active.set(turn.id, active);
    this.deps.realtime.subscribe(chat.id);
    const publisher = createPublisher(turn.id, {
      send: (message) => this.deps.realtime.send(message, { buffer: true }),
      redact: (text) => this.deps.redact(text),
      shouldRedact: () => this.deps.settings.data.redactSecrets,
      info: (info) => this.deps.engineInfo(turn.chatId, { ...info, at: Date.now() }),
      share: this.deps.attachments.sharer(chat.id, {
        skip: (prompt.data.attachments ?? []).map((file) => file.sha256),
        rename: (name) => (this.deps.settings.data.redactSecrets ? this.deps.redact(name) : name),
      }),
    });
    let outcome: TurnOutcome;
    try {
      const result = await this.execute(active, prompt, publisher.sink);
      outcome = { status: result.status, error: result.error ?? null, usage: result.usage ?? null };
      if (result.status === 'failed' && result.error) publisher.sink.item('error', { kind: 'error', data: { message: result.error } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('runner', `turn ${turn.id} failed`, message);
      publisher.sink.item('error', { kind: 'error', data: { message } });
      outcome = { status: active.controller.signal.aborted ? 'cancelled' : 'failed', error: message };
    } finally {
      for (const pending of active.pending.values()) pending.resolve(null, null);
      // Before the server hears the turn ended, so the turn it starts next can take the main session.
      if (this.mainTurns.get(chat.id) === turn.id) this.mainTurns.delete(chat.id);
    }
    await publisher.finish(outcome);
    this.deps.realtime.unsubscribe(chat.id);
    this.active.delete(turn.id);
  }

  private profileFor(turn: TurnInfo): ProviderProfile {
    const { profiles, defaultProfileId } = this.deps.settings.data;
    const byId = profiles.find((profile) => profile.id === turn.config.profileId && profile.engine === turn.config.engine);
    const fallback =
      profiles.find((profile) => profile.id === defaultProfileId && profile.engine === turn.config.engine) ?? profiles.find((profile) => profile.engine === turn.config.engine);
    const profile = byId ?? fallback;
    if (!profile) {
      throw new Error(`No ${ENGINE_NAME[turn.config.engine] ?? turn.config.engine} model is set up on this computer. Add one in Settings → Models & keys.`);
    }
    return profile;
  }

  private async workingDirectory(chat: ChatSummary, sink: EngineSink): Promise<string> {
    if (chat.hasWorkspace) {
      const sync = await this.deps.sync.activate(chat);
      if (!sync) throw new Error('Could not prepare the shared workspace');
      try {
        await sync.ensureCaughtUp();
      } catch (error) {
        sink.item('sync-warning', {
          kind: 'notice',
          data: { text: `Could not finish syncing before starting: ${error instanceof Error ? error.message : String(error)}`, level: 'warn' },
        });
      }
      return sync.root;
    }
    const prefs = this.deps.settings.chatPrefs(chat.id);
    if (prefs.folder) {
      if (!existsSync(prefs.folder)) throw new Error(`The working folder ${prefs.folder} no longer exists. Pick another one in the chat panel.`);
      return prefs.folder;
    }
    const folder = join(this.deps.settings.data.privateRoot, `${folderSlug(chat.title)}-${chat.id.slice(0, 6)}`);
    await mkdir(folder, { recursive: true });
    this.deps.settings.update((data) => {
      data.chatPrefs[chat.id] = { ...(data.chatPrefs[chat.id] ?? {}), folder };
    });
    return folder;
  }

  private async execute(active: ActiveTurn, prompt: TranscriptItem<'user'>, sink: EngineSink): Promise<EngineRunResult> {
    const { turn, chat } = active;
    const me = this.deps.user();
    if (!me) throw new Error('You are not signed in');
    const profile = this.profileFor(turn);
    const key = this.deps.secrets.get(`provider:${profile.id}`);
    const cwd = await this.workingDirectory(chat, sink);
    const engine = turn.config.engine;
    const model = turn.config.model ?? profile.model ?? null;
    const typed = promptText(prompt.data);
    const slash = parseSlash(typed);
    if (slash && NEW_SESSION_COMMANDS.includes(slash.name)) {
      // A turn still running in the main session finds it replaced when it ends, and leaves it so.
      this.deps.settings.update((data) => {
        data.sessions[chat.id] = { engine, profileId: profile.id, sessionId: '', cwd, lastRev: prompt.rev, lastTurnId: turn.id, seenRev: prompt.rev, originRev: prompt.rev, turnIds: [turn.id] };
      });
      sink.item('new-session', { kind: 'notice', data: { text: 'New agent session: earlier messages are no longer in its context' } });
      return { sessionId: null, status: 'done', usage: { contextTokens: 0 } };
    }

    const plan = turn.automation?.fresh ? freshSession(prompt.rev) : this.planSession(turn, chat.id, engine, profile.id, cwd);
    const caught = await this.catchUp(chat.id, turn.id, plan.knows);
    const attachments = await this.deps.attachments.materialize(chat.id, cwd, prompt.data.attachments ?? []);
    const earlier = await this.deps.attachments.materialize(chat.id, cwd, catchUpAttachments(caught.items));
    const catchUp = renderCatchUp(caught.items, chat, new Map(earlier.map((copy) => [copy.id, relative(cwd, copy.path)])));
    const alongside = renderAlongside(caught.alongside, chat);
    const context = [
      ...(catchUp
        ? [
            plan.resume
              ? 'What happened in the chat since your last turn (turns run by other participants on their own computers, or beside yours):'
              : plan.knows
                ? 'What happened in the chat since this session started:'
                : 'Chat history so far:',
            catchUp,
          ]
        : []),
      // Claude Code records interruptions in its session; Codex and Cursor don't say so when they are stopped.
      ...(plan.interrupted && engine !== 'claude' ? ['Your previous turn was interrupted before it finished: the user sent a new message instead.'] : []),
      ...(alongside ? ["Running right now, beside this turn (their results reach you later, so don't redo their work):", alongside] : []),
      ...(alongside || turn.parallel ? [PARALLEL_NOTE] : []),
      ...(turn.automation ? [automationNote(turn.automation, me.name)] : []),
    ];
    const preamble = context.length ? `<cooprompt_context>\n${context.join('\n')}\n</cooprompt_context>` : null;
    const codexText = engine === 'codex' && slash ? await codexPrompt(slash, codexHome(this.deps.shellEnv()), this.deps.settings.data.language) : null;
    const text = codexText ?? typed;
    const requester = chat.members.find((member) => member.user.id === turn.requesterId)?.user ?? me;
    const named = chat.kind !== 'private' && !text.trim().startsWith('/') ? `[${requester.name}]: ${text}` : text;
    const prefs = this.deps.settings.chatPrefs(chat.id);
    // Text items the agent publishes, to share the media files its answers point to once the turn ends.
    const answers = new Map<string, string>();
    const engineSink: EngineSink = {
      ...sink,
      item: (key, item) => {
        if (item.kind === 'text' && !(item.data as TextItemData).parentToolId) answers.set(key, (item.data as TextItemData).text);
        sink.item(key, item);
      },
    };

    const base: Omit<EngineRunInput, 'env'> = {
      cwd,
      prompt: [named, attachmentNote(attachments, cwd)].filter(Boolean).join('\n\n'),
      attachments,
      nativeMedia: nativeMedia(profile),
      preamble,
      systemAppend: systemAppend(chat, me, cwd),
      model,
      effort: turn.config.effort ?? null,
      sessionId: plan.resume,
      forkAt: plan.forkAt,
      permissionMode: turn.config.permissionMode,
      mcpServers: await this.deps.connectors.serversFor(engine),
      signal: active.controller.signal,
      sink: engineSink,
      requestPermission: (request) => this.requestPermission(active, request, sink, prefs.allowOthersToApprove ?? false),
      askQuestion: (request) => this.askQuestion(active, request.key, request.questions, sink),
      log: (line) => log(`engine:${engine}`, line),
    };

    const result =
      engine === 'claude'
        ? await runClaude({ ...base, env: { ...claudeEnv(profile, key, this.deps.shellEnv(), this.deps.appVersion), ...claudeModelEnv(profile, model) }, executable: this.deps.executables.claude() })
        : engine === 'cursor'
          ? await runCursor({
              ...base,
              env: cursorEnv(profile, this.deps.shellEnv()),
              executable: this.deps.executables.cursor(this.deps.shellEnv()),
              nativeMcpServers: await this.deps.connectors.nativeNames('cursor'),
              appVersion: this.deps.appVersion,
            })
          : await (async () => {
              const codex = this.deps.executables.codex();
              const setup = codexSetup(profile, key, this.deps.shellEnv(), codex.pathDirs);
              const nativeMcpServers = await this.deps.connectors.nativeNames('codex');
              const approvalScopes = await this.deps.connectors.codexApprovalScopes();
              return runCodex({ ...base, env: setup.env, executable: codex.bin, setup, nativeMcpServers, approvalScopes });
            })();

    // Each file once, with the last answer that mentions it (an earlier one may only announce it).
    const shared = new Set<string>();
    for (const [key, answer] of [...answers].reverse()) {
      const paths = (await referencedMedia(answer, cwd).catch(() => [])).filter((path) => !shared.has(path));
      for (const path of paths) shared.add(path);
      if (paths.length > 0) sink.attach(key, paths.map((path) => ({ path })));
    }
    if (chat.hasWorkspace) {
      const sync = this.deps.sync.get(chat.id);
      await sync?.flush().catch((error) => log('runner', 'flush failed', error));
    }
    if (result.sessionId) {
      // The session now holds what it caught up on plus this turn's own items, which are excluded by
      // id next time, so activity others add meanwhile is never skipped.
      const record: EngineSession = {
        engine,
        profileId: profile.id,
        sessionId: result.sessionId,
        cwd,
        lastRev: prompt.rev,
        lastTurnId: turn.id,
        ...caught.next,
        ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
        ...(result.status === 'cancelled' ? { interrupted: true } : {}),
      };
      const main = plan.main;
      if (main) {
        this.deps.settings.update((data) => {
          // A /new or a folder change while the turn ran replaced the main session; that choice stands.
          if (data.sessions[chat.id] === main.startedFrom) data.sessions[chat.id] = record;
        });
      } else {
        this.sideSessions.delete(turn.id);
        this.sideSessions.set(turn.id, record);
        for (const old of this.sideSessions.keys()) {
          if (this.sideSessions.size <= MAX_SIDE_SESSIONS) break;
          this.sideSessions.delete(old);
        }
      }
    }
    return result;
  }

  /**
   * Which engine session a turn continues. The first turn in a chat takes the main session (resumed when
   * its engine, profile and folder still match). A turn interrupting one that ran beside it continues that
   * one's session. Any other turn starting while the main session is busy forks it where its last turn
   * ended, when the engine can, or starts a new session that catches up on the whole history.
   */
  private planSession(turn: TurnInfo, chatId: string, engine: EngineId, profileId: string, cwd: string): SessionPlan {
    const resumable = (record: EngineSession | undefined): EngineSession | null =>
      record?.sessionId && record.engine === engine && record.profileId === profileId && record.cwd === cwd ? record : null;
    const main = this.deps.settings.data.sessions[chatId];
    const target = resumable(turn.interrupts ? this.sideSessions.get(turn.interrupts) : undefined);
    if (target) return { knows: knowledge(target), resume: target.sessionId, forkAt: null, interrupted: Boolean(target.interrupted), main: null };
    const current = resumable(main);
    if (!this.mainTurns.has(chatId)) {
      this.mainTurns.set(chatId, turn.id);
      // After /new the record has no session, only the point the next one catches up from.
      const knows = current ?? (main && !main.sessionId ? main : null);
      return { knows: knows && knowledge(knows), resume: current?.sessionId ?? null, forkAt: null, interrupted: Boolean(current?.interrupted), main: { startedFrom: main } };
    }
    if (current?.checkpoint) return { knows: knowledge(current), resume: current.sessionId, forkAt: current.checkpoint, interrupted: false, main: null };
    const origin = main ? knowledge(main).originRev : 0;
    return { knows: origin ? { seenRev: origin, deferred: [], turnIds: [], originRev: origin } : null, resume: null, forkAt: null, interrupted: false, main: null };
  }

  /**
   * What the engine session is missing: the transcript changes since it last caught up and the turns it
   * deferred then, without its own turns. Turns still queued or running are deferred again, and the
   * running ones are listed apart, so each turn reaches a session once, whole.
   */
  private async catchUp(chatId: string, turnId: string, knows: Knowledge | null) {
    // Turns first: one that ends between the two requests is just deferred once more.
    const turns = await this.deps.api.get<TurnInfo[]>(`/api/chats/${chatId}/turns`);
    const pending = turns.filter((turn) => turn.id !== turnId && (turn.status === 'queued' || turn.status === 'running'));
    const seen = knows?.seenRev ?? 0;
    const afterRev = knows ? Math.max(knows.originRev, Math.min(seen, ...knows.deferred.map((entry) => entry.rev - 1))) : 0;
    // Never with `include=team`: the server then hands over team-only messages as stand-ins without their content.
    const history = await this.deps.api.get<TranscriptItem[]>(`/api/chats/${chatId}/items?afterRev=${afterRev}&limit=${HISTORY_LIMIT}`);
    const own = new Set([turnId, ...(knows?.turnIds ?? [])]);
    const waiting = new Set(pending.map((turn) => turn.id));
    const late = new Set(knows?.deferred.map((entry) => entry.turnId));
    const items = history.filter((item) => {
      if (item.turnId && (own.has(item.turnId) || waiting.has(item.turnId))) return false;
      return item.rev > seen || (item.turnId !== null && late.has(item.turnId));
    });
    const prompts = new Map(history.filter((item) => item.kind === 'user' && item.turnId).map((item) => [item.turnId!, item]));
    const truncated = history.length >= HISTORY_LIMIT;
    const next: Knowledge = {
      seenRev: truncated ? seen : Math.max(afterRev, seen, ...history.map((item) => item.rev)),
      deferred: [
        ...pending.map((turn) => ({ turnId: turn.id, rev: prompts.get(turn.id)?.rev ?? knows?.deferred.find((entry) => entry.turnId === turn.id)?.rev ?? afterRev + 1 })),
        ...(truncated ? (knows?.deferred ?? []).filter((entry) => !waiting.has(entry.turnId)) : []),
      ],
      turnIds: [...(knows?.turnIds ?? []), turnId].slice(-MAX_OWN_TURNS),
      originRev: knows?.originRev ?? 0,
    };
    const alongside = pending.filter((turn) => turn.status === 'running').map((turn) => ({ turn, prompt: prompts.get(turn.id) ?? null }));
    return { items, alongside, next };
  }

  private async requestPermission(active: ActiveTurn, request: PermissionRequest, sink: EngineSink, othersCanDecide: boolean): Promise<PermissionAnswer> {
    const chatId = active.chat.id;
    const rule = permissionKey(request.toolName, request.input);
    const unattended = Boolean(active.turn.automation);
    // A read-only automation stays read-only whatever was always allowed in the chat.
    if ((this.deps.settings.data.alwaysAllow[chatId] ?? []).includes(rule) && !(unattended && active.turn.config.permissionMode === 'plan')) return { allow: true };
    const key = `perm.${request.key}`;
    const itemId = `${active.turn.id}.${key}`;
    const data: PermissionItemData = {
      toolName: request.toolName,
      title: request.title,
      description: request.description,
      input: request.input,
      status: 'pending',
      othersCanDecide,
      allowAlways: request.allowAlways,
    };
    if (unattended) {
      sink.item(key, { kind: 'permission', data: { ...data, status: 'expired' } });
      return { allow: false, message: UNATTENDED_DENIAL };
    }
    sink.item(key, { kind: 'permission', data });
    this.deps.notify(tr('CooPrompt needs your permission'), request.title ?? tr('The agent wants to use {tool}', { tool: request.toolName }));
    const answer = await new Promise<{ decision: Decision | null; by: string | null }>((resolve) => {
      active.pending.set(itemId, { kind: 'permission', othersCanDecide, resolve: (decision, by) => resolve({ decision, by }) });
    });
    active.pending.delete(itemId);
    const decision = answer.decision?.type === 'permission' ? answer.decision : null;
    sink.item(key, { kind: 'permission', data: { ...data, status: decision ? (decision.allow ? 'allowed' : 'denied') : 'expired', decidedBy: answer.by } });
    if (decision?.allow && decision.always && request.allowAlways) {
      this.deps.settings.update((settings) => {
        settings.alwaysAllow[chatId] = [...new Set([...(settings.alwaysAllow[chatId] ?? []), rule])];
      });
    }
    return decision ? { allow: decision.allow, message: decision.message } : { allow: false, message: 'Turn cancelled' };
  }

  private async askQuestion(active: ActiveTurn, requestKey: string, questions: QuestionItemData['questions'], sink: EngineSink): Promise<Record<string, string> | null> {
    const key = `question.${requestKey}`;
    const itemId = `${active.turn.id}.${key}`;
    const data: QuestionItemData = { questions, status: 'pending' };
    if (active.turn.automation) {
      sink.item(key, { kind: 'question', data: { ...data, status: 'expired' } });
      return null;
    }
    sink.item(key, { kind: 'question', data });
    this.deps.notify(tr('The agent has a question'), questions[0]?.question ?? '');
    const answer = await new Promise<{ decision: Decision | null; by: string | null }>((resolve) => {
      active.pending.set(itemId, { kind: 'question', othersCanDecide: true, resolve: (decision, by) => resolve({ decision, by }) });
    });
    active.pending.delete(itemId);
    const answers = answer.decision?.type === 'question' ? answer.decision.answers : null;
    sink.item(key, { kind: 'question', data: { ...data, status: answers ? 'answered' : 'expired', answers: answers ?? undefined, answeredBy: answer.by } });
    return answers;
  }
}
