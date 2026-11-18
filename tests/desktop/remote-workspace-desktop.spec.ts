import { test, expect, type Locator } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, readdir } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { launchOwnedElectron } from '../fixtures/owned-electron';
import { verifyLatestPi } from '../fixtures/pi-installation';
import { Store } from '../../src/remote/store';
import type { Attempt, Server, Task } from '../../src/remote/contract';

async function expectMenuUnderTrigger(trigger: Locator, action: Locator) {
  const anchor = (await trigger.boundingBox())!;
  const menu = (await action.locator('..').boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
  expect(menu.y - (anchor.y + anchor.height)).toBeLessThanOrEqual(10);
  expect(Math.abs(menu.x + menu.width - (anchor.x + anchor.width))).toBeLessThanOrEqual(2);
}

test('remote workspace reviews immutable inputs, bounds CLI authority, restores focus and renders light dark narrow', async () => {
  test.setTimeout(90000);
  const root = await realpath(await mkdtemp('/private/tmp/pi-remote-ui-')),
    profile = join(root, 'profile'),
    agent = join(root, 'agent'),
    sessions = join(root, 'sessions'),
    project = join(root, 'Synthetic project'),
    evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE!);
  await mkdir(sessions);
  await mkdir(project);
  await mkdir(evidence, { recursive: true });
  await writeFile(join(project, 'input.txt'), 'owned UI input');
  await mkdir(join(project, 'dataset', 'empty'), { recursive: true });
  await writeFile(join(project, 'dataset', 'small.txt'), 'owned recursive input');
  for (let index = 0; index < 24; index++) {
    await writeFile(join(project, 'dataset', `z-${String(index).padStart(2, '0')}.txt`), `fixture ${index}`);
  }
  await writeFile(
    join(evidence, 'pi-version.json'),
    JSON.stringify(await verifyLatestPi(), null, 2),
  );
  const app = await launchOwnedElectron(root, profile, agent, sessions, evidence);
  const report: any = { layouts: [] };
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '远端任务', exact: true }).click();
    await expect(page.getByText('正在打开独立远端工作区…')).toHaveCount(0);
    const sidebar = page.getByRole('complementary', { name: '服务器导航' });
    const search = sidebar.getByRole('searchbox', { name: '搜索服务器名称或主机' });
    const more = sidebar.getByRole('button', { name: '远端工作区更多操作' });
    const addOptions = sidebar.getByRole('button', { name: '服务器添加选项' });
    const cli = sidebar.getByRole('button', { name: 'Agent CLI', exact: true });
    await expect(sidebar.getByText('还没有服务器')).toBeVisible();
    await expect(search).toHaveCount(0);
    await expect(cli).toHaveCount(0);
    await page.screenshot({ path: join(evidence, 'empty-sidebar-light.png') });
    await page.getByRole('button', { name: '添加服务器', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '添加服务器' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '添加服务器', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '导入 SSH 别名' }).click();
    const importDialog = page.getByRole('dialog', { name: '导入 SSH 别名' });
    const defaultConfig = importDialog.getByRole('button', { name: '使用默认 SSH 配置' });
    await defaultConfig.click();
    await expect(importDialog.getByRole('alert')).toContainText('未找到默认 SSH 配置');

    const sshDir = join(root, 'home', '.ssh');
    await mkdir(sshDir);
    const sshConfig = join(sshDir, 'config');
    const defaultSource = [
      'Include conf.d/*.conf',
      'Host owned-default',
      '  HostName default.example',
      '  Port 2222',
      '  IdentityFile ~/.ssh/owned-key',
      '  StrictHostKeyChecking no',
      '  UserKnownHostsFile /dev/null',
      'Host needs-review',
      '  HostName review.example',
      '  ProxyJump unlisted',
      'Host *',
      '  User fixture',
      '  UseKeychain yes',
    ].join('\n');
    await writeFile(sshConfig, defaultSource);
    await defaultConfig.click();
    const aliasPreview = importDialog.getByRole('region', { name: 'SSH 别名预览' });
    await expect(aliasPreview.getByRole('status')).toContainText('未解析 Include');
    await aliasPreview.getByText('1 个别名需要手动核对').click();
    await expect(aliasPreview.getByText('needs-review：跳板')).toBeVisible();
    await expect(importDialog.getByLabel('SSH 配置片段')).toHaveValue('');
    await page.screenshot({ path: join(evidence, 'default-ssh-preview.png') });
    await aliasPreview.getByRole('button', { name: 'owned-default fixture@default.example:2222' }).click();
    await expect(page.getByLabel('用户', { exact: true })).toHaveValue('fixture');
    await expect(page.getByLabel('主机', { exact: true })).toHaveValue('default.example');
    await expect(page.getByLabel('端口', { exact: true })).toHaveValue('2222');
    await expect(page.getByLabel('私钥路径（不读取密钥内容）')).toHaveValue(join(sshDir, 'owned-key'));
    await expect(page.getByLabel('已核对的主机公钥')).toHaveValue('');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(sidebar.getByText('还没有服务器')).toBeVisible();
    expect(await readFile(sshConfig, 'utf8')).toBe(defaultSource);

    await page.getByRole('button', { name: '导入 SSH 别名' }).click();
    await page.getByLabel('SSH 配置片段').fill('Match exec forbidden');
    await page.getByRole('button', { name: '预览别名' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
      '不支持此 SSH 配置',
    );
    await page.screenshot({ path: join(evidence, 'import-error-light.png') });
    const configFile = join(root, 'owned-ssh-config');
    await writeFile(configFile, 'Host owned\n HostName 127.0.0.1\n User fixture\n Port 1');
    // Exact one-shot OS picker boundary. Reading/import/preview use the real product path.
    await app.evaluate(({ dialog }, path) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        dialog.showOpenDialog = original;
        const options = args.at(-1) as Electron.OpenDialogOptions;
        if (!options.properties?.includes('openFile')) throw Error('Unexpected picker');
        return { canceled: false, filePaths: [path] };
      }) as typeof original;
    }, configFile);
    await page.getByRole('button', { name: '选择 SSH 配置文件…' }).click();
    await expect(page.getByLabel('SSH 配置片段')).toHaveValue(
      'Host owned\n HostName 127.0.0.1\n User fixture\n Port 1',
    );
    await page.getByRole('button', { name: '预览别名' }).click();
    await page.getByRole('button', { name: 'owned fixture@127.0.0.1' }).click();
    await page.getByLabel('名称', { exact: true }).fill('Owned Linux');
    await page.getByLabel('私有远端工作目录').fill('/owned/pi-hub');
    await page.getByRole('button', { name: '保存服务器' }).click();
    await expect(
      page.getByRole('heading', { name: 'Owned Linux', exact: true }),
    ).toBeVisible();
    await expect(search).toBeVisible();
    await addOptions.press('Enter');
    const menuImport = sidebar.getByRole('button', { name: '导入 SSH 别名', exact: true });
    await expect(menuImport).toBeVisible();
    await expectMenuUnderTrigger(addOptions, menuImport);
    await page.screenshot({ path: join(evidence, 'server-options-light.png') });
    await page.keyboard.press('Tab');
    await expect(sidebar.getByRole('button', { name: '添加服务器', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menuImport).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: '导入 SSH 别名' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(addOptions).toBeFocused();
    await expect(menuImport).toHaveCount(0);
    await page.getByRole('button', { name: '新建任务' }).click();
    await page.getByLabel('名称', { exact: true }).fill('Synthetic foreground');
    await app.evaluate(({ dialog }, path) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        dialog.showOpenDialog = original;
        const options = args.at(-1) as Electron.OpenDialogOptions;
        if (!options.properties?.includes('openDirectory'))
          throw Error('Expected project directory picker');
        return { canceled: false, filePaths: [path] };
      }) as typeof original;
    }, project);
    await page.getByRole('button', { name: '选择项目目录…' }).click();
    await expect(page.getByLabel('本地项目目录')).toHaveValue(project);
    await page.getByLabel('前台可执行程序').fill('/usr/bin/true');
    await app.evaluate(
      ({ dialog }, { project, paths }) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = (async (...args: unknown[]) => {
          dialog.showOpenDialog = original;
          const options = args.at(-1) as Electron.OpenDialogOptions;
          if (
            !options.properties?.includes('openFile') ||
            !options.properties.includes('openDirectory') ||
            options.defaultPath !== project
          )
            throw Error('Expected combined input picker');
          return { canceled: false, filePaths: paths };
        }) as typeof original;
      },
      { project, paths: [join(project, 'input.txt'), join(project, 'dataset')] },
    );
    await page.getByRole('button', { name: '选择输入文件或目录…' }).click();
    await expect(page.getByLabel('输入文件')).toHaveValue('input.txt\ndataset');
    await page.getByLabel('允许取回的结果').fill('stdout.log');
    await page.getByRole('button', { name: '保存任务' }).click();
    await page.getByRole('button', { name: '准备提交' }).click();
    const review = page.getByRole('dialog', { name: '核对远端操作' });
    await expect(review.getByText('不可变输入快照')).toBeVisible();
    await expect(review).toContainText('26 个文件 · 2 个目录');
    await expect(review.getByText('dataset/small.txt', { exact: true })).toBeVisible();
    await review.getByRole('button', { name: '清单下一页' }).click();
    await expect(review.getByText('input.txt', { exact: true })).toBeVisible();
    await expect(review.getByText('dataset/empty', { exact: true })).toBeVisible();
    await writeFile(join(project, 'input.txt'), 'changed after review');
    await app.evaluate(({ nativeTheme, BrowserWindow }) => {
      nativeTheme.themeSource = 'light';
      BrowserWindow.getAllWindows()[0].setSize(1440, 900);
    });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: join(evidence, 'review-light.png') });
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect
      .poll(() => page.locator('.remote-operations').last().innerText())
      .toContain('已拒绝');
    // Approval before capability evidence must produce a truthful blocked operation, never a job.
    await page.getByRole('button', { name: '准备提交' }).click();
    await page.getByRole('button', { name: '批准此操作' }).click();
    await expect
      .poll(() => page.locator('.remote-operations').last().innerText())
      .toContain('已阻止');
    await expect(page.locator('.remote-operations').last()).toContainText(
      '请先核对主机指纹，再检测连接与能力',
    );
    await expect(page.locator('.remote-phase')).toHaveCount(0);
    await page.getByRole('button', { name: '授权所选任务…' }).click();
    await page.getByRole('button', { name: '创建私有授权文件' }).click();
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    for (const [theme, width, height] of [
      ['light', 1440, 900],
      ['dark', 1440, 900],
      ['light', 860, 700],
      ['dark', 860, 700],
    ] as const) {
      await app.evaluate(
        ({ nativeTheme, BrowserWindow }, { theme, width, height }) => {
          nativeTheme.themeSource = theme;
          BrowserWindow.getAllWindows()[0].setSize(width, height);
        },
        { theme, width, height },
      );
      await page.emulateMedia({ colorScheme: theme });
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await expect
        .poll(() =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
          ),
        )
        .toBe(theme === 'dark' ? '#20282f' : '#fff');
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
        columns: getComputedStyle(document.querySelector('.remote-workspace')!)
          .gridTemplateColumns,
      }));
      expect(layout.overflow).toBe(false);
      report.layouts.push({ theme, ...layout });
      if (width < 1050) {
        const drawer = page.getByRole('dialog', { name: '任务详情', exact: true });
        if (theme === 'light') {
          // The selected task's wide detail pane becomes a modal on the first resize.
          await drawer.getByRole('button', { name: '关闭详情' }).click();
        }
        await expect(drawer).toHaveCount(0);
        const row = page.getByRole('button', {
          name: /Synthetic foreground \/usr\/bin\/true/,
        });
        await row.click();
        await expect(drawer).toBeVisible();
        await page.keyboard.press('Tab');
        expect(
          await page.evaluate(() =>
            Boolean(document.querySelector('dialog')?.contains(document.activeElement)),
          ),
        ).toBe(true);
        await page.screenshot({ path: join(evidence, `details-${theme}-${width}.png`) });
        await page.keyboard.press('Escape');
        await expect(row).toBeFocused();
      }
      await page.screenshot({ path: join(evidence, `workspace-${theme}-${width}.png`) });
    }
    await more.press('Enter');
    await expect(cli).toBeVisible();
    await expectMenuUnderTrigger(more, cli);
    await page.keyboard.press('Tab');
    await expect(cli).toBeFocused();
    await page.keyboard.press('Enter');
    await page.getByLabel('Node 24+ 可执行文件').fill('/does/not/exist');
    await page.getByRole('button', { name: '检测并创建此配置的启动器' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await expect(cli).toHaveCount(0);
    // Both phase-one backends expose reviewed drafts without inventing a cluster.
    const slurm = await page.evaluate(async () => {
      const result = await window.remoteWorkspace.request<
        import('../../src/remote/contract').Server
      >({
        command: 'saveServer',
        server: {
          id: crypto.randomUUID(),
          revision: 0,
          name: 'Owned Slurm',
          backend: 'slurm',
          root: '/owned/slurm',
          hops: [{ alias: 'slurm', host: '127.0.0.1', user: 'fixture', port: 1 }],
        },
      });
      if (!result.ok) throw Error(result.error);
      return result.value;
    });
    const slurmRow = sidebar.getByRole('button', { name: /Owned Slurm Slurm/ });
    const linuxRow = sidebar.getByRole('button', { name: /Owned Linux Linux/ });
    await expect(slurmRow).toBeVisible();
    await search.fill('127.0.0.1');
    await expect(slurmRow).toBeVisible();
    await expect(linuxRow).toBeVisible();
    await search.fill('owned slurm');
    await expect(slurmRow).toBeVisible();
    await expect(linuxRow).toHaveCount(0);
    await search.fill('no matching host');
    await expect(sidebar.getByRole('status')).toHaveText('未找到匹配的服务器');
    await page.screenshot({ path: join(evidence, 'no-server-match-dark.png') });
    await sidebar.getByRole('button', { name: '清除搜索' }).click();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('');
    await expect(linuxRow).toBeVisible();
    await slurmRow.click();
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('Owned Slurm draft');
    await page.getByLabel('本地项目目录').fill(project);
    await page.getByLabel('前台可执行程序').fill('/usr/bin/true');
    await page.getByLabel('分区', { exact: true }).fill('compute');
    await page.getByLabel('CPU 数', { exact: true }).fill('4');
    await page.getByLabel('环境变量（每行 NAME=value）').fill('OMP_NUM_THREADS=4');
    await page.getByRole('button', { name: '保存任务', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '任务详情', exact: true })).toBeVisible();
    await page
      .getByRole('dialog', { name: '任务详情', exact: true })
      .getByRole('button', { name: '准备提交', exact: true })
      .click();
    await expect(
      page
        .getByRole('dialog', { name: '核对远端操作' })
        .getByText('compute', { exact: true })
        .first(),
    ).toBeVisible();
    await page.screenshot({ path: join(evidence, 'slurm-draft-review.png') });
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '核对远端操作' })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '任务详情', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '任务详情', exact: true })).toHaveCount(0);
    report.slurmDraftServer = slurm.id;
    await page.getByRole('button', { name: '本地会话', exact: true }).click();
    await expect(page.getByRole('button', { name: '远端任务', exact: true })).toBeVisible();
    report.noBusinessRemoteConnection = true;
  } finally {
    await writeFile(join(evidence, 'remote-ui.json'), JSON.stringify(report, null, 2));
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('result review uses the selected execution’s original paths and disables legacy fetches', async () => {
  const root = await realpath(await mkdtemp('/private/tmp/pi-remote-results-'));
  const profile = join(root, 'profile');
  const sessions = join(root, 'sessions');
  const evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE!, 'historical-results');
  await mkdir(join(profile, 'remote'), { recursive: true, mode: 0o700 });
  await mkdir(sessions);
  const server: Server = {
    id: 'historical-server',
    revision: 1,
    name: 'Owned history',
    backend: 'linux',
    root: '/owned/history',
    hops: [{ alias: 'owned', host: '127.0.0.1', user: 'owned', port: 1 }],
  };
  const original: Task = {
    id: 'historical-task',
    name: 'Original synthetic task',
    serverId: server.id,
    serverRevision: server.revision,
    project: root,
    argv: ['/usr/bin/true'],
    inputs: [],
    artifacts: ['results', 'stdout.log'],
  };
  const historical: Attempt = {
    id: 'original-run',
    executionId: 'original-execution',
    taskId: original.id,
    server,
    createdAt: Date.now(),
    phase: 'unknown',
    marker: 'owned',
    detail: '',
    inputDigest: 'fixture',
    owned: true,
    taskSnapshot: original,
  };
  const seed = new Store(join(profile, 'remote/remote.sqlite'));
  seed.put('server', server.id, server);
  seed.put('task', original.id, {
    ...original,
    name: 'Edited synthetic task',
    artifacts: ['current.txt'],
  });
  seed.put('attempt', historical.id, historical);
  seed.put('attempt', 'legacy-run', {
    ...historical,
    id: 'legacy-run',
    executionId: 'legacy-execution',
    taskSnapshot: undefined,
  });
  seed.close();
  const app = await launchOwnedElectron(
    root,
    profile,
    join(root, 'agent'),
    sessions,
    evidence,
  );
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '远端任务', exact: true }).click();
    await page.getByRole('button', { name: /Original synthetic task.*original/ }).click();
    await expect(page.getByText('结果范围：results、stdout.log')).toBeVisible();
    await page.getByRole('button', { name: '取回结果…' }).click();
    const fetch = page.getByRole('dialog', { name: '取回结果', exact: true });
    await expect(fetch.getByLabel('结果路径')).toHaveValue('results\nstdout.log');
    await fetch.getByLabel('新的本地目录').fill(join(root, 'retrieved'));
    await fetch.getByRole('button', { name: '准备取回' }).click();
    const review = page.getByRole('dialog', { name: '核对远端操作' });
    await expect(review.getByText('results、stdout.log', { exact: true })).toBeVisible();
    await expect(review).not.toContainText('current.txt');
    await page.screenshot({ path: join(evidence, 'historical-fetch-review.png') });
    await review.getByRole('button', { name: '拒绝', exact: true }).click();
    await page.getByRole('button', { name: /已有任务.*legacy/ }).click();
    await expect(page.getByText('本次执行缺少原始结果声明。')).toBeVisible();
    await expect(page.getByRole('button', { name: '取回结果…' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('long profile keeps GUI available and worker crash replaces only the exited writer', async () => {
  test.setTimeout(60000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-remote-long-profile-'))),
    profile = join(root, 'owned-profile-with-an-intentionally-long-socket-path'),
    agent = join(root, 'agent'),
    sessions = join(root, 'sessions'),
    evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE!, 'long-profile');
  await mkdir(sessions);
  await mkdir(evidence, { recursive: true });
  const app = await launchOwnedElectron(root, profile, agent, sessions, evidence);
  const sockets = new Set<Socket>(),
    endpoint = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '远端任务', exact: true }).click();
    await expect(page.getByText('还没有服务器')).toBeVisible();
    const before = await page.evaluate(async () => {
      const r = await window.remoteWorkspace.request<
        import('../../src/remote/contract').Snapshot
      >({
        command: 'snapshot',
      });
      if (!r.ok) throw Error(r.error);
      return r.value.generation;
    });
    const port = (endpoint.address() as { port: number }).port;
    await page.evaluate(
      async ({ port, user }) => {
        const saved = await window.remoteWorkspace.request<
          import('../../src/remote/contract').Server
        >({
          command: 'saveServer',
          server: {
            id: 'blackhole',
            revision: 0,
            name: 'Owned transport fault',
            backend: 'linux',
            root: '/owned/no-write',
            hops: [
              {
                alias: 'owned',
                host: '127.0.0.1',
                port,
                user,
                hostKey:
                  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIICf8nVLSwxYvEKg7ZV9yAkVnR6dRi0YePnyzULvj5Tz',
              },
            ],
          },
        });
        if (!saved.ok) throw Error(saved.error);
        const probe = await window.remoteWorkspace.request({
          command: 'probe',
          serverId: 'blackhole',
        });
        if (!probe.ok) throw Error(probe.error);
      },
      { port, user: userInfo().username },
    );
    let transportRecord = '';
    await expect
      .poll(async () => {
        for (const name of await readdir(join(profile, 'remote'))) {
          if (name.startsWith('ssh-')) {
            try {
              transportRecord = await readFile(
                join(profile, 'remote', name, 'root.pid'),
                'utf8',
              );
            } catch {}
          }
        }
        return transportRecord;
      })
      .not.toBe('');
    const transportPID = Number(transportRecord.trim().split(/\s+/)[0]);
    const killed = await app.evaluate(({ app }) => {
      const worker = app.getAppMetrics().find((m) => m.name === 'Pi Hub remote workspace');
      if (!worker) throw Error('Owned remote worker missing');
      process.kill(worker.pid, 'SIGKILL');
      return worker;
    });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.remoteWorkspace.request<
            import('../../src/remote/contract').Snapshot
          >({ command: 'snapshot' });
          return r.ok ? r.value.generation : '';
        }),
      )
      .not.toBe(before);
    await expect
      .poll(() => {
        try {
          return execFileSync('/bin/ps', ['-p', String(transportPID), '-o', 'lstart=,comm='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch {
          return '';
        }
      })
      .toBe('');
    await page.getByRole('button', { name: '远端工作区更多操作' }).click();
    await page.getByRole('button', { name: 'Agent CLI', exact: true }).click();
    await page.getByLabel('Node 24+ 可执行文件').fill(await realpath(process.execPath));
    await page.getByRole('button', { name: '检测并创建此配置的启动器' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
      '此配置路径超过私有套接字长度限制',
    );
    await page.keyboard.press('Escape');
    await writeFile(
      join(evidence, 'worker-restart.json'),
      JSON.stringify(
        {
          before,
          killed,
          transportRecord,
          transportPID,
          transportExited: true,
          socketBytes: Buffer.byteLength(join(profile, 'remote/control.sock')),
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('first connection discovers a candidate without granting trust and requires explicit fingerprint review', async () => {
  test.setTimeout(60000);
  const { ownedRemoteSSH } = await import('../fixtures/owned-remote-ssh');
  const fixture = await ownedRemoteSSH(),
    root = await realpath(await mkdtemp('/private/tmp/pi-trust-ui-')),
    profile = join(root, 'profile'),
    agent = join(root, 'agent'),
    sessions = join(root, 'sessions'),
    evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE!, 'first-trust');
  await mkdir(sessions);
  await mkdir(evidence, { recursive: true });
  const app = await launchOwnedElectron(root, profile, agent, sessions, evidence);
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '远端任务', exact: true }).click();
    await page.getByRole('button', { name: '添加服务器', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('自有信任检查');
    await page.getByLabel('私有远端工作目录').fill(fixture.server.root);
    await page.getByLabel('主机', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('用户', { exact: true }).fill(fixture.server.hops[0].user);
    await page.getByLabel('端口').fill(String(fixture.server.hops[0].port));
    const discovery = page.getByRole('button', { name: '获取候选主机指纹…', exact: true });
    await discovery.click();
    const review = page.getByRole('dialog', { name: '核对候选主机指纹' });
    await expect(review).toBeVisible();
    await expect(review.getByText(/^SHA256:/)).toBeVisible();
    await page.screenshot({ path: join(evidence, 'candidate-before-trust.png') });
    await page.keyboard.press('Escape');
    await expect(discovery).toBeFocused();
    await discovery.click();
    await page.getByRole('button', { name: '已核对，使用此公钥' }).click();
    await expect(page.getByLabel('已核对的主机公钥')).toHaveValue(
      fixture.server.hops[0].hostKey!,
    );
    await page.getByRole('button', { name: '保存服务器', exact: true }).click();
    const state = await page.evaluate(async () => {
      const r = await window.remoteWorkspace.request<
        import('../../src/remote/contract').Snapshot
      >({
        command: 'snapshot',
      });
      if (!r.ok) throw Error(r.error);
      return r.value;
    });
    expect(state.servers[0].hops[0].hostKey).toBe(fixture.server.hops[0].hostKey);
    expect(state.servers[0].capability).toBeUndefined();
  } finally {
    await app.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
