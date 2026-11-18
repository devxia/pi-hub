import { it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, readdir, symlink, rename, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownedRemoteSSH, until } from '../fixtures/owned-remote-ssh';
import { snapshotInputs, publishDisk } from '../../src/remote/snapshots';
import { hash, checkedDirectory, type SecureFiles } from '../../src/remote/security';
import { discover, agentIdentities } from '../../src/remote/discovery';
import { RemoteService } from '../../src/remote/service';
import { Store } from '../../src/remote/store';
import type { Attempt, Grant, Operation, Reply, Task } from '../../src/remote/contract';
const native = createRequire(import.meta.url)(resolve('dist/remote/secure-fs.node')) as SecureFiles;

it('streams recursive >16 MiB snapshots over actual SFTP, verifies bytes, and publishes atomically', async () => {
  const fixture = await ownedRemoteSSH();
  const { root, transport, server } = fixture;
  try {
    const project = join(root, 'project'),
      reviews = join(root, 'reviews');
    await mkdir(join(project, 'dataset', 'empty'), { recursive: true });
    await mkdir(reviews);
    const large = Buffer.alloc(20 * 1024 * 1024 + 17, 0x51);
    await writeFile(join(project, 'dataset', 'large.bin'), large);
    await writeFile(join(project, 'dataset', 'small.txt'), 'synthetic');
    await writeFile(join(project, 'dataset', '.env'), 'must-exclude');
    const snapshot = await snapshotInputs(project, ['dataset'], reviews, native);
    expect(snapshot.totalBytes).toBe(large.length + 9);
    expect(snapshot.files.map((f) => f.path)).toEqual(['dataset/large.bin', 'dataset/small.txt']);
    expect(snapshot.directories).toContain('dataset/empty');
    const attemptId = randomUUID(),
      executionId = randomUUID();
    expect(
      await transport.upload(server, snapshot, {
        attemptId,
        executionId,
        identity: { attemptId, executionId, marker: 'owned', createdAt: Date.now() },
        supervisorHash: hash(await readFile(resolve('dist/remote/supervisor.py'))),
      }),
    ).toMatchObject({ staged: true });
    const attempt = join(server.root, 'attempts', attemptId);
    expect(hash(await readFile(join(attempt, 'input/dataset/large.bin')))).toBe(hash(large));
    expect(await readdir(join(attempt, 'input/dataset/empty'))).toEqual([]);
    await mkdir(join(attempt, 'output', 'results', 'empty'), { recursive: true });
    await writeFile(join(attempt, 'output', 'results', 'large.bin'), large);
    await writeFile(join(attempt, 'output', 'unrelated.txt'), 'untouched');
    const download = join(root, 'download');
    await mkdir(download, { mode: 0o700 });
    const result = await transport.download(
      server,
      { attemptId, executionId, paths: ['results'] },
      download,
    );
    expect(result.totalBytes).toBe(large.length);
    expect(result.directories).toContain('results/empty');
    const destination = join(root, 'published');
    await publishDisk(
      destination,
      download,
      result.files,
      native,
      await checkedDirectory(root),
      '',
      result.directories,
    );
    expect(hash(await readFile(join(destination, 'results/large.bin')))).toBe(hash(large));
    expect(await readdir(join(destination, 'results/empty'))).toEqual([]);
    expect(await readFile(join(attempt, 'output/unrelated.txt'), 'utf8')).toBe('untouched');
    await expect(
      publishDisk(destination, download, result.files, native, await checkedDirectory(root)),
    ).rejects.toThrow();
    await symlink('large.bin', join(attempt, 'output/results/link'));
    await expect(
      transport.download(server, { attemptId, executionId, paths: ['results'] }, download),
    ).rejects.toThrow(/symlink|regular/i);
    expect(await readdir(join(server.root, '.transfers'))).toEqual([]);
    const bad = snapshot.files.map((f) => ({ ...f, sha256: '0'.repeat(64) }));
    const badId = randomUUID();
    await expect(
      transport.upload(
        server,
        { ...snapshot, files: bad },
        {
          attemptId: badId,
          executionId,
          identity: { attemptId: badId, executionId },
          supervisorHash: hash(await readFile(resolve('dist/remote/supervisor.py'))),
        },
      ),
    ).rejects.toThrow(/digest mismatch/);
    expect(await readdir(join(server.root, 'attempts'))).toEqual([attemptId]);
    expect(await readdir(join(server.root, '.transfers'))).toEqual([]);
    const parent = join(root, 'changed');
    await mkdir(parent);
    const expected = await checkedDirectory(parent);
    await rename(parent, parent + '-old');
    await mkdir(parent);
    await expect(
      publishDisk(join(parent, 'result'), download, result.files, native, expected),
    ).rejects.toThrow(/parent changed/);
    await writeFile(join(download, result.files[0].object), 'tampered');
    await expect(
      publishDisk(
        join(root, 'tampered-result'),
        download,
        result.files,
        native,
        await checkedDirectory(root),
      ),
    ).rejects.toThrow(/摘要|大小/);
  } finally {
    await fixture.close();
  }
}, 60000);

it('interrupts an actual SFTP stream without publishing an attempt or changing unrelated content', async () => {
  const fixture = await ownedRemoteSSH();
  const { root, transport, server } = fixture;
  try {
    const project = join(root, 'project'),
      reviews = join(root, 'reviews');
    await mkdir(project);
    await mkdir(reviews);
    const file = await open(join(project, 'large.bin'), 'wx');
    await file.truncate(128 * 1024 * 1024);
    await file.close();
    const snapshot = await snapshotInputs(project, ['large.bin'], reviews, native);
    const attemptId = randomUUID(),
      executionId = randomUUID();
    await mkdir(server.root, { mode: 0o700 });
    await writeFile(join(server.root, 'unrelated'), 'keep');
    const transfer = transport.upload(server, snapshot, {
      attemptId,
      executionId,
      identity: { attemptId, executionId },
      supervisorHash: hash(await readFile(resolve('dist/remote/supervisor.py'))),
    });
    const observed = transfer.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: String(error) }),
    );
    await until(
      async () => {
        try {
          const tickets = await readdir(join(server.root, '.transfers'));
          for (const token of tickets) {
            try {
              const file = await open(join(server.root, '.transfers', token, '00000000'), 'r');
              const stat = await file.stat();
              await file.close();
              if (stat.size > 0 && stat.size < snapshot.totalBytes) return true;
            } catch {}
          }
        } catch {}
        return false;
      },
      () => false,
      15,
    );
    transport.interrupt(server.id);
    expect((await observed).ok).toBe(false);
    expect(await readdir(join(server.root, 'attempts')).catch(() => [])).not.toContain(attemptId);
    expect(await readFile(join(server.root, 'unrelated'), 'utf8')).toBe('keep');
    expect(await readdir(join(server.root, '.transfers'))).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 45000);

it('reports only acknowledged loopback batches and separates verified result publication', async () => {
  const fixture = await ownedRemoteSSH();
  const { root, server, transport } = fixture;
  const assets = resolve('dist/remote');
  let service: RemoteService | undefined;
  const unwrap = <T>(reply: Reply<T>) => {
    if (!reply.ok) throw Error(reply.error);
    return reply.value;
  };
  try {
    const profile = join(root, 'profile');
    await mkdir(join(profile, 'remote'), { recursive: true, mode: 0o700 });
    const project = join(root, 'project');
    await mkdir(project, { mode: 0o700 });
    const reviewDir = join(root, 'review');
    await mkdir(reviewDir, { mode: 0o700 });
    const attemptId = randomUUID(), executionId = randomUUID();
    const snapshot = await snapshotInputs(project, [], reviewDir, native);
    await transport.upload(server, snapshot, {
      attemptId,
      executionId,
      identity: { attemptId, executionId, marker: 'synthetic', createdAt: Date.now() },
      supervisorHash: hash(await readFile(join(assets, 'supervisor.py'))),
    });
    const output = join(server.root, 'attempts', attemptId, 'output', 'results');
    await mkdir(output, { recursive: true });
    for (let i = 0; i < 17; i++) {
      await writeFile(join(output, String(i).padStart(2, '0') + '.txt'), '1234567890');
    }
    const task: Task = { id: 'owned-task', serverId: server.id, serverRevision: server.revision,
      name: 'Synthetic fetch', project, argv: ['/usr/bin/true'], inputs: [], artifacts: ['results'] };
    const attempt: Attempt = { id: attemptId, executionId, taskId: task.id, server, marker: 'synthetic',
      createdAt: Date.now(), inputDigest: 'synthetic', phase: 'unknown', detail: 'Fixture output', owned: true,
      taskSnapshot: task };
    const seed = new Store(join(profile, 'remote/remote.sqlite'));
    seed.put('server', server.id, server);
    seed.put('task', task.id, task);
    seed.put('attempt', attempt.id, attempt);
    seed.close();
    const seen: { requestId: string; transfer: Operation['transfer'] }[] = [];
    let interrupted = false;
    service = new RemoteService(profile, assets, JSON.parse(await readFile(join(assets, 'assets.json'), 'utf8')), (state) => {
      for (const op of state.operations) {
        if (!op.transfer) continue;
        seen.push({ requestId: op.requestId, transfer: op.transfer });
        if (!interrupted && op.requestId === 'interrupted-fetch' && op.transfer.acknowledgedBytes === 160) {
          interrupted = true;
          void service!.request({ command: 'interrupt', serverId: server.id });
        }
      }
    });
    const grant = unwrap(await service.request({ command: 'grant', grant: {
      taskIds: [task.id], actions: ['fetch'], serverId: server.id, project, expiresAt: Date.now() + 60_000,
    } })) as Grant;
    const credential = JSON.parse(await readFile(grant.tokenPath, 'utf8'));
    const run = async (requestId: string, expected: Operation['status']) => {
      const destination = join(root, requestId);
      const action = { kind: 'fetch', attemptId, destination, paths: ['results'] };
      const operation = async () => unwrap(await service!.cliRequest({ ...credential, request: { command: 'operation', requestId } })) as Operation;
      expect(unwrap(await service!.cliRequest({ ...credential, request: { command: 'propose', requestId, action } }))).toMatchObject({ status: 'preparing' });
      const op = await vi.waitFor(async () => {
        const result = await operation();
        expect(result.status).toBe('review');
        return result;
      });
      unwrap(await service!.request({ command: 'approve', requestId, digest: op.digest, allow: true }));
      const completed = await vi.waitFor(async () => {
        const result = await operation();
        expect(result.status).toBe(expected);
        return result;
      }, { timeout: 15_000 });
      return { completed, destination };
    };
    const partial = await run('interrupted-fetch', 'unknown');
    expect(partial.completed.transfer).toEqual({ acknowledgedBytes: 160, totalBytes: 170 });
    await expect(readdir(partial.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    const full = await run('published-fetch', 'done');
    expect(full.completed.transfer).toEqual({ acknowledgedBytes: 170, totalBytes: 170, publishedBytes: 170 });
    expect(await readFile(join(full.destination, 'results/16.txt'), 'utf8')).toBe('1234567890');
    expect(seen).toContainEqual({ requestId: 'published-fetch', transfer: { acknowledgedBytes: 170, totalBytes: 170 } });
    expect(await readdir(join(server.root, '.transfers'))).toEqual([]);
    await writeFile(join(process.env.PI_HUB_TEST_EVIDENCE!, 'acknowledged-transfers.json'), JSON.stringify({ seen, partial: partial.completed, full: full.completed }, null, 2));
  } finally {
    await service?.close();
    await fixture.close();
  }
}, 45_000);

it('discovers candidates without authentication and uses only the selected owned Agent key on every hop', async () => {
  const fixture = await ownedRemoteSSH();
  const { root, transport, server } = fixture;
  try {
    const unknown = { ...server, hops: server.hops.map((h) => ({ ...h, hostKey: undefined })) };
    const candidate = await discover(unknown, 0, transport);
    expect(candidate.some((k) => k.key === server.hops[0].hostKey)).toBe(true);
    expect(candidate[0].fingerprint).toMatch(/^SHA256:/);
    await expect(transport.run(unknown, { kind: 'probe' })).rejects.toThrow(/every SSH hop/);
    const agent = await fixture.startAgent();
    const identities = await agentIdentities();
    expect(identities.some((k) => k.key === agent.publicKey)).toBe(true);
    const hop = {
      ...server.hops[0],
      identityFile: undefined,
      agent: 'environment' as const,
      agentIdentity: agent.publicKey,
    };
    const agentServer = { ...server, hops: [hop, { ...hop, alias: 'destination' }] };
    const first = await transport.run(agentServer, {
      kind: 'uploadPrepare',
      manifest: [],
      directories: [],
      attemptId: 'owned',
      executionId: 'owned',
      identity: {},
      supervisorHash: 'x',
    });
    expect(first.token).toMatch(/^[a-f0-9]{32}$/);
    await transport.run(agentServer, { kind: 'transferRelease', token: first.token });
    const scanned = await discover(
      { ...agentServer, hops: [hop, { ...hop, hostKey: undefined }] },
      1,
      transport,
    );
    expect(scanned.some((k) => k.key === server.hops[0].hostKey)).toBe(true);
    await expect(
      transport.run(
        { ...server, hops: [{ ...hop, agentIdentity: agent.otherKey }] },
        { kind: 'uploadPrepare', manifest: [], directories: [] },
      ),
    ).rejects.toThrow(/SSH stopped/);
    await expect(
      transport.run({ ...server, hops: [{ ...hop, agentIdentity: undefined }] }, { kind: 'probe' }),
    ).rejects.toThrow(/公钥/);
    expect(await readdir(join(root, 'work'))).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 45000);

it('rejects a replaced remote attempt parent during real commit and never publishes into either directory', async () => {
  const fixture = await ownedRemoteSSH();
  const { root, transport, server } = fixture;
  try {
    const project = join(root, 'project'),
      reviews = join(root, 'reviews');
    await mkdir(project);
    await mkdir(reviews);
    const fd = await open(join(project, 'large.bin'), 'wx');
    await fd.truncate(128 * 1024 * 1024);
    await fd.close();
    const snapshot = await snapshotInputs(project, ['large.bin'], reviews, native),
      attemptId = randomUUID(),
      executionId = randomUUID();
    const result = transport
      .upload(server, snapshot, {
        attemptId,
        executionId,
        identity: { attemptId, executionId },
        supervisorHash: hash(await readFile(resolve('dist/remote/supervisor.py'))),
      })
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error: String(error) }),
      );
    const attempts = join(server.root, 'attempts');
    await until(
      async () => {
        try {
          for (const entry of await readdir(attempts)) {
            if (entry.startsWith('.stage-')) {
              try {
                const fd = await open(join(attempts, entry, 'input/large.bin'), 'r');
                const st = await fd.stat();
                await fd.close();
                if (st.size > 0 && st.size < snapshot.totalBytes) return true;
              } catch {}
            }
          }
        } catch {}
        return false;
      },
      () => false,
      20,
    );
    await rename(attempts, attempts + '-replaced');
    await mkdir(attempts, { mode: 0o700 });
    await writeFile(join(attempts, 'unrelated'), 'keep');
    expect(await result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/parent directory replaced/),
    });
    expect(await readdir(attempts)).toEqual(['unrelated']);
    expect(await readdir(attempts + '-replaced')).toEqual([]);
    expect(await readFile(join(attempts, 'unrelated'), 'utf8')).toBe('keep');
  } finally {
    await fixture.close();
  }
}, 45000);
