import { expect, test } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Request } from '../../src/remote/contract';
import { observeProcess } from '../../src/session-management/runtime-process';
import { launchOwnedElectron } from '../fixtures/owned-electron';
import { verifyLatestPi } from '../fixtures/pi-installation';

const outputRecords = async (file: string) => {
  const bytes = await readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return bytes.split('\n').slice(0, -1).map((line) => JSON.parse(line));
};

test('Pi opened from a task queries its scope, requests GUI approval and reselects after native /new', async () => {
  test.setTimeout(90000);
  const root = await realpath(await mkdtemp('/private/tmp/pi-native-remote-'));
  const profile = join(root, 'profile'), agent = join(root, 'agent'), sessions = join(root, 'sessions');
  const project = join(root, 'Owned task project'), otherProject = join(root, 'Other task project');
  const entry = join(root, 'entry'), results = join(root, 'pi-tool-results.jsonl');
  const evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE!);
  for (const path of [agent, sessions, project, otherProject, entry, evidence]) await mkdir(path, { recursive: true });
  await writeFile(join(project, 'input.txt'), 'Owned Pi input\n');
  const extension = join(agent, 'local-provider.ts');
  await copyFile(resolve('tests/fixtures/terminal-local-provider.ts'), extension);
  const versions = verifyLatestPi();
  const settings = JSON.stringify({ cacheWarming: 'off', defaultProjectTrust: 'never',
    defaultProvider: 'hub-terminal-local', defaultModel: 'deterministic',
    extensions: [extension], lastChangelogVersion: versions.latest });
  await writeFile(join(agent, 'settings.json'), settings);
  await writeFile(join(evidence, 'native-pi-version.json'), JSON.stringify(versions));
  const originalApp = process.env.PI_HUB_TEST_APP, originalEntry = process.env.PI_HUB_TEST_ENTRY;
  const production = originalEntry ? resolve(originalEntry, 'dist/desktop/main.cjs')
    : resolve(dirname(originalApp!), '../Resources/app.asar/dist/desktop/main.cjs');
  await writeFile(join(entry, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
  // Exercise real launch preparation through the manual handoff after an OS automation refusal.
  await writeFile(join(entry, 'main.cjs'), `
const cp = require('node:child_process');
const {promisify} = require('node:util');
const original = cp.execFile;
const invoke = promisify(original);
const wrapper = (...args) => original(...args);
wrapper[promisify.custom] = (file, args, options) => {
  if (file === '/usr/bin/osascript' && args?.[1]?.includes('set launched to do script'))
    return Promise.reject(Object.assign(Error('owned automation refusal'), {stderr:'-1743'}));
  return invoke(file, args, options);
};
cp.execFile = wrapper;
require(${JSON.stringify(production)});
`);
  process.env.PI_HUB_TEST_APP = resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  process.env.PI_HUB_TEST_ENTRY = entry;
  let app: Awaited<ReturnType<typeof launchOwnedElectron>> | undefined;
  let tui: ChildProcessWithoutNullStreams | undefined;
  let pid: number | undefined;
  let output = '';
  let passed = false;
  try {
    app = await launchOwnedElectron(root, profile, agent, sessions, evidence);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '远端任务', exact: true }).click();
    const request = async (input: Request) => {
      const r = await page.evaluate((input) => window.remoteWorkspace.request(input), input);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    };
    await request({ command: 'saveServer', server: {
      id: 'owned-pi-server', revision: 0, name: 'Owned Pi server', backend: 'linux', root: '/owned/pi',
      hops: [{ alias: 'owned', host: '127.0.0.1', port: 1, user: 'owned' }],
    } });
    for (const task of [{ id: 'first-task', name: 'A Direct task', project, inputs: ['input.txt'] },
      { id: 'other-task', name: 'B Other task', project: otherProject, inputs: [] }]) {
      await request({ command: 'saveTask', task: { ...task, serverId: 'owned-pi-server',
        serverRevision: 1, argv: ['/usr/bin/true'], artifacts: [] } });
    }
    await page.getByRole('button', { name: /Owned Pi server/ }).click();
    await page.getByRole('button', { name: /A Direct task/ }).click();
    await page.getByRole('button', { name: '在 Pi 中打开', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '选择终端' })).toBeVisible();
    await page.getByRole('radio', { name: /^Terminal / }).check();
    await page.getByRole('button', { name: '打开会话', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('自动化授权被拒绝');
    await page.getByRole('button', { name: '复制手动启动命令' }).click();
    await expect(page.getByRole('dialog')).toContainText('命令已复制');
    const command = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(command).toMatch(/^exec /);
    expect(command).toContain(profile);
    tui = spawn('/usr/bin/python3', [resolve('tests/fixtures/pi-tui.py'), root, '/bin/sh', '-c', command], {
      env: { HOME: join(root, 'home'), PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color',
        PI_HUB_TEST_REMOTE_RESULTS: results, PI_HUB_TEST_PROCESS_LOG: join(evidence, 'pty-process.jsonl') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    tui.stdout.on('data', (data) => output += data);
    tui.stderr.on('data', (data) => output += data);
    const connected = () => page.evaluate(async () => {
      const r = await window.sessionManagement.getPiStatus();
      if (r.status === 'completed') return r.value.instances.find((i) => i.state === 'connected') ?? null;
      return null;
    });
    await expect.poll(connected, { timeout: 20000 }).not.toBeNull();
    const instance = (await connected())!;
    pid = instance.pid;
    expect(await observeProcess(pid)).toMatchObject({ tty: instance.tty });
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 });
    const send = (line: string) => tui!.stdin.write('\u0015' + line + '\r');
    const issue = async (params: object) => {
      const count = (await outputRecords(results)).length;
      send('owned-remote:' + JSON.stringify(params));
      return async () => {
        await expect.poll(async () => (await outputRecords(results)).length, { timeout: 16000 }).toBe(count + 1);
        const last = (await outputRecords(results)).at(-1);
        return { cwd: last.cwd, value: JSON.parse(last.content[0].text) };
      };
    };
    const direct = await (await issue({ action: 'list' }))();
    expect(direct.cwd).toBe(project);
    expect(direct.value.tasks.map((task: { id: string }) => task.id)).toEqual(['first-task']);
    expect(output).not.toContain('选择此 Pi 会话要关联的远端任务');
    const submission = (await (await issue({ action: 'submit' }))()).value;
    expect(submission).toMatchObject({ status: 'preparing' });
    expect(submission.digest).toBeUndefined();
    const pending = page.locator('.remote-operations').getByRole('button', { name: /提交 · 待审批/ });
    await pending.click();
    const review = page.getByRole('dialog', { name: '核对远端操作' });
    await expect(review.getByText('input.txt', { exact: true })).toBeVisible();
    await review.getByRole('button', { name: '拒绝', exact: true }).click();
    const rejected = await (await issue({ action: 'operation', requestId: submission.requestId }))();
    expect(rejected.value.status).toBe('denied');
    expect(page.locator('.remote-phase')).not.toBeVisible();

    send('/new');
    await expect.poll(async () => {
      const current = await connected();
      return Boolean(current && current.sessionId !== instance.sessionId);
    }).toBe(true);
    const finishSelection = await issue({ action: 'list' });
    await expect.poll(() => output).toContain('选择此 Pi 会话要关联的远端任务');
    await expect.poll(() => output).toContain('B Other task');
    tui.stdin.write('\x1b[B\r');
    const selected = await finishSelection();
    expect(selected.value.tasks.map((task: { id: string }) => task.id)).toEqual(['other-task']);
    const denied = await (await issue({ action: 'operation', requestId: submission.requestId }))();
    expect(denied.value.error).toMatch(/outside grant scope|越界/);
    await expect(readFile(join(profile, 'remote', 'cli-binding.json'))).rejects.toHaveProperty('code', 'ENOENT');
    expect(await readFile(join(agent, 'settings.json'), 'utf8')).toBe(settings);
    send('/hub-test-quit');
    await expect.poll(() => tui!.exitCode, { timeout: 12000 }).toBe(0);
    await expect(observeProcess(pid)).rejects.toBeTruthy();
    passed = true;
  } finally {
    try {
      if (tui && tui.exitCode === null) {
        tui.stdin.end(); // PTY harness reaps only its own child.
        await expect.poll(() => tui!.exitCode, { timeout: 12000 }).not.toBeNull();
      }
      await writeFile(join(evidence, 'native-pi-tui.log'), output);
      await writeFile(join(evidence, 'native-pi-results.json'), JSON.stringify({ passed, pid, records: await outputRecords(results) }, null, 2));
    } finally {
      await app?.close();
      if (originalApp === undefined) delete process.env.PI_HUB_TEST_APP;
      else process.env.PI_HUB_TEST_APP = originalApp;
      if (originalEntry === undefined) delete process.env.PI_HUB_TEST_ENTRY;
      else process.env.PI_HUB_TEST_ENTRY = originalEntry;
      await rm(root, { recursive: true, force: true });
    }
  }
});
