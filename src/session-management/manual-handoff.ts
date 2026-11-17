import { terminalHostCommand } from './terminal-shell';
import { createHash } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TerminalLaunchDescriptor } from './terminal';
export interface ManualHandoff {
  command: string;
  descriptorPath: string;
  entryPath: string;
  claimPath: string;
  descriptorHash: string;
  entryHash: string;
}
export interface ManualInspection {
  state: 'pending' | 'claimed' | 'revoked' | 'unknown';
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function owned(path: string) {
  const s = await lstat(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid!() ||
    (s.mode & 0o777) !== 0o600 ||
    s.size > 1024 * 1024
  )
    throw Error('Invalid owned handoff');
  return readFile(path);
}
async function valid(h: ManualHandoff) {
  const parent = await lstat(dirname(h.descriptorPath));
  return (
    parent.isDirectory() &&
    !parent.isSymbolicLink() &&
    parent.uid === process.getuid!() &&
    (parent.mode & 0o777) === 0o700 &&
    hash(await owned(h.descriptorPath)) === h.descriptorHash &&
    hash(await owned(h.entryPath)) === h.entryHash
  );
}
async function createOrVerify(path: string, bytes: string | Buffer) {
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      hash(await owned(path)) !== hash(bytes)
    )
      throw error;
  }
}
export async function prepareManualHandoff(d: TerminalLaunchDescriptor): Promise<ManualHandoff> {
  if (!d.startupAssetPath || !d.runtimeNodePath || !d.attemptId)
    throw Error('Guarded startup required');
  const directory = join(d.appData, 'terminal-launches');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o777) !== 0o700
  )
    throw Error('Invalid owned handoff directory');
  const prefix = join(directory, d.requestId + '.' + d.attemptId),
    entryPath = prefix + '.manual.mjs',
    descriptorPath = prefix + '.manual.json',
    claimPath = prefix + '.claim.json',
    entry = await readFile(d.startupAssetPath),
    entryHash = hash(entry);
  const env = d.env;
  const descriptor = { ...d, env, manual: { claimPath, entryHash } };
  const bytes = JSON.stringify(descriptor);
  await createOrVerify(entryPath, entry);
  await createOrVerify(descriptorPath, bytes);
  return {
    command: 'exec ' + terminalHostCommand(d, entryPath, descriptorPath),
    entryPath,
    descriptorPath,
    claimPath,
    entryHash,
    descriptorHash: hash(bytes),
  };
}
export async function inspectManualHandoff(h: ManualHandoff): Promise<ManualInspection> {
  try {
    if (!(await valid(h))) return { state: 'unknown' };
    try {
      const claim = JSON.parse((await owned(h.claimPath)).toString());
      if (claim.descriptorHash !== h.descriptorHash) return { state: 'unknown' };
      return {
        state:
          claim.state === 'revoked' ? 'revoked' : claim.state === 'claimed' ? 'claimed' : 'unknown',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { state: 'unknown' };
      const d = JSON.parse((await owned(h.descriptorPath)).toString());
      for (const path of [d.statusPath, d.proofPath])
        if (path) {
          try {
            await lstat(path);
            return { state: 'unknown' };
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { state: 'unknown' };
          }
        }
      return { state: 'pending' };
    }
  } catch {
    return { state: 'unknown' };
  }
}
export async function revokeManualHandoff(h: ManualHandoff): Promise<ManualInspection> {
  const inspected = await inspectManualHandoff(h);
  if (inspected.state !== 'pending') return inspected;
  try {
    const fd = await open(h.claimPath, 'wx', 0o600);
    try {
      await fd.writeFile(JSON.stringify({ state: 'revoked', descriptorHash: h.descriptorHash }));
      await fd.sync();
    } finally {
      await fd.close();
    }
    return { state: 'revoked' };
  } catch {
    return inspectManualHandoff(h);
  }
}
