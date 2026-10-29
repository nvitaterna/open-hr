/**
 * ohr-web's own database (decision 0008): the admin account and sessions.
 * It belongs to the unprivileged ohr user; core never opens it and web
 * never opens core's.
 */

import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

const IN_MEMORY = ':memory:';
const SCHEMA_VERSION = 1;
const ADMIN_ID = 1;

const SCHEMA = `
create table if not exists schema_version (version integer not null);
create table if not exists admin (
  id integer primary key check (id = 1),
  username text not null,
  password_hash text not null,
  created_at text not null
);
create table if not exists sessions (
  token_hash text primary key,
  created_at text not null,
  last_used_at text not null
);
`;

const adminRowSchema = z.object({ username: z.string(), passwordHash: z.string() });
const sessionRowSchema = z.object({ lastUsedAt: z.string() });

export interface Admin {
  readonly username: string;
  readonly passwordHash: string;
}

export class WebStore {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Opens or creates the database at `path`, or in memory for ":memory:". */
  static open(path: string): WebStore {
    const db = new DatabaseSync(path);
    if (path !== IN_MEMORY) {
      db.exec('pragma journal_mode = wal');
    }
    db.exec(SCHEMA);
    if (db.prepare('select version from schema_version').get() === undefined) {
      db.prepare('insert into schema_version (version) values (?)').run(SCHEMA_VERSION);
    }
    return new WebStore(db);
  }

  close(): void {
    this.#db.close();
  }

  admin(): Admin | null {
    const row = this.#db
      .prepare('select username, password_hash as passwordHash from admin where id = ?')
      .get(ADMIN_ID);
    if (row === undefined) {
      return null;
    }
    return adminRowSchema.parse(row);
  }

  /** Creates the one admin account. Returns false if it already exists. */
  createAdmin(admin: Admin, now: string): boolean {
    const result = this.#db
      .prepare(
        'insert or ignore into admin (id, username, password_hash, created_at) values (?, ?, ?, ?)',
      )
      .run(ADMIN_ID, admin.username, admin.passwordHash, now);
    return Number(result.changes) === 1;
  }

  createSession(tokenHash: string, now: string): void {
    this.#db
      .prepare('insert into sessions (token_hash, created_at, last_used_at) values (?, ?, ?)')
      .run(tokenHash, now, now);
  }

  /**
   * Marks the session used and returns true, or deletes it and returns false
   * when it has not been used since `idleCutoff`. Unknown sessions are false.
   */
  useSession(tokenHash: string, now: string, idleCutoff: string): boolean {
    const row = this.#db
      .prepare('select last_used_at as lastUsedAt from sessions where token_hash = ?')
      .get(tokenHash);
    if (row === undefined) {
      return false;
    }
    if (sessionRowSchema.parse(row).lastUsedAt < idleCutoff) {
      this.deleteSession(tokenHash);
      return false;
    }
    this.#db
      .prepare('update sessions set last_used_at = ? where token_hash = ?')
      .run(now, tokenHash);
    return true;
  }

  deleteSession(tokenHash: string): void {
    this.#db.prepare('delete from sessions where token_hash = ?').run(tokenHash);
  }

  /** Deletes every session idle since before `idleCutoff`. */
  deleteIdleSessions(idleCutoff: string): void {
    this.#db.prepare('delete from sessions where last_used_at < ?').run(idleCutoff);
  }
}
