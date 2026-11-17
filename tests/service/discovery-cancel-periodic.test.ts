import {test,expect} from 'vitest';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSessionManagement} from '../../src/session-management/service';
import type {Result} from '../../src/session-management/interface';
const value=<T>(r:Result<T>):T=>{if(r.status==='failed')throw Error(JSON.stringify(r.error));return r.value;};
test('cancellation drains the current job while a later periodic calibration remains enabled',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub16-periodic-')),project=join(root,'project'),sessions=join(root,'sessions');for(const p of [project,sessions])await mkdir(p);
 const m=value(await openSessionManagement(join(root,'db'),{sessionsRoot:sessions,reconciliationIntervalMs:400})),events:{at:number;state:string;queued?:number}[]=[];const stop=m.subscribe(-1,s=>events.push({at:Date.now(),state:s.discovery.state,queued:s.discovery.work?.queuedReconciliations}));
 try{const b=value(await m.prepareImport({requestId:'project',path:project}))!;await expect.poll(async()=>value(await m.getImport({batchId:b.id})).state).toBe('ready');value(await m.commitImport({batchId:b.id}));await expect.poll(async()=>value(await m.getImport({batchId:b.id})).state).toBe('completed');value(await m.reconcile());const cancelled=value(await m.cancelReconciliation());expect(cancelled.work).toMatchObject({activeReads:0,queuedReconciliations:0});const index=events.length;await expect.poll(()=>events.slice(index).some(e=>e.state==='scanning'),{timeout:2000,interval:20}).toBe(true);expect(events.slice(index).find(e=>e.state==='scanning')!.at).toBeGreaterThanOrEqual(events[index-1].at);
  if(process.env.PI_HUB_TEST_EVIDENCE){const {writeFile}=await import('node:fs/promises');await writeFile(join(process.env.PI_HUB_TEST_EVIDENCE,'periodic-cancel-timeline.json'),JSON.stringify({intervalMs:400,sourceWritesAfterCancel:0,events},null,2));}
 }finally{stop();await m.close();await rm(root,{recursive:true,force:true});}
});
