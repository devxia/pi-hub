import { pendingDeleteIdentities, pendingRenameIdentities } from './operation-reservations';
import { runtimeCapabilities } from './runtime-capabilities';
import {
  storageLocations,
  pendingStorageImports,
  identityResolver,
  recordSources,
  mergeSources,
  storageSessions,
} from './storage';
import { owner, activeSessions } from './project-scope';
import { isVisibleSession, compareSessions } from './session-list';
import type Database from 'better-sqlite3';
import { watch, constants, type FSWatcher } from 'node:fs';
import { access, stat, opendir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import {
  readIdentity,
  readRecord,
  locationFiles,
  PartialRecordError,
  sourceFingerprint,
} from './history-reader';
import {
  completed,
  type Result,
  type Project,
  type ManagedSession,
  type WorkspaceSnapshot,
  type DiscoveryState,
  type SourceAvailability,
  type StorageAvailability,
  type ImportBatch,
} from './interface';

interface SourceHint {
  locationId: string;
  path: string;
}
interface StoredState {
  discovery?: DiscoveryState;
  projects?: Record<string, SourceAvailability>;
  sources?: Record<string, SourceAvailability>;
  rootIdentity?: string;
  locations?: Record<string, StorageAvailability>;
}
const unavailable = (reason: string): SourceAvailability => ({ state: 'unavailable', reason });
const available: SourceAvailability = { state: 'available' };
export function discovery(
  db: Database.Database,
  configuredRoot: string,
  projects: () => Project[],
  databaseFailure: (error: unknown) => Result<never>,
  interval = 30000,
  previewRevision: (key: string) => string = () => '',
  runtimeState: (key: string) => import('./interface').RuntimeState = () => 'unknown',
  runtimeCwd: (key: string) => string | undefined = () => undefined,
) {
  const root = resolve(configuredRoot);
  const persisted = db.prepare('SELECT revision, data FROM discovery_state WHERE id=1').get() as {
    revision: number;
    data: string;
  };
  let revision = persisted.revision;
  let state: StoredState = JSON.parse(persisted.data);
  let progress: DiscoveryState = { state: 'idle', inspected: 0, parsed: 0, issues: [] };
  if (state.discovery) progress = { ...state.discovery, state: 'idle' };
  const listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  let closed = false;
  let cancelling = 0;
  const watchers = new Map<string, { watcher: FSWatcher; identity: string }>();
  const sourceRefresh = Symbol('source refresh');
  let job:
    | {
        controller: AbortController;
        promise: Promise<void>;
        kind: 'full' | 'sources';
        userCancelled?: boolean;
      }
    | undefined;
  let scheduled: NodeJS.Timeout | undefined;
  let followup = false,
    fullPending = false;
  const pendingHints = new Map<string, SourceHint>();
  const concurrencyLimit = 4,
    progressIntervalMs = 500;
  let activeReads = 0;
  const currentProgress = (): DiscoveryState => ({
    ...structuredClone(progress),
    work: {
      concurrencyLimit,
      activeReads,
      queuedReconciliations: Number(
        followup || !!scheduled || fullPending || pendingHints.size > 0,
      ),
      pendingPaths: pendingHints.size,
      pendingPathLimit: 256,
    },
  });
  const sessions = () =>
    (db.prepare('SELECT data FROM sessions').all() as { data: string }[]).map(
      (r) => JSON.parse(r.data) as ManagedSession,
    );
  const managed = () =>
    new Set(
      (db.prepare('SELECT data FROM import_batches').all() as { data: string }[])
        .map((r) => JSON.parse(r.data) as ImportBatch)
        .filter((b) => b.state === 'completed')
        .map((b) => b.project.id),
    );
  function snapshot(): WorkspaceSnapshot {
    const scope = projects(),
      locations = storageLocations(db),
      pendingRenames = pendingRenameIdentities(db),
      pendingDeletes = pendingDeleteIdentities(db);
    return {
      revision,
      discovery: currentProgress(),
      projects: scope.map((p) => {
        const availability = state.projects?.[p.id] ?? unavailable('目录尚待核对。');
        return {
          ...p,
          availability,
          newSession: {
            allowed: availability.state === 'available',
            reason: availability.state === 'unavailable' ? availability.reason : undefined,
          },
        };
      }),
      locations: locations.map((l) => ({
        ...l,
        availability:
          state.locations?.[l.id] ??
          (progress.state === 'scanning'
            ? { state: 'checking' as const, reason: '正在核对存储位置。' }
            : {
                state: 'pending' as const,
                reason: scope.length
                  ? '等待后台核对，也可点击「重新扫描」。'
                  : '添加项目后核对存储位置，可继续添加项目。',
              }),
      })),
      sessions: activeSessions(storageSessions(db, sessions()), scope)
        .filter(isVisibleSession)
        .sort(compareSessions)
        .map((s) => {
          const availability = state.sources?.[s.key] ?? unavailable('记录尚待核对。');
          const permits = runtimeCapabilities(
            runtimeState(s.key),
            availability.state === 'unavailable'
              ? { allowed: false, code: 'UNAVAILABLE', reason: availability.reason }
              : s.identityConflict
                ? { allowed: false, code: 'IDENTITY_CONFLICT', reason: s.uniqueIdentity?.reason }
                : undefined,
          );
          if (pendingRenames.has(s.identity)) {
            const p = {
              allowed: false,
              code: 'RENAME_PENDING',
              reason: '原改名结果尚待核对，请读取原请求。',
            };
            permits.rename = p;
            permits.delete = p;
          }
          if (pendingDeletes.has(s.identity)) {
            const p = {
              allowed: false,
              code: 'DELETE_PENDING',
              reason: '原删除结果尚待核对，请读取原请求。',
            };
            permits.rename = p;
            permits.delete = p;
          }
          return {
            ...s,
            ...(runtimeCwd(s.key) ? { runtimeCwd: runtimeCwd(s.key) } : {}),
            runtimeCapabilities: permits,
            previewRevision: previewRevision(s.key),
            availability,
            runtimeState: runtimeState(s.key),
            openSession: {
              allowed: availability.state === 'available' && !s.identityConflict,
              reason:
                availability.state === 'unavailable'
                  ? availability.reason
                  : s.identityConflict
                    ? s.uniqueIdentity?.reason
                    : state.projects?.[s.projectId]?.state === 'unavailable'
                      ? state.projects[s.projectId].reason
                      : undefined,
            },
          };
        }),
    };
  }
  let publishedSnapshot = snapshot();
  function notify() {
    const current = publishedSnapshot;
    for (const listener of listeners) {
      try {
        listener(structuredClone(current));
      } catch {
        /* Subscribers cannot interrupt indexing. */
      }
    }
  }
  function publish(emit = true) {
    state.discovery = progress;
    db.prepare('UPDATE discovery_state SET revision=revision+1, data=? WHERE id=1').run(
      JSON.stringify(state),
    );
    revision++;
    publishedSnapshot = snapshot();
    if (emit) notify();
  }
  function queue() {
    if (closed || cancelling) return;
    if (job) {
      followup = true;
      return;
    }
    if (!scheduled)
      scheduled = setTimeout(() => {
        scheduled = undefined;
        const hints = [...pendingHints.values()];
        pendingHints.clear();
        if (hints.length) start(hints);
        else {
          fullPending = false;
          start();
        }
      }, 100);
  }
  function schedule() {
    if (cancelling) return;
    fullPending = true;
    queue();
  }
  function schedulePath(
    location: import('./interface').StorageLocation,
    filename: string | Buffer | null,
  ) {
    if (cancelling) return;
    if (!filename) {
      schedule();
      return;
    }
    const path = resolve(location.path, filename.toString()),
      rel = relative(location.path, path),
      parts = rel.split('/');
    if (
      !rel ||
      rel.startsWith('..') ||
      isAbsolute(rel) ||
      !path.endsWith('.jsonl') ||
      parts.length !== (location.enumeration === 'flat' ? 1 : 2)
    ) {
      schedule();
      return;
    }
    const key = location.id + '\0' + path;
    if (pendingHints.size >= 256 && !pendingHints.has(key)) {
      pendingHints.clear();
      schedule();
      return;
    }
    pendingHints.set(key, { locationId: location.id, path });
    if (job?.kind === 'full') {
      fullPending = true;
      job.controller.abort(sourceRefresh);
    }
    queue();
  }
  async function directory(path: string) {
    const info = await stat(path);
    if (!info.isDirectory()) throw Error('路径不是目录。');
    await access(path, constants.R_OK | constants.X_OK);
    return info;
  }
  async function scan(signal: AbortSignal, hints?: SourceHint[]) {
    const classificationRevision = (
      db.prepare('SELECT revision FROM classification_state').get() as { revision: number }
    ).revision;
    const pendingStorage = pendingStorageImports(db);
    const scopeRevision = (
      db.prepare('SELECT revision FROM scope_state').get() as { revision: number }
    ).revision;
    const stillCurrent = () =>
      scopeRevision ===
      (db.prepare('SELECT revision FROM scope_state').get() as { revision: number }).revision;
    const ids = managed();
    const scope = projects().filter((p) => ids.has(p.id));
    const projectStates: Record<string, SourceAvailability> = {};
    for (const p of projects()) {
      try {
        await directory(p.path);
        projectStates[p.id] = available;
      } catch {
        projectStates[p.id] = unavailable('项目目录不可用，请恢复目录与访问权限。');
      }
    }
    if (!stillCurrent()) {
      followup = true;
      return;
    }
    state.projects = projectStates;
    signal.throwIfAborted();
    if (!scope.length) {
      state.projects = projectStates;
      progress.state = 'completed';
      publish();
      return;
    }
    const locations = storageLocations(db);
    const locationStates: Record<string, SourceAvailability> = {};
    for (const [id, entry] of watchers)
      if (!locations.some((l) => l.id === id)) {
        entry.watcher.close();
        watchers.delete(id);
      }
    const canonicalIdentity = identityResolver(db);
    const previous = sessions();
    const previousByKey = new Map(previous.map((s) => [s.key, s]));
    const next = new Map<string, ManagedSession>(hints ? previous.map((s) => [s.key, s]) : []);
    const sourceStates: Record<string, SourceAvailability> = {};
    const validatedSources = new Map<string, string>();
    const evidence = new Map<
      string,
      { rootIdentity: string; seen: Set<string>; absent: Set<string> }
    >();
    const rootResults = new Map<
      string,
      {
        records: Map<string, ManagedSession>;
        sources: Record<string, SourceAvailability>;
        validated: Map<string, string>;
      }
    >();
    let lastProgress = Date.now();
    for (const location of locations) {
      if (hints && !hints.some((h) => h.locationId === location.id)) continue;
      const local = new Map<string, ManagedSession>();
      const localStates: Record<string, SourceAvailability> = {};
      const validated = new Map<string, string>();
      const seen = new Set<string>();
      try {
        const before = await directory(location.path);
        const rootIdentity = `${before.dev}:${before.ino}`;
        if (watchers.get(location.id)?.identity !== rootIdentity) {
          watchers.get(location.id)?.watcher.close();
          watchers.delete(location.id);
          try {
            const watcher = watch(
              location.path,
              { recursive: location.enumeration === 'encoded' },
              (_event, filename) => schedulePath(location, filename),
            );
            watchers.set(location.id, { watcher, identity: rootIdentity });
            watcher.on('error', () => {
              watcher.close();
              watchers.delete(location.id);
              schedule();
            });
          } catch {
            /* Periodic reconciliation covers unavailable watchers. */
          }
        }
        const inspect = async (path: string) => {
          activeReads++;
          try {
            if (hints) {
              const parent = await opendir(resolve(path, '..'));
              await parent.close();
            }
            signal.throwIfAborted();
            seen.add(path);
            progress.inspected++;
            if (
              (!hints && progress.inspected === 1) ||
              Date.now() - lastProgress >= progressIntervalMs
            ) {
              publish();
              lastProgress = Date.now();
            }
            try {
              const identity = canonicalIdentity(await readIdentity(path, signal));
              const project = owner(scope, identity.cwd);
              if (!project) return;
              const old = previousByKey.get(identity.key);
              if (!old && pendingStorage.blocks(identity)) return;
              const legacySignatures = new Map<string, string | null>();
              const legacyArchive =
                old?.classification === 'archive' &&
                old.projectionVersion !== 6 &&
                !old.archiveWatermark?.some((message) => message.startsWith('dialogue:'));
              const info = await stat(path);
              const record =
                old?.projectionVersion === 6 &&
                old.hasMessages !== false &&
                old.sourceFingerprint === sourceFingerprint(info) &&
                state.sources?.[old.key]?.state === 'available'
                  ? { ...old, ...identity }
                  : await readRecord(
                      identity,
                      signal,
                      legacyArchive
                        ? (raw, semantic) => legacySignatures.set(raw, semantic)
                        : undefined,
                    );
              progress.parsed++;
              if (record) {
                const sources = mergeSources(old ? recordSources(old) : [], [
                  { locationId: location.id, sourcePath: path, rootIdentity },
                ]);
                const prior = local.get(record.key);
                // Development schemas <=06 stored raw line hashes. Fully mapped old lines
                // prove that extra dialogue is new, including messages saved while offline.
                // Rewritten old lines are ambiguous; preserve archive and record uncertainty.
                const mappedLegacy =
                  legacyArchive &&
                  (old.archiveWatermark ?? []).every((message) => legacySignatures.has(message));
                const archiveBaselineUncertain =
                  legacyArchive &&
                  !mappedLegacy &&
                  old.sourceFingerprint !== record.sourceFingerprint;
                const baseline = legacyArchive
                  ? [
                      ...new Set([
                        ...(old.archiveWatermark ?? []),
                        ...(mappedLegacy
                          ? old
                              .archiveWatermark!.map((message) => legacySignatures.get(message))
                              .filter((message): message is string => typeof message === 'string')
                          : record.messageWatermark),
                      ]),
                    ]
                  : (old?.archiveWatermark ?? null);
                const reactivate =
                  old?.classification === 'archive' &&
                  record.messageWatermark.some((message) => !baseline?.includes(message));
                local.set(record.key, {
                  ...record,
                  sources: mergeSources(prior?.sources ?? [], sources),
                  sourceRootIdentity: rootIdentity,
                  projectId: project.id,
                  classification: reactivate ? 'main' : (old?.classification ?? 'main'),
                  archiveWatermark: reactivate ? null : baseline,
                  ...(reactivate
                    ? {
                        classificationChange: {
                          revision: (old?.classificationRevision ?? 0) + 1,
                          cause: 'message' as const,
                        },
                      }
                    : old?.classificationChange
                      ? { classificationChange: old.classificationChange }
                      : {}),
                  ...(archiveBaselineUncertain || old?.archiveBaselineUncertain
                    ? { archiveBaselineUncertain: true }
                    : {}),
                  ...(old?.classificationRevision !== undefined || reactivate
                    ? {
                        classificationRevision:
                          (old?.classificationRevision ?? 0) + Number(reactivate),
                      }
                    : {}),
                });
                localStates[record.key] = available;
                validated.set(path, record.key);
              } else if (old) {
                local.set(old.key, { ...old, hasMessages: false });
                localStates[old.key] = available;
              }
            } catch (error) {
              signal.throwIfAborted();
              if (hints && (error as NodeJS.ErrnoException).code === 'ENOENT') fullPending = true;
              if (!(error instanceof PartialRecordError))
                progress.issues.push({ path, message: String(error) });
              for (const old of previous.filter((s) =>
                recordSources(s).some((source) => source.sourcePath === path),
              )) {
                local.set(old.key, old);
                localStates[old.key] = unavailable('记录暂不可读取，请检查内容与访问权限。');
              }
            }
            if (Date.now() - lastProgress >= progressIntervalMs) {
              publish();
              lastProgress = Date.now();
            }
          } finally {
            activeReads--;
          }
        };
        // Each reader asks for its next path only after finishing its previous file.
        // The iterator and in-flight reads are bounded; failures drain before root publication.
        const files = hints
          ? (async function* () {
              for (const hint of hints) if (hint.locationId === location.id) yield hint.path;
            })()
          : locationFiles(location.path, location.enumeration, signal);
        let failure: { error: unknown } | undefined;
        try {
          await Promise.all(
            Array.from({ length: concurrencyLimit }, async () => {
              while (!failure) {
                try {
                  const next = await files.next();
                  if (next.done || failure) break;
                  await inspect(next.value);
                } catch (error) {
                  failure ??= { error };
                }
              }
            }),
          );
        } finally {
          await files.return(undefined);
        }
        if (failure) throw failure.error;
        const after = await directory(location.path);
        if (after.dev !== before.dev || after.ino !== before.ino)
          throw Error('扫描期间存储位置已变化。');
        evidence.set(location.id, { rootIdentity, seen, absent: new Set() });
        locationStates[location.id] = available;
        rootResults.set(location.id, { records: local, sources: localStates, validated });
      } catch (error) {
        signal.throwIfAborted();
        locationStates[location.id] = unavailable(
          '存储位置暂不可用，已保留缓存。恢复目录与访问权限后会自动核对，也可关闭设置并点击「重新扫描」。',
        );
        if (hints) {
          fullPending = true;
          for (const old of previous)
            if (recordSources(old).some((source) => source.locationId === location.id))
              sourceStates[old.key] = unavailable('记录所在存储位置暂不可用，已保留缓存。');
        }
        progress.issues.push({ path: location.path, message: String(error) });
      }
    }
    // Keep each root's projections and deletion evidence private until its final recheck.
    // A late failure invalidates only that root, including any apparent file disappearances.
    for (const location of locations) {
      const proof = evidence.get(location.id);
      if (!proof) continue;
      try {
        for (const old of hints ? [] : previous)
          for (const source of recordSources(old)) {
            if (source.locationId !== location.id || proof.seen.has(source.sourcePath)) continue;
            try {
              await stat(source.sourcePath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                proof.absent.add(source.sourcePath);
            }
          }
        const info = await directory(location.path);
        if (`${info.dev}:${info.ino}` !== proof.rootIdentity)
          throw Error('核对期间存储位置已变化。');
      } catch (error) {
        signal.throwIfAborted();
        evidence.delete(location.id);
        rootResults.delete(location.id);
        if (hints) {
          fullPending = true;
          for (const old of previous)
            if (recordSources(old).some((source) => source.locationId === location.id))
              sourceStates[old.key] = unavailable('记录所在存储位置暂不可用，已保留缓存。');
        }
        locationStates[location.id] = unavailable(
          '存储位置暂不可用，已保留缓存。恢复目录与访问权限后会自动核对，也可关闭设置并点击「重新扫描」。',
        );
        progress.issues.push({ path: location.path, message: String(error) });
      }
    }
    for (const result of rootResults.values()) {
      for (const [key, record] of result.records) {
        const prior = next.get(key);
        next.set(key, {
          ...record,
          sources: mergeSources(prior?.sources ?? [], record.sources ?? []),
        });
        if (sourceStates[key]?.state !== 'available') sourceStates[key] = result.sources[key];
      }
      for (const [path, key] of result.validated) validatedSources.set(path, key);
    }
    for (const old of previous) {
      if (hints ? next.get(old.key) !== old : next.has(old.key)) continue;
      const activeSources = recordSources(old).filter((s) =>
        locations.some((l) => l.id === s.locationId),
      );
      const replacement =
        activeSources.length > 0 &&
        activeSources.every(
          (s) =>
            validatedSources.has(s.sourcePath) && validatedSources.get(s.sourcePath) !== old.key,
        );
      if (replacement) {
        next.delete(old.key);
        delete sourceStates[old.key];
        continue;
      }
      if (hints) continue;
      const project = owner(scope, old.cwd);
      if (!activeSources.length || !project || projectStates[project.id]?.state === 'unavailable') {
        next.set(old.key, old);
        sourceStates[old.key] = state.sources?.[old.key] ?? available;
        continue;
      }
      let deleted = true;
      for (const source of activeSources) {
        const proof = evidence.get(source.locationId);
        const baseline =
          source.rootIdentity ??
          (source.locationId === 'standard'
            ? (old.sourceRootIdentity ?? state.rootIdentity)
            : undefined);
        if (!proof || proof.rootIdentity !== baseline) {
          deleted = false;
          break;
        }
        if (proof.seen.has(source.sourcePath)) continue;
        if (!proof.absent.has(source.sourcePath)) {
          deleted = false;
          break;
        }
      }
      if (!deleted) {
        next.set(old.key, old);
        sourceStates[old.key] = unavailable('记录位置暂不可用，尚未确认删除。');
      }
    }
    signal.throwIfAborted();
    // Healthy root results, retained caches and location availability publish in one transaction.
    const previousState = structuredClone(state);
    const previousRevision = revision;
    const previousSnapshot = publishedSnapshot;
    try {
      db.transaction(() => {
        if (
          !stillCurrent() ||
          classificationRevision !==
            (db.prepare('SELECT revision FROM classification_state').get() as { revision: number })
              .revision ||
          pendingStorageImports(db).revision !== pendingStorage.revision
        ) {
          followup = true;
          return;
        }
        const pendingDeletes = pendingDeleteIdentities(db);
        for (const old of previous)
          if (pendingDeletes.has(old.identity)) {
            next.set(old.key, old);
            sourceStates[old.key] = state.sources?.[old.key] ?? available;
          }
        for (const old of previous)
          if (!next.has(old.key)) db.prepare('DELETE FROM sessions WHERE key=?').run(old.key);
        for (const s of next.values())
          if (!hints || previousByKey.get(s.key) !== s)
            db.prepare('INSERT OR REPLACE INTO sessions(key,project_id,data) VALUES(?,?,?)').run(
              s.key,
              s.projectId,
              JSON.stringify(s),
            );
        const queued = db.prepare('SELECT key, batch_id FROM import_queue').all() as {
          key: string;
          batch_id: string;
        }[];
        for (const q of queued) {
          const row = db.prepare('SELECT data FROM import_batches WHERE id=?').get(q.batch_id) as {
            data: string;
          };
          const batch = JSON.parse(row.data) as ImportBatch;
          if (batch.state === 'completed' && ids.has(batch.project.id) && next.has(q.key))
            db.prepare('DELETE FROM import_queue WHERE key=?').run(q.key);
        }
        state = hints
          ? {
              ...state,
              projects: { ...state.projects, ...projectStates },
              sources: { ...state.sources, ...sourceStates },
              locations: {
                ...state.locations,
                ...Object.fromEntries(
                  Object.entries(locationStates).filter(
                    ([id, value]) =>
                      value.state === 'unavailable' || state.locations?.[id]?.state === 'available',
                  ),
                ),
              },
            }
          : {
              projects: projectStates,
              sources: sourceStates,
              locations: locationStates,
              rootIdentity: state.rootIdentity,
            };
        progress.state = evidence.size
          ? hints && fullPending
            ? 'scanning'
            : 'completed'
          : 'error';
        if (!evidence.size)
          progress.error = {
            code: 'IMPORT_UNAVAILABLE',
            message: '会话存储位置暂不可用，已保留缓存。请恢复位置与权限后重新扫描。',
          };
        publish(false);
      })();
    } catch (error) {
      state = previousState;
      revision = previousRevision;
      publishedSnapshot = previousSnapshot;
      throw error;
    }
    notify();
  }
  function start(hints?: SourceHint[]) {
    if (closed || cancelling) return;
    if (job) {
      fullPending = true;
      followup = true;
      if (!hints) publish();
      return;
    }
    if (!hints) fullPending = false;
    else for (const hint of hints) pendingHints.delete(hint.locationId + '\0' + hint.path);
    if (scheduled) {
      clearTimeout(scheduled);
      scheduled = undefined;
    }
    progress = { state: 'scanning', inspected: 0, parsed: 0, issues: [] };
    try {
      if (!hints) publish();
    } catch (error) {
      progress.state = 'error';
      const failure = databaseFailure(error);
      if (failure.status === 'failed') progress.error = failure.error;
      return;
    }
    const controller = new AbortController();
    const promise = scan(controller.signal, hints)
      .catch((error) => {
        const databaseError = String((error as { code?: string })?.code ?? '').startsWith('SQLITE_')
          ? databaseFailure(error)
          : null;
        const superseded = controller.signal.reason === sourceRefresh && !job?.userCancelled;
        progress.state = superseded
          ? 'scanning'
          : controller.signal.aborted
            ? 'cancelled'
            : 'error';
        progress.error = controller.signal.aborted
          ? undefined
          : databaseError?.status === 'failed'
            ? databaseError.error
            : {
                code: 'IMPORT_UNAVAILABLE',
                message: '会话存储位置暂不可用，已保留缓存。请恢复位置与权限后重新扫描。',
                detail: String(error),
              };
        if (!superseded)
          state.sources = Object.fromEntries(
            sessions().map((s) => [
              s.key,
              unavailable(
                controller.signal.aborted
                  ? '扫描已取消，记录尚待核对。'
                  : '存储位置暂不可用，显示已保存的记录。',
              ),
            ]),
          );
        try {
          publish();
        } catch {
          /* Persistent cache remains intact on database failure. */
        }
      })
      .finally(() => {
        clearTimeout(delayedProgress);
        job = undefined;
        if ((followup || fullPending || pendingHints.size) && !closed) {
          followup = false;
          queue();
        }
      });
    const delayedProgress = hints
      ? setTimeout(() => {
          if (job?.controller === controller && !controller.signal.aborted) {
            try {
              publish();
            } catch {
              /* The final transaction reports storage failure without an uncaught timer error. */
            }
          }
        }, progressIntervalMs)
      : undefined;
    job = { controller, promise, kind: hints ? 'sources' : 'full' };
  }
  const timer = setInterval(schedule, Math.max(100, interval));
  timer.unref();
  schedule();
  return {
    classificationChanged<T>(mutation: () => T): T {
      const previousState = structuredClone(state);
      const previousRevision = revision;
      const previousSnapshot = publishedSnapshot;
      let result: T;
      try {
        result = db.transaction(() => {
          const result = mutation();
          publish(false);
          return result;
        })();
      } catch (error) {
        state = previousState;
        revision = previousRevision;
        publishedSnapshot = previousSnapshot;
        throw error;
      }
      notify();
      schedule();
      return result;
    },
    invalidatePreview() {
      publish();
    },
    scopeChanged() {
      pendingHints.clear();
      fullPending = true;
      publish();
      if (job) {
        job.controller.abort();
        followup = true;
      } else start();
    },
    async getSnapshot(): Promise<Result<WorkspaceSnapshot>> {
      try {
        return completed(structuredClone(publishedSnapshot));
      } catch (error) {
        return databaseFailure(error);
      }
    },
    async reconcileSource(path: string) {
      for (let pass = 0; pass < 2; pass++) {
        if (job?.kind === 'full') {
          fullPending = true;
          job.controller.abort(sourceRefresh);
        }
        await job?.promise;
        const hints = storageLocations(db)
          .filter((location) => {
            const rel = relative(location.path, path);
            return (
              !!rel &&
              !rel.startsWith('..') &&
              !isAbsolute(rel) &&
              rel.split('/').length === (location.enumeration === 'flat' ? 1 : 2)
            );
          })
          .map((location) => ({ locationId: location.id, path }));
        if (!hints.length) throw Error('源记录已不在有效存储位置。');
        start(hints);
        await job?.promise;
      }
    },
    async reconcileSettled() {
      start();
      await job?.promise;
      start();
      await job?.promise;
    },
    async reconcile(): Promise<Result<DiscoveryState>> {
      start();
      return completed(currentProgress());
    },
    async cancelReconciliation(): Promise<Result<DiscoveryState>> {
      cancelling++;
      const clearPending = () => {
        followup = false;
        fullPending = false;
        pendingHints.clear();
        if (scheduled) clearTimeout(scheduled);
        scheduled = undefined;
      };
      const hadWork = !!job || !!scheduled || followup || fullPending || pendingHints.size > 0;
      try {
        clearPending();
        if (job) {
          job.userCancelled = true;
          job.controller.abort();
        }
        await job?.promise;
        // Reader cleanup and late native watcher deliveries cannot restart cancelled work.
        clearPending();
        if (hadWork) {
          progress.state = 'cancelled';
          progress.error = undefined;
          state.sources = Object.fromEntries(
            sessions().map((s) => [s.key, unavailable('扫描已取消，记录尚待核对。')]),
          );
          try {
            publish();
          } catch (error) {
            return databaseFailure(error);
          }
        }
        return completed(currentProgress());
      } finally {
        cancelling--;
      }
    },
    subscribe(afterRevision: number, listener: (snapshot: WorkspaceSnapshot) => void) {
      listeners.add(listener);
      if (revision > afterRevision) listener(structuredClone(publishedSnapshot));
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (scheduled) clearTimeout(scheduled);
      for (const entry of watchers.values()) entry.watcher.close();
      job?.controller.abort();
      await job?.promise;
      listeners.clear();
    },
  };
}
