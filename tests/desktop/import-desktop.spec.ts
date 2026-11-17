import {launchOwnedElectron} from '../fixtures/owned-electron';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const evidence = process.env.PI_HUB_TEST_EVIDENCE ? resolve(process.env.PI_HUB_TEST_EVIDENCE, 'import-regression') : resolve('.scratch/pi-hub-test-runs/import-desktop');
test.beforeAll(async () => { await mkdir(evidence, { recursive: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-import-ui-'));
  const project = join(root, '项目 · 中文 空格'); const sessionsRoot = join(root, 'agent', 'sessions');
  await mkdir(project); await mkdir(join(sessionsRoot, '--not-the-project-name--'), { recursive: true });
  for (const [id, name] of [['alpha', '整理项目结构与接口边界'], ['beta', '排查重复名称会话的历史记录'], ['gamma', '很长的会话名称 · 保留中文、空格与用户提供的完整标题用于辨认历史任务']]) {
    const entries = [{ type: 'session', id, version: 3, timestamp: '2026-01-01T00:00:00Z', cwd: project }, { type: 'message', id: `${id}-m1`, message: { role: 'user', content: name, timestamp: 1767225600000 } }, { type: 'session_info', name }];
    await writeFile(join(sessionsRoot, '--not-the-project-name--', `${id}.jsonl`), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  }
  const launch = () => launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),sessionsRoot,evidence);
  return { root, project, sessionsRoot, launch };
}
async function choose(app: ElectronApplication, path: string | null) {
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: path === null, filePaths: path ? [path] : [] }); }, path);
}
test('packaged selective import keeps choice across restart and publishes main/archive only after commit', async () => {
  const f = await fixture(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); let page = await app.firstWindow();
    await app.evaluate(({ nativeTheme, BrowserWindow }) => { nativeTheme.themeSource = 'light'; BrowserWindow.getAllWindows()[0].setSize(1440, 900); });
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await choose(app, f.project); await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: '选择历史会话' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveCount(3);
    await dialog.getByRole('checkbox', { name: /整理项目结构/ }).check();
    await expect(dialog.getByText('已选 1 条 · 其余 2 条归档')).toBeVisible();
    await expect(page.getByRole('button', { name: '确认添加项目' })).toBeEnabled();
    await page.getByRole('button', { name: '确认添加项目' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('.import-identity summary')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '全选', exact: true })).toBeFocused();
    await page.screenshot({ path: join(evidence, 'import-selection-light.png') });
    await app.close(); app = await f.launch(); page = await app.firstWindow();
    await app.evaluate(({ nativeTheme, BrowserWindow }) => { nativeTheme.themeSource = 'light'; BrowserWindow.getAllWindows()[0].setSize(1440, 900); });
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /整理项目结构/ })).toBeChecked();
    await page.getByRole('button', { name: '确认添加项目', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('main').getByText('整理项目结构与接口边界', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText('排查重复名称会话的历史记录', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: join(evidence, 'main-light.png') });
    await page.getByRole('button', { name: '归档', exact: true }).click();
    await expect(page.getByRole('main').getByText('排查重复名称会话的历史记录', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText('整理项目结构与接口边界', { exact: true })).toHaveCount(0);
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
    await page.emulateMedia({ colorScheme: null });
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
    await page.screenshot({ path: join(evidence, 'archive-dark.png') });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(860, 640); });
    await page.getByRole('button', { name: '全部会话', exact: true }).focus();
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await page.screenshot({ path: join(evidence, 'archive-narrow-dark.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await writeFile(join(evidence, 'packaged-runtime.json'), JSON.stringify(await app.evaluate(({ app }) => ({ versions: process.versions, metrics: app.getAppMetrics(), appPath: app.getAppPath() })), null, 2));
  } finally { if (app) await app.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('cancel leaves no project, all/none selection works and a failed commit retains choice for retry', async () => {
  const f = await fixture(); let app: ElectronApplication | undefined;
  const { chmod } = await import('node:fs/promises');
  try {
    app = await f.launch(); const page = await app.firstWindow();
    await app.evaluate(({ nativeTheme, BrowserWindow }) => { nativeTheme.themeSource = 'light'; BrowserWindow.getAllWindows()[0].setSize(1440, 900); });
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await choose(app, null); await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await choose(app, f.project); await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    await page.getByRole('button', { name: '全选', exact: true }).click();
    await expect(page.getByText('已选 3 条 · 其余 0 条归档')).toBeVisible();
    await page.getByRole('button', { name: '取消添加' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    await page.getByRole('button', { name: '全选', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认添加项目' })).toBeEnabled();
    await chmod(join(f.root, 'profile'), 0o500);
    await page.getByRole('button', { name: '确认添加项目' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await expect(page.getByRole('checkbox').first()).toBeChecked();
    await expect(page.getByRole('button', { name: '确认添加项目' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '核对保存结果' })).toBeVisible();
    await page.screenshot({ path: join(evidence, 'import-write-error.png') });
    await chmod(join(f.root, 'profile'), 0o700);
    await page.getByRole('button', { name: '核对保存结果' }).click();
    await expect(page.getByRole('dialog')).toContainText('尚未提交');
    await page.getByRole('button', { name: '重新提交' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.session-row')).toHaveCount(3);
    await page.getByRole('button', { name: '归档', exact: true }).click();
    await expect(page.getByRole('heading', { name: '暂无归档会话' })).toBeVisible();
  } finally {
    await chmod(join(f.root, 'profile'), 0o700).catch(() => {});
    if (app) await app.close(); await rm(f.root, { recursive: true, force: true });
  }
  const none = await fixture(); app = undefined;
  try {
    app = await none.launch(); const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await choose(app, none.project); await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    await page.getByRole('button', { name: '全选', exact: true }).click();
    await page.getByRole('button', { name: '全不选', exact: true }).click();
    await page.getByRole('button', { name: '确认添加项目' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '历史会话已归档' })).toBeVisible();
    await page.screenshot({ path: join(evidence, 'all-archived.png') });
    await page.getByRole('button', { name: '归档', exact: true }).click();
    await expect(page.locator('.session-row')).toHaveCount(3);
  } finally { if (app) await app.close(); await rm(none.root, { recursive: true, force: true }); }
});

test('storage error recovery and candidate deletion feedback are truthful in the packaged UI', async () => {
  const f = await fixture(); let app: ElectronApplication | undefined;
  const { rename, unlink } = await import('node:fs/promises');
  const kept = join(f.root, 'sessions-kept');
  await rename(f.sessionsRoot, kept); await writeFile(f.sessionsRoot, 'not a directory');
  try {
    app = await f.launch(); const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await choose(app, f.project); await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('存储位置不是文件夹');
    await expect(page.getByRole('dialog')).not.toContainText('其余 0 条归档');
    await expect(page.getByRole('dialog')).toContainText('候选结果尚未确定');
    await expect(page.getByRole('dialog').locator('details .error-detail')).not.toBeVisible();
    await expect(page.getByRole('button', { name: '确认添加项目' })).toBeDisabled();
    await page.screenshot({ path: join(evidence, 'import-storage-error.png') });
    await unlink(f.sessionsRoot); await rename(kept, f.sessionsRoot);
    await page.getByRole('button', { name: '重试导入' }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    await page.getByRole('button', { name: '全选', exact: true }).click();
    await unlink(join(f.sessionsRoot, '--not-the-project-name--', 'beta.jsonl'));
    await page.getByRole('button', { name: '确认添加项目' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.session-row')).toHaveCount(2);
    await expect(page.getByRole('status')).toContainText('1 条已删除，未导入');
  } finally { if (app) await app.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('large discovery shows real progress, allows cancellation, and never saves a project', async () => {
  const f = await fixture(); let app: ElectronApplication | undefined;
  const header = { type: 'session', id: 'slow', cwd: f.project, version: 3, padding: 'x'.repeat(60000) };
  for (let index = 0; index < 80; index++) await writeFile(join(f.sessionsRoot, '--not-the-project-name--', `slow-${index}.jsonl`), JSON.stringify({ ...header, id: `slow-${index}` }) + '\n' + JSON.stringify({ type: 'message', id: `m-${index}`, message: { role: 'user', content: '扫描取消检查' } }) + '\n');
  try {
    app = await f.launch(); const page = await app.firstWindow();
    await app.evaluate(({ nativeTheme, BrowserWindow }) => { nativeTheme.themeSource = 'dark'; BrowserWindow.getAllWindows()[0].setSize(860, 640); });
    await page.emulateMedia({ colorScheme: null });
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await choose(app, f.project); await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('正在查找历史会话');
    await expect(page.getByRole('button', { name: '确认添加项目' })).toBeDisabled();
    await expect(page.getByRole('dialog').getByRole('status')).not.toContainText('已检查 0 个文件');
    await page.screenshot({ path: join(evidence, 'scanning-narrow-dark.png') });
    await page.getByRole('button', { name: '取消添加' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await expect(page.locator('.session-footer').getByRole('status')).toContainText('项目未保存');
  } finally { if (app) await app.close(); await rm(f.root, { recursive: true, force: true }); }
});

for (const phase of ['scanning', 'validating'] as const) test(`manual progress reread resumes ${phase} polling after a transient failure`, async () => {
  const f = await fixture(); let app: ElectronApplication | undefined;
  const header = { type: 'session', cwd: f.project, version: 3, padding: 'x'.repeat(60000) };
  for (let index = 0; index < 80; index++) await writeFile(join(f.sessionsRoot, '--not-the-project-name--', `progress-${index}.jsonl`), JSON.stringify({ ...header, id: `progress-${index}` }) + '\n');
  try {
    app = await f.launch(); const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    // Fault injection at Electron's transport boundary. Business results come from the real service.
    // Replay its first in-progress response on manual retry, as a delayed transport reply.
    await app.evaluate(({ ipcMain }, phase) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> })._invokeHandlers;
      const original = handlers.get('imports:getImport')!;
      let delayed: unknown; let first = true;
      ipcMain.removeHandler('imports:getImport');
      ipcMain.handle('imports:getImport', async (...args) => {
        if (first) {
          const response = await original(...args);
          if (response.status !== 'completed' || response.value.state !== phase) return response;
          first = false; delayed = response;
          return { status: 'failed', error: { code: 'BACKGROUND_UNAVAILABLE', message: '进度读取暂时中断，请重新读取。' } };
        }
        if (delayed) { const response = delayed; delayed = undefined; return response; }
        return original(...args);
      });
    }, phase);
    await choose(app, f.project); await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    if (phase === 'validating') {
      await expect(page.getByRole('checkbox')).toHaveCount(3);
      await page.getByRole('button', { name: '全选', exact: true }).click();
      await page.getByRole('button', { name: '确认添加项目' }).click();
    }
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('进度读取暂时中断');
    await page.getByRole('button', { name: phase === 'validating' ? '核对保存结果' : '重新读取', exact: true }).click();
    if (phase === 'validating') {
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('.session-row')).toHaveCount(3);
    } else {
      await expect(page.getByRole('dialog').getByRole('checkbox')).toHaveCount(3);
      await expect(page.getByRole('button', { name: '确认添加项目' })).toBeEnabled();
    }
    await page.screenshot({ path: join(evidence, `polling-${phase}-recovered.png`) });
  } finally { if (app) await app.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('migrated projects without an import never claim that history was scanned empty', async () => {
  const f = await fixture(); let app: ElectronApplication | undefined;
  const Database = (await import('better-sqlite3')).default;
  await mkdir(join(f.root, 'profile'));
  const db = new Database(join(f.root, 'profile', 'projects.sqlite'));
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE); PRAGMA user_version=1');
  db.prepare('INSERT INTO projects VALUES (?, ?)').run('legacy', f.project); db.close();
  try {
    app = await f.launch(); const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '暂无已导入会话' })).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('未发现已保存的历史对话');
    await expect(page.getByRole('main')).toContainText('尚无已导入的会话记录');
    await page.screenshot({ path: join(evidence, 'migrated-project-neutral.png') });
  } finally { if (app) await app.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('post-discovery corruption is shown before publication and valid selections can still be imported', async () => {
  const f = await fixture(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await choose(app, f.project); await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    await page.getByRole('button', { name: '全选', exact: true }).click();
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(f.sessionsRoot, '--not-the-project-name--', 'beta.jsonl'), 'BAD LINE\n');
    await page.getByRole('button', { name: '确认添加项目' }).click();
    await expect(page.getByRole('dialog')).toContainText('1 条记录已损坏');
    await expect(page.getByRole('checkbox')).toHaveCount(2);
    await expect(page.getByRole('checkbox').first()).toBeChecked();
    await expect(page.getByRole('dialog')).toContainText('本次尚未提交');
    await page.screenshot({ path: join(evidence, 'corrupt-candidate-review.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 640));
    await expect(page.getByRole('button', { name: '确认添加项目' })).toBeInViewport();
    await page.screenshot({ path: join(evidence, 'corrupt-candidate-narrow.png') });
    await page.getByRole('button', { name: '确认添加项目' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.session-row')).toHaveCount(2);
  } finally { if (app) await app.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('lost commit response requires verification and discovers success without another submission', async () => {
  const f = await fixture(); let app: ElectronApplication | undefined;
  try {
    app = await f.launch(); const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
    await choose(app, f.project); await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    await page.getByRole('button', { name: '全选', exact: true }).click();
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> })._invokeHandlers.get('imports:commitImport')!;
      ipcMain.removeHandler('imports:commitImport');
      ipcMain.handle('imports:commitImport', async (...args) => {
        await original(...args);
        return { status: 'failed', error: { code: 'BACKGROUND_UNAVAILABLE', message: '未收到保存回执。' } };
      });
    });
    await page.getByRole('button', { name: '确认添加项目' }).click();
    await expect(page.getByRole('button', { name: '确认添加项目' })).toBeDisabled();
    await expect(page.getByRole('dialog')).toContainText('请先核对本次保存结果');
    await page.getByRole('button', { name: '核对保存结果' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.session-row')).toHaveCount(3);
    await expect(page.locator('.project-row')).toHaveCount(1);
  } finally { if (app) await app.close(); await rm(f.root, { recursive: true, force: true }); }
});
