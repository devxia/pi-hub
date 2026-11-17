import {expect,test,_electron as electron,type ElectronApplication} from '@playwright/test';
import {realpath,writeFile,mkdir,readFile} from 'node:fs/promises';
import * as asar from '@electron/asar';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute,relative,resolve,join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const fixtureRequire=createRequire(import.meta.url);
import {installMemoryClipboard} from './clipboard';
/** Harness assertion before any product interaction: Electron does not infer userData from HOME. */
export async function launchOwnedElectron(root:string,profile:string,agent:string,sessions:string,evidence:string,options:{foreground?:boolean}={}){
 const home=join(root,'home'),entry=process.env.PI_HUB_TEST_ENTRY;
 const canonicalRoot=await realpath(root);
 const inside=(path:string)=>{const rel=relative(canonicalRoot,path);return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);};
 for(const path of [profile,home,agent,sessions]){const rel=relative(resolve(root),resolve(path));if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('Owned Electron rejected an external path');}
 for(const path of [profile,home,agent,evidence])await mkdir(path,{recursive:true});
 for(const path of [profile,home,agent,sessions]){try{if(!inside(await realpath(path)))throw Error('Owned Electron rejected a canonical external path');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 let foreground=options.foreground;
 if(foreground===undefined){try{foreground=test.info().project.metadata.foreground===true;}catch{foreground=false;}}
 const requestedExecutable=resolve(process.env.PI_HUB_TEST_APP!);
 const productionRoot=entry?resolve(entry):resolve(dirname(requestedExecutable),'../Resources/app.asar');
 let executablePath=requestedExecutable,launchEntry=entry;
 if(!foreground){
  const bootstrap=join(root,'quiet-electron-entry');await mkdir(bootstrap,{recursive:true});
  const metadata=JSON.parse(entry?await readFile(join(productionRoot,'package.json'),'utf8'):asar.extractFile(productionRoot,'package.json').toString());
  await writeFile(join(bootstrap,'package.json'),JSON.stringify({...metadata,main:'main.cjs'}));
  const boundary=fileURLToPath(new URL('./quiet-electron.cjs',import.meta.url));
  // Electron's own default-app loader uses setAppPath before loading a package. Keep
  // module lookup and getAppPath pointed at the real product, never at a fake app.
  await writeFile(join(bootstrap,'main.cjs'),`const electron=require('electron');try{const quiet=require(${JSON.stringify(boundary)})(electron),Module=require('node:module'),load=Module._load;Module._load=function(request,...args){return request==='electron'?quiet:load.call(this,request,...args);};if(typeof electron.app.setAppPath!=='function')throw Error('Quiet harness requires Electron package loader support');electron.app.setAppPath(${JSON.stringify(productionRoot)});require(${JSON.stringify(productionRoot)});}catch(error){console.error(error);electron.app.exit(1);}`);
  executablePath=fixtureRequire('electron');launchEntry=bootstrap;
 }
 const args=[...(launchEntry?[resolve(launchEntry)]:[]),`--user-data-dir=${profile}`,'--use-mock-keychain','--password-store=basic'];
 const app=await electron.launch({executablePath,args,env:{...process.env,ELECTRON_RUN_AS_NODE:'',HOME:home,PI_CODING_AGENT_DIR:agent,PI_HUB_SESSIONS_ROOT:sessions,PI_OFFLINE:'1'}});
 try{
  const actual=await app.evaluate(({app})=>({argv:process.argv,userData:app.getPath('userData'),home:process.env.HOME,agent:process.env.PI_CODING_AGENT_DIR,sessions:process.env.PI_HUB_SESSIONS_ROOT,pid:process.pid}));
  const canonicalProfile=await realpath(profile),actualProfile=await realpath(actual.userData);
  if(!actual.argv.includes(`--user-data-dir=${profile}`)||actualProfile!==canonicalProfile||!inside(actualProfile)||actual.home!==home||actual.agent!==agent||actual.sessions!==sessions)throw Error('Owned Electron preflight rejected actual argv/profile/environment');
  await installMemoryClipboard(app);
  const close=app.close.bind(app);app.close=async()=>{
   if(!foreground){
    const windows=await app.evaluate(({BrowserWindow})=>({state:(globalThis as any).ownedQuietWindows,windows:BrowserWindow.getAllWindows().map(window=>({id:window.id,visible:window.isVisible(),focused:window.isFocused()}))}));
    await writeFile(join(evidence,'quiet-windows-'+actual.pid+'.json'),JSON.stringify(windows,null,2));
    // Clean the owned application even when a native visibility assertion fails.
    await observeOwnedShutdown(app,evidence,close);
    expect(windows.state.violations).toEqual([]);
    expect(windows.windows.every(window=>!window.visible&&!window.focused)).toBe(true);
   }else await observeOwnedShutdown(app,evidence,close);
  };
  await writeFile(join(evidence,'owned-launch-'+actual.pid+'.json'),JSON.stringify({...actual,canonicalRoot,actualProfile,mode:foreground?'foreground':'quiet',productionRoot,requestedExecutable,spawnargs:app.process().spawnargs},null,2));
  return app;
 }catch(error){await app.close();throw error;}
}

/** Observe an owned app's normal native quit as well as Playwright close, with identical process proof. */
export async function observeOwnedShutdown(app:ElectronApplication,evidence:string,action:()=>Promise<unknown>){
 const exec=promisify(execFile);
 const observe=async(pid:number)=>{try{return (await exec('/bin/ps',['-p',String(pid),'-o','lstart=','-o','tty='],{env:{...process.env,LC_ALL:'C',LANG:'C'}})).stdout.trim()||null;}catch{return null;}};
 const {pid,metrics}=await app.evaluate(({app})=>({pid:process.pid,metrics:app.getAppMetrics().map(m=>({pid:m.pid,type:m.type}))}));
 const before=await Promise.all(metrics.map(async m=>({...m,identity:await observe(m.pid)})));
 await action();
 await expect.poll(async()=>Promise.all(before.map(async m=>await observe(m.pid)===m.identity&&m.identity!==null)),{timeout:10000}).not.toContain(true);
 await writeFile(join(evidence,'owned-cleanup-'+pid+'.json'),JSON.stringify({before,after:await Promise.all(before.map(async m=>({pid:m.pid,identity:await observe(m.pid)})))},null,2));
}
