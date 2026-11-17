import {launchOwnedElectron} from '../fixtures/owned-electron';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const executablePath = resolve(process.env.PI_HUB_TEST_APP!);
const evidence = process.env.PI_HUB_TEST_EVIDENCE ? resolve(process.env.PI_HUB_TEST_EVIDENCE, 'foundation-regression') : resolve('.scratch/pi-hub-test-runs/desktop/foundation-regression');
test.beforeAll(async () => { await mkdir(evidence, { recursive: true }); });
async function launch(userData: string) {
  const root=userData.endsWith('/profile')?dirname(userData):userData,profile=userData.endsWith('/profile')?userData:join(userData,'profile'),agent=join(root,'isolated-agent'),sessions=join(agent,'sessions');
  await mkdir(sessions,{recursive:true});
  return launchOwnedElectron(root,profile,agent,sessions,evidence);
}
async function choose(app: ElectronApplication, path: string | null) {
  // Only the OS picker result is substituted; UI, IPC, utility and SQLite are real.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: path === null, filePaths: path ? [path] : [] });
  }, path);
}

test('packaged desktop adds, cancels and restores projects with a restricted renderer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-ui-'));
  const project = join(root, '桌面项目 · 中文与空格 · 一个需要完整路径辅助辨认的长项目名称');
  await mkdir(project);
  let app: ElectronApplication | undefined;
  try {
    app = await launch(join(root, 'profile'));
    let page = await app.firstWindow();
    await expect(page).toHaveTitle('Pi Hub');
    await expect(page.locator('.titlebar')).toHaveText('Pi Hub');
    const identity = await app.evaluate(({ app, Menu, BrowserWindow }) => ({
      name: app.getName(), profile: app.getPath('userData'),
      title: BrowserWindow.getAllWindows()[0].getTitle(),
      applicationMenu: Menu.getApplicationMenu()!.items[0].label,
      menuLabels: Menu.getApplicationMenu()!.items[0].submenu!.items.map(item => item.label),
    }));
    expect(identity).toMatchObject({ name: 'Pi Hub', profile: join(root, 'profile'), title: 'Pi Hub', applicationMenu: 'Pi Hub' });
    expect(identity.menuLabels).toEqual(expect.arrayContaining(['关于 Pi Hub', '隐藏 Pi Hub', '退出 Pi Hub']));
    await writeFile(join(evidence, 'pi-hub-identity.json'), JSON.stringify(identity, null, 2));
    await page.emulateMedia({ colorScheme: null });
    await app.evaluate(({ nativeTheme, BrowserWindow }) => { nativeTheme.themeSource = 'light'; BrowserWindow.getAllWindows()[0].setSize(1440, 900); });
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await page.screenshot({ path: join(evidence, 'empty-light.png') });
    expect(await page.evaluate(() => ({ require: typeof (window as any).require, process: typeof (window as any).process, keys: Object.keys((window as any).sessionManagement) })))
      .toEqual({ require: 'undefined', process: 'undefined', keys: ["showSettings","updateSettingsWindow","closeSettings","onSettingsChanged","cancelTerminalCommand","retryTerminal","copyTerminalCommand","getPiStatus","inspectPi","savePiConfiguration","locateSession","getTerminalSettings","setDefaultTerminal","showSessionMenu","sessionTerminals","exitSession","openTerminal","getTerminalOutcome","prepareClone","prepareDelete","deleteSession","getDeleteOutcome","prepareRename","renameSession","getRenameOutcome","cloneSession","getCloneOutcome","setSessionClassification","getClassificationOutcome","listStorageLocations","chooseStorageLocation","removeStorageLocation","changeProjectScope","removeProject","getPreview","cancelPreview","getSnapshot","reconcile","cancelReconciliation","subscribe","listProjects","chooseProject","listImports","getImport","selectImport","commitImport","cancelImport","retryImport","listSessions"] });
    await choose(app, null);
    await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await choose(app, project);
    await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await page.getByRole('button', { name: '确认添加项目', exact: true }).click();
    await expect(page.getByRole('heading', { name: '暂无已导入会话', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /桌面项目 · 中文与空格/ })).toHaveCount(1);
    await page.screenshot({ path: join(evidence, 'project-light.png') });
    await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await expect(page.getByRole('alert')).toContainText('项目已存在');
    await page.getByRole('button', { name: '全部会话', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('项目已存在');
    await page.locator('.project-row').filter({ hasText: project.split('/').at(-1)! }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: join(evidence, 'duplicate-project-recovered.png') });
    await app.close();
    app = await launch(join(root, 'profile'));
    page = await app.firstWindow();
    await page.emulateMedia({ colorScheme: null });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1440, 900); });
    await expect(page.getByRole('button', { name: /桌面项目 · 中文与空格/ })).toBeVisible();
    await page.getByRole('button', { name: /桌面项目 · 中文与空格/ }).click();
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
    await page.screenshot({ path: join(evidence, 'project-dark.png') });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(860, 640); });
    await page.getByRole('button', { name: '添加项目', exact: true }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.screenshot({ path: join(evidence, 'narrow-dark-focus.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await app.close();
    app = undefined;
  } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('close keeps the writer, activate reopens, a second instance exits, and explicit quit stops resources', {tag:'@foreground'}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-lifecycle-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launch(root);
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    const runtime = await app.evaluate(({ app }) => ({ versions: process.versions, metrics: app.getAppMetrics(), pid: process.pid }));
    const writer = runtime.metrics.find(metric => metric.name === 'Pi Hub database');
    expect(writer).toBeDefined();
    await writeFile(join(evidence, 'runtime.json'), JSON.stringify(runtime, null, 2));
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    expect(await app.evaluate(({ app }, pid) => app.getAppMetrics().some(metric => metric.pid === pid), writer!.pid)).toBe(true);
    const reopened = app.waitForEvent('window');
    // Target this test app only; LaunchServices can activate another running profile.
    await app.evaluate(({ app }) => { app.emit('activate'); });
    page = await reopened;
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    const second = spawn(executablePath, [`--user-data-dir=${join(root,'profile')}`, '--use-mock-keychain', '--password-store=basic'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PI_HUB_SESSIONS_ROOT: join(root, 'isolated-agent', 'sessions') }, stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve, reject) => { second.once('exit', resolve); second.once('error', reject); });
    expect(code).toBe(0);
    expect(await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.name === 'Pi Hub database').map(metric => metric.pid))).toEqual([writer!.pid]);
    const closed = app.waitForEvent('close');
    // Playwright keyboard events target the renderer, not macOS menu accelerators.
    // Native Cmd+Q is covered by tests/native/native-shell.spec.ts.
    await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await closed;
    app = undefined;
    expect(() => process.kill(writer!.pid, 0)).toThrow();
  } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('corrupt database is an error rather than a false empty state, and retry preserves the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-corrupt-ui-'));
  const bytes = Buffer.from('preserve this corrupt SQLite file');
  await mkdir(join(root,'profile'));await writeFile(join(root, 'profile','projects.sqlite'), bytes);
  let app: ElectronApplication | undefined;
  try {
    app = await launch(root);
    const page = await app.firstWindow();
    await expect(page.getByRole('alert')).toContainText('未能读取项目');
    await expect(page.getByRole('alert')).toContainText('已保存的项目未被更改');
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '添加项目', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '重新读取项目' }).click();
    await expect(page.getByRole('alert')).toContainText('未能读取项目');
    await expect(page.getByRole('alert')).toContainText('已保存的项目未被更改');
    expect(await readFile(join(root, 'profile','projects.sqlite'))).toEqual(bytes);
    await page.screenshot({ path: join(evidence, 'database-error.png') });
    await app.close(); app = undefined;
  } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('invalid IPC parameters and a foreign window are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-security-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launch(root);
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).sessionManagement.chooseProject({ requestId: 'x', path: '/tmp' }))).toMatchObject({ status: 'failed', error: { code: 'INVALID_REQUEST' } });
    const result = await app.evaluate(async ({ BrowserWindow }) => {
      const foreign = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
      try {
        await foreign.loadURL('about:blank');
        return await foreign.webContents.executeJavaScript("require('electron').ipcRenderer.invoke('projects:list')");
      } finally { foreign.destroy(); }
    });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'INVALID_REQUEST' } });
    await app.close(); app = undefined;
  } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('a real SQLite write failure keeps project context and does not announce success', async () => {
  const { chmod } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-write-ui-'));
  const profile = join(root, 'profile');
  const first = join(root, '已保存项目');
  const second = join(root, '保存失败的项目');
  await mkdir(first); await mkdir(second);
  let app: ElectronApplication | undefined;
  try {
    app = await launch(profile);
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await choose(app, first);
    await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await page.getByRole('button', { name: '确认添加项目', exact: true }).click();
    await expect(page.getByRole('heading', { name: '已保存项目', exact: true })).toBeVisible();
    await chmod(profile, 0o500); // Prevent SQLite from creating its transaction journal.
    await choose(app, second);
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('未能添加项目');
    await expect(page.getByRole('alert')).toContainText('已有项目保持不变');
    await page.getByRole('button', { name: '全部会话', exact: true }).click();
    await page.locator('.project-row').filter({ hasText: '已保存项目' }).click();
    await expect(page.getByRole('alert')).toContainText('未能添加项目');
    await expect(page.getByRole('alert').getByRole('button', { name: '重新选择目录' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '已保存项目', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /保存失败的项目/ })).toHaveCount(0);
    await expect(page.getByRole('status')).not.toHaveText('项目已添加。');
    await page.screenshot({ path: join(evidence, 'write-error-context.png') });
    await chmod(profile, 0o700);
    await page.getByRole('alert').getByRole('button', { name: '重新选择目录' }).click();
    await page.getByRole('button', { name: '确认添加项目', exact: true }).click();
    await expect(page.getByRole('heading', { name: '保存失败的项目', exact: true })).toBeVisible();
    await app.close(); app = undefined;
  } finally {
    await chmod(profile, 0o700).catch(() => {});
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});


test('archive without projects describes its own scope without claiming history is empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-archive-ui-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launch(root);
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await page.getByRole('button', { name: '归档', exact: true }).click();
    await expect(page.getByRole('heading', { name: '归档', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '暂无归档会话' })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('导入时未选择的历史会话会保留在这里。');
    await expect(page.getByRole('main').getByRole('button', { name: '添加项目' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toHaveCount(0);
    await page.screenshot({ path: join(evidence, 'archive-empty-light.png') });
    await page.getByRole('button', { name: '全部会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await app.close(); app = undefined;
  } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
});
