import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AutomationSchedule, EngineId, PermissionModeId, TurnConfig } from '@cooprompt/protocol';
import { AUTOMATION_PERMISSION_MODES, isTimeZone, scheduleError } from '@cooprompt/protocol';
import { DEFAULT_TIME_LIMIT_MINUTES, MAX_AUTOMATIONS_PER_OWNER, type AutomationFields, type AutomationRow, type Automations } from './automations.ts';
import { HttpError } from './errors.ts';
import type { Hub } from './hub.ts';
import { bearer, EFFORT, ENGINES, text } from './routes.ts';
import type { Store, UserRecord } from './store.ts';

type Body = Record<string, unknown>;

const DEVICE_ID = /^[A-Za-z0-9_-]{8,100}$/;

function turnConfig(raw: unknown): TurnConfig {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Body;
  const engine = value.engine as EngineId;
  if (!ENGINES.has(engine)) throw new HttpError(400, 'Invalid engine');
  const permissionMode = value.permissionMode as PermissionModeId;
  if (!(AUTOMATION_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new HttpError(400, 'Automations run unattended: choose read-only, edit files or no restrictions');
  }
  const effort = typeof value.effort === 'string' && EFFORT.test(value.effort) ? value.effort : null;
  return {
    engine,
    profileId: typeof value.profileId === 'string' ? value.profileId.slice(0, 100) : null,
    model: typeof value.model === 'string' && value.model.trim() ? value.model.trim().slice(0, 200) : null,
    permissionMode,
    ...(effort ? { effort } : {}),
  };
}

/** Only the fields each kind has, once `scheduleError` accepted it. */
function cleanSchedule(schedule: AutomationSchedule): AutomationSchedule {
  switch (schedule.kind) {
    case 'interval':
      return { kind: 'interval', minutes: schedule.minutes };
    case 'daily':
      return { kind: 'daily', time: schedule.time };
    case 'weekly':
      return { kind: 'weekly', days: [...schedule.days].sort((a, b) => a - b), time: schedule.time };
    case 'cron':
      return { kind: 'cron', expression: schedule.expression.trim() };
  }
}

/** Automations: anyone sees those of the chats they are in; only the owner changes, runs or deletes them. */
export function registerAutomationRoutes(app: FastifyInstance, ctx: { store: Store; hub: Hub; automations: Automations }): void {
  const { store, hub, automations } = ctx;

  const currentUser = (request: FastifyRequest): UserRecord => {
    const token = bearer(request);
    const user = token ? store.getUserByToken(token) : undefined;
    if (!user) throw new HttpError(401, 'Your session is invalid or expired');
    return user;
  };

  const owned = (request: FastifyRequest, user: UserRecord): AutomationRow => {
    const row = automations.row((request.params as Body).id as string);
    if (!row || !automations.visibleTo(row, user)) throw new HttpError(404, 'Automation not found');
    if (row.owner_id !== user.id) throw new HttpError(403, 'Only its owner can change or run an automation');
    return row;
  };

  /** Validates a new automation, or the fields a change sends over the current ones. */
  const fields = (body: Body, user: UserRecord, current?: AutomationFields): AutomationFields => {
    const given = (key: string) => !current || body[key] !== undefined;
    const name = given('name') ? text(body, 'name', { max: 80 }) : current!.name;
    const instructions = given('instructions') ? text(body, 'instructions', { max: 20_000 }) : current!.instructions;

    let chatId = current?.chatId ?? '';
    if (given('chatId')) {
      chatId = text(body, 'chatId', { max: 100 });
      if (!store.getChat(chatId) || !store.isMember(chatId, user.id)) throw new HttpError(403, 'Automations can only post in chats you are a member of');
    }

    let deviceId = current?.deviceId ?? '';
    let deviceName = current?.deviceName ?? '';
    if (given('deviceId')) {
      const chosen = text(body, 'deviceId', { max: 100 });
      if (!DEVICE_ID.test(chosen)) throw new HttpError(400, 'Invalid device');
      if (chosen !== deviceId) {
        if (!hub.isDeviceOnline(user.id, chosen)) throw new HttpError(409, 'The computer that will run it must be connected');
        deviceName = hub.deviceName(user.id, chosen) ?? 'Device';
      }
      deviceId = chosen;
    }

    const timeZone = given('timeZone') ? body.timeZone : current!.timeZone;
    if (!isTimeZone(timeZone)) throw new HttpError(400, 'Invalid time zone');
    const schedule = given('schedule') ? body.schedule : current!.schedule;
    const problem = scheduleError(schedule, timeZone, automations.minIntervalMinutes, automations.now());
    if (problem) throw new HttpError(400, problem);

    const limit = given('timeLimitMinutes') ? (body.timeLimitMinutes ?? DEFAULT_TIME_LIMIT_MINUTES) : current!.timeLimitMinutes;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > automations.maxRunMinutes) {
      throw new HttpError(400, `The time limit must be between 1 and ${automations.maxRunMinutes} minutes`);
    }

    return {
      name,
      instructions,
      chatId,
      deviceId,
      deviceName,
      schedule: given('schedule') ? cleanSchedule(schedule as AutomationSchedule) : current!.schedule,
      timeZone,
      config: given('config') ? turnConfig(body.config) : current!.config,
      providerLabel: given('providerLabel') ? (typeof body.providerLabel === 'string' ? body.providerLabel.slice(0, 120) : null) : current!.providerLabel,
      fresh: given('fresh') ? body.fresh === true : current!.fresh,
      timeLimitMinutes: limit,
      enabled: given('enabled') ? body.enabled !== false : current!.enabled,
    };
  };

  app.get('/api/automations', async (request) => {
    const user = currentUser(request);
    return automations.visibleRows(user).map((row) => automations.info(row, user.id));
  });

  app.post('/api/automations', async (request) => {
    const user = currentUser(request);
    if (automations.ownedCount(user.id) >= MAX_AUTOMATIONS_PER_OWNER) throw new HttpError(400, `You can have up to ${MAX_AUTOMATIONS_PER_OWNER} automations`);
    return automations.create(user, fields((request.body ?? {}) as Body, user));
  });

  app.patch('/api/automations/:id', async (request) => {
    const user = currentUser(request);
    const row = owned(request, user);
    return automations.update(row, fields((request.body ?? {}) as Body, user, automations.fields(row)));
  });

  app.delete('/api/automations/:id', async (request) => {
    const user = currentUser(request);
    automations.remove(owned(request, user), user);
    return { ok: true };
  });

  app.post('/api/automations/:id/run', async (request) => {
    const user = currentUser(request);
    const row = owned(request, user);
    const problem = automations.manualRunError(row);
    if (problem) throw new HttpError(409, problem);
    return automations.runNow(row);
  });

  app.get('/api/automations/runs', async (request) => {
    const user = currentUser(request);
    const query = request.query as Body;
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
    if (typeof query.automationId !== 'string') return automations.runs(user, { limit });
    const row = automations.row(query.automationId);
    if (!row || !automations.visibleTo(row, user)) throw new HttpError(404, 'Automation not found');
    return automations.runs(user, { automation: row, limit });
  });

  app.post('/api/automations/runs/read', async (request) => {
    const user = currentUser(request);
    const body = (request.body ?? {}) as Body;
    if (body.all === true) automations.markRead(user.id, 'all');
    else if (Array.isArray(body.ids)) automations.markRead(user.id, body.ids.filter((id): id is string => typeof id === 'string').slice(0, 500));
    else throw new HttpError(400, 'Missing field ids');
    return { ok: true };
  });
}
