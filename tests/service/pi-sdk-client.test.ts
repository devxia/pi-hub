import {piInstallation} from '../fixtures/pi-installation';
import {test,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openSessionManagement} from '../../src/session-management/service';
import type {Result} from '../../src/session-management/interface';
const value=<T>(r:Result<T>):T=>{if(r.status==='failed')throw Error(r.error.message);return r.value;};
test('Pi SDK configuration preserves user resources and only removes the exact retired Hub extension',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-sdk-config-')),agent=join(root,'agent'),app=join(root,'app');for(const p of [agent,app,join(root,'sessions')])await mkdir(p,{recursive:true});const legacy=join(app,'companion','extension.ts'),settings={theme:'dark',packages:['/user-package'],extensions:['/user-extension.ts',legacy],custom:{keep:true}};await writeFile(join(agent,'settings.json'),JSON.stringify(settings));
 const opened=await openSessionManagement(join(root,'db'),{sessionsRoot:join(root,'sessions'),runtime:{appData:app,agentDir:agent,hostAssetPath:resolve('src/terminal/sdk-host.mjs')}});const m=value(opened);
 try{expect(value(await m.getPiStatus()).configured).toBe(false);const reviewed=value(await m.inspectPi({mode:'launcher',piPath:piInstallation.launcher,nodePath:process.execPath}));expect(reviewed.compatibility).toBe('supported');expect(await readFile(join(agent,'settings.json'),'utf8')).toBe(JSON.stringify(settings));const saved=value(await m.savePiConfiguration({reviewId:reviewed.reviewId!}));expect(saved.configured).toBe(true);expect(saved.legacyExtensionConfigured).toBe(false);expect(JSON.parse(await readFile(join(agent,'settings.json'),'utf8'))).toEqual({...settings,extensions:['/user-extension.ts']});expect(saved).not.toHaveProperty('baselineConfirmed');expect(saved).not.toHaveProperty('extensionPath');}
 finally{await m.close();await rm(root,{recursive:true,force:true});}
},15000);

test('browse and classification need no Pi setup and no global configuration is created',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-sdk-browse-')),project=join(root,'project'),sessions=join(root,'sessions'),folder=join(sessions,'encoded');await mkdir(project);await mkdir(folder,{recursive:true});await writeFile(join(folder,'saved.jsonl'),[{type:'session',version:3,id:'browse',cwd:project},{type:'message',id:'u',parentId:null,message:{role:'user',content:'Native file',timestamp:1}}].map(e=>JSON.stringify(e)).join('\n')+'\n');const m=value(await openSessionManagement(join(root,'db'),{sessionsRoot:sessions}));
 try{const batch=value(await m.prepareImport({requestId:'import',path:project}))!;await expect.poll(async()=>value(await m.getImport({batchId:batch.id})).state).toBe('ready');const ready=value(await m.getImport({batchId:batch.id}));value(await m.selectImport({batchId:batch.id,selectedKeys:ready.candidates.map(c=>c.key)}));value(await m.commitImport({batchId:batch.id}));await expect.poll(async()=>value(await m.getImport({batchId:batch.id})).state).toBe('completed');const s=value(await m.getSnapshot()).sessions[0];expect(value(await m.getPreview({requestId:'preview',key:s.key})).messages[0].text).toBe('Native file');value(await m.setSessionClassification({requestId:'archive',key:s.key,classification:'archive',expectedRevision:s.classificationRevision??0}));expect(value(await m.getSnapshot()).sessions[0].classification).toBe('archive');const prepared=value(await m.prepareRename({key:s.key}));expect(value(await m.renameSession({requestId:'native-offline-name',key:s.key,identity:s.identity,expectedRevision:prepared.expectedRevision,name:'From graphical client'})).state).toBe('completed');const {SessionManager}=await import('@earendil-works/pi-coding-agent');expect(SessionManager.open(join(folder,'saved.jsonl')).getSessionName()).toBe('From graphical client');expect(value(await m.prepareDelete({key:s.key})).sourcePath).toBeTruthy();}
 finally{await m.close();await rm(root,{recursive:true,force:true});}
 // The first native name operation loads the real SDK; allow its cold import under packaging load.
},15000);
