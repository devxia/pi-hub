import Database from 'better-sqlite3';
import type { Attempt, Operation, OperationSummary } from './contract';
import { existsSync, copyFileSync, chmodSync, constants } from 'node:fs';
export class Store {
  private db: Database.Database;
  constructor(path: string) {
    const existed = existsSync(path);
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma('busy_timeout = 3000');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 1) throw Error('Remote database is newer than this application.');
    if (version < 1) {
      if (existed) {
        const result = this.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
        if (result.some((r) => r.busy)) throw Error('Remote migration checkpoint is busy.');
        const backup = path + '.before-v1-' + Date.now();
        copyFileSync(path, backup, constants.COPYFILE_EXCL);
        chmodSync(backup, 0o600);
      }
      this.db.transaction(() => {
        this.db.exec(
          'CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=1;',
        );
      })();
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE INDEX IF NOT EXISTS operation_status ON objects(json_extract(value, '$.status'))
      WHERE kind='operation'`);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM objects WHERE kind=? AND id=?').get(kind, id) as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  all<T>(kind: string): T[] {
    return (
      this.db.prepare('SELECT value FROM objects WHERE kind=? ORDER BY rowid').all(kind) as {
        value: string;
      }[]
    ).map((r) => JSON.parse(r.value));
  }
  operationHistory(offset: number, limit: number, subject?: string, pending = false) {
    const rows = this.db.prepare(`SELECT json_object(
      'requestId', id, 'digest', value->>'$.digest',
      'action', json_object('kind', value->>'$.action.kind'),
      'status', value->>'$.status', 'createdAt', value->>'$.createdAt',
      'expiresAt', value->>'$.expiresAt', 'subject', value->>'$.subject',
      'detail', value->>'$.detail', 'attemptId', coalesce(value->>'$.attemptId', value->>'$.action.attemptId'),
      'transfer', value->'$.transfer') AS summary FROM objects WHERE kind='operation'
      AND (? IS NULL OR value->>'$.subject'=?)
      ${pending ? "AND json_extract(value, '$.status') IN ('preparing','review','approved','running')" : ''}
      ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(subject ?? null, subject ?? null, limit, offset) as
      { summary: string }[];
    return rows.map(({ summary }) => JSON.parse(summary) as OperationSummary);
  }
  attemptHistory(serverId: string | null, offset: number, limit: number) {
    const rows = this.db.prepare(`SELECT json_remove(value, '$.log', '$.logs', '$.logCursors') AS value
      FROM objects WHERE kind='attempt' AND (? IS NULL OR value->>'$.server.id'=?)
      ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(serverId, serverId, limit, offset) as { value: string }[];
    return rows.map(({ value }) => JSON.parse(value) as Attempt);
  }
  observedAttempts(serverId: string, watchedId: string | null) {
    const rows = this.db.prepare(`SELECT value FROM objects WHERE kind='attempt'
      AND value->>'$.server.id'=? AND (id=? OR (
        value->>'$.phase' NOT IN ('succeeded','failed','cancelled')
        AND coalesce(value->>'$.invalidated', 0)=0))
      ORDER BY rowid`).all(serverId, watchedId) as { value: string }[];
    return rows.map(({ value }) => JSON.parse(value) as Attempt);
  }
  taskChoices(offset: number, limit: number) {
    return this.db.prepare(`SELECT id, value->>'$.name' AS name, value->>'$.serverId' AS serverId
      FROM objects WHERE kind='task' ORDER BY rowid LIMIT ? OFFSET ?`).all(limit, offset) as
      { id: string; name: string; serverId: string }[];
  }
  grantedAttempts(serverId: string, taskIds: string[], project: string, limit = 100) {
    const rows = this.db.prepare(`SELECT value FROM objects WHERE kind='attempt'
      AND value->>'$.server.id'=? AND value->>'$.taskId' IN (SELECT value FROM json_each(?))
      AND value->>'$.taskSnapshot.project'=?
      ORDER BY rowid DESC LIMIT ?`).all(serverId, JSON.stringify(taskIds), project, limit) as { value: string }[];
    return rows.map(({ value }) => JSON.parse(value) as Attempt);
  }
  nextPreparation() {
    const row = this.db.prepare(`SELECT value FROM objects WHERE kind='operation'
      AND json_extract(value, '$.status')='preparing' ORDER BY rowid LIMIT 1`).get() as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) as Operation : undefined;
  }
  expiredReviews(now: number, activeId?: string) {
    const rows = this.db.prepare(`SELECT value FROM objects WHERE kind='operation'
      AND json_extract(value, '$.status') IN ('preparing','review')
      AND value->>'$.expiresAt'<=? AND id<>?`).all(now, activeId ?? '') as { value: string }[];
    return rows.map(({ value }) => JSON.parse(value) as Operation);
  }
  pendingCount() {
    const row = this.db.prepare(`SELECT count(*) AS count FROM objects WHERE kind='operation'
      AND json_extract(value, '$.status') IN ('approved','running','unknown')`).get() as { count: number };
    return row.count;
  }
  operationsWhere(statuses: Operation['status'][], attemptId?: string) {
    const ids = this.db.prepare(`SELECT id FROM objects WHERE kind='operation'
      AND json_extract(value, '$.status') IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR coalesce(value->>'$.attemptId', value->>'$.action.attemptId')=?)`).all(
      JSON.stringify(statuses), attemptId ?? null, attemptId ?? null,
    ) as { id: string }[];
    return ids.map(({ id }) => this.get<Operation>('operation', id)!);
  }
  releasedSnapshotCandidates() {
    return this.db.prepare(`SELECT id, value->>'$.review.snapshotId' AS name,
      value->>'$.review.files.directory' AS directory FROM objects WHERE kind='operation'
      AND json_extract(value, '$.status') IN ('done','unknown','denied','blocked','expired')
      AND (name IS NOT NULL OR directory IS NOT NULL)`).all() as
      { id: string; name: string | null; directory: string | null }[];
  }
  put(kind: string, id: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO objects(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value',
      )
      .run(kind, id, JSON.stringify(value));
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  close() {
    this.db.close();
  }
}
