import {
  storageLocations,
  saveLocation,
  locationIdentities,
  identityResolver,
  recordSources,
  mergeSources,
  storageSessions,
} from './storage';
import { readProjects, owner, covers, reassignSessions, activeSessions } from './project-scope';
import { selectSessions, validSessionQuery } from './session-list';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  completed,
  failed,
  type StorageLocationRequest,
  type RemoveStorageRequest,
  type StorageLocation,
  type ProjectScopeRequest,
  type RemoveProjectRequest,
  type Project,
  type RecordIdentity,
  type ImportBatch,
  type Result,
  type ManagementError,
  type ManagedSession,
  type SessionRecord,
  type ImportRequest,
  type ImportSelectionRequest,
  type SessionListRequest,
} from './interface';
import { readIdentity, readRecord, RecordParseError } from './history-reader';

interface StoredBatch extends ImportBatch {
  storageRoot: string;
  scanLocations?: StorageLocation[];
  identities?: RecordIdentity[];
  discoveryComplete?: boolean;
}
export function imports(
  db: Database.Database,
  configuredSessionsRoot: string,
  databaseFailure: (error: unknown) => Result<never>,
  onCompleted: () => void = () => {},
) {
  const sessionsRoot = resolve(configuredSessionsRoot);
  const jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const failedWrites = new Map<string, StoredBatch>();
  const save = (batch: StoredBatch) => {
    db.prepare('INSERT OR REPLACE INTO import_batches (id, data) VALUES (?, ?)').run(
      batch.id,
      JSON.stringify(batch),
    );
    failedWrites.delete(batch.id);
  };
  const readAll = (): StoredBatch[] =>
    (db.prepare('SELECT data FROM import_batches ORDER BY rowid').all() as { data: string }[]).map(
      (row) => JSON.parse(row.data),
    );
  const get = (id: string): StoredBatch => {
    const memory = failedWrites.get(id);
    if (memory) return memory;
    const row = db.prepare('SELECT data FROM import_batches WHERE id = ?').get(id) as
      { data: string } | undefined;
    if (!row) throw Error('导入批次不存在。');
    return JSON.parse(row.data);
  };
  const revision = () =>
    (db.prepare('SELECT revision FROM scope_state').get() as { revision: number }).revision;
  const publicBatch = ({
    storageRoot: _storageRoot,
    scanLocations: _scanLocations,
    identities: _identities,
    discoveryComplete: _discoveryComplete,
    ...batch
  }: StoredBatch): ImportBatch => structuredClone(batch);
  const validRequest = (request: ImportRequest) =>
    request && typeof request.batchId === 'string' && /^[\w-]{1,128}$/.test(request.batchId);
  function query<T>(read: () => T): Result<T> {
    try {
      return completed(read());
    } catch (error) {
      if (error && typeof error === 'object' && 'managementError' in error)
        return { status: 'failed', error: error.managementError as ManagementError };
      return databaseFailure(error);
    }
  }
  // Interrupted discovery is explicitly cancelled; a finished identity snapshot remains recoverable.
  for (const batch of readAll()) {
    if (batch.state !== 'scanning' && batch.state !== 'validating') continue;
    if (!batch.discoveryComplete) {
      batch.state = 'cancelled';
    } else {
      batch.state = 'error';
      batch.error = {
        code: 'IMPORT_UNAVAILABLE',
        message: '上次导入中断，选择已保留。请重试或取消。',
      };
    }
    save(batch);
  }
  function launch(batch: StoredBatch, action: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    const promise = action(controller.signal)
      .catch((error) => {
        if (controller.signal.aborted) return;
        batch.state = 'error';
        const databaseError = String((error as { code?: string })?.code ?? '').startsWith('SQLITE_')
          ? databaseFailure(error)
          : null;
        batch.error =
          error && typeof error === 'object' && 'managementError' in error
            ? (error.managementError as ManagementError)
            : databaseError?.status === 'failed'
              ? databaseError.error
              : {
                  code: 'IMPORT_UNAVAILABLE',
                  message:
                    (error as NodeJS.ErrnoException)?.code === 'ENOTDIR'
                      ? '会话存储位置不是文件夹，请检查该位置后重试。'
                      : ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code ?? '')
                        ? '没有权限读取会话存储位置，请恢复访问权限后重试。'
                        : '读取未完成，请检查会话存储位置后重试。',
                  detail: String(error),
                };
        try {
          save(batch);
        } catch (writeError) {
          const failure = databaseFailure(writeError);
          if (failure.status === 'failed') batch.error = failure.error;
          failedWrites.set(batch.id, batch);
        }
      })
      .finally(() => jobs.delete(batch.id));
    jobs.set(batch.id, { controller, promise });
  }
  function reject(
    code: ManagementError['code'],
    message: string,
    existingProjectId?: string,
  ): never {
    throw { managementError: { code, message, existingProjectId } };
  }
  const known = (key: string) => !!db.prepare('SELECT key FROM sessions WHERE key=?').get(key);
  const eligibleHistory = (project: Project, activeProjects: Project[], identity: RecordIdentity) =>
    covers(project, identity.cwd) && !owner(activeProjects, identity.cwd) && !known(identity.key);
  const eligible = (batch: StoredBatch, activeProjects: Project[], identity: RecordIdentity) =>
    batch.purpose === 'storage'
      ? !!owner(activeProjects, identity.cwd)
      : eligibleHistory(batch.project, activeProjects, identity);
  const batchProjects = (batch: StoredBatch) =>
    batch.purpose === 'storage' ? (batch.projects ?? []) : [batch.project];
  const batchOwner = (batch: StoredBatch, projects: Project[], cwd: string) =>
    batch.purpose === 'storage'
      ? owner(projects, cwd)
      : covers(batch.project, cwd)
        ? batch.project
        : undefined;
  function addIdentity(identities: RecordIdentity[], identity: RecordIdentity) {
    const previous = identities.find((candidate) => candidate.identity === identity.identity);
    if (previous) previous.sources = mergeSources(previous.sources ?? [], identity.sources ?? []);
    else identities.push(identity);
  }
  const rootsFor = (batch: StoredBatch) => batch.scanLocations ?? storageLocations(db);
  async function* enumerate(batch: StoredBatch, signal: AbortSignal) {
    const failures: { path: string; message: string }[] = [];
    let rootFailure: unknown;
    yield* locationIdentities(db, rootsFor(batch), signal, (path, error) => {
      const issue = { path, message: String(error) };
      batch.issues.push(issue);
      if (rootsFor(batch).some((l) => l.path === path)) {
        failures.push(issue);
        rootFailure = error;
      }
    });
    if (failures.length === rootsFor(batch).length) throw rootFailure;
  }
  async function directory(path: string) {
    if (!(await stat(path)).isDirectory()) throw Error('不是目录');
    await access(path, constants.R_OK | constants.X_OK);
  }
  function stage(project: Project, id: string, purpose: ImportBatch['purpose']): ImportBatch {
    const batch: StoredBatch = {
      storageRoot: sessionsRoot,
      id,
      project,
      purpose,
      scopeRevision: revision(),
      state: 'scanning',
      candidates: [],
      selectedKeys: [],
      progress: { phase: 'discovering', inspected: 0, total: 0, parsed: 0 },
      issues: [],
    };
    save(batch);
    launch(batch, (signal) => scan(batch, signal));
    return publicBatch(batch);
  }
  async function scan(batch: StoredBatch, signal: AbortSignal) {
    const activeProjects = readProjects(db);
    if (batch.storageRoot !== sessionsRoot)
      reject('SCOPE_CHANGED', '会话存储位置已变化。本次未提交，请取消后重新选择项目。');
    if (!batch.discoveryComplete) {
      batch.identities = [];
      for await (const identity of enumerate(batch, signal)) {
        batch.progress.total++;
        batch.progress.inspected++;
        if (eligible(batch, activeProjects, identity)) addIdentity(batch.identities, identity);
        save(batch);
      }
      batch.discoveryComplete = true;
      batch.progress.phase = 'reading';
      save(batch);
    }
    batch.candidates = [];
    batch.progress.parsed = 0;
    for (const identity of batch.identities ?? []) {
      signal.throwIfAborted();
      if (known(identity.key)) continue;
      try {
        const record = await readRecord(identity, signal);
        if (record) batch.candidates.push(record);
      } catch (error) {
        signal.throwIfAborted();
        batch.issues.push({ path: identity.sourcePath, message: String(error) });
      }
      batch.progress.parsed++;
      save(batch);
    }
    batch.selectedKeys = batch.selectedKeys.filter((key) =>
      batch.candidates.some((candidate) => candidate.key === key),
    );
    if (batch.purpose === 'storage')
      batch.candidateProjectIds = Object.fromEntries(
        batch.candidates.map((c) => [c.key, owner(activeProjects, c.cwd)!.id]),
      );
    batch.state = 'ready';
    save(batch);
  }
  async function commit(batch: StoredBatch, signal: AbortSignal) {
    const activeProjects = readProjects(db);
    if (batch.storageRoot !== sessionsRoot)
      reject('SCOPE_CHANGED', '会话存储位置已变化。本次未提交，请取消后重新选择项目。');
    if (revision() !== batch.scopeRevision)
      reject('SCOPE_CHANGED', '项目范围已变化。本次未提交，请取消后重新选择项目。');
    try {
      for (const project of batchProjects(batch)) await directory(project.path);
    } catch {
      reject('DIRECTORY_UNAVAILABLE', '项目目录不可用，请恢复目录后重试。');
    }
    const rootEvidence = new Map<string, string>();
    for (const location of rootsFor(batch)) {
      try {
        const info = await stat(location.path);
        if (!info.isDirectory()) throw Error('不是目录');
        rootEvidence.set(location.id, `${info.dev}:${info.ino}`);
      } catch (error) {
        if (batch.purpose === 'storage')
          reject('IMPORT_UNAVAILABLE', '会话存储位置不可访问，请恢复后重试。');
      }
    }
    if (
      batch.candidates.some((candidate) =>
        recordSources(candidate).some((source) => !rootEvidence.has(source.locationId)),
      )
    )
      reject('IMPORT_UNAVAILABLE', '候选记录的存储位置不可访问，未确认记录删除。请恢复后重试。');
    const discovered: RecordIdentity[] = [];
    for await (const identity of enumerate(batch, signal)) {
      if (eligible(batch, activeProjects, identity)) addIdentity(discovered, identity);
    }
    const canonicalIdentity = identityResolver(db);
    const records: SessionRecord[] = [];
    const excluded = new Set<string>();
    let removed = 0;
    for (const candidate of batch.candidates) {
      signal.throwIfAborted();
      let identity: RecordIdentity;
      try {
        identity = canonicalIdentity(await readIdentity(candidate.sourcePath, signal));
        identity.sources = candidate.sources;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          removed++;
          continue;
        }
        throw error;
      }
      if (
        identity.identity !== candidate.identity ||
        !batchOwner(batch, activeProjects, identity.cwd)
      )
        reject('RECORD_CHANGED', '候选记录的身份或目录已变化。本次未提交，请取消后重新扫描。');
      try {
        const record = await readRecord(identity, signal);
        if (!record)
          reject('RECORD_CHANGED', '候选记录的对话已被清空。本次未提交，请取消后重新扫描。');
        records.push(record);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof RecordParseError)) throw error;
        // Corrupt content is isolatable; a replaced identity still requires a new import.
        const latest = await readIdentity(candidate.sourcePath, signal);
        if (latest.identity !== candidate.identity)
          reject('RECORD_CHANGED', '候选记录的身份已变化。本次未提交，请取消后重新扫描。');
        excluded.add(candidate.key);
        batch.issues.push({ path: candidate.sourcePath, message: error.message });
      }
      batch.progress.parsed++;
      save(batch);
    }
    const queued: SessionRecord[] = [];
    const candidateKeys = new Set(batch.candidates.map((candidate) => candidate.key));
    for (const identity of discovered) {
      if (candidateKeys.has(identity.key) || known(identity.key)) continue;
      signal.throwIfAborted();
      try {
        const record = await readRecord(identity, signal);
        if (record) queued.push(record);
      } catch (error) {
        signal.throwIfAborted();
        batch.issues.push({ path: identity.sourcePath, message: String(error) });
      }
    }
    // A candidate checked early may be replaced while later files are being read.
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      try {
        const latest = await readIdentity(record.sourcePath, signal);
        if (latest.identity !== record.identity)
          reject('RECORD_CHANGED', '候选记录的身份或目录已变化。本次未提交，请取消后重新扫描。');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        records.splice(index, 1);
        removed++;
      }
    }
    for (const location of rootsFor(batch)) {
      if (!rootEvidence.has(location.id)) continue;
      try {
        const info = await stat(location.path);
        if (!info.isDirectory() || `${info.dev}:${info.ino}` !== rootEvidence.get(location.id))
          throw Error('位置变化');
      } catch {
        reject(
          'IMPORT_UNAVAILABLE',
          '会话存储位置不可访问或已变化，未确认任何记录删除。请恢复后重试。',
        );
      }
    }
    try {
      for (const project of batchProjects(batch)) await directory(project.path);
    } catch {
      reject('DIRECTORY_UNAVAILABLE', '项目目录不可用，请恢复目录后重试。');
    }
    signal.throwIfAborted();
    if (revision() !== batch.scopeRevision)
      reject('SCOPE_CHANGED', '项目范围已变化。本次未提交，请取消后重新选择项目。');
    if (excluded.size) {
      batch.candidates = batch.candidates.filter((candidate) => !excluded.has(candidate.key));
      batch.selectedKeys = batch.selectedKeys.filter((key) => !excluded.has(key));
      batch.validationNotice = `${excluded.size} 条记录已损坏，已从本次导入中排除。其余选择已保留，本次尚未提交。请核对后再次确认。`;
      batch.state = 'ready';
      save(batch);
      return;
    }
    // Classification, project publication, queue and completed receipt share one SQLite transaction.
    db.transaction(() => {
      if (revision() !== batch.scopeRevision)
        reject('SCOPE_CHANGED', '项目范围已变化。本次未提交，请取消后重新选择项目。');
      if (batch.purpose !== 'storage')
        db.prepare(
          'INSERT INTO projects (id, path, include_descendants, enabled) VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET include_descendants=excluded.include_descendants, enabled=1',
        ).run(batch.project.id, batch.project.path, Number(batch.project.includeDescendants));
      if (batch.location) saveLocation(db, { ...batch.location, enabled: true });
      for (const identity of discovered) {
        const row = db.prepare('SELECT data FROM sessions WHERE key=?').get(identity.key) as
          { data: string } | undefined;
        if (row) {
          const old = JSON.parse(row.data) as ManagedSession;
          old.sources = mergeSources(recordSources(old), identity.sources ?? []);
          db.prepare('UPDATE sessions SET data=? WHERE key=?').run(JSON.stringify(old), old.key);
        }
      }
      const selected = new Set(batch.selectedKeys);
      const previousByPath = new Map(
        (db.prepare('SELECT key, data FROM sessions').all() as { key: string; data: string }[]).map(
          (row) => [(JSON.parse(row.data) as ManagedSession).sourcePath, row.key],
        ),
      );
      for (const record of records) {
        if (known(record.key)) continue;
        // A newly validated identity at an old location replaces the stale index entry.
        const previousKey = previousByPath.get(record.sourcePath);
        if (previousKey) db.prepare('DELETE FROM sessions WHERE key=?').run(previousKey);
        const session: ManagedSession = {
          ...record,
          sourceRootIdentity: record.sources?.[0]?.rootIdentity,
          projectId: batchOwner(batch, activeProjects, record.cwd)!.id,
          classification: selected.has(record.key) ? 'main' : 'archive',
          archiveWatermark: selected.has(record.key) ? null : record.messageWatermark,
        };
        db.prepare('INSERT INTO sessions (key, project_id, data) VALUES (?, ?, ?)').run(
          record.key,
          session.projectId,
          JSON.stringify(session),
        );
      }
      for (const record of queued)
        db.prepare('INSERT OR IGNORE INTO import_queue (key, batch_id, data) VALUES (?, ?, ?)').run(
          record.key,
          batch.id,
          JSON.stringify(record),
        );
      reassignSessions(db);
      db.prepare('UPDATE scope_state SET revision = revision + 1').run();
      batch.outcome = {
        main: records.filter((record) => selected.has(record.key)).length,
        archived: records.filter((record) => !selected.has(record.key)).length,
        removed,
        queued: queued.length,
      };
      batch.scopeOutcomes = batchProjects(batch).map((project) => ({
        projectId: project.id,
        main: records.filter(
          (r) => owner(activeProjects, r.cwd)?.id === project.id && selected.has(r.key),
        ).length,
        archived: records.filter(
          (r) => owner(activeProjects, r.cwd)?.id === project.id && !selected.has(r.key),
        ).length,
      }));
      batch.state = 'completed';
      batch.error = undefined;
      batch.validationNotice = undefined;
      save(batch);
    })();
    onCompleted();
  }
  async function validateChange(request: RemoveProjectRequest): Promise<Result<Project>> {
    if (
      !request ||
      typeof request.requestId !== 'string' ||
      !/^[\w-]{1,128}$/.test(request.requestId) ||
      typeof request.projectId !== 'string' ||
      !Number.isSafeInteger(request.expectedScopeRevision)
    )
      return failed('INVALID_REQUEST', '无效的项目设置请求。');
    const result = query(() => {
      const project = readProjects(db).find((p) => p.id === request.projectId);
      if (!project || revision() !== request.expectedScopeRevision)
        reject('SCOPE_CHANGED', '项目范围已变化，请重新读取设置。');
      return project;
    });
    if (result.status === 'failed') return result;
    try {
      await directory(result.value.path);
    } catch {
      return failed(
        'DIRECTORY_UNAVAILABLE',
        '项目目录不可用，请恢复目录与访问权限后重试。输入已保留。',
      );
    }
    return result;
  }
  return {
    async listStorageLocations() {
      return query(() => ({ locations: storageLocations(db), revision: revision() }));
    },
    async prepareStorageLocation(
      request: StorageLocationRequest,
    ): Promise<Result<ImportBatch | null>> {
      if (
        !request ||
        typeof request.requestId !== 'string' ||
        !/^[\w-]{1,128}$/.test(request.requestId) ||
        !['flat', 'encoded'].includes(request.enumeration)
      )
        return failed('INVALID_REQUEST', '无效的存储位置请求。');
      if (request.path === null) return completed(null);
      if (
        typeof request.path !== 'string' ||
        !isAbsolute(request.path) ||
        request.path.includes('\0')
      )
        return failed('INVALID_REQUEST', '请选择绝对目录路径。');
      const path = resolve(request.path);
      try {
        await directory(path);
      } catch {
        return failed('DIRECTORY_UNAVAILABLE', '存储位置不可用，请检查目录与访问权限。');
      }
      return query(() => {
        const repeat = readAll().find((b) => b.id === request.requestId);
        if (repeat) {
          if (repeat.location?.path !== path || repeat.location.enumeration !== request.enumeration)
            reject('INVALID_REQUEST', '请求身份已用于其他操作。');
          return publicBatch(repeat);
        }
        const saved = (db.prepare('SELECT data FROM storage_locations').all() as { data: string }[])
          .map((r) => JSON.parse(r.data) as StorageLocation)
          .find((l) => l.path === path && l.enumeration === request.enumeration);
        if (saved?.enabled) reject('INVALID_REQUEST', '此存储位置已经启用。');
        const location: StorageLocation = saved ?? {
          id: randomUUID(),
          path,
          kind: 'custom',
          enumeration: request.enumeration,
          enabled: false,
        };
        const projects = readProjects(db);
        const batch: StoredBatch = {
          id: request.requestId,
          storageRoot: sessionsRoot,
          scanLocations: [location],
          location,
          projects,
          project: projects[0] ?? {
            id: 'storage',
            name: '存储位置',
            path,
            includeDescendants: false,
          },
          purpose: 'storage',
          scopeRevision: revision(),
          state: 'scanning',
          candidates: [],
          selectedKeys: [],
          progress: { phase: 'discovering', inspected: 0, total: 0, parsed: 0 },
          issues: [],
        };
        save(batch);
        launch(batch, (signal) => scan(batch, signal));
        return publicBatch(batch);
      });
    },
    async removeStorageLocation(request: RemoveStorageRequest): Promise<Result<null>> {
      if (
        !request ||
        typeof request.requestId !== 'string' ||
        !/^[\w-]{1,128}$/.test(request.requestId) ||
        typeof request.locationId !== 'string' ||
        !Number.isSafeInteger(request.expectedScopeRevision)
      )
        return failed('INVALID_REQUEST', '无效的存储位置请求。');
      const result = query(() =>
        db.transaction(() => {
          if (revision() !== request.expectedScopeRevision)
            reject('SCOPE_CHANGED', '范围已变化，请重新读取设置。');
          const location = storageLocations(db).find((l) => l.id === request.locationId);
          if (!location || location.kind === 'standard')
            reject('INVALID_REQUEST', '请选择自定义存储位置。');
          saveLocation(db, { ...location, enabled: false });
          db.prepare('UPDATE scope_state SET revision=revision+1').run();
          return null;
        })(),
      );
      if (result.status === 'completed') onCompleted();
      return result;
    },
    async changeProjectScope(request: ProjectScopeRequest): Promise<Result<ImportBatch | null>> {
      if (typeof request?.includeDescendants !== 'boolean')
        return failed('INVALID_REQUEST', '无效的项目范围。');
      const checked = await validateChange(request);
      if (checked.status === 'failed') return checked;
      const result = query(() =>
        db.transaction(() => {
          if (revision() !== request.expectedScopeRevision)
            reject('SCOPE_CHANGED', '项目范围已变化，请重新读取设置。');
          const pending = readAll().find(
            (batch) =>
              batch.project.id === request.projectId &&
              batch.purpose === 'expand' &&
              !['completed', 'cancelled'].includes(batch.state),
          );
          if (pending && pending.project.includeDescendants !== request.includeDescendants)
            reject('SCOPE_CHANGED', '此项目仍有未完成的范围调整，请先取消该导入，再保存范围。');
          if (checked.value.includeDescendants === request.includeDescendants) return null;
          if (request.includeDescendants) {
            const repeat = readAll().find((b) => b.id === request.requestId);
            if (repeat) {
              if (repeat.project.id !== request.projectId || repeat.purpose !== 'expand')
                reject('INVALID_REQUEST', '请求身份已用于其他操作。');
              return publicBatch(repeat);
            }
            return stage(
              { ...checked.value, includeDescendants: true },
              request.requestId,
              'expand',
            );
          }
          db.prepare('UPDATE projects SET include_descendants=0 WHERE id=?').run(request.projectId);
          reassignSessions(db);
          db.prepare('UPDATE scope_state SET revision=revision+1').run();
          return null;
        })(),
      );
      if (result.status === 'completed' && !result.value) onCompleted();
      return result;
    },
    async removeProject(request: RemoveProjectRequest): Promise<Result<null>> {
      const checked = await validateChange(request);
      if (checked.status === 'failed') return checked;
      const result = query(() =>
        db.transaction(() => {
          if (revision() !== request.expectedScopeRevision)
            reject('SCOPE_CHANGED', '项目范围已变化，请重新读取设置。');
          db.prepare('UPDATE projects SET enabled=0 WHERE id=?').run(request.projectId);
          reassignSessions(db);
          db.prepare('UPDATE scope_state SET revision=revision+1').run();
          return null;
        })(),
      );
      if (result.status === 'completed') onCompleted();
      return result;
    },
    async prepareImport(request: {
      requestId: string;
      path: string | null;
    }): Promise<Result<ImportBatch | null>> {
      if (
        !request ||
        typeof request.requestId !== 'string' ||
        !/^[\w-]{1,128}$/.test(request.requestId)
      )
        return failed('INVALID_REQUEST', '无效的导入请求。');
      if (request.path === null) return completed(null);
      if (
        typeof request.path !== 'string' ||
        !isAbsolute(request.path) ||
        request.path.includes('\0')
      )
        return failed('INVALID_REQUEST', '请选择绝对目录路径。');
      const path = resolve(request.path);
      try {
        await directory(path);
      } catch {
        return failed('DIRECTORY_UNAVAILABLE', '目录不可用，请检查位置与访问权限。');
      }
      return query(() => {
        const batches = readAll();
        const repeat = batches.find((batch) => batch.id === request.requestId);
        if (repeat) {
          if (repeat.project.path !== path) reject('INVALID_REQUEST', '请求身份已用于其他项目。');
          return publicBatch(repeat);
        }
        const pending = batches.find(
          (batch) =>
            batch.project.path === path && !['completed', 'cancelled'].includes(batch.state),
        );
        if (pending) return publicBatch(pending);
        const existing = readProjects(db, true).find((p) => p.path === path);
        if (existing?.enabled)
          reject('SCOPE_CHANGED', '项目已存在，请在左侧选择该项目。', existing.id);
        return stage(
          existing
            ? { ...existing, enabled: true }
            : {
                id: randomUUID(),
                path,
                name: basename(path),
                includeDescendants: false,
                enabled: true,
              },
          request.requestId,
          existing ? 'return' : 'add',
        );
      });
    },
    async getImport(request: ImportRequest) {
      if (!validRequest(request)) return failed('INVALID_REQUEST', '无效的导入请求。');
      return query(() => publicBatch(get(request.batchId)));
    },
    async listImports() {
      return query(() =>
        readAll()
          .filter((batch) => !['completed', 'cancelled'].includes(batch.state))
          .map((batch) => publicBatch(failedWrites.get(batch.id) ?? batch)),
      );
    },
    async selectImport(request: ImportSelectionRequest) {
      if (
        !validRequest(request) ||
        !Array.isArray(request.selectedKeys) ||
        request.selectedKeys.some((key) => typeof key !== 'string')
      )
        return failed('INVALID_REQUEST', '无效的导入选择。');
      return query(() => {
        const batch = get(request.batchId);
        if (
          batch.state !== 'ready' ||
          request.selectedKeys.some(
            (key) => !batch.candidates.some((candidate) => candidate.key === key),
          )
        )
          reject('INVALID_REQUEST', '候选记录已变化，请重新读取导入。');
        batch.selectedKeys = [...new Set(request.selectedKeys)];
        save(batch);
        return publicBatch(batch);
      });
    },
    async commitImport(request: ImportRequest) {
      if (!validRequest(request)) return failed('INVALID_REQUEST', '无效的导入请求。');
      return query(() => {
        const batch = get(request.batchId);
        if (batch.state === 'completed' || batch.state === 'validating') return publicBatch(batch);
        if (batch.state !== 'ready') reject('INVALID_REQUEST', '请先完成历史会话选择。');
        batch.state = 'validating';
        batch.progress.phase = 'validating';
        batch.progress.parsed = 0;
        save(batch);
        launch(batch, (signal) => commit(batch, signal));
        return publicBatch(batch);
      });
    },
    async cancelImport(request: ImportRequest) {
      if (!validRequest(request)) return failed('INVALID_REQUEST', '无效的导入请求。');
      const job = jobs.get(request.batchId);
      job?.controller.abort();
      await job?.promise;
      return query(() => {
        const batch = get(request.batchId);
        if (batch.state === 'completed') reject('INVALID_REQUEST', '此导入已完成。');
        batch.state = 'cancelled';
        batch.error = undefined;
        save(batch);
        return publicBatch(batch);
      });
    },
    async retryImport(request: ImportRequest) {
      if (!validRequest(request)) return failed('INVALID_REQUEST', '无效的导入请求。');
      return query(() => {
        const batch = get(request.batchId);
        if (batch.state !== 'error') reject('INVALID_REQUEST', '此导入无需重试。');
        batch.error = undefined;
        if (batch.progress.phase === 'validating') {
          batch.state = 'ready';
          save(batch);
        } else {
          batch.state = 'scanning';
          save(batch);
          launch(batch, (signal) => scan(batch, signal));
        }
        return publicBatch(batch);
      });
    },
    async listSessions(request: SessionListRequest) {
      if (!validSessionQuery(request)) return failed('INVALID_REQUEST', '无效的会话范围。');
      return query(() => {
        const projects = readProjects(db);
        return selectSessions(
          activeSessions(
            storageSessions(
              db,
              (db.prepare('SELECT data FROM sessions').all() as { data: string }[]).map(
                (row) => JSON.parse(row.data) as ManagedSession,
              ),
            ),
            projects,
          ),
          projects,
          request,
        );
      });
    },
    async listQueuedRecords() {
      return query(() =>
        (db.prepare('SELECT data FROM import_queue').all() as { data: string }[]).map(
          (row) => JSON.parse(row.data) as SessionRecord,
        ),
      );
    },
    async close() {
      for (const job of jobs.values()) job.controller.abort();
      await Promise.allSettled([...jobs.values()].map((job) => job.promise));
    },
  };
}
