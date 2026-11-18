import { test, expect } from '@playwright/test';
import { launchOwnedElectron } from '../fixtures/owned-electron';
import { verifyLatestPi } from '../fixtures/pi-installation';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
test('exact unpacked CLI outside repository uses only the live owned profile and denies altered authority', async () => {
  test.setTimeout(90000);
  const evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE!),
    root = await realpath(await mkdtemp('/private/tmp/pi-cli-')),
    profile = join(root, 'profile'),
    agent = join(root, 'agent'),
    sessions = join(root, 'sessions'),
    project = join(root, 'project');
  await mkdir(sessions);
  await mkdir(project);
  await mkdir(evidence, { recursive: true });
  await writeFile(join(project, 'input.txt'), 'owned CLI input');
  const versions = await verifyLatestPi(),
    app = await launchOwnedElectron(root, profile, agent, sessions, evidence);
  let launcher = '',
    cliPath = '',
    grantPath = '';
  let original: Buffer | undefined;
  const outcomes: any[] = [];
  const run = async (args: string[], ok: boolean) => {
    let stdout = '',
      stderr = '',
      code = 0;
    try {
      ({ stdout, stderr } = await exec(launcher, args, {
        cwd: root,
        env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home') },
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      }));
    } catch (e: any) {
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
      code = e.code;
    }
    outcomes.push({ args, code, stdout, stderr });
    expect(code === 0).toBe(ok);
    return { stdout, stderr, code };
  };
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '远端任务', exact: true }).click();
    const invoke = async (request: any) =>
      page.evaluate((request) => window.remoteWorkspace.request<any>(request), request);
    const unwrap = (r: any) => {
      expect(r.ok, r.error).toBe(true);
      return r.value;
    };
    unwrap(
      await invoke({
        command: 'saveServer',
        server: {
          id: 'cli-server',
          revision: 0,
          name: 'Synthetic CLI server',
          backend: 'linux',
          root: '/owned/cli',
          hops: [{ alias: 'owned', host: '127.0.0.1', user: 'owned', port: 1 }],
        },
      }),
    );
    unwrap(
      await invoke({
        command: 'saveTask',
        task: {
          id: 'cli-task',
          serverId: 'cli-server',
          serverRevision: 1,
          project,
          name: 'Owned CLI task',
          argv: ['/usr/bin/true'],
          inputs: ['input.txt'],
          artifacts: ['stdout.log'],
        },
      }),
    );
    const grant = unwrap(
      await invoke({
        command: 'grant',
        grant: {
          serverId: 'cli-server',
          project,
          taskIds: ['cli-task'],
          actions: ['observe', 'submit'],
          expiresAt: Date.now() + 60000,
        },
      }),
    );
    const nodePath = await realpath('/usr/local/bin/node');
    unwrap(await invoke({ command: 'configureCLI', nodePath }));
    const binding = JSON.parse(await readFile(join(profile, 'remote/cli-binding.json'), 'utf8'));
    cliPath = binding.cliPath;
    expect(cliPath).toContain('/app.asar.unpacked/dist/remote/cli.mjs');
    expect(await realpath(cliPath)).toBe(cliPath);
    launcher = join(profile, 'remote/pi-hub-remote');
    // The independent tool is also a real unpacked executable, and never accepts a manual pass.
    const acceptanceBinding = JSON.parse(
      await readFile(join(profile, 'remote/acceptance-binding.json'), 'utf8'),
    );
    expect(acceptanceBinding.toolPath).toContain(
      '/app.asar.unpacked/dist/remote/acceptance-cli.mjs',
    );
    const acceptanceLauncher = join(profile, 'remote/pi-hub-remote-acceptance');
    const acceptanceRun = async (args: string[]) => {
      try {
        await exec(acceptanceLauncher, args, {
          cwd: root,
          env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home') },
          timeout: 15000,
        });
        throw Error('unexpected acceptance success');
      } catch (error: any) {
        expect(error.code).toBe(1);
        outcomes.push({
          acceptance: true,
          args,
          code: error.code,
          stdout: error.stdout,
          stderr: error.stderr,
        });
        return String(error.stderr);
      }
    };
    expect(await acceptanceRun([])).toContain('--authorize-owned-resources');
    const acceptanceOriginal = await readFile(acceptanceBinding.toolPath);
    try {
      await writeFile(
        acceptanceBinding.toolPath,
        Buffer.concat([acceptanceOriginal, Buffer.from('\n// owned integrity fault\n')]),
      );
      expect(await acceptanceRun(['--authorize-owned-resources'])).toContain(
        'integrity binding changed',
      );
    } finally {
      await writeFile(acceptanceBinding.toolPath, acceptanceOriginal);
    }
    outcomes.push({ acceptanceBinding, acceptanceHash: sha(acceptanceOriginal) });
    grantPath = grant.tokenPath;
    const args = ['--grant-file', grant.tokenPath];
    const listed = JSON.parse((await run([...args, 'server', 'list'], true)).stdout);
    expect(JSON.stringify(listed)).not.toContain('identityFile');
    const reserved = await run(
      [
        ...args,
        'task',
        'prepare',
        'cli-request',
        JSON.stringify({ kind: 'submit', taskId: 'cli-task' }),
      ],
      true,
    );
    expect(JSON.parse(reserved.stdout).value).toMatchObject({
      requestId: 'cli-request', status: 'preparing', digest: '',
    });
    let reviewed: { digest: string } | undefined;
    await expect.poll(async () => {
      const result = await run([...args, 'operation', 'status', 'cli-request'], true);
      const status = JSON.parse(result.stdout).value;
      if (status.status === 'review') reviewed = status;
      return status.status;
    }).toBe('review');
    expect(reviewed?.digest).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(project, 'input.txt'), 'changed CLI input');
    const changed = await run(
      [...args, 'prepare', 'cli-request', JSON.stringify({ kind: 'submit', taskId: 'cli-task' })],
      true,
    );
    expect(JSON.parse(changed.stdout).value).toMatchObject({ status: 'review', digest: reviewed?.digest });
    const denied = await run(
      [...args, 'propose', 'cli-outside', JSON.stringify({ kind: 'submit', taskId: 'outside' })],
      false,
    );
    expect(denied.stdout).toContain('unavailable');
    await run([...args, 'approve', 'cli-request'], false);
    const expired = unwrap(
      await invoke({
        command: 'grant',
        grant: {
          serverId: 'cli-server',
          project,
          taskIds: ['cli-task'],
          actions: ['observe'],
          expiresAt: Date.now() + 1000,
        },
      }),
    );
    await expect.poll(async () => Date.now() > expired.expiresAt, { timeout: 3000 }).toBe(true);
    const expiredResult = await run(['--grant-file', expired.tokenPath, 'list'], false);
    expect(expiredResult.stdout).toContain('expired');
    unwrap(await invoke({ command: 'revoke', grantId: grant.id }));
    expect((await run([...args, 'list'], false)).stdout).toContain('revoked');
    original = await readFile(cliPath);
    await writeFile(
      cliPath,
      Buffer.concat([original, Buffer.from('\n// owned integrity fault\n')]),
    );
    try {
      const tampered = await run([...args, 'list'], false);
      expect(tampered.stderr).toContain('integrity binding changed');
    } finally {
      await writeFile(cliPath, original);
    }
    outcomes.push({ binding, versions, cliSha256: sha(original), outsideCwd: root, profile });
  } finally {
    if (original && cliPath) await writeFile(cliPath, original);
    await app.close();
    if (launcher) {
      const gone = await run(['--grant-file', grantPath, 'list'], false);
      expect(gone.stderr).toContain('unavailable');
      outcomes.push({ hubStopped: true, result: gone });
    }
    await writeFile(join(evidence, 'exact-cli.json'), JSON.stringify(outcomes, null, 2));
    await rm(root, { recursive: true, force: true });
  }
});
