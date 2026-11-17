import {test,expect,vi} from 'vitest';
import {readFile,rename,mkdir,chmod,unlink,writeFile,appendFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {nativeRecordFixture,value} from '../fixtures/native-record';
import {executeTrash} from '../../src/desktop/trash-adapter';
import {shell} from 'electron';
vi.mock('electron',()=>({shell:{trashItem:vi.fn()}}));

for(const fault of ['project-replaced','root-replaced','parent-replaced','project-permission','file-replaced','file-revised'] as const)test(`queued native trash rechecks its pinned directories: ${fault}`,async()=>{
 let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let ownedRoot='';
 const native=vi.mocked(shell.trashItem);native.mockImplementation(async path=>{if(!path.startsWith(ownedRoot+'/'))throw Error('Owned fixture only');await unlink(path);});
 const f=await nativeRecordFixture({trash:async source=>{entered();await gate;await executeTrash({id:1,source});}});ownedRoot=realpathSync(f.root);
 try{
  const s=await f.record(),p=value(await f.m.prepareDelete({key:s.key})),before=await readFile(f.file,'utf8');
  const request={requestId:fault,key:s.key,identity:s.identity,expectedRevision:p.expectedRevision,confirmed:true as const},deleting=f.m.deleteSession(request);await waiting;
  if(fault==='project-replaced'){await rename(f.project,f.project+'-original');await mkdir(f.project);}
  else if(fault==='root-replaced'){await rename(f.root+'/sessions',f.root+'/sessions-original');await mkdir(f.root+'/sessions');await rename(f.root+'/sessions-original/encoded',f.folder);}
  else if(fault==='parent-replaced'){await rename(f.folder,f.folder+'-original');await mkdir(f.folder);await rename(f.folder+'-original/saved.jsonl',f.file);}
  else if(fault==='file-replaced'){await unlink(f.file);await writeFile(f.file,before);}
  else if(fault==='file-revised')await appendFile(f.file,'\n');
  else await chmod(f.project,0);
  release();expect(value(await deleting).state).toBe('uncertain');
  const originalPath=f.file;
  expect(await readFile(originalPath,'utf8')).toBe(fault==='file-revised'?before+'\n':before);expect(native).not.toHaveBeenCalled();
  if(fault==='project-permission')await chmod(f.project,0o700);
  await f.restart();expect(value(await f.m.getDeleteOutcome({requestId:request.requestId}))?.state).toBe('uncertain');expect(await readFile(originalPath,'utf8')).toBe(fault==='file-revised'?before+'\n':before);expect(native).not.toHaveBeenCalled();
 }finally{release();if(fault==='project-permission')await chmod(f.project,0o700);await f.close();native.mockReset();}
},15000);
