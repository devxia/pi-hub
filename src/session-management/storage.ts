import type Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import type {
  ManagedSession,
  RecordIdentity,
  StorageLocation,
  RecordSource,
  ImportBatch,
} from './interface';
import { locationFiles, readIdentity } from './history-reader';

export function storageLocations(db: Database.Database): StorageLocation[] {
  return (db.prepare('SELECT data FROM storage_locations').all() as { data: string }[])
    .map((row) => JSON.parse(row.data) as StorageLocation)
    .filter((location) => location.enabled);
}
export function saveLocation(db: Database.Database, location: StorageLocation) {
  db.prepare('INSERT OR REPLACE INTO storage_locations(id,data) VALUES(?,?)').run(
    location.id,
    JSON.stringify(location),
  );
}
export function recordSources(record: RecordIdentity): RecordSource[] {
  return (
    record.sources ?? [
      {
        locationId: 'standard',
        sourcePath: record.sourcePath,
        rootIdentity: (record as ManagedSession).sourceRootIdentity,
      },
    ]
  );
}
export function tracked(db: Database.Database, record: RecordIdentity): boolean {
  const ids = new Set(storageLocations(db).map((location) => location.id));
  return recordSources(record).some((source) => ids.has(source.locationId));
}
function preferredSourcePath(record: RecordIdentity, ids: Set<string>): string {
  const sources = recordSources(record);
  return (
    sources.find((source) => ids.has(source.locationId) && source.sourcePath === record.sourcePath)
      ?.sourcePath ??
    sources.find((source) => ids.has(source.locationId))?.sourcePath ??
    record.sourcePath
  );
}
export function activeSourcePath(db: Database.Database, record: RecordIdentity): string {
  return preferredSourcePath(record, new Set(storageLocations(db).map((location) => location.id)));
}
export function storageSessions(
  db: Database.Database,
  records: ManagedSession[],
): ManagedSession[] {
  const ids = new Set(storageLocations(db).map((location) => location.id));
  const active = records
    .filter((record) => recordSources(record).some((source) => ids.has(source.locationId)))
    .map((record) => ({ ...record, sourcePath: preferredSourcePath(record, ids) }));
  const identitiesByHeader = new Map<string, Set<string>>();
  for (const record of active) {
    const identities = identitiesByHeader.get(record.headerId) ?? new Set();
    identities.add(record.identity);
    identitiesByHeader.set(record.headerId, identities);
  }
  return active.map((record) =>
    identitiesByHeader.get(record.headerId)!.size > 1
      ? {
          ...record,
          identityConflict: true,
          uniqueIdentity: {
            allowed: false,
            reason: '会话 ID 冲突：不同物理记录使用相同 ID，已暂停需要唯一身份的操作。',
          },
        }
      : record,
  );
}
/** Preserve existing record keys across the physical-identity projection migration. */
export function identityResolver(
  db: Database.Database,
): (identity: RecordIdentity) => RecordIdentity {
  const keys = new Map(
    (db.prepare('SELECT data FROM sessions').all() as { data: string }[]).map((row) => {
      const record = JSON.parse(row.data) as ManagedSession;
      return [record.identity, record.key];
    }),
  );
  return (identity) => ({ ...identity, key: keys.get(identity.identity) ?? identity.key });
}
export async function* locationIdentities(
  db: Database.Database,
  locations: StorageLocation[],
  signal: AbortSignal,
  issue: (path: string, error: unknown) => void,
): AsyncGenerator<RecordIdentity> {
  const canonicalIdentity = identityResolver(db);
  for (const location of locations) {
    let rootIdentity: string;
    try {
      const info = await stat(location.path);
      if (!info.isDirectory())
        throw Object.assign(Error('存储位置不是文件夹。'), { code: 'ENOTDIR' });
      rootIdentity = `${info.dev}:${info.ino}`;
    } catch (error) {
      if (location.kind === 'standard' && (error as NodeJS.ErrnoException).code === 'ENOENT')
        continue;
      issue(location.path, error);
      continue;
    }
    try {
      for await (const path of locationFiles(location.path, location.enumeration, signal)) {
        try {
          const identity = canonicalIdentity(await readIdentity(path, signal));
          yield {
            ...identity,
            sources: [{ locationId: location.id, sourcePath: path, rootIdentity }],
          };
        } catch (error) {
          signal.throwIfAborted();
          issue(path, error);
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      issue(location.path, error);
    }
  }
}
export function mergeSources(a: RecordSource[], b: RecordSource[]): RecordSource[] {
  return [
    ...new Map(
      [...a, ...b].map((source) => [source.locationId + '\0' + source.sourcePath, source]),
    ).values(),
  ];
}

/** A pending location owns its historical decision even when another entry sees an alias. */
export function pendingStorageImports(db: Database.Database) {
  const batches = (db.prepare('SELECT data FROM import_batches').all() as { data: string }[])
    .map(
      (row) =>
        JSON.parse(row.data) as ImportBatch & {
          identities?: RecordIdentity[];
          discoveryComplete?: boolean;
        },
    )
    .filter(
      (batch) => batch.purpose === 'storage' && !['completed', 'cancelled'].includes(batch.state),
    );
  const identities = batches.flatMap((batch) => batch.identities ?? []);
  const headerIdentities = new Set(identities.map((identity) => identity.identity));
  const physicalIdentities = new Set(
    [
      ...identities.map((identity) => identity.physicalIdentity),
      ...batches.flatMap((batch) =>
        batch.candidates.map(
          (candidate) =>
            candidate.physicalIdentity ??
            candidate.sourceFingerprint?.split(':').slice(0, 2).join(':'),
        ),
      ),
    ].filter(Boolean),
  );
  const paths = new Set(
    identities.flatMap((identity) => [
      identity.sourcePath,
      ...(identity.sources ?? []).map((source) => source.sourcePath),
    ]),
  );
  const discovering = batches.some(
    (batch) => batch.state === 'scanning' && !batch.discoveryComplete,
  );
  return {
    // Detect staging/cancellation while an older reconciliation is suspended in file I/O.
    revision: JSON.stringify(
      batches.map((batch) => [
        batch.id,
        batch.state,
        batch.discoveryComplete,
        (batch.identities ?? []).map((identity) => [
          identity.identity,
          identity.physicalIdentity,
          identity.sourcePath,
        ]),
      ]),
    ),
    blocks: (identity: RecordIdentity) =>
      discovering ||
      headerIdentities.has(identity.identity) ||
      (!!identity.physicalIdentity && physicalIdentities.has(identity.physicalIdentity)) ||
      paths.has(identity.sourcePath),
  };
}
