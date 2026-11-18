import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  assert,
  absolutePath,
  relativePath,
  checkedDirectory,
  digest,
  type SecureFiles,
} from './security';

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  object: string;
}
export interface DiskSnapshot {
  directory: string;
  files: ManifestFile[];
  directories: string[];
  totalBytes: number;
}
export const MAX_FILES = 10000;
export const MAX_BYTES = 1024 ** 4;
export interface InputHandle {
  handle: unknown;
  fd: number;
  size: number;
  sourceStamp: string;
}

/** Native handles retain and recheck the entire source parent chain during streaming. */
export async function copyInput(
  native: SecureFiles,
  root: string,
  path: string,
  destination?: string,
  check?: () => void,
) {
  const input = native.openInput(root, path);
  const sha = createHash('sha256');
  let size = 0;
  let closed = false;
  try {
    const reader = createReadStream('', {
      fd: input.fd,
      autoClose: false,
      highWaterMark: 256 * 1024,
    });
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > input.size || size > MAX_BYTES)
          return done(Error('文件在读取时增长或超过 1 TiB。'));
        try {
          check?.();
          sha.update(chunk);
          done(null, chunk);
        } catch (error) {
          done(error as Error);
        }
      },
    });
    if (destination) {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const file = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o400,
      );
      try {
        await pipeline(reader, measure, createWriteStream('', { fd: file.fd, autoClose: false }));
        await file.sync();
      } finally {
        await file.close();
      }
    } else {
      for await (const chunk of reader) {
        size += chunk.length;
        assert(size <= input.size, '文件在读取时增长。');
        sha.update(chunk);
      }
    }
    assert(size === input.size, '文件在读取时改变大小。');
    closed = true;
    native.finishInput(input, true);
    return { size, sha256: sha.digest('hex'), sourceStamp: input.sourceStamp };
  } catch (error) {
    if (!closed) native.finishInput(input, false);
    throw error;
  }
}

export async function snapshotInputs(
  root: string,
  selections: string[],
  parent: string,
  native: SecureFiles,
  name: string = randomUUID(),
  prepared?: (bytes: number) => void,
): Promise<DiskSnapshot> {
  absolutePath(root);
  selections.forEach(relativePath);
  assert(
    selections.length <= MAX_FILES && new Set(selections).size === selections.length,
    '请选择不超过 10000 个不同的文件或目录。',
  );
  await checkedDirectory(parent);
  assert(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name), 'Invalid snapshot identity.');
  prepared?.(0);
  const directory = join(parent, name);
  await mkdir(directory, { mode: 0o700 });
  try {
    const tree = native.enumerate(root, selections);
    assert(tree.files.length + tree.directories.length <= MAX_FILES, '递归输入清单超过 10000 项。');
    const files: ManifestFile[] = [];
    let totalBytes = 0;
    for (const path of tree.files) {
      const object = String(files.length).padStart(8, '0');
      const file = await copyInput(native, root, path, join(directory, object), () => prepared?.(totalBytes));
      totalBytes += file.size;
      assert(totalBytes <= MAX_BYTES, '输入快照超过 1 TiB。');
      files.push({ path, object, size: file.size, sha256: file.sha256 });
      prepared?.(totalBytes);
    }
    assert(
      digest(native.enumerate(root, selections)) === digest(tree),
      '输入目录在制作快照时改变，请重新审核。',
    );
    const dir = await open(directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    const owner = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await owner.sync();
    } finally {
      await owner.close();
    }
    return { directory, files, directories: tree.directories, totalBytes };
  } catch (error) {
    try {
      native.releaseSnapshot(parent, name);
    } catch {
      // The durable reservation lets service reconciliation retry a refused cleanup.
    }
    throw error;
  }
}

export async function verifySnapshot(snapshot: DiskSnapshot, native: SecureFiles) {
  let total = 0;
  for (const file of snapshot.files) {
    const actual = await copyInput(native, snapshot.directory, file.object);
    assert(
      actual.size === file.size && actual.sha256 === file.sha256,
      '审核快照摘要改变，操作已阻止。',
    );
    total += actual.size;
  }
  assert(total === snapshot.totalBytes, '审核快照总量改变。');
}

export async function publishDisk(
  destination: string,
  source: string,
  files: ManifestFile[],
  native: SecureFiles,
  parent: string,
  revision = '',
  directories: string[] = [],
  beforePublish?: () => void,
) {
  const checked = [];
  for (const file of files) {
    relativePath(file.path);
    const actual = await copyInput(native, source, file.object);
    assert(
      actual.sha256 === file.sha256 && actual.size === file.size,
      '取回结果的摘要或大小不匹配。',
    );
    checked.push({ ...file, sourceStamp: actual.sourceStamp });
  }
  const backup = '.pi-hub-result-' + randomUUID();
  beforePublish?.();
  native.publishDisk(destination, checked, parent, backup, revision, source, directories);
  return revision ? join(dirname(destination), backup) : undefined;
}
