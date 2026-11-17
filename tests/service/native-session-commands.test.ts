import {piInstallation} from '../fixtures/pi-installation';
import {test,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {TerminalAdapterFailure} from '../../src/session-management/terminal';
import {prepareManualHandoff,inspectManualHandoff,revokeManualHandoff} from '../../src/session-management/manual-handoff';
import {openSessionManagement} from '../../src/session-management/service';
import type {Result} from '../../src/session-management/interface';
const value=<T>(r:Result<T>):T=>{if(r.status==='failed')throw Error(r.error.message);return r.value;};
async function fixture(extra?:(root:string)=>Parameters<typeof openSessionManagement>[1]){
 const root=await realpath(await mkdtemp(join(tmpdir(),'pi-native-commands-'))),project=join(root,'project'),folder=join(root,'sessions','encoded');await mkdir(project);await mkdir(folder,{recursive:true});
 const files=['one','two'].map(id=>join(folder,id+'.jsonl'));
 for(let i=0;i<files.length;i++)await writeFile(files[i],[{type:'session',version:3,id:['one','two'][i],cwd:project},{type:'message',id:'u',parentId:null,message:{role:'user',content:'Native command '+i,timestamp:1}}].map(e=>JSON.stringify(e)).join('\n')+'\n');
 let trashCalls=0;
 const m=value(await openSessionManagement(join(root,'db'),{sessionsRoot:join(root,'sessions'),deletion:{async trash(proof){expect(files).toContain(proof.path);trashCalls++;await unlink(proof.path);}},...extra?.(root)}));
 const batch=value(await m.prepareImport({requestId:'import',path:project}))!;await expect.poll(async()=>value(await m.getImport({batchId:batch.id})).state).toBe('ready');const ready=value(await m.getImport({batchId:batch.id}));value(await m.selectImport({batchId:batch.id,selectedKeys:ready.candidates.map(c=>c.key)}));value(await m.commitImport({batchId:batch.id}));await expect.poll(async()=>value(await m.getImport({batchId:batch.id})).state).toBe('completed');await expect.poll(async()=>value(await m.getSnapshot()).sessions.filter(s=>s.availability.state==='available').length).toBe(files.length);
 return {root,files,m,get trashCalls(){return trashCalls;},async close(){await m.close();await rm(root,{recursive:true,force:true});}};
}

test('one graphical rename request cannot mutate two records or repeat its native append',async()=>{
 // Loading the real public Pi SDK on the first name command is part of this integration path.
 const f=await fixture();try{
  const rows=value(await f.m.getSnapshot()).sessions,preparations=await Promise.all(rows.map(s=>f.m.prepareRename({key:s.key}))),before=await Promise.all(f.files.map(p=>readFile(p,'utf8')));
  const requests=preparations.map((p,i)=>({requestId:'one-request',key:rows[i].key,identity:rows[i].identity,expectedRevision:value(p).expectedRevision,name:'Name '+i}));
  const results=await Promise.all(requests.map(r=>f.m.renameSession(r)));expect(results.filter(r=>r.status==='completed')).toHaveLength(1);expect(results.filter(r=>r.status==='failed')).toHaveLength(1);
  const winner=results.findIndex(r=>r.status==='completed'),after=await Promise.all(f.files.map(p=>readFile(p,'utf8')));expect(after.filter((text,i)=>text!==before[i])).toHaveLength(1);
  expect(value(await f.m.renameSession(requests[winner])).state).toBe('completed');expect(await Promise.all(f.files.map(p=>readFile(p,'utf8')))).toEqual(after);
 }finally{await f.close();}
},15000);

test('lost rename receipt is read-only and preserves a newer native name',async()=>{
 const f=await fixture();const Database=(await import('better-sqlite3')).default;const fault=new Database(join(f.root,'db'));
 try{
  const row=value(await f.m.getSnapshot()).sessions[0],p=value(await f.m.prepareRename({key:row.key}));
  fault.exec("CREATE TRIGGER lost_name_receipt BEFORE UPDATE ON rename_requests WHEN json_extract(NEW.data,'$.outcome.state')='completed' BEGIN SELECT RAISE(ABORT,'owned lost name receipt'); END");
  const request={requestId:'lost-name',key:row.key,identity:row.identity,expectedRevision:p.expectedRevision,name:'Graphical name'};
  expect(await f.m.renameSession(request)).toMatchObject({status:'failed',error:{code:'DATABASE_UNAVAILABLE'}});fault.exec('DROP TRIGGER lost_name_receipt');
  const {SessionManager}=await import('@earendil-works/pi-coding-agent');SessionManager.open(row.sourcePath).appendSessionInfo('Newer native name');const before=await readFile(row.sourcePath,'utf8');
  expect(value(await f.m.getRenameOutcome({requestId:request.requestId}))).toMatchObject({state:'superseded',canonicalName:'Newer native name'});expect(value(await f.m.renameSession(request))).toMatchObject({state:'superseded',canonicalName:'Newer native name'});expect(await readFile(row.sourcePath,'utf8')).toBe(before);
 }finally{fault.close();await f.close();}
});

test('concurrent retries and manual preparation dispatch only the same original launch attempt',async()=>{
 let launches=0,manualPreparations=0;
 const f=await fixture(root=>({runtime:{appData:join(root,'app'),agentDir:join(root,'agent'),hostAssetPath:resolve('src/terminal/sdk-host.mjs')},terminal:{appData:join(root,'app'),adapter:{async inspect(){return {bundleId:'com.apple.Terminal',path:'/System/Applications/Utilities/Terminal.app',version:'2.14'};},async launch(){launches++;throw new TerminalAdapterFailure('STARTUP_IO',true);},async prepareManual(d){manualPreparations++;return prepareManualHandoff(d);},inspectManual:inspectManualHandoff,revokeManual:revokeManualHandoff}}}));
 try{
  const inspected=value(await f.m.inspectPi({piPath:piInstallation.launcher,nodePath:process.execPath}));value(await f.m.savePiConfiguration({reviewId:inspected.reviewId!}));value(await f.m.setDefaultTerminal({terminal:'Terminal'}));const row=value(await f.m.getSnapshot()).sessions[0],request={requestId:'one-launch',intent:'resume' as const,projectId:row.projectId,key:row.key,identity:row.identity};expect(value(await f.m.openTerminal(request)).state).toBe('not-started');expect(launches).toBe(1);
  const retried=await Promise.all([f.m.retryTerminal({requestId:request.requestId}),f.m.retryTerminal({requestId:request.requestId})]);expect(retried.map(r=>value(r).state)).toEqual(['not-started','not-started']);expect(launches).toBe(2);
  const prepared=await Promise.all([f.m.prepareTerminalCommand({requestId:request.requestId}),f.m.prepareTerminalCommand({requestId:request.requestId})]);expect(prepared.map(r=>value(r).state)).toEqual(['awaiting-paste','awaiting-paste']);expect(manualPreparations).toBe(1);expect(launches).toBe(2);expect(value(await f.m.cancelTerminalCommand({requestId:request.requestId})).state).toBe('not-started');
  expect(await f.m.openTerminal({...request,requestId:'mixed-new',intent:'new'})).toMatchObject({status:'failed',error:{code:'INVALID_REQUEST'}});expect(launches).toBe(2);
  const original=await readFile(row.sourcePath,'utf8');await writeFile(row.sourcePath,original.replace('"version":3','"version":2'));await f.m.reconcile();let legacy:any;await expect.poll(async()=>{legacy=value(await f.m.getSnapshot()).sessions.find(s=>s.sourcePath===row.sourcePath);return legacy?.identity!==row.identity&&!!legacy;}).toBe(true);const legacyBytes=await readFile(row.sourcePath,'utf8');expect(await f.m.openTerminal({...request,requestId:'legacy-resume',key:legacy.key,identity:legacy.identity})).toMatchObject({status:'failed',error:{code:'RECORD_CHANGED',message:expect.stringContaining('升级')}});expect(launches).toBe(2);expect(await readFile(row.sourcePath,'utf8')).toBe(legacyBytes);
 }finally{await f.close();}
},15000);

test('unconnected native records can be renamed and explicitly deleted without occupancy inference',async()=>{
 const f=await fixture();try{
  const row=value(await f.m.getSnapshot()).sessions[0];expect(row.runtimeState).toBe('unknown');expect(row.runtimeCapabilities.rename.allowed).toBe(true);expect(row.runtimeCapabilities.delete.allowed).toBe(true);
  const p=value(await f.m.prepareDelete({key:row.key})),before=await readFile(row.sourcePath,'utf8');expect(f.trashCalls).toBe(0);expect(await readFile(row.sourcePath,'utf8')).toBe(before);
  const request={requestId:'native-delete',key:row.key,identity:row.identity,expectedRevision:p.expectedRevision,confirmed:true as const};expect(value(await f.m.deleteSession(request)).state).toBe('completed');expect(f.trashCalls).toBe(1);expect(value(await f.m.deleteSession(request)).state).toBe('completed');expect(f.trashCalls).toBe(1);expect(value(await f.m.getSnapshot()).sessions.some(s=>s.key===row.key)).toBe(false);
 }finally{await f.close();}
});
