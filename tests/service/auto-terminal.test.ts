import {piInstallation} from '../fixtures/pi-installation';
import {shellQuote} from '../../src/session-management/terminal-shell';
import {test,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,access,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openSessionManagement} from '../../src/session-management/service';
import {TerminalAdapterFailure,type TerminalLaunchDescriptor} from '../../src/session-management/terminal';
import type {Result,SessionManagement} from '../../src/session-management/interface';
const value=<T>(r:Result<T>):T=>{if(r.status==='failed')throw Error(r.error.message);return r.value;};

test('PATH discovery opens with a one-time choice and only remembers an explicit default across restart',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'pi-auto-terminal-'))),agent=join(root,'agent'),app=join(root,'app'),bin=join(root,'bin'),project=join(root,'project'),sessions=join(root,'sessions');for(const p of [agent,app,bin,project,sessions])await mkdir(p);
 const settings=JSON.stringify({theme:'dark',extensions:[],packages:[],custom:{keep:true}});await writeFile(join(agent,'settings.json'),settings);await symlink(process.execPath,join(bin,'node'));await writeFile(join(bin,'pi'),`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(piInstallation.cli)} "$@"\n`,{mode:0o700});
 const previousPath=process.env.PATH;process.env.PATH=bin+':/usr/bin:/bin:/usr/sbin:/sbin';const launches:TerminalLaunchDescriptor[]=[];let m:SessionManagement|undefined;
 const options={sessionsRoot:sessions,runtime:{appData:app,agentDir:agent,hostAssetPath:resolve('src/terminal/sdk-host.mjs')},terminal:{appData:app,adapter:{async inspect(){return {bundleId:'com.apple.Terminal' as const,path:'/System/Applications/Utilities/Terminal.app',version:'2.14'};},async launch(d:TerminalLaunchDescriptor){launches.push(d);throw new TerminalAdapterFailure('STARTUP_IO',true);}},ghosttyAdapter:{async inspect(){throw Error('Not installed');}}}};
 try{
  m=value(await openSessionManagement(join(root,'db'),options));const p=value(await m.addProject({requestId:'project',path:project})).project!,request={requestId:'first-open',intent:'new' as const,projectId:p.id};expect(value(await m.getTerminalSettings())).toMatchObject({defaultTerminal:null,available:[{terminal:'Terminal'}]});expect(value(await m.getPiStatus()).configured).toBe(false);
  expect(await m.openTerminal(request)).toMatchObject({status:'failed',error:{code:'TERMINAL_MISSING'}});expect(launches).toHaveLength(0);await expect(access(join(app,'pi-launch.json'))).rejects.toBeTruthy();
  expect(value(await m.openTerminal({...request,terminal:'Terminal',rememberTerminal:false})).state).toBe('not-started');expect(launches).toHaveLength(1);expect(value(await m.getPiStatus())).toMatchObject({configured:true,compatibility:'supported',launch:{piPath:join(bin,'pi'),nodePath:process.execPath}});expect(value(await m.getTerminalSettings()).defaultTerminal).toBeNull();expect(await readFile(join(agent,'settings.json'),'utf8')).toBe(settings);
  expect(await m.openTerminal({...request,requestId:'still-ask'})).toMatchObject({status:'failed',error:{code:'TERMINAL_MISSING'}});expect(launches).toHaveLength(1);
  value(await m.openTerminal({...request,requestId:'remember',terminal:'Terminal',rememberTerminal:true}));expect(value(await m.getTerminalSettings()).defaultTerminal).toBe('Terminal');await m.close();m=value(await openSessionManagement(join(root,'db'),options));expect(value(await m.getTerminalSettings()).defaultTerminal).toBe('Terminal');value(await m.openTerminal({...request,requestId:'use-default'}));expect(launches).toHaveLength(3);
  value(await m.setDefaultTerminal({terminal:null}));expect(value(await m.getTerminalSettings()).defaultTerminal).toBeNull();expect(await m.openTerminal({...request,requestId:'ask-again'})).toMatchObject({status:'failed',error:{code:'TERMINAL_MISSING'}});expect(await m.openTerminal({...request,requestId:'invalid',rememberTerminal:true})).toMatchObject({status:'failed',error:{code:'INVALID_REQUEST'}});expect(launches).toHaveLength(3);
 }finally{await m?.close();if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;await rm(root,{recursive:true,force:true});}
},20000);
