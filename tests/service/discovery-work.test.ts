import {test,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,appendFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {openSessionManagement} from '../../src/session-management/service';
import type {Result,WorkspaceSnapshot} from '../../src/session-management/interface';
const value=<T>(r:Result<T>):T=>{if(r.status==='failed')throw Error(JSON.stringify(r.error));return r.value;};
test('scan work is observable and bounded; cancellation drains readers without losing archive choice',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub16-work-')),project=join(root,'project'),sessions=join(root,'sessions'),folder=join(sessions,'encoded');for(const p of [project,folder])await mkdir(p,{recursive:true});
 const file=join(folder,'source.jsonl');await writeFile(file,[{type:'session',version:3,id:'work',cwd:project},{type:'message',id:'u',message:{role:'user',content:'保留归档',timestamp:1767225600000}}].map(x=>JSON.stringify(x)).join('\n')+'\n');
 const fs=createRequire(import.meta.url)('node:fs') as typeof import('node:fs'),originalWatch=fs.watch,listeners:((event:string,path:string)=>void)[]=[];
 fs.watch=((...args:any[])=>{listeners.push(args[2]);return (originalWatch as (...args:any[])=>unknown)(...args);}) as typeof fs.watch;syncBuiltinESMExports();
 const m=value(await openSessionManagement(join(root,'hub.sqlite'),{sessionsRoot:sessions,reconciliationIntervalMs:600000}));
 try{
  const b=value(await m.prepareImport({requestId:'import',path:project}))!;await expect.poll(async()=>value(await m.getImport({batchId:b.id})).state).toBe('ready');value(await m.commitImport({batchId:b.id}));await expect.poll(async()=>value(await m.getImport({batchId:b.id})).state).toBe('completed');value(await m.cancelReconciliation());
  await appendFile(file,JSON.stringify({type:'custom',id:'large',parentId:'u',padding:'x'.repeat(8*1024*1024)})+'\n');const before=await readFile(file);
  const observed:WorkspaceSnapshot[]=[];let lateEvent=false;let active!:()=>void;const reading=new Promise<void>(resolve=>active=resolve);const stop=m.subscribe(-1,s=>{observed.push(s);if(s.discovery.state==='cancelled'&&!lateEvent){lateEvent=true;for(const listener of listeners)listener('change','encoded/source.jsonl');}if((s.discovery.work?.activeReads??0)>0)active();});
  try{value(await m.reconcile());await reading;value(await m.reconcile());expect(value(await m.reconcile()).work?.queuedReconciliations).toBe(1);value(await m.cancelReconciliation());const snapshot=value(await m.getSnapshot());
   expect(snapshot.discovery.work).toMatchObject({activeReads:0,queuedReconciliations:0});
   expect(observed.some(s=>s.discovery.state==='scanning')).toBe(true);
   for(const s of observed){const work=s.discovery.work;expect(work).toBeDefined();expect(work!.concurrencyLimit).toBeGreaterThan(0);expect(work!.activeReads).toBeGreaterThanOrEqual(0);expect(work!.activeReads).toBeLessThanOrEqual(work!.concurrencyLimit);expect(work!.queuedReconciliations).toBeLessThanOrEqual(1);}
   expect(value(await m.listSessions({classification:'archive'})).map(s=>s.headerId)).toEqual(['work']);expect(await readFile(file)).toEqual(before);
  }finally{stop();}
 }finally{fs.watch=originalWatch;syncBuiltinESMExports();await m.close();await rm(root,{recursive:true,force:true});}
});
