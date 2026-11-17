import {launchOwnedElectron} from '../fixtures/owned-electron';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE ?? '.scratch/pi-hub-test-runs/browse-desktop');
test('packaged browsing keeps context and safely previews real records in wide and narrow themes', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-hub-04-ui-')); const project = join(root, '中文 · 长路径项目'); const sessionsRoot = join(root, 'sessions'); const folder = join(sessionsRoot, '--fixture--');
 await mkdir(project); await mkdir(folder, { recursive: true }); await mkdir(evidence, { recursive: true });
 const attack = '<script>window.compromised=true</script> ![image](https://example.invalid/track) [run](command:rm)';
 for (let i = 0; i < 65; i++) await writeFile(join(folder, `${i}.jsonl`), [
  { type: 'session', version: 3, id: `session-${i}`, cwd: project, timestamp: `2020-01-01T00:00:00.000Z` },
  { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: `需求 ${i}`, timestamp: 1767225600000 + i * 1000 } },
  { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: i === 64 ? attack + '\n长内容。'.repeat(500) : `回答 ${i} 正文唯一词`, timestamp: 1767225600001 + i * 1000 } },
  { type: 'session_info', id: 'n', parentId: 'a', name: '重名会话' },
 ].map(e => JSON.stringify(e)).join('\n') + '\n');
 const app = await launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),sessionsRoot,evidence);
 try {
  const page = await app.firstWindow(); const remote: string[] = []; page.on('request', r => { if (r.url().startsWith('http')) remote.push(r.url()); });
  await app.evaluate(({ nativeTheme, BrowserWindow }) => { nativeTheme.themeSource = 'light'; BrowserWindow.getAllWindows()[0].setSize(1440, 900); });
  await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
  await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click(); await expect(page.getByRole('checkbox')).toHaveCount(50);
  await page.getByRole('button', { name: '全选', exact: true }).click(); await page.getByRole('checkbox').last().uncheck(); await page.getByRole('button', { name: '确认添加项目' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('searchbox', { name: '搜索会话' }).fill('正文唯一词'); await expect(page.getByText('没有匹配的会话', { exact: true })).toBeVisible();
  await page.getByRole('searchbox').fill('需求 64'); await expect(page.locator('.session-row')).toHaveCount(1); await page.locator('.session-row button').click();
  await expect(page.locator('.preview-content')).toContainText(attack); await expect(page.locator('.preview img, .preview a, .preview script')).toHaveCount(0);
  await expect(page.locator('.preview-actions')).toHaveCount(0); expect(remote).toEqual([]);
  await expect(page.locator('.preview-content details')).toHaveCount(1); await page.screenshot({ path: join(evidence, 'browse-light.png') });
  await page.getByRole('button', { name: '归档', exact: true }).click(); await expect(page.getByRole('searchbox')).toHaveValue('需求 64'); await page.getByRole('searchbox').fill('');
  await page.getByRole('combobox', { name: '归档项目' }).selectOption({ label: '中文 · 长路径项目' }); await expect(page.locator('.session-row')).toHaveCount(1); await page.screenshot({ path: join(evidence, 'archive-filter.png') });
  await page.getByRole('button', { name: '全部会话', exact: true }).click(); await page.getByRole('combobox', { name: '会话范围' }).selectOption('all'); await expect(page.locator('.session-footer')).toContainText('65 条会话');
  await page.getByRole('combobox', { name: '排序' }).selectOption('name'); await page.locator('.session-list').evaluate(el => { el.scrollTop = 600; }); const scroll = await page.locator('.session-list').evaluate(el => el.scrollTop);
  await page.getByRole('button', { name: '归档', exact: true }).click(); await page.getByRole('button', { name: '全部会话', exact: true }).click(); expect(await page.locator('.session-list').evaluate(el => el.scrollTop)).toBe(scroll);
  await page.getByRole('combobox', { name: '排序' }).selectOption('recent'); await page.locator('.session-row button').first().focus(); await page.keyboard.press('Enter'); await expect(page.locator('.preview-content')).toContainText('需求 64');
  // Delay a real preview response at the transport seam; newer selection must win.
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> })._invokeHandlers.get('sessions:getPreview')!;
    let first = true; let release: (() => void) | undefined;
    ipcMain.removeHandler('sessions:getPreview'); ipcMain.handle('sessions:getPreview', async (...args) => {
      const result = await original(...args); if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); } return result;
    });
    (globalThis as any).releasePreview = () => release?.();
  });
  await page.locator('.session-row button').nth(2).click(); await expect(page.locator('.preview-content')).toContainText('正在读取预览');
  await page.locator('.session-row button').nth(1).click(); await expect(page.locator('.preview-content')).toContainText('需求 63');
  await app.evaluate(() => (globalThis as any).releasePreview()); await expect(page.locator('.preview-content')).toContainText('需求 63');
  await page.locator('.session-row button').first().click(); await expect(page.locator('.preview-content')).toContainText('需求 64');
  await app.evaluate(({ nativeTheme, BrowserWindow }) => { nativeTheme.themeSource = 'dark'; BrowserWindow.getAllWindows()[0].setSize(860, 640); }); await page.emulateMedia({ colorScheme: null });
  await expect(page.locator('.preview')).toBeVisible(); await page.screenshot({ path: join(evidence, 'preview-dark-narrow.png') });
  await page.getByRole('button', { name: '关闭预览' }).click(); await expect(page.locator('.session-row button').first()).toBeFocused();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await expect(page.locator('.preview-content')).toContainText('需求 63'); await page.keyboard.press('Escape'); await expect(page.locator('.session-row button').nth(1)).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await writeFile(join(evidence, 'runtime.json'), JSON.stringify(await app.evaluate(({ app }) => ({ appPath: app.getAppPath(), versions: process.versions })), null, 2));
 } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
