import {launchOwnedElectron} from '../fixtures/owned-electron';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE ?? '.scratch/pi-hub-test-runs/browse-revision-desktop');
async function fixture(long = false) {
 const root = await mkdtemp(join(tmpdir(), 'pi-hub-04-revision-'));
 const project = long ? join(root, ...Array.from({ length: 3 }, (_, i) => `${i}-${'长目录'.repeat(24)}`)) : join(root, '运行分支');
 const sessionsRoot = join(root, 'sessions'); const folder = join(sessionsRoot, '--fixture--');
 await mkdir(project, { recursive: true }); await mkdir(folder, { recursive: true }); await mkdir(evidence, { recursive: true });
 const title = long ? '需要完整辨认的长会话名称'.repeat(180) : '分支预览';
 const source = join(folder, 'branches.jsonl');
 await writeFile(source, [
  { type: 'session', version: 3, id: 'branches', cwd: project, timestamp: '2026-01-01T00:00:00Z' },
  { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: '辨认分支的问题', timestamp: 1767225600000 } },
  { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: '当前活动分支 A', timestamp: 1767225600001 } },
  { type: 'message', id: 'b', parentId: 'u', message: { role: 'assistant', content: '磁盘恢复分支 B', timestamp: 1767225600002 } },
  { type: 'session_info', id: 'name', parentId: 'b', name: title },
 ].map(e => JSON.stringify(e)).join('\n') + '\n');
 let app: ElectronApplication | undefined;
 try {
  app = await launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),sessionsRoot,evidence);
  const page = await app.firstWindow(); await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
  await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click(); await expect(page.getByRole('checkbox')).toHaveCount(1); await page.getByRole('button', { name: '全选', exact: true }).click(); await page.getByRole('button', { name: '确认添加项目' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  return { app, page, project, title, source, root, close: async () => { await app!.close(); await rm(root, { recursive: true, force: true }); } };
 } catch (error) { if (app) await app.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
async function runtime(app: ElectronApplication, generation: number, leafId: string | null, connected = true) {
 return app.evaluate(async ({ app }, observation) => {
  // Cached main module exposes the trusted bridge, not a renderer IPC mutation.
  const requireMain = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
  const bridge = requireMain(app.getAppPath() + '/dist/desktop/main.cjs').background;
  const snapshot = await bridge.getSnapshot(); const row = snapshot.value.sessions[0];
  return bridge.updatePreviewRuntime({ key: row.key, identity: row.identity, ...observation });
 }, { generation, leafId, connected });
}
test('displayed preview follows trusted runtime invalidations and rejects delayed responses without file changes', async () => {
 const f = await fixture();
 try {
  const bytes = await readFile(f.source); await f.page.locator('.session-row button').click(); await expect(f.page.locator('.preview-content')).toContainText('磁盘恢复分支 B');
  expect(await f.page.evaluate(() => 'updatePreviewRuntime' in window.sessionManagement)).toBe(false);
  expect(await runtime(f.app, 1, 'a')).toMatchObject({ status: 'completed' }); await expect(f.page.locator('.preview-content')).toContainText('当前活动分支 A');
  expect(await runtime(f.app, 2, 'b')).toMatchObject({ status: 'completed' }); await expect(f.page.locator('.preview-content')).toContainText('磁盘恢复分支 B');
  expect(await runtime(f.app, 3, 'a')).toMatchObject({ status: 'completed' }); await expect(f.page.locator('.preview-content')).toContainText('当前活动分支 A');
  expect(await runtime(f.app, 4, null, false)).toMatchObject({ status: 'completed' }); await expect(f.page.locator('.preview-content')).toContainText('磁盘恢复分支 B');
  // Hold an actual A reply after service validation, then accept B's newer revision.
  await f.app.evaluate(({ ipcMain }) => {
   const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> })._invokeHandlers;
   const original = handlers.get('sessions:getPreview')!; let hold = true;
   ipcMain.removeHandler('sessions:getPreview'); ipcMain.handle('sessions:getPreview', async (...args) => {
    const result = await original(...args); if (hold) { hold = false; await new Promise<void>(resolve => { (globalThis as any).releasePreview = resolve; }); } return result;
   });
  });
  expect(await runtime(f.app, 5, 'a')).toMatchObject({ status: 'completed' }); await expect(f.page.locator('.preview-content')).toContainText('正在读取预览');
  await expect.poll(() => f.app.evaluate(() => typeof (globalThis as any).releasePreview)).toBe('function');
  expect(await runtime(f.app, 6, 'b')).toMatchObject({ status: 'completed' }); await expect(f.page.locator('.preview-content')).toContainText('磁盘恢复分支 B');
  await f.app.evaluate(async () => { (globalThis as any).releasePreview(); await new Promise<void>(resolve => setImmediate(resolve)); });
  await f.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(f.page.locator('.preview-content')).not.toContainText('当前活动分支 A'); await expect(f.page.locator('.preview-content')).toContainText('磁盘恢复分支 B');
  expect(await readFile(f.source)).toEqual(bytes); await f.page.screenshot({ path: join(evidence, 'runtime-disconnect-restored.png') });
 } finally { await f.close(); }
});
test('long valid identity leaves conversation and actions reachable at normal and narrow sizes, with styled retry', async () => {
 const f = await fixture(true);
 try {
  await f.page.locator('.session-row button').click(); await expect(f.page.locator('.preview-content')).toContainText('磁盘恢复分支 B');
  for (const [width, height] of [[1440, 900], [860, 640]]) {
   await f.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size as [number, number]), [width, height]);
   await expect(f.page.locator('.preview-content')).toBeInViewport(); await expect(f.page.locator('.preview-actions')).toHaveCount(0);
   const content = await f.page.locator('.preview-content').boundingBox(); expect(content!.height).toBeGreaterThan(120);
   await expect(f.page.locator('.preview-identity')).toContainText(f.title); await expect(f.page.locator('.preview-identity')).toContainText(f.project);
   if(!await f.page.locator('.preview-identity details').getAttribute('open').then(value=>value!==null)){await f.page.locator('.preview-identity summary').focus();await f.page.keyboard.press('Enter');}
   await f.page.locator('.preview-identity').focus(); await f.page.keyboard.press('End');
   await expect.poll(() => f.page.locator('.preview-identity').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
   await f.page.locator('.preview-content').focus(); await f.page.keyboard.press('End'); await expect(f.page.locator('.preview-message').last()).toBeInViewport();
   await f.page.screenshot({ path: join(evidence, `long-identity-${width}.png`) });
  }
  await writeFile(f.source, (await readFile(f.source, 'utf8')) + '{"type":"custom","id":"cycle","parentId":"cycle"}\n');
  await f.page.getByRole('button', { name: '关闭预览' }).click(); await f.page.locator('.session-row button').click();
  await expect(f.page.locator('.preview .error-panel[role="alert"]')).toContainText('无法读取'); await expect(f.page.locator('.preview .error-panel svg')).toBeVisible();
  await expect(f.page.getByRole('button', { name: '重试预览' })).toBeInViewport(); await f.page.screenshot({ path: join(evidence, 'preview-error-narrow.png') });
 } finally { await f.close(); }
});
test('selected dark navigation retains text contrast during theme change, hover and keyboard focus', async () => {
 const f = await fixture();
 try {
  await f.page.getByRole('button', { name: '全部会话', exact: true }).click();
  await f.app.evaluate(({ nativeTheme, BrowserWindow }) => { nativeTheme.themeSource = 'light'; BrowserWindow.getAllWindows()[0].setSize(860, 640); });
  await f.page.emulateMedia({ colorScheme: null }); await expect.poll(() => f.page.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches)).toBe(true);
  // Finish existing light selection transitions, then measure every frame across the theme change.
  await f.page.locator('.nav-row.selected').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  await f.app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  const samples = await f.page.locator('.nav-row.selected').evaluate(async el => {
   const luminance = (rgb: string) => rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
   const samples = []; for (let i = 0; i < 14; i++) { await new Promise(requestAnimationFrame); const style = getComputedStyle(el); const a = luminance(style.color), b = luminance(style.backgroundColor); samples.push({ foreground: style.color, background: style.backgroundColor, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }); } return samples;
  });
  await writeFile(join(evidence, 'theme-transition-contrast.json'), JSON.stringify(samples, null, 2)); expect(Math.min(...samples.map(s => s.ratio))).toBeGreaterThanOrEqual(4.5);
  const colors = [];
  for (const state of ['selected', 'hover', 'focus']) {
   const nav = f.page.locator('.nav-row.selected');
   if (state === 'hover') await nav.hover();
   if (state === 'focus') { await f.page.mouse.move(840, 620); await nav.focus(); await f.page.keyboard.press('Tab'); await f.page.keyboard.press('Shift+Tab'); await expect(nav).toBeFocused(); }
   await nav.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
   colors.push(await nav.evaluate((el, state) => ({ state, rect: el.getBoundingClientRect().toJSON(), textRect: el.querySelector('span')!.getBoundingClientRect().toJSON(), foreground: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, icon: getComputedStyle(el.querySelector('svg')!).color, outline: getComputedStyle(el).outlineColor }), state));
   await f.page.screenshot({ path: join(evidence, `dark-nav-${state}.png`) });
  }
  for (const color of colors) {
   const luminance = (rgb: string) => rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
   const a = luminance(color.foreground), b = luminance(color.background);
   expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toBeGreaterThanOrEqual(4.5); expect(color.icon).toBe(color.foreground);
  }
  await writeFile(join(evidence, 'dark-nav-colors.json'), JSON.stringify(colors, null, 2));
 } finally { await f.close(); }
});
