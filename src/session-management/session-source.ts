import { statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const normalizeSessionName = (name: string) => name.replace(/[\r\n]+/g, ' ').trim();
/** Verify the exact on-disk record before a GUI mutation; this says nothing about other processes. */
export function inspectSessionSource(path: string, identity: string) {
  const before = statSync(path),
    bytes = readFileSync(path, 'utf8'),
    after = statSync(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    !bytes.endsWith('\n')
  )
    throw Error('记录正在变化，请重读后再操作。');
  const entries = bytes
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l)),
    header = entries[0];
  if (
    createHash('sha256')
      .update(`${before.dev}:${before.ino}:${bytes.slice(0, bytes.indexOf('\n'))}`)
      .digest('hex') !== identity
  )
    throw Error('原记录物理身份已变化。');
  if (header.type !== 'session' || header.version !== 3)
    throw Error('此格式请先用当前原生Pi打开升级；Hub不会静默迁移历史源。');
  let name = '';
  for (const e of entries)
    if (e.type === 'session_info' && typeof e.name === 'string')
      name = normalizeSessionName(e.name);
  return {
    bytes,
    header,
    entries,
    name,
    leafId: entries.at(-1)?.id ?? null,
    physicalIdentity: `${before.dev}:${before.ino}`,
  };
}
export function cloneHistoryUnsupportedReason(
  entry: { type?: unknown; version?: unknown },
  header = false,
) {
  return header && (entry.type !== 'session' || entry.version !== 3)
    ? '此格式请先用原生Pi打开升级。'
    : undefined;
}
