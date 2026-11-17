import {test,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,appendFile,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir,cpus,totalmem,release,platform} from 'node:os';
import {join,resolve} from 'node:path';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {Session} from 'node:inspector/promises';
import {createHash} from 'node:crypto';
import {openSessionManagement} from '../../src/session-management/service';
import type {Result,SessionManagement,DiscoveryState} from '../../src/session-management/interface';
import {generateScaleData} from '../fixtures/scale-data';
const value=<T>(r:Result<T>):T=>{if(r.status==='failed')throw Error(JSON.stringify(r.error));return r.value;};
const wait=async(check:()=>Promise<boolean>,timeout=180000)=>{const start=performance.now();while(!await check()){if(performance.now()-start>timeout)throw Error('condition timed out');await new Promise(r=>setTimeout(r,20));}};
function scanSettled(manager:SessionManagement,count?:number,observe?:(progress:DiscoveryState)=>void){
 let stop=()=>{};let timer:NodeJS.Timeout;
 const promise=new Promise<void>((resolve,reject)=>{timer=setTimeout(()=>reject(Error('scan timed out')),180000);stop=manager.subscribe(-1,s=>{observe?.(s.discovery);if(s.discovery.state!=='scanning'&&(count===undefined||s.sessions.length===count))resolve();});});
 return promise.finally(()=>{clearTimeout(timer);stop();});
}
// Exploratory timings are recorded, never asserted against hardware-specific CI thresholds.
test.skipIf(!process.env.PI_HUB_SCALE)('public management scale baseline and source invariants',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub16-scale-')),evidence=resolve(process.env.PI_HUB_TEST_EVIDENCE!);await mkdir(evidence,{recursive:true});const sessions=join(root,'sessions');await mkdir(sessions);
 let manager:SessionManagement|undefined;let timer:NodeJS.Timeout|undefined;let profiler:Session|undefined;const results:any={root,device:{cpu:cpus()[0]?.model,cores:cpus().length,ram:totalmem(),os:platform()+' '+release(),node:process.version},samples:[],work:[]};
 const observeWork=(progress:DiscoveryState)=>results.work.push({state:progress.state,inspected:progress.inspected,...progress.work});
 const loop=monitorEventLoopDelay({resolution:20});loop.enable();const start=performance.now();
 try{
  manager=value(await openSessionManagement(join(root,'hub.sqlite'),{sessionsRoot:sessions,reconciliationIntervalMs:600000}));let m=manager;
  for(let i=0;i<50;i++){const path=join(root,'projects',`项目-${String(i).padStart(2,'0')}`);await mkdir(path,{recursive:true});const b=value(await m.prepareImport({requestId:`seed-project-${i}`,path}))!;await wait(async()=>value(await m.getImport({batchId:b.id})).state==='ready');value(await m.commitImport({batchId:b.id}));await wait(async()=>value(await m.getImport({batchId:b.id})).state==='completed');}
  value(await m.cancelReconciliation());await m.close();manager=undefined;const data=await generateScaleData(root,Number(process.env.PI_HUB_SCALE));results.data=data;await writeFile(join(evidence,'fixture.json'),JSON.stringify(results,null,2));
  manager=value(await openSessionManagement(join(root,'hub.sqlite'),{sessionsRoot:sessions,reconciliationIntervalMs:600000}));m=manager;
  let peakRss=process.memoryUsage().rss;timer=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);results.peakRss=peakRss;},50);
  profiler=new Session();profiler.connect();await profiler.post('Profiler.enable');await profiler.post('Profiler.start');
  const scan=performance.now();value(await m.reconcile());await scanSettled(m,data.count,observeWork);results.initialScanMs=performance.now()-scan;console.log('initialScanMs',results.initialScanMs);await writeFile(join(evidence,'in-progress.json'),JSON.stringify(results,null,2));
  expect(value(await m.listSessions({classification:'all'}))).toHaveLength(data.count);expect(value(await m.getSnapshot()).discovery.issues).toHaveLength(1);
  const target=value(await m.listSessions({classification:'main',limit:1}))[0];expect(value(await m.getPreview({key:target.key,requestId:'preview'})).messages.map(m=>m.role)).toContain('assistant');
  for(let i=0;i<3;i++){const mark=performance.now();value(await m.reconcile());await scanSettled(m);results.samples.push(performance.now()-mark);console.log('warmScanMs',results.samples.at(-1));await writeFile(join(evidence,'in-progress.json'),JSON.stringify(results,null,2));}
  const unchanged=createHash('sha256');for(const file of (await readdir(data.folder)).sort())unchanged.update(await readFile(join(data.folder,file)));expect(unchanged.digest('hex')).toBe(data.sourceDigest);results.sourceUnchanged=true;
  const archived=value(await m.setSessionClassification({requestId:'archive',key:target.key,classification:'archive',expectedRevision:target.classificationRevision??0}));expect(archived.classification).toBe('archive');
  await appendFile(target.sourcePath,JSON.stringify({type:'session_info',id:'renamed',parentId:'m-1',name:'仅名称不恢复'})+'\n');value(await m.reconcile());await scanSettled(m);expect(value(await m.listSessions({classification:'archive'}))[0].title).toBe('仅名称不恢复');
  await appendFile(target.sourcePath,JSON.stringify({type:'message',id:'new-assistant',parentId:'renamed',timestamp:'2026-01-02T00:00:00.000Z',message:{role:'assistant',content:'归档之后实际新增的可见回复',timestamp:1767312000000}})+'\n');value(await m.reconcile());await scanSettled(m);expect(value(await m.listSessions({classification:'archive'}))).toEqual([]);
  value(await m.reconcile());expect(value(await m.cancelReconciliation()).state).toBe('cancelled');expect(value(await m.listSessions({classification:'main'}))).toHaveLength(data.count);
  await m.close();manager=undefined;const cacheStart=performance.now();manager=value(await openSessionManagement(join(root,'hub.sqlite'),{sessionsRoot:sessions,reconciliationIntervalMs:600000}));const cached=value(await manager.getSnapshot());results.cacheReadyMs=performance.now()-cacheStart;expect(cached.discovery.state).toBe('idle');expect(cached.sessions).toHaveLength(data.count);expect(cached.sessions.find(s=>s.key===target.key)?.classification).toBe('main');
  results.peakRss=peakRss;clearInterval(timer);results.loop={p95Ms:loop.percentile(95)/1e6,maxMs:loop.max/1e6};results.durationMs=performance.now()-start;results.status='passed';
 }catch(error){results.status='failed';results.error=String(error);throw error;}finally{clearInterval(timer);results.loop={p95Ms:loop.percentile(95)/1e6,maxMs:loop.max/1e6};results.durationMs=performance.now()-start;loop.disable();if(profiler){const {profile}=await profiler.post('Profiler.stop');profiler.disconnect();const hits=new Map<number,number>();for(const id of profile.samples??[])hits.set(id,(hits.get(id)??0)+1);results.profile=profile.nodes.map(n=>({function:n.callFrame.functionName,url:n.callFrame.url,line:n.callFrame.lineNumber+1,hits:hits.get(n.id)??0})).sort((a,b)=>b.hits-a.hits).slice(0,30);}await manager?.close();await writeFile(join(evidence,'service-scale.json'),JSON.stringify(results,null,2));if(process.env.PI_HUB_SCALE_KEEP!=='1')await rm(root,{recursive:true,force:true});}
},600000);
