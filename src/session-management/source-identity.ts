import { createHash } from 'node:crypto';
import { openSync, closeSync, readSync, fstatSync } from 'node:fs';

/** Bounded final header check: no event-loop yield between this check and SQLite admission. */
export function matchesSourceIdentity(path: string, identity: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const info = fstatSync(fd),
      bytes = Buffer.alloc(65536);
    const length = readSync(fd, bytes, 0, bytes.length, 0),
      end = bytes.subarray(0, length).indexOf(10);
    return (
      end >= 0 &&
      createHash('sha256')
        .update(`${info.dev}:${info.ino}:${bytes.subarray(0, end).toString('utf8')}`)
        .digest('hex') === identity
    );
  } finally {
    closeSync(fd);
  }
}
