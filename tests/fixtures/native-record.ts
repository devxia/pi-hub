import {expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSessionManagement} from '../../src/session-management/service';
import type {DeleteAdapter} from '../../src/session-management/session-deletes';
import type {Result} from '../../src/session-management/interface';
export const value=<T>(r:Result<T>):T=>{if(r.status==='failed')throw Error(r.error.message);return r.value;};
/** Native file/SQLite fixture; it has no runtime registration or occupancy assumptions. */
export async function nativeRecordFixture(deletion?:DeleteAdapter){
 const root=await realpath(await mkdtemp(join(tmpdir(),'pi-native-record-'))),project=join(root,'project'),folder=join(root,'sessions','encoded'),file=join(folder,'saved.jsonl'),dbPath=join(root,'hub.sqlite');await mkdir(project);await mkdir(folder,{recursive:true});await writeFile(file,[{type:'session',version:3,id:'native-source',cwd:project},{type:'message',id:'u',parentId:null,message:{role:'user',content:'Owned native record',timestamp:1}}].map(e=>JSON.stringify(e)).join('\n')+'\n');
 const options={sessionsRoot:join(root,'sessions'),deletion};let manager=value(await openSessionManagement(dbPath,options));
 const batch=value(await manager.prepareImport({requestId:'import',path:project}))!;await expect.poll(async()=>value(await manager.getImport({batchId:batch.id})).state).toBe('ready');const ready=value(await manager.getImport({batchId:batch.id}));value(await manager.selectImport({batchId:batch.id,selectedKeys:ready.candidates.map(c=>c.key)}));value(await manager.commitImport({batchId:batch.id}));await expect.poll(async()=>value(await manager.getImport({batchId:batch.id})).state).toBe('completed');await expect.poll(async()=>value(await manager.getSnapshot()).sessions[0]?.availability.state).toBe('available');
 return {root,project,folder,file,dbPath,get m(){return manager;},async record(){return value(await manager.getSnapshot()).sessions[0];},async restart(){await manager.close();manager=value(await openSessionManagement(dbPath,options));},async close(){await manager.close();await rm(root,{recursive:true,force:true});}};
}
