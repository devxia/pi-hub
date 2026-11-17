import {piInstallation} from '../fixtures/pi-installation';
import {test,expect,type ElectronApplication} from '@playwright/test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {launchOwnedElectron} from '../fixtures/owned-electron';
import {openSettings,closeSettings} from '../fixtures/settings-window';
const evidence=resolve(process.env.PI_HUB_TEST_EVIDENCE??'.scratch/pi-hub-test-runs/settings');

test('one independent settings window preserves drafts and protects native close and application quit',async()=>{
 test.setTimeout(60000);
 const root=await mkdtemp(join(tmpdir(),'pi-hub-settings-')),sessions=join(root,'sessions');await mkdir(sessions);let app:ElectronApplication|undefined;
 try{
  app=await launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),sessions,evidence);const main=await app.firstWindow();
  await expect(main.getByRole('heading',{name:'从一个项目开始'})).toBeVisible();await expect(main.locator('.sidebar-bottom button')).toHaveText(['添加项目','设置']);await main.locator('.sidebar-bottom').screenshot({path:join(evidence,'sidebar-settings-label.png')});
  let page=await openSettings(app,main);await expect(page.getByRole('heading',{name:'终端',exact:true})).toBeVisible();
  await expect.poll(()=>page.getByRole('button',{name:'保存终端设置'}).isEnabled()).toBe(false);
  await main.getByRole('button',{name:'归档',exact:true}).click();await expect(main.getByRole('heading',{name:'归档',exact:true})).toBeVisible();
  const wc=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Pi Hub 设置')!.webContents.id);
  await openSettings(app,main);await page.getByRole('button',{name:'Pi 启动',exact:true}).click();await page.getByLabel('Pi 启动文件',{exact:true}).fill('/owned/unconfigured/pi');
  await page.getByRole('button',{name:'终端',exact:true}).click();await page.getByRole('radio',{name:/^Terminal/}).check();await page.getByRole('button',{name:'Pi 启动',exact:true}).click();await page.getByRole('button',{name:'终端',exact:true}).click();await expect(page.getByRole('radio',{name:/^Terminal/})).toBeChecked();
  await page.getByRole('button',{name:'Pi 启动',exact:true}).click();await expect(page.getByLabel('Pi 启动文件',{exact:true})).toHaveValue('/owned/unconfigured/pi');await expect(page.locator('.settings-nav')).toContainText('未保存');
  await app.evaluate(({dialog})=>{(globalThis as any).settingsPrompts=[];(dialog as any).showMessageBox=async(_window:any,options:any)=>{(globalThis as any).settingsPrompts.push(options);return {response:0,checkboxChecked:false};};});
  await app.evaluate(({BrowserWindow,webContents},id)=>BrowserWindow.fromWebContents(webContents.fromId(id)!)!.close(),wc);
  await expect.poll(()=>app!.evaluate(()=>(globalThis as any).settingsPrompts.length)).toBe(1);expect(page.isClosed()).toBe(false);
  await app.evaluate(({app})=>app.quit());await expect.poll(()=>app!.evaluate(()=>(globalThis as any).settingsPrompts.length)).toBe(2);expect(page.isClosed()).toBe(false);
  await page.screenshot({path:join(evidence,'settings-draft-light.png')});
  const denied=await page.evaluate(()=>window.sessionManagement.chooseProject({requestId:crypto.randomUUID()}));expect(denied).toMatchObject({status:'failed',error:{code:'INVALID_REQUEST'}});
  await app.evaluate(({dialog})=>{(dialog as any).showMessageBox=async()=>({response:1,checkboxChecked:false});});await closeSettings(page);
  // Native application menu and keyboard accelerator share the same singleton entry.
  await app.evaluate(({Menu})=>{const item=Menu.getApplicationMenu()!.items[0].submenu!.items.find(i=>i.label==='设置…')!;if(item.accelerator!=='Command+,')throw Error('Missing settings shortcut');item.click();});
  await expect.poll(()=>app!.windows().filter(p=>p.url().includes('view=settings')).length).toBe(1);page=app.windows().find(p=>p.url().includes('view=settings'))!;
  await expect(page.getByLabel('Pi 启动文件',{exact:true})).toHaveValue('');await expect(page.getByRole('button',{name:'检测 Pi 启动配置',exact:true})).toBeEnabled();
  await app.evaluate(({nativeTheme,BrowserWindow})=>{nativeTheme.themeSource='dark';BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Pi Hub 设置')!.setSize(680,520);});
  await page.emulateMedia({colorScheme:null});await page.screenshot({path:join(evidence,'settings-dark-680.png')});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await closeSettings(page);
 }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Pi Hub 设置')?.destroy());await app.close();}await rm(root,{recursive:true,force:true});}
});

test('Pi settings detects real SDK configuration before saving and retains validation failures in its category',async()=>{
 test.setTimeout(60000);const root=await mkdtemp(join(tmpdir(),'pi-hub-pi-settings-')),sessions=join(root,'sessions');await mkdir(sessions);let app:ElectronApplication|undefined;
 try{
  app=await launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),sessions,evidence);const main=await app.firstWindow(),page=await openSettings(app,main,'Pi 启动');
  await page.getByLabel('Pi 启动文件',{exact:true}).fill('/owned/missing/pi');await page.getByRole('button',{name:'检测 Pi 启动配置',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('button',{name:'保存启动配置'})).toBeDisabled();await page.getByRole('button',{name:'重新读取启动配置'}).click();await expect(page.getByLabel('Pi 启动文件',{exact:true})).toHaveValue('/owned/missing/pi');
  await page.getByLabel('Pi 启动文件',{exact:true}).fill(piInstallation.launcher);await page.getByLabel('Node 可执行文件',{exact:true}).fill(piInstallation.node);await page.getByRole('button',{name:'检测 Pi 启动配置',exact:true}).click();await expect(page.getByRole('button',{name:'保存启动配置'})).toBeEnabled();
  await page.getByRole('button',{name:'保存启动配置'}).click();await expect(page.getByRole('status')).toContainText('启动配置已保存');expect(await page.evaluate(()=>window.sessionManagement.getPiStatus())).toMatchObject({status:'completed',value:{configured:true}});
  await page.getByLabel('Node 可执行文件',{exact:true}).fill('/owned/changed/node');await expect(page.getByRole('button',{name:'保存启动配置'})).toBeDisabled();
  await app.evaluate(({dialog})=>{(dialog as any).showMessageBox=async()=>({response:1,checkboxChecked:false});});await closeSettings(page);
 }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Pi Hub 设置')?.destroy());await app.close();}await rm(root,{recursive:true,force:true});}
});
