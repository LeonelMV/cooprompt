import type { PublicUser, TurnConfig } from './index.ts';

/**
 * Automations: saved instructions the team server starts on a schedule as turns of their owner, run on the
 * owner's device. Servers that predate them omit `automations` in `ready`; apps that predate them ignore the
 * `automation.*` messages and show automation turns as the owner's messages.
 */

/** When an automation runs. Times of day are wall-clock times in the automation's `timeZone`. */
export type AutomationSchedule =
  /** Every `minutes`, counted from `anchor` (assigned by the server when the schedule is saved). */
  | { kind: 'interval'; minutes: number; anchor?: number }
  /** `time` is `HH:MM`, 24-hour. */
  | { kind: 'daily'; time: string }
  /** `days`: 0 is Sunday, 6 Saturday. */
  | { kind: 'weekly'; days: number[]; time: string }
  /** Five fields: minute, hour, day of the month, month, day of the week (or a macro such as `@daily`). */
  | { kind: 'cron'; expression: string };

/** What the server allows, announced in `ready`. */
export interface AutomationLimits {
  /** Shortest time between two runs of one automation. */
  minIntervalMinutes: number;
  /** The longest time limit a run may have. */
  maxRunMinutes: number;
}

export type AutomationTrigger = 'schedule' | 'manual' | 'catch-up';
export type AutomationRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'missed' | 'skipped';

/** One run of an automation, or a scheduled time it didn't run (`missed`, `skipped`). */
export interface AutomationRun {
  id: string;
  automationId: string;
  automationName: string;
  chatId: string;
  /** The computer that runs (or would have run) it. */
  deviceId: string;
  /** The turn it posted; null when it didn't run. */
  turnId: string | null;
  trigger: AutomationTrigger;
  status: AutomationRunStatus;
  /** The scheduled time it belongs to; null for runs started by hand. */
  scheduledFor: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** English: why it failed, was missed or was skipped. */
  error: string | null;
  /** The owner has seen it; always true for everyone else. */
  read: boolean;
  createdAt: number;
}

export interface AutomationInfo {
  id: string;
  owner: PublicUser;
  /** Where its runs are posted, as turns of the owner. */
  chatId: string;
  deviceId: string;
  deviceName: string;
  name: string;
  instructions: string;
  schedule: AutomationSchedule;
  /** IANA time zone of the owner when it was saved. */
  timeZone: string;
  /** Non-secret run options, resolved on the owner's device like any turn's. */
  config: TurnConfig;
  providerLabel: string | null;
  /** Each run starts a new agent session instead of continuing the chat's. */
  fresh: boolean;
  /** A run still going after this long is stopped (still waiting in the queue, skipped). */
  timeLimitMinutes: number;
  enabled: boolean;
  /** English: why the server turned it off (its chat is gone, the owner left it). */
  pausedReason: string | null;
  nextRunAt: number | null;
  lastRun: AutomationRun | null;
  createdAt: number;
  updatedAt: number;
}

/** Body of `POST /api/automations`; every field is optional in `PATCH /api/automations/:id`. */
export interface AutomationInput {
  name: string;
  instructions: string;
  /** A chat the owner is a member of. */
  chatId: string;
  /** One of the owner's devices, connected when it is chosen. */
  deviceId: string;
  schedule: AutomationSchedule;
  timeZone: string;
  config: TurnConfig;
  providerLabel?: string | null;
  fresh?: boolean;
  timeLimitMinutes?: number;
  enabled?: boolean;
}

/** The started turn's link to its automation; older servers omit it and older apps ignore it. */
export interface TurnAutomation {
  id: string;
  runId: string;
  /** The automation's name when the run started. */
  name: string;
  fresh: boolean;
}

/** Permission modes for unattended runs: read-only, edit files, no restrictions. */
export const AUTOMATION_PERMISSION_MODES = ['plan', 'acceptEdits', 'bypassPermissions'] as const;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Far enough for any date a cron expression can name (February 29 included). */
const MAX_SEARCH_DAYS = 366 * 8;

interface CronSpec {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Both day fields are restricted: a day matches either, as cron does. */
  eitherDay: boolean;
}

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of the month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, offset: 1 },
  { name: 'day of the week', min: 0, max: 7, names: DAY_NAMES, offset: 0 },
] as const;

function cronField(text: string, field: (typeof FIELDS)[number]): number[] {
  const invalid = () => new Error(`Invalid ${field.name} in the custom schedule: ${text}`);
  const value = (raw: string) => {
    const name = 'names' in field ? field.names.indexOf(raw.toLowerCase() as never) : -1;
    if (name >= 0) return name + ('offset' in field ? field.offset : 0);
    if (!/^\d+$/.test(raw)) throw invalid();
    const number = Number(raw);
    if (number < field.min || number > field.max) throw invalid();
    return number;
  };
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined || !range) throw invalid();
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : 0;
    if (step < 1) throw invalid();
    let low: number;
    let high: number;
    if (range === '*') {
      low = field.min;
      high = field.max;
    } else {
      const [from, to, more] = range.split('-');
      if (more !== undefined) throw invalid();
      low = value(from);
      high = to !== undefined ? value(to) : stepText !== undefined ? field.max : low;
    }
    if (low > high) throw invalid();
    for (let current = low; current <= high; current += step) values.add(current);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses a five-field cron expression; errors are English messages for people. */
export function parseCron(expression: string): CronSpec {
  const source = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = source.split(/\s+/);
  if (parts.length !== 5) throw new Error('The custom schedule needs five fields: minute, hour, day of the month, month and day of the week');
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => cronField(part, FIELDS[index]));
  return {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((day) => day % 7)),
    eitherDay: !parts[2].startsWith('*') && !parts[4].startsWith('*'),
  };
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function timeOfDay(time: string): { hour: number; minute: number } {
  const match = TIME.exec(time);
  if (!match) throw new Error('Choose a time of day as HH:MM');
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const ALL_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
const ALL_MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);

function cronSpec(schedule: Exclude<AutomationSchedule, { kind: 'interval' }>): CronSpec {
  if (schedule.kind === 'cron') return parseCron(schedule.expression);
  const { hour, minute } = timeOfDay(schedule.time);
  const weekdays = schedule.kind === 'weekly' ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  return { minutes: [minute], hours: [hour], days: new Set(ALL_DAYS), months: new Set(ALL_MONTHS), weekdays: new Set(weekdays), eitherDay: false };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, format);
  }
  return format;
}

export function isTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 100) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `timeZone` at `instant`. */
export function wallClock(instant: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`. */
function offsetAt(instant: number, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in `timeZone`: the first one when clocks went back and it happens
 * twice, and right after the jump when clocks went forward over it. The offsets a day before and after are
 * the two a clock change on that day can involve.
 */
function instantOf(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = wall - offsetAt(wall - DAY, timeZone);
  const after = wall - offsetAt(wall + DAY, timeZone);
  const shows = (instant: number) => {
    const clock = wallClock(instant, timeZone);
    return clock.day === day && clock.hour === hour && clock.minute === minute;
  };
  const matches = [before, after].filter(shows);
  return matches.length > 0 ? Math.min(...matches) : Math.max(before, after);
}

function nextCron(spec: CronSpec, timeZone: string, after: number): number | null {
  const start = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  const local = wallClock(start, timeZone);
  for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset++) {
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    const day = date.getUTCDate();
    const month = date.getUTCMonth() + 1;
    if (!spec.months.has(month)) continue;
    const dayMatches = spec.eitherDay ? spec.days.has(day) || spec.weekdays.has(date.getUTCDay()) : spec.days.has(day) && spec.weekdays.has(date.getUTCDay());
    if (!dayMatches) continue;
    for (const hour of spec.hours) {
      // An hour of margin for days when the clocks change.
      if (offset === 0 && hour < local.hour - 1) continue;
      for (const minute of spec.minutes) {
        const instant = instantOf(date.getUTCFullYear(), month, day, hour, minute, timeZone);
        if (instant >= start) return instant;
      }
    }
  }
  return null;
}

/** The first time after `after` the schedule runs, or null when it never does. Throws on an invalid schedule. */
export function nextRun(schedule: AutomationSchedule, timeZone: string, after: number): number | null {
  if (schedule.kind === 'interval') {
    const step = schedule.minutes * MINUTE;
    const anchor = schedule.anchor ?? after;
    if (after < anchor) return anchor;
    return anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  return nextCron(cronSpec(schedule), timeZone, after);
}

export function upcomingRuns(schedule: AutomationSchedule, timeZone: string, after: number, count: number): number[] {
  const runs: number[] = [];
  let from = after;
  while (runs.length < count) {
    const next = nextRun(schedule, timeZone, from);
    if (next === null) break;
    runs.push(next);
    from = next;
  }
  return runs;
}

/** What is wrong with a schedule, in English, or null when it can be saved. */
export function scheduleError(schedule: unknown, timeZone: string, minIntervalMinutes: number, now: number): string | null {
  if (!schedule || typeof schedule !== 'object') return 'Choose when the automation runs';
  const value = schedule as Record<string, unknown>;
  const minimum = Math.max(1, Math.ceil(minIntervalMinutes));
  try {
    switch (value.kind) {
      case 'interval': {
        const minutes = value.minutes;
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes > 31 * 24 * 60) return 'Choose how often it runs';
        if (minutes < minimum) return `Runs must be at least ${minimum} minutes apart`;
        return null;
      }
      case 'daily':
        if (typeof value.time !== 'string') return 'Choose a time of day as HH:MM';
        timeOfDay(value.time);
        return null;
      case 'weekly': {
        if (typeof value.time !== 'string') return 'Choose a time of day as HH:MM';
        timeOfDay(value.time);
        const days = value.days;
        if (!Array.isArray(days) || days.length === 0 || days.length > 7 || !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) || new Set(days).size !== days.length) {
          return 'Choose the days of the week it runs';
        }
        return null;
      }
      case 'cron': {
        if (typeof value.expression !== 'string' || value.expression.length > 200) return 'The custom schedule needs five fields: minute, hour, day of the month, month and day of the week';
        const runs = upcomingRuns(schedule as AutomationSchedule, timeZone, now, 48);
        if (runs.length === 0) return 'This schedule never runs';
        for (let index = 1; index < runs.length; index++) {
          if (runs[index] - runs[index - 1] < minimum * MINUTE) return `Runs must be at least ${minimum} minutes apart`;
        }
        return null;
      }
      default:
        return 'Choose when the automation runs';
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
