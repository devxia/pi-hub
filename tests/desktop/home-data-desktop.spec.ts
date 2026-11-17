import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,readFile,realpath,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {launchOwnedElectron} from '../fixtures/owned-electron';

test('packaged default stores Hub data under owned HOME/.pi-hub without inheriting the previous directory',async()=>{
 const evidence=resolve(process.env.PI_HUB_TEST_EVIDENCE!),root=await realpath(await mkdtemp(join(tmpdir(),'pi-hub-home-data-'))),home=join(root,'home'),profile=join(home,'.pi-hub'),appData=join(home,'Library','Application Support'),legacy=join(appData,'Pi Hub'),agent=join(root,'agent'),sessions=join(root,'sessions'),entry=join(root,'entry'),project=join(root,'fresh-project');
 for(const path of [profile,legacy,agent,sessions,entry,project,evidence])await mkdir(path,{recursive:true});
 const oldDb='owned obsolete profile must not be read or migrated',oldLaunch=JSON.stringify({obsolete:true});await writeFile(join(legacy,'projects.sqlite'),oldDb);await writeFile(join(legacy,'pi-launch.json'),oldLaunch);
 const originalApp=process.env.PI_HUB_TEST_APP,originalEntry=process.env.PI_HUB_TEST_ENTRY;
 const packageRoot=resolve(dirname(originalApp!),'../Resources/app.asar'),production=join(packageRoot,'dist/desktop/main.cjs');
 await writeFile(join(entry,'package.json'),JSON.stringify({name:'pi-hub-home-data-proof',main:'main.cjs'}));
 // Control only the owned OS appData boundary and remove the switch before requiring the real packaged main.
 // argv retains the explicitly owned profile; launchOwnedElectron verifies actual userData/HOME before any UI.
 await writeFile(join(entry,'main.cjs'),`const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});app.commandLine.removeSwitch('user-data-dir');require(${JSON.stringify(production)});if(app.getPath('userData')!==${JSON.stringify(profile)})throw Error('Default profile escaped owned HOME');`);
 process.env.PI_HUB_TEST_APP=resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');process.env.PI_HUB_TEST_ENTRY=entry;
 let app:Awaited<ReturnType<typeof launchOwnedElectron>>|undefined;
 try{
  app=await launchOwnedElectron(root,profile,agent,sessions,evidence);const actual=await app.evaluate(({app})=>({name:app.getName(),home:process.env.HOME,userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),logs:app.getPath('logs'),crashDumps:app.getPath('crashDumps'),profileSwitch:app.commandLine.hasSwitch('user-data-dir'),argv:process.argv}));
  expect(actual).toMatchObject({name:'Pi Hub',home,userData:profile,sessionData:profile,logs:join(profile,'logs'),crashDumps:join(profile,'Crashpad'),profileSwitch:false});
  const page=await app.firstWindow();await expect(page.getByRole('heading',{name:'从一个项目开始'})).toBeVisible();expect(await page.evaluate(()=>window.sessionManagement.getPiStatus())).toMatchObject({status:'completed',value:{configured:false}});
  await app.evaluate(({dialog},project)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[project]});},project);await page.getByRole('button',{name:'添加项目',exact:true}).first().click();await page.getByRole('button',{name:'确认添加项目',exact:true}).click();await expect(page.getByRole('heading',{name:'fresh-project',exact:true})).toBeVisible();expect((await stat(join(profile,'projects.sqlite'))).size).toBeGreaterThan(0);expect(await readFile(join(legacy,'projects.sqlite'),'utf8')).toBe(oldDb);expect(await readFile(join(legacy,'pi-launch.json'),'utf8')).toBe(oldLaunch);await app.close();app=undefined;
  app=await launchOwnedElectron(root,profile,agent,sessions,evidence);const reopened=await app.firstWindow();await expect(reopened.getByRole('button',{name:/fresh-project/}).first()).toBeVisible();await writeFile(join(evidence,'default-home-result.json'),JSON.stringify({actual,packagedProductionMain:production,freshDefaultProfile:true,noLegacyImport:true,newDatabasePersists:true,legacyBytesUnchanged:true},null,2));
 }finally{await app?.close();if(originalApp===undefined)delete process.env.PI_HUB_TEST_APP;else process.env.PI_HUB_TEST_APP=originalApp;if(originalEntry===undefined)delete process.env.PI_HUB_TEST_ENTRY;else process.env.PI_HUB_TEST_ENTRY=originalEntry;await rm(root,{recursive:true,force:true});}
});
