import {launchOwnedElectron} from '../fixtures/owned-electron';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE ?? '.scratch/pi-hub-test-runs/project-scope-desktop');
test('packaged settings stage descendants, retain failed input, remove with confirmation and restore only new history after restart', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-hub-05-ui-')); const project = join(root, '项目 · 范围设置'); const child = join(project, '子目录'); const sessionsRoot = join(root, 'sessions'); const folder = join(sessionsRoot, 'records');
 await mkdir(child, {recursive:true}); await mkdir(folder, {recursive:true}); await mkdir(evidence,{recursive:true});
 const record = async (id:string,cwd:string) => { const file=join(folder,id+'.jsonl'); await writeFile(file,[{type:'session',version:3,id,cwd,timestamp:'2026-01-01T00:00:00Z'},{type:'message',id:'m-'+id,parentId:null,message:{role:'user',content:'对话 '+id,timestamp:1767225600000}}].map(x=>JSON.stringify(x)).join('\n')+'\n'); return file; };
 const file=await record('子目录历史',child); const before=await readFile(file); await record('根目录历史',project);
 const launch=()=>launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),sessionsRoot,evidence);
 let app:ElectronApplication|undefined;
 try {
  app=await launch(); let page=await app.firstWindow(); await app.evaluate(({nativeTheme,BrowserWindow})=>{nativeTheme.themeSource='light';BrowserWindow.getAllWindows()[0].setSize(1440,900);});
  const choose=async()=>{await app!.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},project);await page.getByRole('button',{name:'添加项目',exact:true}).first().click();};
  await expect(page.getByRole('heading',{name:'从一个项目开始'})).toBeVisible(); await choose(); await expect(page.getByRole('checkbox')).toHaveCount(1); await page.getByRole('button',{name:'确认添加项目',exact:true}).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'项目设置',exact:true}).click(); await page.getByRole('checkbox',{name:'包含子目录',exact:true}).check(); await page.screenshot({path:join(evidence,'settings-light.png')}); await page.getByRole('button',{name:'保存范围',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'选择历史会话'})).toBeVisible(); await expect(page.getByRole('checkbox')).toHaveCount(1); await expect(page.getByRole('dialog')).toContainText('子目录历史'); await page.getByRole('button',{name:'取消范围调整'}).click(); await expect(page.locator('.scope-badge')).toHaveText('仅当前目录');
  await page.getByRole('button',{name:'项目设置',exact:true}).click(); await page.getByRole('checkbox',{name:'包含子目录',exact:true}).check(); await rename(project,project+'-moved'); await page.getByRole('button',{name:'保存范围',exact:true}).click(); await expect(page.getByRole('dialog').getByRole('alert')).toContainText('目录不可用'); await expect(page.getByRole('checkbox',{name:'包含子目录',exact:true})).toBeChecked();
  await app.evaluate(({nativeTheme,BrowserWindow})=>{nativeTheme.themeSource='dark';BrowserWindow.getAllWindows()[0].setSize(860,640);}); await page.emulateMedia({colorScheme:null}); await page.screenshot({path:join(evidence,'settings-unavailable-dark-narrow.png')}); await rename(project+'-moved',project); await page.getByRole('button',{name:'保存范围',exact:true}).click(); await expect(page.getByRole('dialog',{name:'选择历史会话'})).toBeVisible(); await expect(page.getByRole('checkbox')).toHaveCount(1); await page.getByRole('button',{name:'全选',exact:true}).click(); await page.getByRole('button',{name:'确认调整范围'}).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('.session-row')).toHaveCount(1); await expect(page.locator('.scope-badge')).toHaveText('包含子目录');
  await page.locator('.session-row button').click(); await expect(page.locator('.preview-content')).toContainText('子目录历史'); await page.getByRole('button',{name:'关闭预览'}).click(); await page.getByRole('button',{name:'项目设置',exact:true}).click(); await page.getByRole('button',{name:'移除项目',exact:true}).click(); await expect(page.getByRole('dialog')).toContainText('不会删除原始会话文件'); await page.screenshot({path:join(evidence,'remove-confirmation-dark-narrow.png')}); await page.getByRole('button',{name:'确认移除项目',exact:true}).click(); await expect(page.getByRole('heading',{name:'从一个项目开始'})).toBeVisible();
  await record('移除期间新增',child); await app.close(); app=await launch(); page=await app.firstWindow(); await expect(page.getByRole('heading',{name:'从一个项目开始'})).toBeVisible(); await choose(); await expect(page.getByRole('checkbox')).toHaveCount(1); await expect(page.getByRole('dialog')).toContainText('移除期间新增'); await page.screenshot({path:join(evidence,'return-new-history.png')}); await page.getByRole('button',{name:'确认添加项目',exact:true}).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('.session-row')).toHaveCount(1); await page.getByRole('button',{name:'归档',exact:true}).click(); await expect(page.locator('.session-row')).toHaveCount(2); expect(await readFile(file)).toEqual(before);
  await writeFile(join(evidence,'runtime.json'),JSON.stringify(await app.evaluate(({app})=>({appPath:app.getAppPath(),versions:process.versions})),null,2));
 } finally { if(app) await app.close(); await rm(root,{recursive:true,force:true}); }
});

test('range confirmation keeps the selected parent preview after a candidate disappears and after restoring and rescanning', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-hub-05-preview-')); const project = join(root, 'Orchard'); const child = join(project, 'web'); const sessionsRoot = join(root, 'sessions'); const folder = join(sessionsRoot, 'records');
 await mkdir(child, { recursive: true }); await mkdir(folder, { recursive: true }); await mkdir(evidence, { recursive: true });
 const record = async (id: string, cwd: string, text: string) => {
  const path = join(folder, `${id}.jsonl`); await writeFile(path, [{ type: 'session', version: 3, id, cwd, timestamp: '2026-01-01T00:00:00Z' }, { type: 'message', id: `m-${id}`, parentId: null, message: { role: 'user', content: text, timestamp: 1767225600000 } }].map(e => JSON.stringify(e)).join('\n') + '\n'); return path;
 };
 const parentFile = await record('parent', project, 'Orchard release checklist'); const childFile = await record('web', child, 'Polish Orchard web navigation'); const before = await Promise.all([readFile(parentFile), readFile(childFile)]);
 const app = await launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),sessionsRoot,evidence);
 try {
  const page = await app.firstWindow(); await app.evaluate(({ nativeTheme, BrowserWindow }) => { nativeTheme.themeSource = 'light'; BrowserWindow.getAllWindows()[0].setSize(1200, 780); });
  await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click(); await expect(page.getByRole('checkbox')).toHaveCount(1); await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '确认添加项目' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  const parent = page.locator('.session-row button').filter({ hasText: 'Orchard release checklist' });
  await parent.click(); await expect(page.locator('.preview-content')).toContainText('Orchard release checklist');
  await page.getByRole('button', { name: '项目设置' }).click(); await page.getByRole('checkbox', { name: '包含子目录', exact: true }).check(); await page.getByRole('button', { name: '保存范围' }).click();
  await expect(page.getByRole('dialog', { name: '选择历史会话' })).toBeVisible(); await expect(page.getByRole('checkbox')).toHaveCount(1); await page.getByRole('checkbox').check();
  await rename(childFile, join(root, 'web-held.jsonl')); await page.getByRole('button', { name: '确认调整范围' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('.session-footer')).toContainText('1 条已删除，未导入');
  await expect(parent).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('.preview-content')).toContainText('Orchard release checklist');
  await page.screenshot({ path: join(evidence, 'interrupted-candidate-parent-preview.png') });
  await rename(join(root, 'web-held.jsonl'), childFile); await expect(page.getByRole('button', { name: '重新扫描', exact: true })).toBeVisible(); await page.getByRole('button', { name: '重新扫描', exact: true }).click(); await expect(page.locator('.session-row')).toHaveCount(2);
  await expect(parent).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('.preview-content')).toContainText('Orchard release checklist'); await page.screenshot({ path: join(evidence, 'restored-rescan-parent-preview.png') });
  await page.locator('.session-row button').filter({ hasText: 'Polish Orchard web navigation' }).click(); await expect(parent).toHaveAttribute('aria-pressed', 'false'); await expect(page.locator('.preview-content')).toContainText('Polish Orchard web navigation'); await expect(page.locator('.preview-identity')).toContainText(child);
  expect(await Promise.all([readFile(parentFile), readFile(childFile)])).toEqual(before);
 } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
