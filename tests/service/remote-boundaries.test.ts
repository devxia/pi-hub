import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  symlink,
  link,
  lstat,
  readdir,
  rm,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { Transport } from '../../src/remote/transport';
import { RemoteService } from '../../src/remote/service';
import { Store } from '../../src/remote/store';
import {
  hash,
  snapshot,
  publishResults,
  checkedDirectory,
  type SecureFiles,
} from '../../src/remote/security';
import type {
  Attempt,
  Server,
  Task,
  Operation,
  Request,
  ReviewPage,
  Grant,
  Reply,
} from '../../src/remote/contract';
const assets = resolve('dist/remote'),
  native = createRequire(import.meta.url)(join(assets, 'secure-fs.node')) as SecureFiles;
let root: string, profile: string, project: string, service: RemoteService | undefined;
const unwrap = <T>(r: Reply<T>): T => {
  if (!r.ok) throw Error(r.error);
  return r.value;
};
const server: Server = {
  id: 'owned-server',
  revision: 0,
  name: 'Owned fixture; no network',
  backend: 'linux',
  root: '/owned/remote',
  hops: [{ alias: 'owned', host: '127.0.0.1', user: 'owned', port: 1 }],
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-remote-boundary-')));
  profile = join(root, 'profile');
  project = join(root, 'project');
  await mkdir(join(profile, 'remote'), { recursive: true, mode: 0o700 });
  await mkdir(project);
  await writeFile(join(project, 'input.txt'), 'synthetic safe');
});
afterEach(async () => {
  await service?.close();
  service = undefined;
  await rm(root, { recursive: true, force: true });
});
async function setup() {
  const manifest = JSON.parse(await readFile(join(assets, 'assets.json'), 'utf8'));
  service = new RemoteService(profile, assets, manifest);
  unwrap(await service.request({ command: 'saveServer', server }));
  const task: Task = {
    id: 'owned-task',
    serverId: server.id,
    serverRevision: 1,
    project,
    name: 'Synthetic foreground',
    argv: ['/usr/bin/true'],
    inputs: ['input.txt'],
    artifacts: ['stdout.log'],
  };
  unwrap(await service.request({ command: 'saveTask', task }));
  return task;
}
async function prepared(request: Extract<Request, { command: 'propose' }>) {
  const reserved = unwrap(await service!.request(request)) as Operation;
  expect(reserved.status).toBe('preparing');
  expect(reserved.digest).toBe('');
  return await review(request.requestId);
}
async function review(requestId: string) {
  return await vi.waitFor(async () => {
    const op = unwrap(await service!.request({ command: 'operation', requestId })) as Operation;
    expect(op.status, op.detail).toBe('review');
    return op;
  });
}
describe('remote filesystem and durable authority boundaries', () => {
  it('retains immutable server revisions and explicit source/default associations when editing tasks', async () => {
    const task = await setup();
    const updated = unwrap(
      await service!.request({
        command: 'saveServer',
        server: {
          ...server,
          revision: 1,
          defaults: { environment: { OMP_NUM_THREADS: '2' } },
        },
      }),
    ) as Server;
    const saved = unwrap(
      await service!.request({
        command: 'saveTask',
        task: {
          ...task,
          serverRevision: updated.revision,
          source: { projectId: 'owned-project', sessionId: 'native-id' },
          artifacts: ['metrics.json'],
          progressMapping: {
            file: 'metrics.json',
            completed: 'step',
            total: 'total',
            metrics: {},
          },
        },
      }),
    ) as Task;
    expect(saved.progressMapping?.file).toBe('metrics.json');
    expect(saved.environment).toEqual({ OMP_NUM_THREADS: '2' });
    expect(saved.source?.sessionId).toBe('native-id');
    const op = await prepared({
        command: 'propose',
        requestId: 'review-version',
        action: { kind: 'submit', taskId: task.id },
      });
    await service!.request({ command: 'saveServer', server: updated });
    expect(
      (
        await service!.request({
          command: 'approve',
          requestId: op.requestId,
          digest: op.digest,
          allow: true,
        })
      ).ok,
    ).toBe(false);
  });
  it('reads actual bytes, rejects final/ancestor symlinks, hardlinks and excluded inputs', async () => {
    const files = await snapshot(project, ['input.txt'], native);
    expect(files[0].sha256).toBe(hash('synthetic safe'));
    await symlink('input.txt', join(project, 'link'));
    await expect(snapshot(project, ['link'], native)).rejects.toThrow();
    await link(join(project, 'input.txt'), join(project, 'hard'));
    await expect(snapshot(project, ['hard'], native)).rejects.toThrow();
    await symlink(project, join(root, 'alias'));
    await expect(snapshot(join(root, 'alias'), ['input.txt'], native)).rejects.toThrow();
    await expect(snapshot(project, ['.env'], native)).rejects.toThrow(/Excluded/);
  });
  it('publishes bounded verified artifacts once and rejects changed destination parents', async () => {
    const dest = join(root, 'results'),
      expected = await checkedDirectory(root),
      files = [
        {
          path: 'nested/file.txt',
          data: Buffer.from('result').toString('base64'),
          sha256: hash('result'),
          size: 6,
        },
      ];
    await publishResults(dest, files, native, expected);
    expect(await readFile(join(dest, 'nested/file.txt'), 'utf8')).toBe('result');
    await expect(publishResults(dest, files, native, expected)).rejects.toThrow();
    await expect(
      publishResults(
        join(root, 'another'),
        [{ ...files[0], sha256: 'bad' }],
        native,
        expected,
      ),
    ).rejects.toThrow(/integrity/);
    const parent = join(root, 'parent');
    await mkdir(parent);
    const old = await checkedDirectory(parent);
    await rename(parent, join(root, 'old-parent'));
    await mkdir(parent);
    await expect(publishResults(join(parent, 'r'), files, native, old)).rejects.toThrow(
      /parent changed/,
    );
  });
  it('requires exact target revision for atomic replacement and retains the previous directory', async () => {
    const dest = join(root, 'existing');
    await mkdir(dest);
    await writeFile(join(dest, 'old.txt'), 'old result');
    const expected = await checkedDirectory(root),
      target = native.inspect(dest),
      files = [
        {
          path: 'new.txt',
          data: Buffer.from('new').toString('base64'),
          sha256: hash('new'),
          size: 3,
        },
      ];
    await writeFile(join(dest, 'old.txt'), 'changed');
    await expect(publishResults(dest, files, native, expected, target)).rejects.toThrow(
      /target changed/,
    );
    const current = native.inspect(dest),
      backup = await publishResults(dest, files, native, expected, current);
    expect(await readFile(join(dest, 'new.txt'), 'utf8')).toBe('new');
    expect(await readFile(join(backup!, 'old.txt'), 'utf8')).toBe('changed');
  });
  it('never follows a raced ancestor into synthetic outside data', async () => {
    const safe = join(project, 'dir'),
      outside = join(root, 'outside');
    await mkdir(safe);
    await mkdir(outside);
    await writeFile(join(safe, 'value'), 'safe');
    await writeFile(join(outside, 'value'), 'outside');
    const script = `const fs=require('fs');const [p,o]=process.argv.slice(1);for(let i=0;i<3000;i++){try{fs.renameSync(p,p+'.hold');fs.symlinkSync(o,p);fs.unlinkSync(p);fs.renameSync(p+'.hold',p);}catch{}}`;
    const child = spawn(process.execPath, ['-e', script, safe, outside], { stdio: 'ignore' });
    const ended = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    try {
      for (let i = 0; i < 1000; i++) {
        try {
          const got = native.snapshot(project, ['dir/value']);
          expect(got[0].bytes.toString()).toBe('safe');
        } catch (e) {
          if (e instanceof Error && e.message.includes('expected')) throw e;
        }
      }
    } finally {
      await ended;
    }
    expect(child.exitCode).toBe(0);
  });
  it('reserves once before preparing and keeps reviewed bytes on retries', async () => {
    const task = await setup();
    const op = await prepared({
        command: 'propose',
        requestId: 'request-one',
        action: { kind: 'submit', taskId: task.id },
      });
    expect(op.status).toBe('review');
    expect(service!.state().operations[0].digest).toBe(op.digest);
    await writeFile(join(project, 'input.txt'), 'changed');
    const reply = await service!.request({
      command: 'propose',
      requestId: 'request-one',
      action: { kind: 'submit', taskId: task.id },
    });
    expect(unwrap(reply)).toMatchObject({ digest: op.digest, status: 'review' });
    const page = unwrap(await service!.request({ command: 'reviewPage',
      requestId: op.requestId, digest: op.digest, offset: 0 })) as ReviewPage;
    expect(page.entries).toEqual([{ path: 'input.txt', size: 14, sha256: hash('synthetic safe') }]);
    const bad = await service!.request({
      command: 'approve',
      requestId: op.requestId,
      digest: 'f'.repeat(64),
      allow: true,
    });
    expect(bad.ok).toBe(false);
  });
  it('recovers snapshots on restart, expires and declines reviews, and leaves unowned bytes intact', async () => {
    const task = await setup();
    const manifest = JSON.parse(await readFile(join(assets, 'assets.json'), 'utf8'));
    const database = join(profile, 'remote/remote.sqlite');
    const parent = join(profile, 'remote/reviews');
    const request = (requestId: string) => ({
      command: 'propose', requestId, action: { kind: 'submit', taskId: task.id },
    }) as const;
    const [first, retry] = await Promise.all([
      service!.request(request('active')), service!.request(request('active')),
    ]);
    expect(unwrap(first)).toEqual(unwrap(retry));
    expect(unwrap(first)).toMatchObject({ status: 'preparing', digest: '' });
    expect((await service!.request({ command: 'approve', requestId: 'active', digest: '', allow: true })).ok).toBe(false);
    const active = await review('active');
    const expired = await prepared(request('expires'));
    const abandoned = await prepared(request('abandoned'));
    const denied = await prepared(request('declined'));
    unwrap(await service!.request({ command: 'approve', requestId: denied.requestId, digest: denied.digest, allow: false }));
    expect((await readdir(parent))).toHaveLength(3);
    await service!.close();
    service = undefined;
    const seed = new Store(database);
    const pending = seed.get<Operation>('operation', 'abandoned')!;
    const timedOut = seed.get<Operation>('operation', 'expires')!;
    seed.put('operation', pending.requestId, { ...pending, status: 'preparing', digest: '' });
    seed.put('operation', timedOut.requestId, { ...timedOut, expiresAt: Date.now() - 1 });
    seed.close();
    const unowned = join(parent, '11111111-1111-1111-1111-111111111111');
    await mkdir(unowned, { mode: 0o700 });
    await writeFile(join(unowned, '00000000'), 'unowned');
    service = new RemoteService(profile, assets, manifest);
    const status = async (requestId: string) => unwrap(await service!.request({ command: 'operation', requestId }));
    expect(await status('active')).toMatchObject({ status: 'review', digest: active.digest });
    expect(await status('expires')).toMatchObject({ status: 'expired', digest: expired.digest });
    expect(await status('abandoned')).toMatchObject({ status: 'blocked', digest: '' });
    expect(await status('declined')).toMatchObject({ status: 'denied', digest: denied.digest });
    expect(unwrap(await service.request(request('abandoned')))).toMatchObject({ status: 'blocked' });
    expect(await readdir(parent)).toHaveLength(2);
    expect(await readFile(join(unowned, '00000000'), 'utf8')).toBe('unowned');
    expect((await service.request({ command: 'reviewPage', requestId: 'abandoned', digest: abandoned.digest, offset: 0 })).ok).toBe(false);
    const historical = unwrap(await service.request({ command: 'reviewPage', requestId: 'declined', digest: denied.digest, offset: 0 })) as ReviewPage;
    expect(historical.entries).toHaveLength(1);
  });
  it('bounds a large manifest and history through the public requests', async () => {
    const task = await setup();
    const dataset = join(project, 'dataset');
    await mkdir(dataset);
    for (let i = 0; i < 1100; i += 25) {
      await Promise.all(Array.from({ length: 25 }, (_, j) => writeFile(
        join(dataset, String(i + j).padStart(4, '0') + '.txt'), 'synthetic',
      )));
    }
    unwrap(await service!.request({ command: 'saveTask', task: { ...task, inputs: ['dataset'] } }));
    const proposed = unwrap(await service!.request({
      command: 'propose', requestId: 'large-manifest', action: { kind: 'submit', taskId: task.id },
    }));
    expect(proposed).toMatchObject({ status: 'preparing' });
    const op = await vi.waitFor(async () => {
      const result = unwrap(await service!.request({ command: 'operation', requestId: 'large-manifest' })) as Operation;
      expect(result.status, result.detail).toBe('review');
      return result;
    }, { timeout: 15_000 });
    expect(JSON.stringify(op).length).toBeLessThan(4096);
    expect(op.review).toMatchObject({ manifest: { fileCount: 1100, directoryCount: 1, totalBytes: 9900 } });
    const entries: ReviewPage['entries'] = [];
    let offset: number | null = 0;
    do {
      const page = unwrap(await service!.request({ command: 'reviewPage', requestId: op.requestId, digest: op.digest, offset })) as ReviewPage;
      expect(page.entries.length).toBeLessThanOrEqual(24);
      entries.push(...page.entries);
      offset = page.next;
    } while (offset !== null);
    expect(entries).toHaveLength(1101);
    expect(entries[1099]).toEqual({ path: 'dataset/1099.txt', size: 9, sha256: hash('synthetic') });
    expect(entries[1100]).toEqual({ path: 'dataset' });
    const seed = new Store(join(profile, 'remote/remote.sqlite'));
    const persisted = seed.get<Operation>('operation', op.requestId)!;
    for (let i = 0; i < 32; i++) {
      const requestId = `historical-${i}`;
      seed.put('operation', requestId, { ...persisted, requestId, status: 'denied', review: {} });
    }
    seed.close();
    const state = service!.state();
    expect(state.operations).toHaveLength(31);
    expect(state.operations[0].requestId).toBe(op.requestId);
    expect(state.nextOperationPage).toBe(30);
    expect(unwrap(await service!.request({ command: 'operations', offset: 30 }))).toMatchObject({
      operations: [{ requestId: 'historical-1' }, { requestId: 'historical-0' }, { requestId: op.requestId }], next: null,
    });
  }, 20_000);
  it('blocks unverified managed Linux before any transport or attempt and never calls it success', async () => {
    const task = await setup();
    const op = await prepared({
        command: 'propose',
        requestId: 'blocked-launch',
        action: { kind: 'submit', taskId: task.id },
      });
    unwrap(
      await service!.request({
        command: 'approve',
        requestId: op.requestId,
        digest: op.digest,
        allow: true,
      }),
    );
    await vi.waitFor(() => expect(service!.state().operations[0].status).toBe('blocked'));
    expect(await readdir(join(profile, 'remote/reviews'))).toEqual([]);
    expect(service!.state().attempts).toHaveLength(0);
    expect(await readdir(join(profile, 'remote'))).not.toContain('ssh-');
  });
  it('enforces exact expiring/revoked grants and GUI-only approval', async () => {
    const task = await setup();
    const grant = unwrap(
      await service!.request({
        command: 'grant',
        grant: {
          serverId: server.id,
          project,
          taskIds: [task.id],
          actions: ['observe', 'submit'],
          expiresAt: Date.now() + 60000,
        },
      }),
    ) as Grant;
    expect((await lstat(grant.tokenPath)).mode & 0o077).toBe(0);
    const credential = JSON.parse(await readFile(grant.tokenPath, 'utf8'));
    const scoped = await service!.cliRequest({
      ...credential,
      request: { command: 'snapshot' },
    });
    expect(scoped.ok).toBe(true);
    expect(JSON.stringify(scoped)).not.toContain('identityFile');
    expect(JSON.stringify(scoped)).not.toContain('hostKey');
    expect(
      (await service!.cliRequest({ ...credential, request: { command: 'approve' } })).ok,
    ).toBe(false);
    expect(
      (
        await service!.cliRequest({
          ...credential,
          request: {
            command: 'propose',
            requestId: 'outside-scope',
            action: { kind: 'submit', taskId: 'unknown' },
          },
        })
      ).ok,
    ).toBe(false);
    const proposal = await service!.cliRequest({
      ...credential,
      request: {
        command: 'propose',
        requestId: 'agent-proposal',
        action: { kind: 'submit', taskId: task.id },
      },
    });
    expect(proposal.ok).toBe(true);
    unwrap(await service!.request({ command: 'revoke', grantId: grant.id }));
    expect(
      (await service!.cliRequest({ ...credential, request: { command: 'snapshot' } })).ok,
    ).toBe(false);
    const op = await review((unwrap(proposal) as Operation).requestId);
    expect(
      (
        await service!.request({
          command: 'approve',
          requestId: op.requestId,
          digest: op.digest,
          allow: true,
        })
      ).ok,
    ).toBe(false);
  });
  it('revokes authority when an edited task leaves its granted project', async () => {
    const task = await setup(),
      grant = unwrap(
        await service!.request({
          command: 'grant',
          grant: {
            serverId: server.id,
            project,
            taskIds: [task.id],
            actions: ['observe', 'submit'],
            expiresAt: Date.now() + 60000,
          },
        }),
      ) as Grant,
      credential = JSON.parse(await readFile(grant.tokenPath, 'utf8')),
      other = join(root, 'other-project');
    await mkdir(other);
    expect(
      (await service!.cliRequest({ ...credential, request: { command: 'snapshot' } })).ok,
    ).toBe(true);
    expect(
      (await service!.request({ command: 'saveTask', task: { ...task, project: other } })).ok,
    ).toBe(true);
    expect(
      await service!.cliRequest({ ...credential, request: { command: 'snapshot' } }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('scope changed') });
  });
  it('fetch scope remains bound to the historical attempt when its task is edited', async () => {
    const task = await setup();
    await service!.close();
    service = undefined;
    const store = new Store(join(profile, 'remote/remote.sqlite'));
    store.put('attempt', 'historical', {
      id: 'historical',
      executionId: 'execution',
      taskId: task.id,
      server: { ...server, revision: 1 },
      createdAt: Date.now(),
      phase: 'unknown',
      marker: 'owned',
      detail: 'Historical identity fixture; no remote success claimed.',
      inputDigest: 'x',
      owned: true,
      taskSnapshot: task,
    });
    store.close();
    service = new RemoteService(
      profile,
      assets,
      JSON.parse(await readFile(join(assets, 'assets.json'), 'utf8')),
    );
    expect(
      (
        await service.request({
          command: 'saveTask',
          task: { ...task, artifacts: ['out.txt', 'private.txt'] },
        })
      ).ok,
    ).toBe(true);
    const denied = await service.request({
      command: 'propose',
      requestId: 'widened-fetch',
      action: {
        kind: 'fetch',
        attemptId: 'historical',
        paths: ['private.txt'],
        destination: join(root, 'result'),
      },
    });
    expect(denied).toMatchObject({
      ok: false,
      error: expect.stringContaining('explicitly allowed artifacts'),
    });
  });
  it('recovers interrupted approved operations as unknown without replay; rejects expired grants', async () => {
    const task = await setup();
    const op = await prepared({
        command: 'propose',
        requestId: 'interrupted',
        action: { kind: 'submit', taskId: task.id },
      });
    const grant = unwrap(
      await service!.request({
        command: 'grant',
        grant: {
          serverId: server.id,
          project,
          taskIds: [task.id],
          actions: ['observe'],
          expiresAt: Date.now() + 60000,
        },
      }),
    ) as Grant;
    const credential = JSON.parse(await readFile(grant.tokenPath, 'utf8'));
    await service!.close();
    service = undefined;
    const store = new Store(join(profile, 'remote', 'remote.sqlite'));
    const persistedOp = store.get<Operation>('operation', op.requestId)!;
    store.put('operation', op.requestId, { ...persistedOp, status: 'approved' });
    const persisted = store.get<any>('grant', grant.id);
    store.put('grant', grant.id, { ...persisted, expiresAt: Date.now() - 1 });
    store.close();
    service = new RemoteService(
      profile,
      assets,
      JSON.parse(await readFile(join(assets, 'assets.json'), 'utf8')),
    );
    expect(service.state().operations[0].status).toBe('unknown');
    expect(service.pending()).toBe(1);
    expect(service.state().attempts).toHaveLength(0);
    expect(
      (await service.cliRequest({ ...credential, request: { command: 'snapshot' } })).ok,
    ).toBe(false);
  });
  it('refreshes mapped progress from the runner and rejects stale or other-generation samples', async () => {
    const task = await setup();
    const mappedTask: Task = {
      ...task,
      artifacts: ['metrics.json'],
      progressMapping: {
        file: 'metrics.json',
        completed: 'step',
        total: 'count',
        metrics: {},
      },
    };
    const attempt: Attempt = {
      id: 'mapped',
      executionId: 'execution',
      taskId: task.id,
      server: { ...server, revision: 1 },
      createdAt: Date.now(),
      phase: 'running',
      marker: 'owned',
      detail: '',
      inputDigest: 'x',
      owned: true,
      taskSnapshot: mappedTask,
    };
    await service!.close();
    service = undefined;
    const store = new Store(join(profile, 'remote/remote.sqlite'));
    store.put('attempt', attempt.id, attempt);
    store.close();
    service = new RemoteService(
      profile,
      assets,
      JSON.parse(await readFile(join(assets, 'assets.json'), 'utf8')),
    );
    const outputDir = join(root, 'output');
    await mkdir(outputDir);
    await writeFile(
      join(outputDir, 'progress.json'),
      JSON.stringify({ step: 99, count: 100 }),
    );
    const script = [
      'import json, os, runpy, sys',
      'runner = runpy.run_path(sys.argv[1])',
      'transfer = runpy.run_path(sys.argv[2])',
      'streams = runner["streams"]',
      'streams.__globals__.update({k: v for k, v in transfer.items() if k.startswith("tf_")})',
      'retained = runner["directory"](sys.argv[3])',
      'result = streams(retained, json.loads(sys.argv[4]))',
      'os.fstat(int(retained.rsplit("/", 1)[1]))',
      'print(json.dumps(result))',
    ].join('\n');
    // Adapt only SSH and kernel state on Darwin. Each sample is read by the production Python reader.
    const run = vi
      .spyOn(Transport.prototype, 'run')
      .mockImplementation(async (_server, request) => {
        if ((request as { kind: string }).kind !== 'observe') return { jobs: [] };
        const raw = execFileSync(
          '/usr/bin/python3',
          [
            '-c',
            script,
            join(assets, 'runner.py'),
            join(assets, 'transfer.py'),
            root,
            JSON.stringify(request),
          ],
          { env: { PATH: '/usr/bin:/bin', HOME: root }, encoding: 'utf8' },
        );
        return { phase: 'running', ...JSON.parse(raw) };
      });
    const refresh = async (document: unknown) => {
      await writeFile(join(outputDir, 'metrics.json'), JSON.stringify(document));
      const before = service!.state().attempts[0].lastObservedAt ?? 0;
      unwrap(await service!.request({ command: 'refresh', serverId: server.id }));
      await vi.waitFor(() =>
        expect(service!.state().attempts[0].lastObservedAt).toBeGreaterThan(before),
      );
      return service!.state().attempts[0];
    };
    try {
      const data = {
        schemaVersion: 1,
        attemptId: attempt.id,
        executionId: attempt.executionId,
        updatedAt: Date.now(),
        count: 10,
      };
      expect((await refresh({ ...data, sequence: 2, step: 4 })).progress).toMatchObject({
        sequence: 2,
        completed: 4,
      });
      expect((await refresh({ ...data, sequence: 2, step: 5 })).progress?.completed).toBe(4);
      expect(
        (await refresh({ ...data, sequence: 3, executionId: 'other', step: 8 })).progress
          ?.completed,
      ).toBe(4);
      expect(
        (await refresh({ ...data, sequence: 3, updatedAt: data.updatedAt - 1000, step: 6 }))
          .progress?.completed,
      ).toBe(6);
      expect((await refresh({ step: 7, count: 10 })).progress?.sequence).toBe(4);
      expect((await refresh({ step: 7, count: 10 })).progress?.sequence).toBe(4);
      expect(run).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'observe', progressFile: 'metrics.json' }),
      );
    } finally {
      run.mockRestore();
    }
  });
  it('refreshes a submitted Slurm identity and adopts the same typed queue observation', async () => {
    const manifest = JSON.parse(await readFile(join(assets, 'assets.json'), 'utf8'));
    const scheduler: Server = { ...server, backend: 'slurm', root: join(root, 'scheduler') };
    const createdAt = Date.now();
    const attempt: Attempt = {
      id: 'scheduler-attempt',
      executionId: 'execution',
      taskId: 'owned-task',
      server: {
        ...scheduler,
        revision: 1,
        capability: { user: 'owned' } as Server['capability'],
      },
      createdAt,
      phase: 'queued',
      marker: 'owned-marker',
      detail: '',
      inputDigest: 'fixture',
      owned: true,
      ref: {
        kind: 'slurm',
        jobId: '123',
        cluster: '',
        owner: 'owned',
        name: 'owned-marker',
        submittedAt: '',
      },
    };
    const attemptDir = join(scheduler.root, 'attempts', attempt.id);
    await mkdir(join(attemptDir, 'output'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(attemptDir, 'attempt.json'),
      JSON.stringify({
        executionId: attempt.executionId,
        marker: attempt.marker,
        createdAt,
      }),
    );
    const seed = new Store(join(profile, 'remote/remote.sqlite'));
    seed.put('server', scheduler.id, attempt.server);
    seed.put('attempt', attempt.id, attempt);
    seed.close();
    service = new RemoteService(profile, assets, manifest);

    const typedJob = {
      job_id: { set: true, number: 123 },
      cluster: 'fixture-cluster',
      user_name: 'owned',
      name: attempt.marker,
      time: { submission: { set: true, number: Math.floor(createdAt / 1000) } },
      state: { current: ['RUNNING'] },
      working_directory: join(attemptDir, 'input'),
      restart_cnt: { set: true, number: 0 },
    };
    const script = [
      'import json, os, re, runpy, sys, types',
      'main = runpy.run_path(sys.argv[1])["main"]',
      'transfer = runpy.run_path(sys.argv[2])',
      'body, jobs = json.loads(sys.argv[3])',
      'calls = []',
      'def command(argv):',
      '    calls.append(argv)',
      '    records = jobs[argv[0]]',
      '    if records is None:',
      '        raise RuntimeError("synthetic scheduler unavailable")',
      '    return json.dumps({"jobs": records})',
      'main.__globals__.update({k: v for k, v in transfer.items() if k.startswith("tf_")})',
      '# Darwin lacks /proc. Adapt its stat alias and known control file at the filesystem boundary.',
      'def stat_path(path, *args, **kwargs):',
      '    held = re.fullmatch(r"/proc/self/fd/([0-9]+)", path)',
      '    return os.fstat(int(held[1])) if held else os.stat(path, *args, **kwargs)',
      'portable_os = types.SimpleNamespace(**vars(os))',
      'portable_os.stat = stat_path',
      'read_json = main.__globals__["read_json"]',
      'def read_control(path, *args):',
      '    assert path.endswith("/attempt.json")',
      '    return read_json(sys.argv[4], *args)',
      'main.__globals__.update(command=command, host=lambda: {"user": "owned"}, read_json=read_control, os=portable_os)',
      'print(json.dumps({"result": main(body), "calls": calls}))',
    ].join('\n');
    const calls: { kind: string; commands: string[][] }[] = [];
    let jobs: Record<string, unknown> = { squeue: [typedJob], sacct: null };
    // Adapt SSH, Linux descriptor paths and scheduler command output on Darwin.
    const run = vi
      .spyOn(Transport.prototype, 'run')
      .mockImplementation(async (_server, request) => {
        const output = execFileSync(
          '/usr/bin/python3',
          [
            '-c',
            script,
            join(assets, 'runner.py'),
            join(assets, 'transfer.py'),
            JSON.stringify([{ root: scheduler.root, request }, jobs]),
            join(attemptDir, 'attempt.json'),
          ],
          { env: { PATH: '/usr/bin:/bin', HOME: root }, encoding: 'utf8' },
        );
        const { result, calls: commands } = JSON.parse(output);
        calls.push({ kind: (request as { kind: string }).kind, commands });
        return result;
      });
    const owned = () => service!.state().attempts.find((a) => a.id === attempt.id)!;
    const refresh = () =>
      service!.request({ command: 'refresh', serverId: scheduler.id }).then(unwrap);
    try {
      await refresh();
      await vi.waitFor(() => expect(owned().phase).toBe('running'));
      const ref = service!.state().queues[0].rows[0].ref;
      expect(ref).toEqual(owned().ref);
      expect(ref).toMatchObject({
        jobId: '123',
        cluster: 'fixture-cluster',
        submittedAt: String(Math.floor(createdAt / 1000)),
      });
      const task: Task = { id: 'scoped-task', name: 'Synthetic Slurm task', serverId: scheduler.id,
        serverRevision: 1, project, argv: ['/usr/bin/true'], inputs: [], artifacts: [] };
      unwrap(await service!.request({ command: 'saveTask', task }));
      const g = unwrap(await service!.request({ command: 'grant', grant: {
        serverId: scheduler.id, project, taskIds: [task.id], actions: ['observe', 'adopt'], expiresAt: Date.now() + 60000,
      } })) as Grant;
      const credential = JSON.parse(await readFile(g.tokenPath, 'utf8'));
      const adopted = unwrap(await service!.cliRequest({ ...credential, request: { command: 'adopt', taskId: task.id, job: ref } })) as Attempt;
      expect(adopted).toEqual({ id: expect.any(String), taskId: task.id, executionId: expect.any(String), owned: false, phase: 'unknown' });
      const scoped = new Store(join(profile, 'remote/remote.sqlite'));
      const persisted = scoped.get<Attempt>('attempt', adopted.id)!;
      const historicalServer = { ...persisted.server, hops: [{ ...persisted.server.hops[0], identityFile: '/owned/historical-key', certificateFile: '/owned/historical-cert' }] };
      scoped.put('attempt', adopted.id, { ...persisted, server: historicalServer });
      scoped.put('attempt', 'outside-adoption', { ...persisted, id: 'outside-adoption', server: historicalServer,
        taskSnapshot: { ...task, project: '/owned/different-project' } });
      scoped.close();
      const listing = unwrap(await service!.cliRequest({ ...credential, request: { command: 'snapshot' } }));
      expect(JSON.stringify(listing)).not.toMatch(/historical-key|historical-cert|outside-adoption|"hops"|"root"/);
      const status = await service!.cliRequest({ ...credential, request: { command: 'status', attemptId: adopted.id } });
      expect(status).toMatchObject({ ok: true, value: { id: adopted.id, serverId: scheduler.id } });
      expect(JSON.stringify(status)).not.toMatch(/historical-key|historical-cert|"hops"/);
      expect((await service!.cliRequest({ ...credential, request: { command: 'status', attemptId: 'outside-adoption' } })).ok).toBe(false);
      await refresh();
      await vi.waitFor(() =>
        expect(service!.state().attempts.find((a) => a.id === adopted.id)?.phase).toBe(
          'running',
        ),
      );
      const completed = { ...typedJob, state: { current: ['COMPLETED'] } };
      jobs = { squeue: null, sacct: [completed] };
      await refresh();
      await vi.waitFor(() => expect(owned().phase).toBe('unknown'));
      jobs = { squeue: [{ ...typedJob, restart_cnt: 1 }], sacct: [completed] };
      await refresh();
      await vi.waitFor(() =>
        expect(owned()).toMatchObject({ phase: 'unknown', invalidated: true }),
      );
      expect(calls).toContainEqual({
        kind: 'slurmQueue',
        commands: [['squeue', '--json', '--me']],
      });
      expect(
        calls.find((call) => call.kind === 'slurmObserve')?.commands.map(([name]) => name),
      ).toEqual(['squeue', 'sacct']);
      if (process.env.PI_HUB_TEST_EVIDENCE) {
        await writeFile(
          join(process.env.PI_HUB_TEST_EVIDENCE, 'slurm-service-refresh.json'),
          JSON.stringify(calls, null, 2),
        );
      }
    } finally {
      run.mockRestore();
    }
  });
  it.each(['cancel returns', 'cancel disconnects', 'observe returns'])(
    'preserves more recent execution evidence when %s', async (scenario) => {
      const task = await setup();
      const observedAt = Date.now();
      const attempt: Attempt = {
        id: 'pending-attempt', executionId: 'old-generation', taskId: task.id,
        taskSnapshot: task, server: { ...server, revision: 1 },
        createdAt: observedAt, lastObservedAt: observedAt, phase: 'running',
        marker: 'synthetic', detail: 'running at transport start', inputDigest: 'synthetic', owned: true,
        ref: { kind: 'linux', host: 'owned', user: 'owned', bootId: 'owned',
          supervisor: { pid: 41, start: '122' }, helper: { pid: 42, start: '123' },
          pgid: 42, endpoint: 'owned-endpoint' },
      };
      const database = join(profile, 'remote/remote.sqlite');
      const seed = new Store(database);
      seed.put('attempt', attempt.id, attempt);
      seed.close();
      let enter!: () => void, resume!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const response = new Promise<void>((resolve) => { resume = resolve; });
      const run = vi.spyOn(Transport.prototype, 'run').mockImplementation(async (_server, request) => {
        if ((request as { kind: string }).kind === 'linuxQueue') return { rows: [] };
        enter();
        await response;
        if (scenario === 'cancel disconnects') throw Error('synthetic disconnect');
        return { phase: 'cancelling', detail: 'late reply' };
      });
      try {
        if (scenario === 'observe returns') {
          unwrap(await service!.request({ command: 'refresh', serverId: server.id }));
        } else {
          const op = await prepared({ command: 'propose', requestId: 'pending-cancel',
            action: { kind: 'cancel', attemptId: attempt.id, force: false } });
          unwrap(await service!.request({ command: 'approve', requestId: op.requestId, digest: op.digest, allow: true }));
        }
        await entered;
        const store = new Store(database);
        const newest = {
          ...attempt,
          phase: scenario === 'cancel returns' ? 'succeeded' : 'unknown',
          invalidated: scenario !== 'cancel returns',
          executionId: scenario === 'observe returns' ? 'new-generation' : attempt.executionId,
          scopeEnded: true,
          detail: 'newer persisted evidence',
          lastObservedAt: observedAt + 1,
        };
        store.put('attempt', attempt.id, newest);
        resume();
        await service!.close();
        service = undefined;
        expect(store.get('attempt', attempt.id)).toEqual(newest);
        if (scenario.startsWith('cancel')) {
          expect(store.get<Operation>('operation', 'pending-cancel')?.status).toBe(
            scenario === 'cancel returns' ? 'done' : 'unknown',
          );
        }
        store.close();
      } finally {
        resume();
        run.mockRestore();
      }
    },
  );
  it('rejects altered compiled asset manifests', async () => {
    await expect(async () => {
      service = new RemoteService(profile, assets, { 'secure-fs.node': '0'.repeat(64) });
    }).rejects.toThrow(/integrity/);
  });
});
