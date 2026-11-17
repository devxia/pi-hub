import type { WorkspaceSnapshot } from './interface';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';

export interface PinnedDirectoryFact {
  path: string;
  physical: string;
  canonical: string;
}
/** Worker-authorized facts for the private native boundary; never accepted from renderer IPC. */
export interface DeleteSourceProof {
  operationId: string;
  key: string;
  projectId: string;
  publicationRevision: number;
  path: string;
  identity: string;
  revision: string;
  physical: string;
  directories: PinnedDirectoryFact[];
}
export function pinDeleteDirectory(path: string): PinnedDirectoryFact {
  const info = statSync(path);
  if (!info.isDirectory()) throw Error('源目录不可用。');
  accessSync(path, constants.R_OK | constants.X_OK);
  return { path, physical: `${info.dev}:${info.ino}`, canonical: realpathSync(path) };
}
export function verifyDeleteDirectories(directories: PinnedDirectoryFact[]): void {
  for (const fact of directories) {
    const current = pinDeleteDirectory(fact.path);
    if (current.physical !== fact.physical || current.canonical !== fact.canonical)
      throw Error('源存储位置、父目录或项目已变化，不能推断文件不存在。');
  }
}
export function validDeleteSourceProof(value: unknown): value is DeleteSourceProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as DeleteSourceProof;
  return (
    Object.keys(s).length === 9 &&
    Object.keys(s).every((k) =>
      [
        'operationId',
        'key',
        'projectId',
        'publicationRevision',
        'path',
        'identity',
        'revision',
        'physical',
        'directories',
      ].includes(k),
    ) &&
    typeof s.key === 'string' &&
    /^[a-f0-9]{64}$/.test(s.key) &&
    typeof s.projectId === 'string' &&
    s.projectId.length > 0 &&
    s.projectId.length <= 128 &&
    Number.isSafeInteger(s.publicationRevision) &&
    s.publicationRevision >= 0 &&
    typeof s.operationId === 'string' &&
    s.operationId.length > 0 &&
    s.operationId.length <= 128 &&
    typeof s.path === 'string' &&
    isAbsolute(s.path) &&
    !s.path.includes('\0') &&
    typeof s.identity === 'string' &&
    /^[a-f0-9]{64}$/.test(s.identity) &&
    typeof s.revision === 'string' &&
    /^[a-f0-9]{64}$/.test(s.revision) &&
    typeof s.physical === 'string' &&
    /^\d+:\d+$/.test(s.physical) &&
    Array.isArray(s.directories) &&
    s.directories.length > 0 &&
    s.directories.every(
      (d) =>
        !!d &&
        typeof d === 'object' &&
        !Array.isArray(d) &&
        Object.keys(d).length === 3 &&
        Object.keys(d).every((k) => ['path', 'physical', 'canonical'].includes(k)) &&
        typeof d.path === 'string' &&
        isAbsolute(d.path) &&
        !d.path.includes('\0') &&
        typeof d.canonical === 'string' &&
        isAbsolute(d.canonical) &&
        !d.canonical.includes('\0') &&
        typeof d.physical === 'string' &&
        /^\d+:\d+$/.test(d.physical),
    )
  );
}
/** Raw-byte guard only: Pi format and history compatibility remain worker responsibilities. */
export function verifyDeleteSourceProof(source: DeleteSourceProof): void {
  verifyDeleteDirectories(source.directories);
  if (realpathSync(source.path) !== source.path) throw Error('原始记录路径已变化。');
  const fd = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || `${before.dev}:${before.ino}` !== source.physical)
      throw Error('原始记录物理身份已变化。');
    const revision = createHash('sha256'),
      header = createHash('sha256').update(`${before.dev}:${before.ino}:`),
      buffer = Buffer.allocUnsafe(65536);
    let headerComplete = false,
      length: number;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const bytes = buffer.subarray(0, length);
      revision.update(bytes);
      if (!headerComplete) {
        const end = bytes.indexOf(10);
        header.update(end < 0 ? bytes : bytes.subarray(0, end));
        headerComplete = end >= 0;
      }
    }
    const after = fstatSync(fd),
      current = lstatSync(source.path);
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ctimeMs !== before.ctimeMs
    )
      throw Error('原始记录在核对期间已变化。');
    if (
      !headerComplete ||
      header.digest('hex') !== source.identity ||
      revision.digest('hex') !== source.revision
    )
      throw Error('原始记录身份或修订已变化。');
  } finally {
    closeSync(fd);
  }
  accessSync(source.path, constants.R_OK);
  accessSync(dirname(source.path), constants.W_OK | constants.X_OK);
  verifyDeleteDirectories(source.directories);
}

/** A newer published danger always overrides the operation's own pending permit. */
export function deletePublicationMatches(
  source: DeleteSourceProof,
  snapshot: WorkspaceSnapshot | undefined,
): boolean {
  if (
    !validDeleteSourceProof(source) ||
    !snapshot ||
    snapshot.revision < source.publicationRevision
  )
    return false;
  const session = snapshot.sessions.find((s) => s.key === source.key),
    project = snapshot.projects.find((p) => p.id === source.projectId);
  return (
    !!session &&
    session.identity === source.identity &&
    session.projectId === source.projectId &&
    session.physicalIdentity === source.physical &&
    !session.identityConflict &&
    session.uniqueIdentity?.allowed !== false &&
    session.availability.state === 'available' &&
    project?.availability.state === 'available' &&
    (session.runtimeCapabilities.delete.allowed ||
      session.runtimeCapabilities.delete.code === 'DELETE_PENDING')
  );
}
