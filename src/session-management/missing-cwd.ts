import { execFileSync } from 'node:child_process';
import { lstatSync, statSync, accessSync, constants } from 'node:fs';
import { dirname, parse } from 'node:path';
/** ENOENT is required. An absent volume, a symlink, permissions or any ambiguous access error is not missing-cwd authorization. */
export function requireMissingCwd(path: string) {
  if (path.startsWith('/Volumes/')) {
    const volume = '/Volumes/' + path.slice(9).split('/')[0];
    const info = lstatSync(volume);
    const mounts = execFileSync('/sbin/mount', [], { encoding: 'utf8', timeout: 3000 });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev === statSync('/Volumes').dev ||
      !mounts.split('\n').some((line) => line.includes(` on ${volume} (`))
    )
      throw Error('原卷挂载状态未确认，不能确认工作目录丢失。');
  }
  try {
    lstatSync(path);
    throw Error('原目录仍存在，不适用目录恢复。');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let parent = dirname(path);
  while (true) {
    try {
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('原目录状态不明确。');
      accessSync(parent, constants.R_OK | constants.X_OK);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || parent === parse(parent).root) throw e;
      parent = dirname(parent);
    }
  }
}
