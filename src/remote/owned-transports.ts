import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, checkedDirectory } from './security';

/** Records are written by controlled wrappers before exec, never by remote text. */
export async function cleanupTransportDirectory(directory: string): Promise<void> {
  await checkedDirectory(directory);
  const st = await lstat(directory);
  assert(
    st.uid === process.getuid?.() && (st.mode & 0o077) === 0,
    'Unsafe owned transport directory.',
  );
  const names = (await readdir(directory)).filter((name) =>
    /^(?:root|sftp|hop-[1-4])\.pid$/.test(name),
  );
  for (const name of names.reverse()) {
    const file = await open(
      join(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let record: string;
    try {
      const identity = await file.stat();
      assert(
        identity.isFile() &&
          identity.nlink === 1 &&
          identity.size <= 4096 &&
          identity.uid === process.getuid?.(),
        'Unsafe transport ownership record.',
      );
      record = await file.readFile('utf8');
    } finally {
      await file.close();
    }
    const match = /^\s*([0-9]+)\s+(.+?)\s*$/.exec(record);
    assert(match, 'Incomplete owned transport identity; retained evidence at ' + directory);
    const pid = Number(match[1]);
    const current = await new Promise<string>((resolve, reject) =>
      execFile(
        '/bin/ps',
        ['-p', String(pid), '-o', 'lstart=,stat=,comm='],
        { timeout: 2000, maxBuffer: 4096 },
        (error, stdout) => {
          if (error && (error as { code?: string | number }).code !== 1) reject(error);
          else resolve(stdout.trim());
        },
      ),
    );
    if (!current) continue;
    const identity = /^(.*?)\s+([A-Z+<NsTslWXZa-z]+)\s+(\/.*)$/.exec(current);
    assert(
      identity &&
        identity[1].trim() === match[2].trim() &&
        ['/usr/bin/ssh', '/usr/bin/sftp', '/bin/sh'].includes(identity[3].trim()),
      'Owned transport identity changed; no signal sent. Evidence: ' + directory,
    );
    if (identity[2].includes('Z')) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    const deadline = Date.now() + 2000;
    while (true) {
      const state = await new Promise<string>((resolve) =>
        execFile(
          '/bin/ps',
          ['-p', String(pid), '-o', 'lstart=,stat='],
          { timeout: 1000, maxBuffer: 4096 },
          (_error, stdout) => resolve(stdout.trim()),
        ),
      );
      if (!state || state.includes(' Z') || !state.startsWith(match[2].trim())) break;
      assert(
        Date.now() < deadline,
        'Owned transport did not exit; retained evidence at ' + directory,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** Only called after the previous utility has exited, before another can start. */
export async function cleanupAbandonedTransports(remoteDirectory: string): Promise<void> {
  let names: string[];
  try {
    await checkedDirectory(remoteDirectory);
    names = await readdir(remoteDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names.filter((name) => /^ssh-[a-zA-Z0-9]{6}$/.test(name))) {
    const directory = join(remoteDirectory, name);
    await cleanupTransportDirectory(directory);
    // A wrapper delayed before writing its record now fails its redirection under
    // set -e. It cannot start SSH after this directory has been removed.
    await rm(directory, { recursive: true });
  }
}
