import {
  pinDeleteDirectory,
  verifyDeleteDirectories,
  type PinnedDirectoryFact,
  type DeleteSourceProof,
} from './delete-source-facts';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { inspectSessionSource as inspectRenameSource } from './session-source';
import { activeSourcePath, recordSources, storageLocations } from './storage';
import { hasSourceReservation } from './operation-reservations';
import {
  completed,
  failed,
  type DeleteRequest,
  type DeleteOutcome,
  type DeletePreparation,
  type Result,
  type WorkspaceSnapshot,
  type ManagedSession,
} from './interface';

/** Only the trusted OS adapter receives a path; renderer commands always use source keys. */
export interface DeleteAdapter {
  trash(source: DeleteSourceProof): Promise<void>;
}
interface Operation {
  request: DeleteRequest;
  outcome: DeleteOutcome;
  path: string;
  physical: string;
  headerId: string;
  projectId: string;
  scopeRevision: number;
  directories: PinnedDirectoryFact[];
  phase: 'trash' | 'permanent';
}
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const directory = pinDeleteDirectory;
function verifyDirectories(o: Operation) {
  verifyDeleteDirectories(o.directories);
}
function verifyFile(o: Operation) {
  verifyDirectories(o);
  const info = lstatSync(o.path);
  if (!info.isFile() || info.nlink !== 1)
    throw Error('源不是独立的原始记录文件；不能删除符号链接或多个硬链接。');
  accessSync(o.path, constants.R_OK);
  accessSync(dirname(o.path), constants.W_OK | constants.X_OK);
  const inspected = inspectRenameSource(o.path, o.request.identity);
  if (
    inspected.physicalIdentity !== o.physical ||
    hash(inspected.bytes) !== o.request.expectedRevision
  )
    throw Error('源物理身份或修订已变化，未删除替换记录。');
  return inspected;
}
function observation(o: Operation): 'same' | 'absent' {
  verifyDirectories(o);
  try {
    lstatSync(o.path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      verifyDirectories(o);
      return 'absent';
    }
    throw e;
  }
  verifyFile(o);
  return 'same';
}
export function sessionDeletes(
  db: Database.Database,
  snapshot: () => Promise<Result<WorkspaceSnapshot>>,
  databaseFailure: (e: unknown) => Result<never>,
  publish: <T>(mutation: () => T) => T,
  changed: () => void,
  adapter?: DeleteAdapter,
) {
  const inFlight = new Set<string>();
  const all = () =>
    (db.prepare('SELECT data FROM delete_requests').all() as { data: string }[]).map(
      (r) => JSON.parse(r.data) as Operation,
    );
  const row = (id: string) => all().find((o) => o.request.requestId === id);
  const save = (o: Operation) => {
    db.prepare('UPDATE delete_requests SET data=? WHERE id=?').run(
      JSON.stringify(o),
      o.request.requestId,
    );
    changed();
  };
  const same = (a: DeleteRequest, b: DeleteRequest) =>
    a.key === b.key &&
    a.identity === b.identity &&
    a.expectedRevision === b.expectedRevision &&
    a.confirmed === b.confirmed;
  async function source(key: string, own = false) {
    const result = await snapshot();
    if (result.status === 'failed') throw Error(result.error.message);
    const s = result.value.sessions.find((s) => s.key === key);
    if (s?.identityConflict || s?.uniqueIdentity?.allowed === false)
      throw Error(s.uniqueIdentity?.reason ?? '会话 ID 冲突，不能删除原始记录。');
    if (
      !s ||
      s.availability.state !== 'available' ||
      (!s.runtimeCapabilities.delete.allowed &&
        !(own && s.runtimeCapabilities.delete.code === 'DELETE_PENDING'))
    )
      throw Error(s?.runtimeCapabilities.delete.reason ?? '源记录不可用。');
    if (hasSourceReservation(db, s.identity, own ? 'delete' : undefined))
      throw Error('已有源操作尚待核对，请读取原请求。');
    return { session: s, workspace: result.value };
  }
  function facts(
    s: ManagedSession,
    workspace: WorkspaceSnapshot,
    request: DeleteRequest,
  ): Operation {
    const original = activeSourcePath(db, s),
      path = realpathSync(original),
      inspected = inspectRenameSource(path, s.identity);
    // Resolve a symlink to its verified original once, then pin both the original parent and canonical parent.
    const locations = storageLocations(db),
      sources = recordSources(s).filter(
        (x) => x.sourcePath === original && locations.some((l) => l.id === x.locationId),
      );
    if (!sources.length) throw Error('原始记录不在已注册存储位置。');
    const roots = sources.map((x) => {
      const fact = directory(locations.find((l) => l.id === x.locationId)!.path);
      if (!x.rootIdentity || fact.physical !== x.rootIdentity) throw Error('存储根身份已变化。');
      return fact;
    });
    const project = workspace.projects.find((p) => p.id === s.projectId);
    if (!project || project.availability.state !== 'available') throw Error('项目目录不可用。');
    const o: Operation = {
      request,
      outcome: { requestId: request.requestId, state: 'pending' },
      path,
      physical: inspected.physicalIdentity,
      headerId: s.headerId,
      projectId: s.projectId,
      scopeRevision: (db.prepare('SELECT revision FROM scope_state').get() as { revision: number })
        .revision,
      directories: [
        ...roots,
        directory(dirname(original)),
        directory(dirname(path)),
        directory(project.path),
      ],
      phase: 'trash',
    };
    verifyFile(o);
    return o;
  }
  async function authorize(o: Operation) {
    const { session, workspace } = await source(o.request.key, true);
    if (
      session.identity !== o.request.identity ||
      session.headerId !== o.headerId ||
      session.projectId !== o.projectId ||
      realpathSync(activeSourcePath(db, session)) !== o.path ||
      (db.prepare('SELECT revision FROM scope_state').get() as { revision: number }).revision !==
        o.scopeRevision
    )
      throw Error('确认后的源身份或管理范围已变化。');
    verifyFile(o);
    return workspace.revision;
  }
  function complete(o: Operation, method: DeleteOutcome['method']): DeleteOutcome {
    // File + SQLite are not atomic: the durable intent remains if this transaction fails.
    return publish(() => {
      if (observation(o) !== 'absent') throw Error('原路径仍存在记录，不能报告删除完成。');
      const current = db.prepare('SELECT data FROM sessions WHERE key=?').get(o.request.key) as
        { data: string } | undefined;
      if (current && JSON.parse(current.data).identity === o.request.identity)
        db.prepare('DELETE FROM sessions WHERE key=?').run(o.request.key);
      db.prepare('UPDATE classification_state SET revision=revision+1').run();
      o.outcome = { requestId: o.request.requestId, state: 'completed', method };
      db.prepare('UPDATE delete_requests SET data=? WHERE id=?').run(
        JSON.stringify(o),
        o.request.requestId,
      );
      return o.outcome;
    });
  }
  function finish(o: Operation): DeleteOutcome {
    if (!['pending', 'uncertain'].includes(o.outcome.state) || inFlight.has(o.request.requestId))
      return o.outcome;
    try {
      if (observation(o) === 'absent') return complete(o, 'observed-absent');
      o.outcome = {
        ...o.outcome,
        state: 'uncertain',
        error: '原文件仍在，原删除调用结果未确认。本请求只核对，不会再次删除。',
      };
    } catch (e) {
      if (String((e as { code?: string }).code ?? '').startsWith('SQLITE_')) throw e;
      o.outcome = { ...o.outcome, state: 'uncertain', error: message(e) };
    }
    save(o);
    return o.outcome;
  }
  return {
    async prepareDelete(request: { key: string }): Promise<Result<DeletePreparation>> {
      try {
        const pending = all().find(
          (o) =>
            o.request.key === request?.key && ['pending', 'uncertain'].includes(o.outcome.state),
        );
        if (pending)
          return completed({
            key: pending.request.key,
            identity: pending.request.identity,
            expectedRevision: pending.request.expectedRevision,
            sourcePath: pending.path,
            pending: pending.outcome,
            request: pending.request,
          });
        const { session: s, workspace } = await source(request?.key);
        const inspected = inspectRenameSource(realpathSync(activeSourcePath(db, s)), s.identity);
        const o = facts(s, workspace, {
          requestId: 'preparation',
          key: s.key,
          identity: s.identity,
          expectedRevision: hash(inspected.bytes),
          confirmed: true,
        });
        return completed({
          key: s.key,
          identity: s.identity,
          expectedRevision: o.request.expectedRevision,
          sourcePath: o.path,
        });
      } catch (e) {
        return String((e as { code?: string }).code ?? '').startsWith('SQLITE_')
          ? databaseFailure(e)
          : failed('RECORD_CHANGED', message(e));
      }
    },
    async deleteSession(request: DeleteRequest): Promise<Result<DeleteOutcome>> {
      if (
        !request ||
        Object.keys(request).some(
          (k) => !['requestId', 'key', 'identity', 'expectedRevision', 'confirmed'].includes(k),
        ) ||
        typeof request.requestId !== 'string' ||
        !request.requestId ||
        request.requestId.length > 128 ||
        typeof request.key !== 'string' ||
        typeof request.identity !== 'string' ||
        typeof request.expectedRevision !== 'string' ||
        request.confirmed !== true
      )
        return failed('INVALID_REQUEST', '需要明确确认删除原始 Pi 文件及永久删除回退。');
      try {
        const previous = row(request.requestId);
        if (previous)
          return same(previous.request, request)
            ? completed(finish(previous))
            : failed('INVALID_REQUEST', '请求标识已用于其他删除。');
        const { session, workspace } = await source(request.key);
        if (session.identity !== request.identity) throw Error('源身份已变化。');
        const o = facts(session, workspace, request);
        const raced = row(request.requestId);
        if (raced)
          return same(raced.request, request)
            ? completed(finish(raced))
            : failed('INVALID_REQUEST', '请求标识已用于其他删除。');
        if (hasSourceReservation(db, request.identity))
          throw Error('已有源操作尚待核对，请读取原请求。');
        db.prepare('INSERT INTO delete_requests(id,data) VALUES(?,?)').run(
          request.requestId,
          JSON.stringify(o),
        );
        inFlight.add(request.requestId);
        try {
          changed();
          const publicationRevision = await authorize(o);
          let trashError: unknown;
          try {
            if (!adapter) throw Error('原生废纸篓服务不可用。');
            await adapter.trash({
              operationId: request.requestId,
              key: request.key,
              projectId: o.projectId,
              publicationRevision,
              path: o.path,
              identity: request.identity,
              revision: request.expectedRevision,
              physical: o.physical,
              directories: o.directories,
            });
          } catch (e) {
            trashError = e;
          }
          if (observation(o) === 'absent')
            return completed(complete(o, trashError ? 'observed-absent' : 'trash'));
          if ((trashError as { outcomeUnknown?: boolean })?.outcomeUnknown) {
            o.outcome = {
              ...o.outcome,
              state: 'uncertain',
              error: '废纸篓操作超时或回执未知；请核对同一请求，不会再次删除。',
            };
            save(o);
            return completed(o.outcome);
          }
          if (!trashError) {
            o.outcome = {
              ...o.outcome,
              state: 'uncertain',
              error: '废纸篓已返回，但原文件仍在；请核对原请求。',
            };
            save(o);
            return completed(o.outcome);
          }
          // Re-authorize after the awaited OS boundary. No yield between the final check and unlink.
          await authorize(o);
          o.phase = 'permanent';
          save(o);
          verifyFile(o);
          try {
            unlinkSync(o.path);
          } catch (e) {
            if (observation(o) === 'absent') return completed(complete(o, 'observed-absent'));
            o.outcome = {
              ...o.outcome,
              state: 'rejected',
              error: `移入废纸篓失败：${message(trashError)}；永久删除失败：${message(e)}`,
            };
            save(o);
            return completed(o.outcome);
          }
          return completed(complete(o, 'permanent'));
        } catch (e) {
          if (String((e as { code?: string }).code ?? '').startsWith('SQLITE_')) throw e;
          o.outcome = { ...o.outcome, state: 'uncertain', error: message(e) };
          save(o);
          return completed(o.outcome);
        } finally {
          inFlight.delete(request.requestId);
        }
      } catch (e) {
        return String((e as { code?: string }).code ?? '').startsWith('SQLITE_')
          ? databaseFailure(e)
          : failed('RECORD_CHANGED', message(e));
      }
    },
    async getDeleteOutcome(request: { requestId: string }): Promise<Result<DeleteOutcome | null>> {
      try {
        const o = row(request?.requestId);
        return completed(o ? finish(o) : null);
      } catch (e) {
        return databaseFailure(e);
      }
    },
  };
}
