import { dirname, join, relative, isAbsolute } from 'node:path';
import { realpath, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ExternalPiSdk } from './interface';
export const bytesHash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
/** Resolve only the actual inspected CLI's package and its declared public root export. */
export async function inspectExternalSdk(
  cliPath: string,
  version: string,
): Promise<ExternalPiSdk | undefined> {
  if (version !== '1.5.2') return;
  let directory = dirname(await realpath(cliPath));
  for (let i = 0; i < 6; i++) {
    try {
      const manifestPath = join(directory, 'package.json'),
        bytes = await readFile(manifestPath),
        manifest = JSON.parse(bytes.toString());
      if (manifest.name === '@earendil-works/pi-coding-agent' && manifest.version === version) {
        const root = manifest.exports?.['.'],
          entry = typeof root === 'string' ? root : root?.import;
        if (typeof entry !== 'string' || !entry.startsWith('./')) return;
        const entryPath = await realpath(join(directory, entry)),
          rel = relative(directory, entryPath);
        if (!rel || rel.startsWith('../') || isAbsolute(rel)) return;
        const info = await stat(directory);
        return {
          packagePath: directory,
          entryPath,
          version,
          packageIdentity: `${info.dev}:${info.ino}`,
          manifestHash: bytesHash(bytes),
          entryHash: bytesHash(await readFile(entryPath)),
        };
      }
    } catch {
      /* Keep walking from the observed executable, never from the GUI's module resolver. */
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
