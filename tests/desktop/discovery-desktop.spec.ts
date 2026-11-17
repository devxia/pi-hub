import {launchOwnedElectron} from '../fixtures/owned-electron';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, rename, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE ?? '.scratch/pi-hub-test-runs/discovery-desktop');
test('packaged live discovery, unavailable cache, recovery and offline additions survive restart', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-hub-discovery-ui-')); const project = join(root, '自动发现 · 项目'); const sessionsRoot = join(root, 'sessions'); const folder = join(sessionsRoot, '--fixture--');
 await mkdir(project); await mkdir(folder, { recursive: true }); await mkdir(evidence, { recursive: true });
 const record = async (id: string) => writeFile(join(folder, `${id}.jsonl`), [ { type: 'session', id, cwd: project, version: 3 }, { type: 'message', id: `${id}-1`, message: { role: 'user', content: `对话 ${id}`, timestamp: 1767225600000 } } ].map(e => JSON.stringify(e)).join('\n') + '\n');
 const launch = () => launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),sessionsRoot,evidence);
 let app: ElectronApplication | undefined;
 try {
  await record('历史归档'); const sourceBefore = await readFile(join(folder, '历史归档.jsonl'));
  app = await launch(); let page = await app.firstWindow();
  await app.evaluate(({ nativeTheme, BrowserWindow }) => { nativeTheme.themeSource = 'light'; BrowserWindow.getAllWindows()[0].setSize(1440, 900); });
  await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
  await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click(); await expect(page.getByRole('checkbox')).toHaveCount(1); await page.getByRole('button', { name: '确认添加项目' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  const start = Date.now(); await record('实时新增'); await expect(page.locator('.session-row').filter({ hasText: '对话 实时新增' })).toBeVisible(); const liveLatency = Date.now() - start;
  await expect(page.getByText('扫描完成', { exact: false })).toBeVisible();
  await expect(page.locator('.session-footer')).toContainText('添加时：0 条加入主列表 · 1 条归档');
  await page.screenshot({ path: join(evidence, 'live-light.png') });
  // Kill only this isolated app's named utility process; the reconnect poll must recover it.
  await app.evaluate(({ app }) => {
    const worker = app.getAppMetrics().find(metric => metric.type === 'Utility' && metric.name === 'Pi Hub database');
    if (!worker) throw Error('Owned utility process not found');
    process.kill(worker.pid, 'SIGKILL');
  });
  await record('服务重连新增');
  await expect(page.locator('.session-row')).toHaveCount(2);
  await page.screenshot({ path: join(evidence, 'utility-reconnected.png') });
  await rename(sessionsRoot, `${sessionsRoot}-away`); await page.getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('存储位置暂不可用'); await expect(page.locator('.session-row').filter({ hasText: '对话 实时新增' })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'storage-unavailable.png') });
  await app.close(); app = await launch(); page = await app.firstWindow();
  await expect(page.locator('.session-row').filter({ hasText: '对话 实时新增' })).toBeVisible(); await expect(page.getByRole('alert')).toContainText('存储位置暂不可用');
  await page.screenshot({ path: join(evidence, 'persistent-cache.png') });
  await rename(`${sessionsRoot}-away`, sessionsRoot); await page.getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await rename(project, `${project}-away`); await page.getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(page.getByText('项目目录不可用，请恢复目录与访问权限。', { exact: true }).first()).toBeVisible();
  await app.evaluate(({ nativeTheme, BrowserWindow }) => { nativeTheme.themeSource = 'dark'; BrowserWindow.getAllWindows()[0].setSize(860, 640); });
  await page.emulateMedia({ colorScheme: null }); await page.screenshot({ path: join(evidence, 'project-unavailable-dark-narrow.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await rename(`${project}-away`, project); await page.getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(page.getByText('项目目录不可用，请恢复目录与访问权限。', { exact: true })).toHaveCount(0);
  await app.close(); await record('退出期间新增'); app = await launch(); page = await app.firstWindow();
  await expect(page.locator('.session-row')).toHaveCount(3); await page.getByRole('button', { name: '归档', exact: true }).click(); await expect(page.locator('.session-row')).toContainText('对话 历史归档');
  expect(await readFile(join(folder, '历史归档.jsonl'))).toEqual(sourceBefore);
  await page.screenshot({ path: join(evidence, 'recovered-archive.png') });
  await writeFile(join(evidence, 'packaged-runtime.json'), JSON.stringify({ liveLatencyMs: liveLatency, ...(await app.evaluate(({ app }) => ({ versions: process.versions, metrics: app.getAppMetrics(), appPath: app.getAppPath() }))) }, null, 2));
 } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
});
test('packaged reconciliation exposes real progress, cancels without clearing cached rows, and isolates malformed records', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-hub-progress-ui-')); const project = join(root, '进度检查'); const sessionsRoot = join(root, 'sessions'); const folder = join(sessionsRoot, '--fixture--');
 await mkdir(project); await mkdir(folder, { recursive: true }); let app: ElectronApplication | undefined;
 const entries = (id: string) => JSON.stringify({ type: 'session', id, cwd: project, version: 3 }) + '\n' + JSON.stringify({ type: 'message', id: `${id}-1`, message: { role: 'user', content: `对话 ${id}`, timestamp: 1767225600000 } }) + '\n';
 try {
  await writeFile(join(folder, 'cached.jsonl'), entries('cached'));
  app = await launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),sessionsRoot,evidence);
  const page = await app.firstWindow(); await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
  await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click(); await expect(page.getByRole('checkbox')).toHaveCount(1); await page.getByRole('button', { name: '全选', exact: true }).click(); await page.getByRole('button', { name: '确认添加项目' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await writeFile(join(folder, 'large.jsonl'), entries('large') + JSON.stringify({ type: 'custom', padding: 'x'.repeat(14 * 1024 * 1024) }) + '\n');
  await expect(page.getByRole('button', { name: '取消扫描', exact: true })).toBeVisible();
  await expect(page.locator('.sync-state')).toContainText('正在扫描');
  await expect(page.locator('.sync-state')).not.toContainText('已检查 0 个文件');
  await page.screenshot({ path: join(evidence, 'scan-progress.png') });
  await page.getByRole('button', { name: '取消扫描', exact: true }).click(); await expect(page.locator('.sync-state')).toContainText('扫描已取消');
  await expect(page.locator('.session-row').first()).toContainText('对话 cached');
  await rm(join(folder, 'large.jsonl')); await writeFile(join(folder, 'bad.jsonl'), entries('bad') + 'BAD COMPLETE LINE\n');
  await expect(page.locator('.scan-issues')).toContainText('1 条记录暂不可读取');
  await page.locator('.scan-issues summary').click(); await page.screenshot({ path: join(evidence, 'record-error.png') });
  await expect(page.locator('.session-row')).toHaveCount(1);
 } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('cached startup error is identified as previous while a restarted utility awaits verification', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-hub-prior-error-ui-')); const project = join(root, '恢复核对');
 const sessionsRoot = join(root, 'sessions'); const folder = join(sessionsRoot, '--fixture--');
 await mkdir(project); await mkdir(folder, { recursive: true }); await mkdir(evidence, { recursive: true });
 await writeFile(join(folder, 'cached.jsonl'), JSON.stringify({ type: 'session', id: 'cached', cwd: project, version: 3 }) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: '等待核对时仍可辨认的会话', timestamp: 1767225600000 } }) + '\n');
 let app: ElectronApplication | undefined;
 try {
  app = await launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),sessionsRoot,evidence);
  const page = await app.firstWindow(); await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
  await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click(); await expect(page.getByRole('checkbox')).toHaveCount(1);
  await page.getByRole('button', { name: '全选', exact: true }).click(); await page.getByRole('button', { name: '确认添加项目' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await rename(sessionsRoot, `${sessionsRoot}-away`); await page.getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('会话同步未完成');
  // Hold transport delivery after the real restarted service's cached snapshot, making the
  // brief cache-first state inspectable without manufacturing any business result.
  await app.evaluate(({ app, BrowserWindow, ipcMain }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents); let cachedDelivered = false;
    const waiting: (() => void)[] = [];
    contents.send = (channel: string, ...args: any[]) => {
      if (channel === 'workspace:changed') {
        if (cachedDelivered) { waiting.push(() => send(channel, ...args)); return; }
        if (args[0]?.discovery.state === 'idle' && args[0]?.discovery.error) cachedDelivered = true;
      }
      send(channel, ...args);
    };
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> })._invokeHandlers.get('workspace:getSnapshot')!;
    ipcMain.removeHandler('workspace:getSnapshot');
    ipcMain.handle('workspace:getSnapshot', async (...args) => {
      const response = await original(...args);
      if (cachedDelivered && response.status === 'completed' && response.value.discovery.state !== 'idle') await new Promise<void>(resolve => waiting.push(resolve));
      return response;
    });
    (globalThis as any).releaseDiscoveryDelivery = () => { contents.send = send; cachedDelivered = false; waiting.splice(0).forEach(release => release()); };
    const worker = app.getAppMetrics().find(metric => metric.type === 'Utility' && metric.name === 'Pi Hub database');
    if (!worker) throw Error('Owned utility missing'); process.kill(worker.pid, 'SIGKILL');
  });
  await page.reload();
  await expect(page.locator('.sync-state')).toContainText('等待后台核对');
  await expect(page.getByRole('alert')).toContainText('上次同步未完成 · 本次尚待核对');
  await expect(page.getByRole('alert')).toContainText('上次记录：');
  await page.screenshot({ path: join(evidence, 'previous-error-awaiting-verification.png') });
  await app.evaluate(() => (globalThis as any).releaseDiscoveryDelivery());
  await expect(page.locator('.sync-state')).toContainText('同步未完成');
  await expect(page.getByRole('alert')).not.toContainText('上次同步');
  await rename(`${sessionsRoot}-away`, sessionsRoot); await page.getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.locator('.session-row')).toHaveCount(1);
 } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('packaged v2 upgrade retains archived sources behind an empty replacement root and later confirms real deletion', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-hub-v2-upgrade-ui-')); const project = join(root, '旧版归档');
 const sessionsRoot = join(root, 'sessions'); const folder = join(sessionsRoot, '--fixture--'); const file = join(folder, 'legacy.jsonl');
 await mkdir(project); await mkdir(folder, { recursive: true });
 const bytes = Buffer.from(JSON.stringify({ type: 'session', id: 'legacy', cwd: project, version: 3 }) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: '升级前保留的归档会话', timestamp: 1767225600000 } }) + '\n'); await writeFile(file, bytes);
 const launch = () => launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),sessionsRoot,evidence);
 let app: ElectronApplication | undefined;
 try {
  app = await launch(); let page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
  await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click(); await expect(page.getByRole('checkbox')).toHaveCount(1);
  await page.getByRole('button', { name: '确认添加项目' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await app.close(); app = undefined;
  // Set up the v2 on-disk format. All result assertions go through the packaged UI.
  const Database = (await import('better-sqlite3')).default; const db = new Database(join(root, 'profile', 'projects.sqlite'));
  db.exec("DROP TABLE sdk_hosts; DROP TABLE native_clone_requests; DROP TABLE delete_requests; DROP TABLE rename_requests; DROP TABLE IF EXISTS directory_recoveries; DROP TABLE terminal_requests; DROP TABLE terminal_settings; DROP TABLE IF EXISTS recovery_requests; DROP TABLE IF EXISTS clone_requests; DROP TABLE IF EXISTS runtime_leases; DROP TABLE IF EXISTS launch_reservations; DROP TABLE classification_requests; DROP TABLE classification_state; DROP TABLE storage_locations; ALTER TABLE projects DROP COLUMN include_descendants; ALTER TABLE projects DROP COLUMN enabled; DROP TABLE discovery_state; UPDATE sessions SET data=json_remove(data,'$.sources','$.sourceRootIdentity','$.sourceFingerprint','$.sourceModifiedAt','$.hasMessages'); PRAGMA user_version=2;"); db.close();
  await rename(sessionsRoot, `${sessionsRoot}-original`); await mkdir(sessionsRoot);
  for (let restart = 0; restart < 2; restart++) {
    app = await launch(); page = await app.firstWindow(); await page.getByRole('button', { name: '归档', exact: true }).click();
    await expect(page.locator('.session-row')).toContainText('升级前保留的归档会话');
    for (let scan = 0; scan < 2; scan++) {
      await expect(page.getByRole('button', { name: '重新扫描', exact: true })).toBeVisible(); await page.getByRole('button', { name: '重新扫描', exact: true }).click();
      await expect(page.locator('.sync-state')).toContainText('扫描完成'); await expect(page.locator('.session-row')).toContainText('记录暂不可读');
    }
    if (restart === 0) { await page.screenshot({ path: join(evidence, 'v2-upgrade-retains-archive.png') }); await app.close(); app = undefined; }
  }
  await rm(sessionsRoot, { recursive: true }); await rename(`${sessionsRoot}-original`, sessionsRoot);
  await page.getByRole('button', { name: '重新扫描', exact: true }).click(); await expect(page.locator('.session-row')).not.toContainText('记录暂不可读');
  // An available cached row can precede calibration of the restored storage root.
  // Wait for the real public snapshot's physical-root proof before testing deletion.
  const restoredRoot=await stat(sessionsRoot);
  await expect.poll(async()=>{const r=await page.evaluate(()=>window.sessionManagement.getSnapshot());return r.status==='completed'?r.value.sessions.find(s=>s.headerId==='legacy')?.sources?.find(s=>s.sourcePath===file)?.rootIdentity:undefined;}).toBe(`${restoredRoot.dev}:${restoredRoot.ino}`);
  expect(await readFile(file)).toEqual(bytes); await page.screenshot({ path: join(evidence, 'v2-original-root-restored.png') });
  await rm(file); await page.getByRole('button', { name: '重新扫描', exact: true }).click(); await expect(page.locator('.session-row')).toHaveCount(0);
  await writeFile(file, bytes); await page.getByRole('button', { name: '全部会话', exact: true }).click(); await expect(page.locator('.session-row')).toContainText('升级前保留的归档会话');
  expect(await readFile(file)).toEqual(bytes);
 } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
});
