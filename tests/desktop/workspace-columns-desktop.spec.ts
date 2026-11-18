import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Request } from '../../src/remote/contract';
import { launchOwnedElectron } from '../fixtures/owned-electron';

const navLabel = '调整导航与列表宽度';
const detailLabel = '调整列表与详情宽度';

function columns(root: Locator) {
  return root.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').map(parseFloat));
}

async function resize(app: ElectronApplication, page: Page, width: number) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 720), width);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
}

async function startDrag(page: Page, handle: Locator, delta: number) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 30;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 4 });
}

async function drag(page: Page, handle: Locator, delta: number) {
  await startDrag(page, handle, delta);
  await page.mouse.up();
}

test('both workspaces resize adjacent columns and remember independent layouts across window modes and relaunch', async () => {
  test.setTimeout(90000);
  const root = await realpath(await mkdtemp('/private/tmp/pi-hub-columns-'));
  const profile = join(root, 'profile');
  const agent = join(root, 'agent');
  const sessions = join(root, 'sessions');
  const project = join(root, 'Layout Project');
  const evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE!);
  await mkdir(project);
  await mkdir(join(sessions, 'owned'), { recursive: true });
  await writeFile(join(sessions, 'owned/layout.jsonl'), [
    { type: 'session', version: 3, id: 'owned-layout', cwd: project, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'message', id: 'm', parentId: null, message: { role: 'user', content: 'Layout preview', timestamp: 1767225600000 } },
    { type: 'session_info', id: 'n', parentId: 'm', name: 'Layout record' },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  let app = await launchOwnedElectron(root, profile, agent, sessions, evidence);
  try {
    let page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await resize(app, page, 1440);
    const local = page.locator('.workspace-columns.workspace');
    const nav = page.getByRole('separator', { name: navLabel });
    const details = page.getByRole('separator', { name: detailLabel });
    await expect.poll(() => columns(local)).toEqual([208, 650, 582]);
    await app.evaluate(({ dialog }, project) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    }, project);
    await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '确认添加项目' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const search = page.getByRole('searchbox', { name: '搜索会话' });
    await search.fill('Layout');
    const session = page.getByRole('button', { name: /Layout record/ });
    await session.click();
    await expect(page.locator('.preview-content')).toContainText('Layout preview');
    const identity = page.locator('.preview-identity details');
    await identity.locator('summary').click();

    await drag(page, nav, 60);
    await expect.poll(() => columns(local)).toEqual([268, 590, 582]);
    await drag(page, details, -140);
    const localWide = [268, 450, 722];
    await expect.poll(() => columns(local)).toEqual(localWide);
    await expect(page.locator('.browse-toolbar')).toHaveCSS('display', 'grid');
    await expect(search).toHaveValue('Layout');
    await expect(session).toHaveAttribute('aria-pressed', 'true');
    await expect(identity).toHaveAttribute('open', '');
    await expect(page.locator('.preview-content')).toContainText('Layout preview');
    await page.screenshot({ path: join(evidence, 'columns-local-wide.png') });

    await startDrag(page, details, 70);
    await expect.poll(() => columns(local)).toEqual([268, 520, 652]);
    await resize(app, page, 1050);
    await page.mouse.up();
    await expect(details).toHaveCount(0);
    await expect(page.locator('.preview')).toBeVisible();
    expect(await page.locator('.preview').evaluate((element) => element.getBoundingClientRect().left)).toBe(268);
    await page.keyboard.press('Escape');
    await expect(session).toBeFocused();
    await resize(app, page, 760);
    await expect(nav).toBeVisible();
    await drag(page, nav, 390);
    await expect.poll(() => columns(local)).toEqual([320, 440]);
    await session.click();
    await expect(page.locator('.preview')).toBeVisible();
    expect(await page.locator('.preview').evaluate((element) => element.getBoundingClientRect().left)).toBe(320);
    await expect(page.locator('.sessions')).toHaveAttribute('inert', '');
    await page.screenshot({ path: join(evidence, 'columns-local-narrow.png') });
    await page.keyboard.press('Escape');
    await resize(app, page, 1051);
    await expect.poll(() => columns(local)).toEqual([268, 360, 423]);
    await expect(details).toHaveAttribute('aria-valuemin', '360');
    await resize(app, page, 1440);
    await expect.poll(() => columns(local)).toEqual(localWide);

    await page.getByRole('button', { name: '远端任务', exact: true }).click();
    const request = async (input: Request) => {
      const result = await page.evaluate((value) => window.remoteWorkspace.request(value), input);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    };
    await request({ command: 'saveServer', server: {
      id: 'owned-layout-server', revision: 0, name: 'Layout Linux', backend: 'linux', root: '/owned/layout',
      hops: [{ alias: 'layout', host: '127.0.0.1', port: 1, user: 'owned' }],
    } });
    const longTaskName = `Layout task ${'LongTaskName'.repeat(8)}`;
    await request({ command: 'saveTask', task: {
      id: 'owned-layout-task', serverId: 'owned-layout-server', serverRevision: 1, name: longTaskName, project,
      argv: ['/usr/bin/true'], inputs: [], artifacts: [],
    } });
    const remote = page.locator('.remote-workspace');
    await expect.poll(() => columns(remote)).toEqual([208, 742, 490]);
    await page.getByRole('button', { name: /Layout Linux Linux/ }).click();
    const task = page.getByRole('button', { name: /^Layout task LongTaskName/ });
    await task.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await startDrag(page, nav, 60);
    await expect.poll(() => columns(remote)).toEqual([268, 682, 490]);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect.poll(() => columns(remote)).toEqual([208, 742, 490]);
    await drag(page, nav, -150);
    await expect.poll(() => columns(remote)).toEqual([168, 782, 490]);
    await details.press('End');
    await expect.poll(() => columns(remote)).toEqual([168, 972, 300]);
    await details.press('Home');
    const remoteWide = [168, 320, 952];
    await expect.poll(() => columns(remote)).toEqual(remoteWide);
    await expect(details).toHaveAttribute('aria-valuenow', '320');
    expect(await task.locator('strong').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.locator('.remote-tasks').evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(true);
    await details.press('ArrowRight');
    await expect.poll(() => columns(remote)).toEqual([168, 332, 940]);
    await details.press('Home');
    await expect(page.locator('.remote-detail')).toHaveCSS('height', '680px');
    await page.screenshot({ path: join(evidence, 'columns-remote-wide.png') });

    const remoteDetail = page.locator('.remote-detail');
    const originalDetail = await remoteDetail.elementHandle();
    await page.getByRole('button', { name: '编辑任务与配置版本…', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑任务', exact: false });
    const taskName = editor.getByRole('textbox', { name: '名称', exact: true });
    await taskName.fill('Unsaved layout draft');
    await resize(app, page, 1050);
    const modal = page.getByRole('dialog', { name: '任务详情' });
    await expect(modal).toHaveCount(0);
    await expect(taskName).toBeFocused();
    await expect(taskName).toHaveValue('Unsaved layout draft');
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('heading', { name: longTaskName })).toBeVisible();
    expect(await originalDetail!.evaluate((node) => node === document.querySelector('.remote-detail'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(task).toBeFocused();
    await resize(app, page, 1051);
    await expect.poll(() => columns(remote)).toEqual([168, 320, 563]);
    await resize(app, page, 760);
    await nav.press('End');
    await expect.poll(() => columns(remote)).toEqual([320, 440]);
    await task.click();
    await expect(modal).toBeVisible();
    await page.screenshot({ path: join(evidence, 'columns-remote-narrow.png') });
    await page.keyboard.press('Escape');
    await resize(app, page, 1440);
    await expect.poll(() => columns(remote)).toEqual(remoteWide);
    await page.getByRole('button', { name: '本地会话', exact: true }).click();
    await expect.poll(() => columns(local)).toEqual(localWide);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);

    await app.close();
    app = await launchOwnedElectron(root, profile, agent, sessions, evidence);
    page = await app.firstWindow();
    await resize(app, page, 1440);
    await expect.poll(() => columns(page.locator('.workspace-columns.workspace'))).toEqual(localWide);
    await page.getByRole('button', { name: '远端任务', exact: true }).click();
    await expect.poll(() => columns(page.locator('.remote-workspace'))).toEqual(remoteWide);
    await page.getByRole('separator', { name: navLabel }).dblclick();
    await expect.poll(() => columns(page.locator('.remote-workspace'))).toEqual([208, 742, 490]);
    await page.getByRole('button', { name: '本地会话', exact: true }).click();
    await expect.poll(() => columns(page.locator('.workspace-columns.workspace'))).toEqual(localWide);
    await page.getByRole('separator', { name: detailLabel }).press('Enter');
    await expect.poll(() => columns(page.locator('.workspace-columns.workspace'))).toEqual([208, 650, 582]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
