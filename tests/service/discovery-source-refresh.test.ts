import {test,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSessionManagement} from '../../src/session-management/service';
import type {Result} from '../../src/session-management/interface';
const value=<T>(r:Result<T>):T=>{if(r.status==='failed')throw Error(JSON.stringify(r.error));return r.value;};
test('a healthy watched source refreshes while complete-root proof waits; absence does not erase another archive',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub16-refresh-')),project=join(root,'project'),sessions=join(root,'sessions'),folder=join(sessions,'encoded');for(const p of [project,folder])await mkdir(p,{recursive:true});
 for(const id of ['healthy','absent'])await writeFile(join(folder,id+'.jsonl'),[{type:'session',version:3,id,cwd:project},{type:'message',id:'u',parentId:null,message:{role:'user',content:id,timestamp:1767225600000}}].map(x=>JSON.stringify(x)).join('\n')+'\n');
 const m=value(await openSessionManagement(join(root,'hub.sqlite'),{sessionsRoot:sessions,reconciliationIntervalMs:600000}));const fs=createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises'),original=fs.opendir;let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 try{const b=value(await m.prepareImport({requestId:'import',path:project}))!;await expect.poll(async()=>value(await m.getImport({batchId:b.id})).state).toBe('ready');value(await m.commitImport({batchId:b.id}));await expect.poll(async()=>value(await m.getImport({batchId:b.id})).state).toBe('completed');value(await m.reconcile());await expect.poll(async()=>value(await m.getSnapshot()).discovery.state).toBe('completed');
  fs.opendir=(async(...args:Parameters<typeof fs.opendir>)=>{if(String(args[0])===sessions)await gate;return (original as (...args:any[])=>unknown)(...args);}) as typeof fs.opendir;syncBuiltinESMExports();
  await rm(join(folder,'absent.jsonl'));await appendFile(join(folder,'healthy.jsonl'),JSON.stringify({type:'session_info',id:'name',parentId:'u',name:'updated locally'})+'\n');
  await expect.poll(async()=>value(await m.listSessions({classification:'archive'})).find(s=>s.headerId==='healthy')?.title,{timeout:5000}).toBe('updated locally');
  const rows=value(await m.listSessions({classification:'archive'}));expect(rows.map(s=>s.headerId).sort()).toEqual(['absent','healthy']);expect(rows.find(s=>s.headerId==='healthy')?.lastMessageAt).toBe('2026-01-01T00:00:00.000Z');
  release();value(await m.reconcile());await expect.poll(async()=>value(await m.listSessions({classification:'archive'})).map(s=>s.headerId),{timeout:10000}).toEqual(['healthy']);
 }finally{release();fs.opendir=original;syncBuiltinESMExports();await m.close();await rm(root,{recursive:true,force:true});}
},15000);

test('a failed final source-root check revokes cached source availability in the same publication',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub16-root-trust-')),project=join(root,'project'),sessions=join(root,'sessions'),folder=join(sessions,'encoded');for(const p of [project,folder])await mkdir(p,{recursive:true});
 const file=join(folder,'source.jsonl');await writeFile(file,[{type:'session',version:3,id:'source',cwd:project},{type:'message',id:'u',parentId:null,message:{role:'user',content:'Owned source',timestamp:1767225600000}}].map(x=>JSON.stringify(x)).join('\n')+'\n');
 const m=value(await openSessionManagement(join(root,'hub.sqlite'),{sessionsRoot:sessions,reconciliationIntervalMs:600000})),fs=createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises'),original=fs.stat;
 let stop=()=>{},rootChecks=0,inconsistent=false;
 try{const b=value(await m.prepareImport({requestId:'import',path:project}))!;await expect.poll(async()=>value(await m.getImport({batchId:b.id})).state).toBe('ready');value(await m.commitImport({batchId:b.id}));await expect.poll(async()=>value(await m.getSnapshot()).sessions[0]?.availability.state).toBe('available');
  fs.stat=(async(...args:Parameters<typeof fs.stat>)=>{if(String(args[0])===sessions&&++rootChecks===3)await fs.rename(sessions,sessions+'-held');return (original as (...args:any[])=>unknown)(...args);}) as typeof fs.stat;syncBuiltinESMExports();
  stop=m.subscribe(-1,s=>{if(s.locations?.find(l=>l.id==='standard')?.availability.state==='unavailable'&&s.sessions.some(row=>row.availability.state==='available'))inconsistent=true;});
  await appendFile(file,JSON.stringify({type:'session_info',id:'name',parentId:'u',name:'Must wait for root proof'})+'\n');
  await expect.poll(async()=>value(await m.getSnapshot()).locations?.find(l=>l.id==='standard')?.availability.state,{timeout:5000}).toBe('unavailable');expect(inconsistent).toBe(false);expect(value(await m.getSnapshot()).sessions[0]?.classification).toBe('archive');
 }finally{stop();fs.stat=original;syncBuiltinESMExports();await m.close();await rm(root,{recursive:true,force:true});}
},10000);
