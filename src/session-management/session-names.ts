import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { inspectSessionSource, normalizeSessionName } from './session-source';
import { activeSourcePath } from './storage';
import { hasSourceReservation } from './operation-reservations';
import type { runtimeHosts } from './runtime-hosts';
import {
  completed,
  failed,
  type RenameRequest,
  type RenameOutcome,
  type RenamePreparation,
  type Result,
  type WorkspaceSnapshot,
} from './interface';

interface Operation {
  request: RenameRequest;
  outcome: RenameOutcome;
  path: string;
  sourceLength: number;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function sessionNames(
  db: Database.Database,
  snapshot: () => Promise<Result<WorkspaceSnapshot>>,
  reconcile: (file: string) => Promise<unknown>,
  databaseFailure: (e: unknown) => Result<never>,
  hosts?: Awaited<ReturnType<typeof runtimeHosts>>,
  changed: () => void = () => {},
) {
  const all = () =>
    (db.prepare('SELECT data FROM rename_requests').all() as { data: string }[]).map(
      (r) => JSON.parse(r.data) as Operation,
    );
  const read = (id: string) => {
    const r = db.prepare('SELECT data FROM rename_requests WHERE id=?').get(id) as
      { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Operation) : undefined;
  };
  const save = (o: Operation) => {
    db.prepare('UPDATE rename_requests SET data=? WHERE id=?').run(
      JSON.stringify(o),
      o.request.requestId,
    );
    changed();
  };
  const same = (a: RenameRequest, b: RenameRequest) =>
    ['requestId', 'key', 'identity', 'expectedRevision', 'name'].every(
      (k) => a[k as keyof RenameRequest] === b[k as keyof RenameRequest],
    );
  async function source(key: string) {
    const r = await snapshot();
    if (r.status === 'failed') throw Error(r.error.message);
    const s = r.value.sessions.find((s) => s.key === key);
    if (!s || s.availability.state !== 'available' || s.identityConflict)
      throw Error('原记录不可用或身份不唯一。');
    return { ...s, sourcePath: activeSourcePath(db, s) };
  }
  async function outcome(o: Operation) {
    if (!['uncertain', 'pending'].includes(o.outcome.state)) return o.outcome;
    try {
      await reconcile(o.path);
      const s = inspectSessionSource(o.path, o.request.identity);
      if (
        !Number.isSafeInteger(o.sourceLength) ||
        hash(s.bytes.slice(0, o.sourceLength)) !== o.request.expectedRevision
      )
        return o.outcome;
      const suffix = s.bytes.slice(o.sourceLength).trim(),
        appended = suffix ? suffix.split('\n').map((l) => JSON.parse(l)) : [];
      const own = appended.findIndex(
        (e) =>
          e.type === 'session_info' &&
          normalizeSessionName(e.name ?? '') === normalizeSessionName(o.request.name),
      );
      if (own < 0) return o.outcome;
      const later = appended.slice(own + 1).some((e) => e.type === 'session_info');
      o.outcome = {
        requestId: o.request.requestId,
        state: later ? 'superseded' : 'completed',
        canonicalName: s.name,
        revision: hash(s.bytes),
      };
      save(o);
    } catch (e) {
      if (String((e as { code?: string }).code ?? '').startsWith('SQLITE_')) throw e;
    }
    return o.outcome;
  }
  return {
    async prepareRename(request: { key: string }): Promise<Result<RenamePreparation>> {
      try {
        const previous = all().find(
          (o) =>
            o.request.key === request?.key && ['pending', 'uncertain'].includes(o.outcome.state),
        );
        if (previous)
          return completed({
            key: previous.request.key,
            identity: previous.request.identity,
            expectedRevision: previous.request.expectedRevision,
            name: previous.request.name,
            pending: previous.outcome,
            request: previous.request,
          });
        const s = await source(request?.key),
          current = inspectSessionSource(s.sourcePath, s.identity);
        return completed({
          key: s.key,
          identity: s.identity,
          expectedRevision: hash(current.bytes),
          name: current.name,
        });
      } catch (e) {
        return failed('RECORD_CHANGED', String((e as Error).message));
      }
    },
    async renameSession(request: RenameRequest): Promise<Result<RenameOutcome>> {
      if (
        !request ||
        Object.keys(request).some(
          (k) => !['requestId', 'key', 'identity', 'expectedRevision', 'name'].includes(k),
        ) ||
        typeof request.requestId !== 'string' ||
        !request.requestId ||
        request.requestId.length > 128 ||
        typeof request.key !== 'string' ||
        typeof request.identity !== 'string' ||
        typeof request.expectedRevision !== 'string' ||
        typeof request.name !== 'string' ||
        request.name.includes('\0')
      )
        return failed('INVALID_REQUEST', '无效名称请求。');
      try {
        const previous = read(request.requestId);
        if (previous)
          return same(previous.request, request)
            ? completed(await outcome(previous))
            : failed('RECORD_CHANGED', '请求ID已用于另一改名。');
        const s = await source(request.key);
        if (s.identity !== request.identity) throw Error('原记录身份已变化。');
        const before = inspectSessionSource(s.sourcePath, s.identity);
        if (hash(before.bytes) !== request.expectedRevision)
          throw Error('原记录修订已变化，请重读名称。');
        const raced = read(request.requestId);
        if (raced)
          return same(raced.request, request)
            ? completed(await outcome(raced))
            : failed('RECORD_CHANGED', '请求ID已用于另一改名。');
        if (hasSourceReservation(db, s.identity))
          throw Error('此管理器还有未完成的源操作，请先核对原请求。');
        const o: Operation = {
          request,
          path: s.sourcePath,
          sourceLength: before.bytes.length,
          outcome: { requestId: request.requestId, state: 'pending' },
        };
        const inserted = db
          .prepare('INSERT INTO rename_requests(id,data) VALUES(?,?) ON CONFLICT(id) DO NOTHING')
          .run(request.requestId, JSON.stringify(o));
        if (!inserted.changes) {
          const existing = read(request.requestId)!;
          return same(existing.request, request)
            ? completed(await outcome(existing))
            : failed('RECORD_CHANGED', '请求ID已用于另一改名。');
        }
        changed();
        try {
          if (hosts?.hasConnected(s.sourcePath)) {
            const r = await hosts.command(s.sourcePath, {
              id: request.requestId,
              type: 'rename',
              name: request.name,
              expectedRevision: request.expectedRevision,
            });
            if (r.status === 'failed') throw Error(r.error.message);
          } else {
            const { SessionManager } = await import('@earendil-works/pi-coding-agent');
            const final = inspectSessionSource(s.sourcePath, s.identity);
            if (hash(final.bytes) !== request.expectedRevision)
              throw Error('原记录在写入前已变化。');
            SessionManager.open(s.sourcePath).appendSessionInfo(request.name);
          }
          await reconcile(s.sourcePath);
          const current = inspectSessionSource(s.sourcePath, s.identity);
          o.outcome = {
            requestId: request.requestId,
            state:
              normalizeSessionName(current.name) === normalizeSessionName(request.name)
                ? 'completed'
                : 'superseded',
            canonicalName: current.name,
            revision: hash(current.bytes),
          };
          save(o);
          return completed(o.outcome);
        } catch (e) {
          if (String((e as { code?: string }).code ?? '').startsWith('SQLITE_')) throw e;
          o.outcome = {
            requestId: request.requestId,
            state: 'uncertain',
            error: String((e as Error).message),
          };
          save(o);
          return completed(o.outcome);
        }
      } catch (e) {
        return String((e as { code?: string }).code ?? '').startsWith('SQLITE_')
          ? databaseFailure(e)
          : failed('RECORD_CHANGED', String((e as Error).message));
      }
    },
    async getRenameOutcome(request: { requestId: string }) {
      try {
        const o = read(request?.requestId);
        return completed(o ? await outcome(o) : null);
      } catch (e) {
        return databaseFailure(e);
      }
    },
  };
}
