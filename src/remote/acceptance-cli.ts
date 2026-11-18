import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transport } from './transport';
import { hash, validateServer, assert } from './security';
import type { Server } from './contract';

declare const __REMOTE_BASE_ASSETS__: Record<string, string>;

/** Standalone explicit host operator tool; it has no Agent/grant or application profile authority. */
async function main() {
  assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ is required.');
  const args = process.argv.slice(2);
  assert(
    args.includes('--authorize-owned-resources'),
    'Explicit --authorize-owned-resources is required. This tool creates only fresh synthetic resources on the selected authorized host.',
  );
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const bindingFile = option('--binding');
  if (bindingFile) {
    const binding = JSON.parse(await readFile(bindingFile, 'utf8'));
    assert(
      binding.schema === 1 &&
        binding.nodePath === (await realpath(process.execPath)) &&
        binding.toolPath === (await realpath(fileURLToPath(import.meta.url))) &&
        binding.nodeHash === hash(await readFile(process.execPath)) &&
        binding.toolHash === hash(await readFile(fileURLToPath(import.meta.url))),
      'Acceptance launcher integrity binding changed.',
    );
  }
  const config = option('--server-file'),
    evidenceDirectory = option('--evidence-dir');
  assert(
    config && evidenceDirectory && isAbsolute(config) && isAbsolute(evidenceDirectory),
    'Use --server-file /explicit/server.json --evidence-dir /new/evidence-directory.',
  );
  const server = JSON.parse(await readFile(config, 'utf8')) as Server;
  validateServer(server);
  assert(
    server.hops.every((h) => h.hostKey),
    'Review every host key before acceptance. Discovery and trust belong in Pi Hub.',
  );
  if (server.backend === 'linux')
    assert(
      Number.isInteger(Number(option('--logout-window-seconds'))) &&
        Number(option('--logout-window-seconds')) >= 30 &&
        Number(option('--logout-window-seconds')) <= 3600,
      'Explicit --logout-window-seconds 30..3600 must cover the authorized host’s known delayed cleanup policy. Unknown policy remains unverified.',
    );
  // The evidence directory must be new: historical failures cannot be overwritten.
  await mkdir(evidenceDirectory, { mode: 0o700 });
  const assets = await realpath(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(await readFile(join(assets, 'assets.json'), 'utf8'));
  for (const [name, expected] of Object.entries(__REMOTE_BASE_ASSETS__))
    assert(
      manifest[name] === expected && hash(await readFile(join(assets, name))) === expected,
      'Acceptance package integrity changed: ' + name,
    );
  const work = join(evidenceDirectory, 'transport');
  await mkdir(work, { mode: 0o700 });
  const transport = new Transport(work, assets, manifest);
  let token = option('--resume-token');
  try {
    const binding = {
      argv: args,
      cwd: process.cwd(),
      node: process.version,
      executable: await realpath(process.execPath),
      serverDigest: hash(await readFile(config)),
      assets: manifest,
      start: new Date().toISOString(),
    };
    await writeFile(join(evidenceDirectory, 'invocation.json'), JSON.stringify(binding, null, 2), {
      mode: 0o600,
    });
    if (!token) {
      const result = await transport.run(server, {
        kind: 'acceptanceStart',
        backend: server.backend,
        mode: option('--cancel-mode') ?? 'constraints',
        mismatchCluster: option('--authorized-mismatch-cluster'),
        logoutWindowSeconds: Number(option('--logout-window-seconds')),
      });
      token = result.token;
      await writeFile(join(evidenceDirectory, 'start.json'), JSON.stringify(result, null, 2));
      console.log('Owned acceptance ticket:', token);
      if (result.pending) {
        console.log(
          'Disconnecting tool SSH sessions for the declared logind policy window. Other sessions keep this check unverified.',
        );
        await new Promise((resolveWait) => setTimeout(resolveWait, result.quietSeconds * 1000));
      }
    }
    const result = await transport.run(server, { kind: 'acceptanceStatus', token });
    await writeFile(join(evidenceDirectory, 'raw-evidence.json'), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    const required =
      server.backend === 'linux'
        ? [
            'lastLogout',
            'termTree',
            'killTree',
            'reapersECHILD',
            'crashNoReplay',
            'mainExitRace',
            'helperLossUnknown',
            'staleIdentity',
          ]
        : ['controllerFilters', 'jobIdReuse', 'ownerMismatch', 'clusterMismatch', 'uniqueName'];
    const passed =
      result.complete === true && required.every((key) => result.evidence?.checks?.[key] === true);
    if (passed && args.includes('--publish')) {
      const receipt = await transport.run(server, { kind: 'acceptancePublish', token });
      await writeFile(
        join(evidenceDirectory, 'published-receipt.json'),
        JSON.stringify(receipt, null, 2),
        { mode: 0o600 },
      );
    }
    await writeFile(
      join(evidenceDirectory, 'result.json'),
      JSON.stringify(
        {
          passed,
          published: passed && args.includes('--publish'),
          token,
          endedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    assert(
      passed,
      'Actual acceptance incomplete or failed. Capability remains closed; inspect raw evidence and retain this run.',
    );
    console.log(
      'Actual checks passed.',
      args.includes('--publish')
        ? 'Bound receipt published for one day.'
        : 'Use a new evidence directory with --resume-token ' + token + ' --publish to publish.',
    );
  } catch (error) {
    await writeFile(
      join(evidenceDirectory, 'failure.json'),
      JSON.stringify(
        {
          passed: false,
          token,
          error: String(error instanceof Error ? error.message : error),
          endedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    throw error;
  } finally {
    await transport.close();
  }
}
main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
