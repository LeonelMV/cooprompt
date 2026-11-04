import { DatabaseSync, type StatementSync } from 'node:sqlite';

const SCHEMA = `
create table if not exists users (
  id text primary key,
  email text not null unique,
  name text not null,
  avatar_url text,
  org_domain text,
  password_hash text,
  google_sub text unique,
  created_at integer not null
);
create table if not exists sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at integer not null,
  last_seen_at integer not null
);
create table if not exists chats (
  id text primary key,
  title text not null,
  kind text not null,
  owner_id text not null references users(id),
  org_domain text,
  created_at integer not null,
  updated_at integer not null,
  last_activity_at integer not null,
  next_seq integer not null default 1,
  next_rev integer not null default 1,
  ws_seq integer not null default 0,
  deleted_at integer
);
create table if not exists chat_members (
  chat_id text not null references chats(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null,
  joined_at integer not null,
  primary key (chat_id, user_id)
);
create table if not exists invitations (
  id text primary key,
  chat_id text not null references chats(id) on delete cascade,
  inviter_id text not null references users(id),
  invitee_email text not null,
  invitee_id text references users(id),
  status text not null,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists invitations_by_email on invitations(invitee_email, status);
create table if not exists items (
  id text primary key,
  chat_id text not null references chats(id) on delete cascade,
  seq integer not null,
  rev integer not null,
  turn_id text,
  kind text not null,
  author_id text,
  data text not null,
  created_at integer not null,
  updated_at integer not null
);
create unique index if not exists items_by_seq on items(chat_id, seq);
create index if not exists items_by_rev on items(chat_id, rev);
create table if not exists turns (
  id text primary key,
  chat_id text not null references chats(id) on delete cascade,
  requester_id text not null references users(id),
  device_id text not null,
  device_name text not null,
  config text not null,
  provider_label text,
  status text not null,
  error text,
  usage text,
  created_at integer not null,
  started_at integer,
  finished_at integer
);
create index if not exists turns_by_status on turns(chat_id, status, created_at);
create table if not exists ws_files (
  chat_id text not null references chats(id) on delete cascade,
  path text not null,
  hash text,
  size integer not null,
  exec integer not null default 0,
  seq integer not null,
  updated_by text,
  updated_at integer not null,
  primary key (chat_id, path)
);
create index if not exists ws_files_by_seq on ws_files(chat_id, seq);
create index if not exists ws_files_by_hash on ws_files(chat_id, hash);
create table if not exists attachments (
  id text primary key,
  chat_id text not null references chats(id) on delete cascade,
  hash text not null,
  name text not null,
  mime text not null,
  kind text not null,
  size integer not null,
  created_by text not null,
  created_at integer not null,
  linked_at integer
);
create index if not exists attachments_by_chat on attachments(chat_id);
create index if not exists attachments_by_hash on attachments(hash);
create table if not exists automations (
  id text primary key,
  owner_id text not null references users(id) on delete cascade,
  chat_id text not null references chats(id) on delete cascade,
  device_id text not null,
  device_name text not null,
  name text not null,
  instructions text not null,
  schedule text not null,
  time_zone text not null,
  config text not null,
  provider_label text,
  fresh integer not null default 0,
  time_limit_minutes integer not null,
  enabled integer not null default 1,
  paused_reason text,
  next_run_at integer,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists automations_due on automations(enabled, next_run_at);
create index if not exists automations_by_owner on automations(owner_id);
create index if not exists automations_by_chat on automations(chat_id);
create table if not exists automation_runs (
  id text primary key,
  automation_id text not null references automations(id) on delete cascade,
  chat_id text not null,
  device_id text not null,
  turn_id text,
  trigger text not null,
  status text not null,
  scheduled_for integer,
  started_at integer,
  finished_at integer,
  error text,
  read_at integer,
  created_at integer not null
);
create index if not exists automation_runs_by_automation on automation_runs(automation_id, created_at);
create index if not exists automation_runs_by_status on automation_runs(status);
`;

export class Database {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
    const turnColumns = new Set((this.raw.prepare('pragma table_info(turns)').all() as { name: string }[]).map((column) => column.name));
    if (!turnColumns.has('priority')) this.raw.exec('alter table turns add column priority integer not null default 0');
    if (!turnColumns.has('parallel')) this.raw.exec('alter table turns add column parallel integer not null default 0');
    if (!turnColumns.has('interrupts')) this.raw.exec('alter table turns add column interrupts text');
    if (!turnColumns.has('automation')) this.raw.exec('alter table turns add column automation text');
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    const result = this.stmt(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  /** Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.raw.exec('begin immediate');
    try {
      const result = fn();
      this.raw.exec('commit');
      return result;
    } catch (error) {
      this.raw.exec('rollback');
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export type SqlParam = string | number | bigint | null | Uint8Array;
