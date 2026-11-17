import type Database from 'better-sqlite3';
import { readIdentity } from './history-reader';
import type { runtimeHosts } from './runtime-hosts';
import {
  completed,
  failed,
  type CloneRequest,
  type CloneOutcome,
  type Result,
  type WorkspaceSnapshot,
} from './interface';

interface Operation {
  request: CloneRequest;
  hostId: string;
  sourceId: string;
  outcome: CloneOutcome;
}
/** The native active runtime's /clone operation intentionally switches that runtime. */
export function nativeClones(
  db: Database.Database,
  snapshot: () => Promise<Result<WorkspaceSnapshot>>,
  reconcile: () => Promise<unknown>,
  hosts?: Awaited<ReturnType<typeof runtimeHosts>>,
) {
  const read = (id: string) => {
    const r = db.prepare('SELECT data FROM native_clone_requests WHERE id=?').get(id) as
      { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Operation) : undefined;
  };
  const save = (o: Operation) =>
    db
      .prepare('UPDATE native_clone_requests SET data=? WHERE id=?')
      .run(JSON.stringify(o), o.request.requestId);
  async function finish(o: Operation, value: any) {
    if (value?.cancelled === true) {
      o.outcome = { ...o.outcome, state: 'rejected', error: 'Pi取消了本次/clone，原记录保持。' };
      save(o);
      return o.outcome;
    }
    if (!value?.file || value.sessionId === o.sourceId) {
      o.outcome = { ...o.outcome, state: 'uncertain', error: 'Pi副本结果尚未确认。' };
      save(o);
      return o.outcome;
    }
    o.outcome = {
      requestId: o.request.requestId,
      state: 'completed',
      targetId: value.sessionId,
      targetPath: value.file,
    };
    save(o);
    await reconcile();
    try {
      const identity = await readIdentity(value.file, AbortSignal.timeout(3000));
      o.outcome.key = identity.key;
      save(o);
    } catch {}
    return o.outcome;
  }
  async function outcome(o: Operation) {
    if (o.outcome.state === 'rejected') return o.outcome;
    if (o.outcome.state === 'completed') {
      if (!o.outcome.key) {
        await reconcile();
        try {
          o.outcome.key = (await readIdentity(o.outcome.targetPath, AbortSignal.timeout(3000))).key;
          save(o);
        } catch {}
      }
      return o.outcome;
    }
    const r = await hosts?.queryCommand(o.hostId, o.request.requestId);
    return r?.status === 'completed' && r.value ? finish(o, r.value) : o.outcome;
  }
  const error = (e: unknown) =>
    failed(
      String((e as { code?: string }).code ?? '').startsWith('SQLITE_')
        ? 'DATABASE_UNAVAILABLE'
        : 'RECORD_CHANGED',
      '原生复制结果未能保存，请核对同一请求。',
      String(e),
    );
  return {
    async prepareClone(request: { key: string }) {
      const r = await snapshot();
      if (r.status === 'failed') return r;
      const s = r.value.sessions.find((s) => s.key === request?.key);
      if (!s || s.availability.state !== 'available')
        return failed('RECORD_CHANGED', '源记录不可用。');
      if (!hosts?.hasConnected(s.sourcePath))
        return failed('IMPORT_UNAVAILABLE', '从Hub打开该记录后，可执行原生/clone。');
      return completed({ key: s.key, identity: s.identity, defaultName: s.title });
    },
    async cloneSession(request: CloneRequest): Promise<Result<CloneOutcome>> {
      if (
        !request ||
        typeof request.requestId !== 'string' ||
        !request.requestId ||
        request.requestId.length > 128 ||
        typeof request.key !== 'string' ||
        Object.keys(request).some((k) => !['requestId', 'key'].includes(k))
      )
        return failed('INVALID_REQUEST', '无效原生复制请求。');
      try {
        const old = read(request.requestId);
        if (old)
          return old.request.key === request.key
            ? completed(await outcome(old))
            : failed('RECORD_CHANGED', '请求ID已用于另一复制。');
        const r = await snapshot();
        if (r.status === 'failed') return r;
        const source = r.value.sessions.find((s) => s.key === request.key),
          hostId = source ? hosts?.hostFor(source.sourcePath) : undefined;
        if (!source || !hosts || !hostId)
          return failed('IMPORT_UNAVAILABLE', '没有可执行/clone的Hub宿主。');
        const o: Operation = {
          request,
          hostId,
          sourceId: source.headerId,
          outcome: { requestId: request.requestId, state: 'pending', targetId: '', targetPath: '' },
        };
        const claimed = db
          .prepare(
            'INSERT INTO native_clone_requests(id,data) VALUES(?,?) ON CONFLICT(id) DO NOTHING',
          )
          .run(request.requestId, JSON.stringify(o));
        if (!claimed.changes) {
          const existing = read(request.requestId)!;
          return existing.request.key === request.key
            ? completed(await outcome(existing))
            : failed('RECORD_CHANGED', '请求ID已用于另一复制。');
        }
        const result = await hosts.command(source.sourcePath, {
          id: request.requestId,
          type: 'clone',
        });
        if (result.status === 'failed') {
          o.outcome = { ...o.outcome, state: 'uncertain', error: result.error.message };
          save(o);
          return completed(o.outcome);
        }
        return completed(await finish(o, result.value));
      } catch (e) {
        return error(e);
      }
    },
    async getCloneOutcome(request: { requestId: string }) {
      try {
        const o = read(request?.requestId);
        return completed(o ? await outcome(o) : null);
      } catch (e) {
        return error(e);
      }
    },
  };
}
