import { randomUUID } from 'node:crypto';
import type {
  AutomationInfo,
  AutomationLimits,
  AutomationRun,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationTrigger,
  PublicUser,
  TurnAutomation,
  TurnConfig,
  TurnInfo,
} from '@cooprompt/protocol';
import { nextRun } from '@cooprompt/protocol';
import type { Hub } from './hub.ts';
import { publicUser, type Store } from './store.ts';

export interface AutomationOptions {
  /** Shortest time between two runs of an automation (15 minutes by default). */
  minIntervalMinutes?: number;
  /** The longest time limit a run may have (4 hours by default). */
  maxRunMinutes?: number;
  /** How often the scheduler looks for due automations and runs past their limit. */
  tickMs?: number;
  /** The scheduler's clock; tests replace it. */
  now?: () => number;
}

/** What an automation is made of once validated (see `automation-routes.ts`). */
export interface AutomationFields {
  name: string;
  instructions: string;
  chatId: string;
  deviceId: string;
  deviceName: string;
  schedule: AutomationSchedule;
  timeZone: string;
  config: TurnConfig;
  providerLabel: string | null;
  fresh: boolean;
  timeLimitMinutes: number;
  enabled: boolean;
}

export interface AutomationRow {
  id: string;
  owner_id: string;
  chat_id: string;
  device_id: string;
  device_name: string;
  name: string;
  instructions: string;
  schedule: string;
  time_zone: string;
  config: string;
  provider_label: string | null;
  fresh: number;
  time_limit_minutes: number;
  enabled: number;
  paused_reason: string | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RunDraft {
  /** A missed run's record, reused when it catches up. */
  id?: string;
  trigger: AutomationTrigger;
  status: AutomationRunStatus;
  scheduledFor: number | null;
  error: string | null;
}

interface RunRow {
  id: string;
  automation_id: string;
  chat_id: string;
  device_id: string;
  turn_id: string | null;
  trigger: AutomationTrigger;
  status: AutomationRunStatus;
  scheduled_for: number | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  read_at: number | null;
  created_at: number;
}

export const DEFAULT_MIN_INTERVAL_MINUTES = 15;
export const DEFAULT_TIME_LIMIT_MINUTES = 20;
const DEFAULT_MAX_RUN_MINUTES = 240;
export const MAX_AUTOMATIONS_PER_OWNER = 50;
const MAX_RUNS_KEPT = 200;
/** A scheduled time found later than this passed while the server wasn't running (or its device slept). */
const LATE_MS = 2 * 60_000;
const ACTIVE = "('queued', 'running')";

/**
 * Whether a missed run still runs when the computer comes back: only while less than half the time to the next
 * scheduled run has passed, so a catch-up never lands right before the next regular run.
 */
export function catchesUp(missedAt: number, nextAt: number | null, now: number): boolean {
  return nextAt === null || now - missedAt < (nextAt - missedAt) / 2;
}

/** Interval runs fall on whole intervals from when the interval was chosen. */
function anchored(schedule: AutomationSchedule, previous: AutomationSchedule | null, now: number): AutomationSchedule {
  if (schedule.kind !== 'interval') return schedule;
  const anchor = previous?.kind === 'interval' && previous.minutes === schedule.minutes && previous.anchor ? previous.anchor : now;
  return { kind: 'interval', minutes: schedule.minutes, anchor };
}

function upcoming(schedule: AutomationSchedule, timeZone: string, after: number): number | null {
  try {
    return nextRun(schedule, timeZone, after);
  } catch {
    return null;
  }
}

/**
 * Stores automations and their runs, and starts them: each run is a turn of the owner, sent to the owner's
 * chosen device through the chat's queue like any message (in multitask mode when that device can), so it uses that
 * device's engines and credentials only. The server is the only scheduler, so missed runs are known even when
 * every app was closed.
 */
export class Automations {
  readonly minIntervalMinutes: number;
  readonly maxRunMinutes: number;
  readonly now: () => number;
  private readonly tickMs: number;
  private timer: NodeJS.Timeout | null = null;
  /** Turns asked to stop for going past their automation's time limit. */
  private readonly stopping = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    options: AutomationOptions = {},
    private readonly log: (message: string) => void = () => {},
  ) {
    this.minIntervalMinutes = options.minIntervalMinutes && options.minIntervalMinutes > 0 ? options.minIntervalMinutes : DEFAULT_MIN_INTERVAL_MINUTES;
    this.maxRunMinutes = Math.max(1, Math.floor(options.maxRunMinutes ?? DEFAULT_MAX_RUN_MINUTES));
    this.tickMs = Math.max(10, options.tickMs ?? 5_000);
    this.now = options.now ?? Date.now;
    hub.automationLimits = this.limits();
    hub.onDeviceReady = (userId, deviceId) => this.catchUp(userId, deviceId);
    hub.onTurn = (turn) => this.syncRun(turn);
  }

  limits(): AutomationLimits {
    return { minIntervalMinutes: this.minIntervalMinutes, maxRunMinutes: this.maxRunMinutes };
  }

  start(): void {
    this.reconcile();
    this.tick();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Data access

  row(id: string): AutomationRow | undefined {
    return this.store.db.get<AutomationRow>('select * from automations where id = ?', id);
  }

  /** The user's own automations and the others' in chats the user is a member of. */
  visibleRows(user: PublicUser): AutomationRow[] {
    return this.store.db.all<AutomationRow>(
      `select * from automations
       where owner_id = ?
          or (chat_id in (select chat_id from chat_members where user_id = ?) and chat_id in (select id from chats where deleted_at is null))
       order by created_at`,
      user.id,
      user.id,
    );
  }

  visibleTo(row: AutomationRow, user: PublicUser): boolean {
    return row.owner_id === user.id || (this.store.getChat(row.chat_id) !== undefined && this.store.isMember(row.chat_id, user.id));
  }

  ownedCount(userId: string): number {
    return this.store.db.get<{ n: number }>('select count(*) as n from automations where owner_id = ?', userId)?.n ?? 0;
  }

  fields(row: AutomationRow): AutomationFields {
    return {
      name: row.name,
      instructions: row.instructions,
      chatId: row.chat_id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      schedule: JSON.parse(row.schedule) as AutomationSchedule,
      timeZone: row.time_zone,
      config: JSON.parse(row.config) as TurnConfig,
      providerLabel: row.provider_label,
      fresh: row.fresh === 1,
      timeLimitMinutes: row.time_limit_minutes,
      enabled: row.enabled === 1,
    };
  }

  info(row: AutomationRow, viewerId: string): AutomationInfo {
    const owner = this.store.getUser(row.owner_id);
    const last = this.store.db.get<RunRow>('select * from automation_runs where automation_id = ? order by created_at desc, rowid desc limit 1', row.id);
    const fields = this.fields(row);
    return {
      id: row.id,
      owner: owner ? publicUser(owner) : { id: row.owner_id, email: '', name: 'Someone', avatarUrl: null, orgDomain: null },
      chatId: fields.chatId,
      deviceId: fields.deviceId,
      deviceName: fields.deviceName,
      name: fields.name,
      instructions: fields.instructions,
      schedule: fields.schedule,
      timeZone: fields.timeZone,
      config: fields.config,
      providerLabel: fields.providerLabel,
      fresh: fields.fresh,
      timeLimitMinutes: fields.timeLimitMinutes,
      enabled: fields.enabled,
      pausedReason: row.paused_reason,
      nextRunAt: row.next_run_at,
      lastRun: last ? this.toRun(last, row, viewerId) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toRun(run: RunRow, automation: AutomationRow, viewerId: string): AutomationRun {
    return {
      id: run.id,
      automationId: run.automation_id,
      automationName: automation.name,
      chatId: run.chat_id,
      deviceId: run.device_id,
      turnId: run.turn_id,
      trigger: run.trigger,
      status: run.status,
      scheduledFor: run.scheduled_for,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      error: run.error,
      read: viewerId !== automation.owner_id || run.read_at !== null,
      createdAt: run.created_at,
    };
  }

  /** Newest first: one automation's (for anyone who sees it) or every run of the user's own automations. */
  runs(user: PublicUser, options: { automation?: AutomationRow; limit: number }): AutomationRun[] {
    const rows = options.automation
      ? this.store.db.all<RunRow>('select * from automation_runs where automation_id = ? order by created_at desc, rowid desc limit ?', options.automation.id, options.limit)
      : this.store.db.all<RunRow>(
          `select automation_runs.* from automation_runs join automations on automations.id = automation_runs.automation_id
           where automations.owner_id = ? order by automation_runs.created_at desc, automation_runs.rowid desc limit ?`,
          user.id,
          options.limit,
        );
    const automations = new Map<string, AutomationRow | undefined>();
    return rows.flatMap((run) => {
      if (!automations.has(run.automation_id)) automations.set(run.automation_id, this.row(run.automation_id));
      const automation = automations.get(run.automation_id);
      return automation ? [this.toRun(run, automation, user.id)] : [];
    });
  }

  private runRow(id: string): RunRow | undefined {
    return this.store.db.get<RunRow>('select * from automation_runs where id = ?', id);
  }

  private activeRun(automationId: string): RunRow | undefined {
    return this.store.db.get<RunRow>(`select * from automation_runs where automation_id = ? and status in ${ACTIVE} limit 1`, automationId);
  }

  // Changes from the owner

  create(owner: PublicUser, fields: AutomationFields): AutomationInfo {
    const now = this.now();
    const id = randomUUID();
    const schedule = anchored(fields.schedule, null, now);
    this.store.db.run(
      `insert into automations (id, owner_id, chat_id, device_id, device_name, name, instructions, schedule, time_zone, config, provider_label,
         fresh, time_limit_minutes, enabled, next_run_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      owner.id,
      fields.chatId,
      fields.deviceId,
      fields.deviceName,
      fields.name,
      fields.instructions,
      JSON.stringify(schedule),
      fields.timeZone,
      JSON.stringify(fields.config),
      fields.providerLabel,
      fields.fresh ? 1 : 0,
      fields.timeLimitMinutes,
      fields.enabled ? 1 : 0,
      fields.enabled ? upcoming(schedule, fields.timeZone, now) : null,
      now,
      now,
    );
    this.publish(id);
    return this.info(this.row(id)!, owner.id);
  }

  update(row: AutomationRow, fields: AutomationFields): AutomationInfo {
    const now = this.now();
    const previousChat = row.chat_id;
    const schedule = anchored(fields.schedule, this.fields(row).schedule, now);
    this.store.db.run(
      `update automations set chat_id = ?, device_id = ?, device_name = ?, name = ?, instructions = ?, schedule = ?, time_zone = ?, config = ?,
         provider_label = ?, fresh = ?, time_limit_minutes = ?, enabled = ?, paused_reason = ?, next_run_at = ?, updated_at = ?
       where id = ?`,
      fields.chatId,
      fields.deviceId,
      fields.deviceName,
      fields.name,
      fields.instructions,
      JSON.stringify(schedule),
      fields.timeZone,
      JSON.stringify(fields.config),
      fields.providerLabel,
      fields.fresh ? 1 : 0,
      fields.timeLimitMinutes,
      fields.enabled ? 1 : 0,
      fields.enabled ? null : row.paused_reason,
      fields.enabled ? upcoming(schedule, fields.timeZone, now) : null,
      now,
      row.id,
    );
    if (previousChat !== fields.chatId) {
      for (const userId of this.store.memberIds(previousChat)) {
        if (userId !== row.owner_id && !this.store.isMember(fields.chatId, userId)) this.hub.sendToUser(userId, { t: 'automation.remove', automationId: row.id });
      }
    }
    this.publish(row.id);
    return this.info(this.row(row.id)!, row.owner_id);
  }

  /** Deleting stops the run in progress. */
  remove(row: AutomationRow, owner: PublicUser): void {
    const audience = this.audience(row);
    const active = this.activeRun(row.id);
    this.store.db.run('delete from automations where id = ?', row.id);
    const turn = active?.turn_id ? this.store.getTurn(active.turn_id) : undefined;
    if (turn) this.hub.cancelTurn(turn, owner);
    for (const userId of audience) this.hub.sendToUser(userId, { t: 'automation.remove', automationId: row.id });
  }

  /** Why "Run now" can't start it, in English, or null. */
  manualRunError(row: AutomationRow): string | null {
    const unavailable = this.unavailable(row);
    if (unavailable) return unavailable;
    if (this.activeRun(row.id)) return 'This automation is already running';
    if (!this.hub.hasFeature(row.owner_id, row.device_id, 'automations')) return this.offline(row, true);
    return null;
  }

  runNow(row: AutomationRow): AutomationRun {
    return this.toRun(this.begin(row, 'manual', null), row, row.owner_id);
  }

  markRead(userId: string, ids: string[] | 'all'): void {
    const now = this.now();
    const unread = this.store.db.all<RunRow>(
      `select automation_runs.* from automation_runs join automations on automations.id = automation_runs.automation_id
       where automations.owner_id = ? and automation_runs.read_at is null ${ids === 'all' ? '' : 'and automation_runs.id in (select value from json_each(?))'}`,
      ...(ids === 'all' ? [userId] : [userId, JSON.stringify(ids)]),
    );
    for (const run of unread) {
      this.store.db.run('update automation_runs set read_at = ? where id = ?', now, run.id);
      const automation = this.row(run.automation_id);
      if (automation) this.hub.sendToUser(userId, { t: 'automation.run', run: this.toRun({ ...run, read_at: now }, automation, userId) });
    }
  }

  // Scheduling

  /** Runs what is due and stops runs past their time limit. */
  tick(): void {
    const now = this.now();
    for (const row of this.store.db.all<AutomationRow>('select * from automations where enabled = 1 and next_run_at is not null and next_run_at <= ?', now)) {
      try {
        this.fire(row, now);
      } catch (error) {
        this.log(`automations: ${row.id} could not run: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.enforceTimeLimits(now);
  }

  private fire(row: AutomationRow, now: number): void {
    const schedule = JSON.parse(row.schedule) as AutomationSchedule;
    let scheduledFor = row.next_run_at!;
    let next = upcoming(schedule, row.time_zone, scheduledFor);
    // Earlier times passed while the server wasn't running: only the latest one counts.
    for (let guard = 0; next !== null && next <= now && guard < 100_000; guard++) {
      scheduledFor = next;
      next = upcoming(schedule, row.time_zone, scheduledFor);
    }
    this.store.db.run('update automations set next_run_at = ? where id = ?', next, row.id);
    const current = { ...row, next_run_at: next };
    if (now - scheduledFor <= LATE_MS) this.begin(current, 'schedule', scheduledFor);
    else if (catchesUp(scheduledFor, next, now)) this.begin(current, 'catch-up', scheduledFor);
    else this.record(current, { trigger: 'schedule', status: 'missed', scheduledFor, error: 'The team server was not running at that time' });
  }

  /** A device connected: its owner's automations that missed their last time there run once, if still worth it. */
  private catchUp(userId: string, deviceId: string): void {
    if (!this.hub.hasFeature(userId, deviceId, 'automations')) return;
    const now = this.now();
    for (const row of this.store.db.all<AutomationRow>('select * from automations where owner_id = ? and device_id = ? and enabled = 1', userId, deviceId)) {
      const last = this.store.db.get<RunRow>('select * from automation_runs where automation_id = ? order by created_at desc, rowid desc limit 1', row.id);
      if (last?.status !== 'missed' || last.scheduled_for === null || !catchesUp(last.scheduled_for, row.next_run_at, now)) continue;
      try {
        this.begin(row, 'catch-up', last.scheduled_for, last.id);
      } catch (error) {
        this.log(`automations: ${row.id} could not catch up: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Starts a run, or records why it can't: the chat is gone or the owner left it (the automation pauses), the
   * previous run hasn't finished (skipped), or the owner's device isn't connected with a CooPrompt that runs
   * automations (missed). `runId` reuses the record of a missed run that now catches up.
   */
  private begin(row: AutomationRow, trigger: AutomationTrigger, scheduledFor: number | null, runId?: string): RunRow {
    const unavailable = this.unavailable(row);
    if (unavailable) {
      this.store.db.run('update automations set enabled = 0, paused_reason = ?, next_run_at = null, updated_at = ? where id = ?', unavailable, this.now(), row.id);
      return this.record(row, { id: runId, trigger, status: 'skipped', scheduledFor, error: unavailable });
    }
    if (this.activeRun(row.id)) return this.record(row, { id: runId, trigger, status: 'skipped', scheduledFor, error: 'The previous run had not finished' });
    if (!this.hub.hasFeature(row.owner_id, row.device_id, 'automations')) return this.record(row, { id: runId, trigger, status: 'missed', scheduledFor, error: this.offline(row, false) });
    const run = this.save(row, { id: runId, trigger, status: 'queued', scheduledFor, error: null });
    this.startTurn(row, run.id);
    return this.announce(row, run.id);
  }

  private unavailable(row: AutomationRow): string | null {
    if (!this.store.getChat(row.chat_id)) return 'Its chat was deleted';
    if (!this.store.isMember(row.chat_id, row.owner_id)) return 'Its owner is no longer in its chat';
    return null;
  }

  private offline(row: AutomationRow, now: boolean): string {
    if (this.hub.isDeviceOnline(row.owner_id, row.device_id)) return `The automation's computer, ${row.device_name}, has a CooPrompt that can't run automations: update it`;
    return now ? `The automation's computer, ${row.device_name}, is not connected` : `The automation's computer, ${row.device_name}, was not connected`;
  }

  private startTurn(row: AutomationRow, runId: string): void {
    const automation: TurnAutomation = { id: row.id, runId, name: row.name, fresh: row.fresh === 1 };
    const { turn, items } = this.store.db.tx(() => {
      const created = this.store.createTurn({
        chatId: row.chat_id,
        requesterId: row.owner_id,
        deviceId: row.device_id,
        deviceName: this.hub.deviceName(row.owner_id, row.device_id) ?? row.device_name,
        config: JSON.parse(row.config) as TurnConfig,
        providerLabel: row.provider_label,
        // As multitask when the computer can: it neither waits behind people's long turns nor makes multitask senders wait.
        parallel: this.hub.runsParallelTurns(row.owner_id, row.device_id),
        automation,
      });
      const prompt = this.store.upsertItem(row.chat_id, { id: `${created.id}.prompt`, kind: 'user', data: { text: row.instructions }, turnId: created.id, authorId: row.owner_id });
      // Apps that predate automations show this line in the turn; newer ones draw a label instead.
      const label = this.store.upsertItem(row.chat_id, { id: `${created.id}.automation`, kind: 'notice', data: { text: `Automation: ${row.name}` }, turnId: created.id, authorId: null });
      this.store.db.run('update automation_runs set turn_id = ? where id = ?', created.id, runId);
      return { turn: created, items: [prompt, label] };
    });
    this.hub.publishItems(row.chat_id, items);
    this.hub.publishTurn(turn);
    this.hub.publishChat(row.chat_id);
    this.hub.scheduleChat(row.chat_id);
  }

  /** Follows the turn of a run: started, finished, failed or cancelled. */
  private syncRun(turn: TurnInfo): void {
    const run = turn.automation ? this.runRow(turn.automation.runId) : undefined;
    if (!run || run.turn_id !== turn.id) return;
    const status: AutomationRunStatus = turn.status === 'cancelled' && run.started_at === null && this.stopping.has(turn.id) ? 'skipped' : turn.status;
    if (status === run.status) return;
    const now = this.now();
    const finished = status !== 'queued' && status !== 'running';
    this.store.db.run(
      'update automation_runs set status = ?, started_at = ?, finished_at = ?, error = ? where id = ?',
      status,
      status === 'running' ? (run.started_at ?? now) : run.started_at,
      finished ? now : null,
      finished ? turn.error : null,
      run.id,
    );
    if (finished) this.stopping.delete(turn.id);
    const row = this.row(run.automation_id);
    if (row) this.announce(row, run.id);
  }

  private enforceTimeLimits(now: number): void {
    const runs = this.store.db.all<RunRow & { time_limit_minutes: number }>(
      `select automation_runs.*, automations.time_limit_minutes from automation_runs join automations on automations.id = automation_runs.automation_id
       where automation_runs.status in ${ACTIVE} and automation_runs.turn_id is not null`,
    );
    for (const run of runs) {
      const minutes = run.time_limit_minutes;
      if (now - (run.started_at ?? run.created_at) < minutes * 60_000 || this.stopping.has(run.turn_id!)) continue;
      const turn = this.store.getTurn(run.turn_id!);
      if (!turn || (turn.status !== 'queued' && turn.status !== 'running')) continue;
      this.stopping.add(turn.id);
      this.hub.stopTurn(
        turn,
        turn.status === 'queued' ? `Skipped: the chat stayed busy for the automation's whole ${minutes}-minute limit` : `Stopped after ${minutes} minutes, the automation's time limit`,
      );
    }
  }

  /** After a restart, runs whose turn ended (or vanished) while the server was down take that outcome. */
  private reconcile(): void {
    for (const run of this.store.db.all<RunRow>(`select * from automation_runs where status in ${ACTIVE}`)) {
      const turn = run.turn_id ? this.store.getTurn(run.turn_id) : undefined;
      if (turn) this.syncRun(turn);
      else this.store.db.run("update automation_runs set status = 'failed', finished_at = ?, error = ? where id = ?", this.now(), 'The team server restarted during the run', run.id);
    }
  }

  // Runs and publishing

  private save(row: AutomationRow, run: RunDraft): RunRow {
    // A time that didn't run keeps its trigger; a missed one that catches up later becomes `catch-up`.
    const trigger = run.status === 'queued' || run.trigger === 'manual' ? run.trigger : 'schedule';
    if (run.id) {
      this.store.db.run('update automation_runs set trigger = ?, status = ?, error = ?, device_id = ? where id = ?', trigger, run.status, run.error, row.device_id, run.id);
      return this.runRow(run.id)!;
    }
    const id = randomUUID();
    this.store.db.run(
      'insert into automation_runs (id, automation_id, chat_id, device_id, trigger, status, scheduled_for, error, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      row.id,
      row.chat_id,
      row.device_id,
      trigger,
      run.status,
      run.scheduledFor,
      run.error,
      this.now(),
    );
    this.store.db.run(
      'delete from automation_runs where automation_id = ? and id not in (select id from automation_runs where automation_id = ? order by created_at desc, rowid desc limit ?)',
      row.id,
      row.id,
      MAX_RUNS_KEPT,
    );
    return this.runRow(id)!;
  }

  /** Saves a run that didn't start and tells the owner. */
  private record(row: AutomationRow, run: RunDraft): RunRow {
    return this.announce(row, this.save(row, run).id);
  }

  /** Tells the owner about the run, and everyone who sees the automation about its new state. */
  private announce(row: AutomationRow, runId: string): RunRow {
    const run = this.runRow(runId)!;
    this.hub.sendToUser(row.owner_id, { t: 'automation.run', run: this.toRun(run, row, row.owner_id) });
    this.publish(row.id);
    return run;
  }

  private audience(row: AutomationRow): string[] {
    return [...new Set([row.owner_id, ...this.store.memberIds(row.chat_id)])];
  }

  publish(id: string): void {
    const row = this.row(id);
    if (!row) return;
    for (const userId of this.audience(row)) this.hub.sendToUser(userId, { t: 'automation.upsert', automation: this.info(row, userId) });
  }
}
