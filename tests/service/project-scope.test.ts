import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSessionManagement } from '../../src/session-management/service';
import type { Result, SessionManagement, ImportBatch, Project } from '../../src/session-management/interface';
const roots: string[] = []; const managers: SessionManagement[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.close(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
function value<T>(r: Result<T>): T { expect(r.status, JSON.stringify(r)).toBe('completed'); if (r.status === 'failed') throw Error(r.error.message); return r.value; }
async function settled(m: SessionManagement, id: string) { let b!: ImportBatch; await expect.poll(async () => { b = value(await m.getImport({ batchId: id })); return b.state; }, { timeout: 10000, interval: 5 }).not.toMatch(/^(scanning|validating)$/); return b; }
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'pi-hub-scope-')); roots.push(root); const path = join(root, 'app'); const child = join(path, 'child'); const sessionsRoot = join(root, 'sessions'); await mkdir(child, {recursive:true}); await mkdir(join(sessionsRoot, 'records'), {recursive:true});
 const open = async () => { const m = value(await openSessionManagement(join(root,'hub.sqlite'), {sessionsRoot, reconciliationIntervalMs:60000})); managers.push(m); return m; }; const m = await open();
 const record = async (id:string,cwd=path) => { const file = join(sessionsRoot,'records',id+'.jsonl'); await writeFile(file, [ {type:'session',version:3,id,cwd,timestamp:'2026-01-01T00:00:00Z'}, {type:'message',id:'m-'+id,parentId:null,message:{role:'user',content:'对话 '+id,timestamp:1767225600000}} ].map(x=>JSON.stringify(x)).join('\n')+'\n'); return file; };
 return {root,path,child,sessionsRoot,open,m,record};
}
async function add(m:SessionManagement,path:string,id:string) { const b = await settled(m,value(await m.prepareImport({requestId:id,path}))!.id); value(await m.commitImport({batchId:b.id})); expect((await settled(m,b.id)).state).toBe('completed'); return b.project; }
async function scope(m:SessionManagement,p:Project,includeDescendants:boolean,id:string) { return value(await m.changeProjectScope({requestId:id,projectId:p.id,expectedScopeRevision:value(await m.listProjects()).revision,includeDescendants})); }
async function commit(m:SessionManagement,b:ImportBatch) { await settled(m,b.id); value(await m.commitImport({batchId:b.id})); expect((await settled(m,b.id)).state).toBe('completed'); }
test('descendant expansion stages only unmanaged history, cancellation preserves exact scope and longest lexical ownership is unique', async () => {
 const f=await fixture(); await f.record('root'); await f.record('child',f.child); await f.record('prefix',f.path+'le'); const p=await add(f.m,f.path,'root');
 expect(value(await f.m.matchProject(f.child))).toBeNull(); const b=(await scope(f.m,p,true,'expand-cancel'))!; expect((await settled(f.m,b.id)).candidates.map(c=>c.headerId)).toEqual(['child']); value(await f.m.cancelImport({batchId:b.id})); expect(value(await f.m.matchProject(f.child))).toBeNull();
 await commit(f.m,(await scope(f.m,p,true,'expand'))!); expect(value(await f.m.matchProject(f.child))?.id).toBe(p.id); expect(value(await f.m.matchProject(f.path+'le'))).toBeNull();
 const child=await add(f.m,f.child,'child'); expect(value(await f.m.listSessions({classification:'all'})).map(s=>[s.headerId,s.projectId]).sort()).toEqual([['child',child.id],['root',p.id]]); expect(value(await f.m.getImport({batchId:'child'})).candidates).toEqual([]);
 const link=join(f.root,'link'); await symlink(f.path,link); const linked=await add(f.m,link,'link'); expect(value(await f.m.matchProject(link))?.id).toBe(linked.id); expect(value(await f.m.matchProject(f.path.toUpperCase()))).toBeNull();
});
async function remove(m:SessionManagement,p:Project) { return m.removeProject({requestId:'remove-'+p.id,projectId:p.id,expectedScopeRevision:value(await m.listProjects()).revision}); }
async function reconciled(m:SessionManagement) { value(await m.reconcile()); await expect.poll(async()=>value(await m.getSnapshot()).discovery.state,{timeout:10000,interval:5}).toBe('completed'); }
test('shrinking and removing hide records and previews without forgetting classifications; readd restores identity and asks only new history',async()=>{
 const f=await fixture(); const file=await f.record('child',f.child); const bytes=await readFile(file); const p=await add(f.m,f.path,'parent'); await commit(f.m,(await scope(f.m,p,true,'expand'))!); const old=value(await f.m.listSessions({classification:'archive'}))[0];
 await scope(f.m,p,false,'shrink'); await reconciled(f.m); expect(value(await f.m.listSessions({classification:'all'}))).toEqual([]); expect(value(await f.m.getSnapshot()).sessions).toEqual([]); expect(await f.m.getPreview({key:old.key,requestId:'hidden'})).toMatchObject({status:'failed',error:{code:'RECORD_CHANGED'}});
 await rename(file,file+'.hidden'); await reconciled(f.m); await rename(file+'.hidden',file); const expand=(await scope(f.m,p,true,'expand-again'))!; expect((await settled(f.m,expand.id)).candidates).toEqual([]); await commit(f.m,expand); expect(value(await f.m.listSessions({classification:'archive'}))[0].key).toBe(old.key);
 value(await remove(f.m,p)); await reconciled(f.m); await f.record('new',f.child); expect(value(await f.m.listProjects()).projects).toEqual([]); await f.m.close(); const m=await f.open(); const b=value(await m.prepareImport({requestId:'return',path:f.path}))!; expect(b.project.id).toBe(p.id); expect((await settled(m,b.id)).candidates.map(c=>c.headerId)).toEqual(['new']); await commit(m,b); expect(value(await m.listSessions({classification:'archive'})).map(s=>s.headerId).sort()).toEqual(['child','new']); expect(await readFile(file)).toEqual(bytes);
});
test('parent takes over removed child uniquely and classifications survive unavailable directory and restart',async()=>{
 const f=await fixture(); await f.record('child',f.child); const child=await add(f.m,f.child,'child'); const parent=await add(f.m,f.path,'parent'); await commit(f.m,(await scope(f.m,parent,true,'expand'))!); const old=value(await f.m.listSessions({classification:'archive'}))[0]; value(await remove(f.m,child)); expect(value(await f.m.listSessions({classification:'archive'}))).toMatchObject([{key:old.key,projectId:parent.id}]);
 await rename(f.path,f.path+'-moved'); await reconciled(f.m); expect(value(await f.m.getSnapshot()).projects[0].availability.state).toBe('unavailable'); expect(await remove(f.m,parent)).toMatchObject({status:'failed',error:{code:'DIRECTORY_UNAVAILABLE'}}); expect(await f.m.changeProjectScope({requestId:'blocked',projectId:parent.id,expectedScopeRevision:value(await f.m.listProjects()).revision,includeDescendants:false})).toMatchObject({status:'failed',error:{code:'DIRECTORY_UNAVAILABLE'}}); expect(value(await f.m.listSessions({classification:'archive'}))).toHaveLength(1);
 await f.m.close(); await rename(f.path+'-moved',f.path); const m=await f.open(); await reconciled(m); expect(value(await m.getSnapshot()).projects[0].availability.state).toBe('available'); expect(value(await m.matchProject(f.child))?.id).toBe(parent.id); const b=value(await m.prepareImport({requestId:'return-child',path:f.child}))!; expect((await settled(m,b.id)).candidates).toEqual([]); await commit(m,b); expect(value(await m.listSessions({classification:'archive'}))).toMatchObject([{key:old.key,projectId:child.id}]);
});
test('scope changes conflict with pending import and an in-flight old scan cannot republish removed records or erase hidden classifications',async()=>{
 const f=await fixture(); const file=await f.record('child',f.child); const p=await add(f.m,f.path,'parent'); const b=(await scope(f.m,p,true,'expand-conflict'))!; await settled(f.m,b.id); value(await remove(f.m,p)); value(await f.m.commitImport({batchId:b.id})); expect((await settled(f.m,b.id)).error?.code).toBe('SCOPE_CHANGED'); value(await f.m.cancelImport({batchId:b.id})); await add(f.m,f.path,'return'); await commit(f.m,(await scope(f.m,p,true,'expand'))!); const old=value(await f.m.listSessions({classification:'archive'}))[0];
 await appendFile(file, JSON.stringify({type:'custom',padding:'x'.repeat(8*1024*1024)})+'\n'); value(await f.m.reconcile()); await expect.poll(async()=>value(await f.m.getSnapshot()).discovery.inspected,{interval:1}).toBeGreaterThan(0); value(await remove(f.m,p)); await reconciled(f.m); expect(value(await f.m.getSnapshot()).sessions).toEqual([]); expect(value(await f.m.listSessions({classification:'all'}))).toEqual([]); const back=value(await f.m.prepareImport({requestId:'return-race',path:f.path}))!; expect((await settled(f.m,back.id)).candidates).toEqual([]); await commit(f.m,back); expect(value(await f.m.listSessions({classification:'archive'}))[0].key).toBe(old.key);
});
test('readding a replaced source never exposes two index rows for the same file',async()=>{
 const f=await fixture(); const file=await f.record('old'); const p=await add(f.m,f.path,'first'); value(await remove(f.m,p)); await writeFile(file,(await readFile(file,'utf8')).replace('"id":"old"','"id":"replacement"')); const b=value(await f.m.prepareImport({requestId:'replaced-return',path:f.path}))!; expect((await settled(f.m,b.id)).candidates.map(c=>c.headerId)).toEqual(['replacement']); const snapshots:string[][]=[]; const unsubscribe=f.m.subscribe(-1,s=>snapshots.push(s.sessions.map(r=>r.sourcePath))); await commit(f.m,b); unsubscribe(); expect(snapshots.every(paths=>new Set(paths).size===paths.length)).toBe(true); expect(value(await f.m.listSessions({classification:'all'})).map(s=>s.headerId)).toEqual(['replacement']);
});
test('scope mutation during validation conflicts atomically and cancellation while expanding preserves the old project',async()=>{
 const f=await fixture(); const p=await add(f.m,f.path,'root'); const file=await f.record('candidate',f.child); await appendFile(file,JSON.stringify({type:'custom',padding:'x'.repeat(8*1024*1024)})+'\n');
 const b=(await scope(f.m,p,true,'validating'))!; await settled(f.m,b.id); value(await f.m.commitImport({batchId:b.id})); value(await remove(f.m,p)); expect((await settled(f.m,b.id)).error?.code).toBe('SCOPE_CHANGED'); expect(value(await f.m.listProjects()).projects).toEqual([]); expect(value(await f.m.listSessions({classification:'all'}))).toEqual([]); value(await f.m.cancelImport({batchId:b.id})); await add(f.m,f.path,'back'); 
 const cancelled=(await scope(f.m,p,true,'cancel-validating'))!; await settled(f.m,cancelled.id); value(await f.m.commitImport({batchId:cancelled.id})); expect(value(await f.m.cancelImport({batchId:cancelled.id})).state).toBe('cancelled'); expect(value(await f.m.listProjects()).projects[0].includeDescendants).toBe(false); expect(value(await f.m.listSessions({classification:'all'}))).toEqual([]);
}, 20000);
test('v4 migration backs up classifications and v5 persists enabled scope without source writes',async()=>{
 const f=await fixture(); const file=await f.record('archive'); const p=await add(f.m,f.path,'root'); const {createHash}=await import('node:crypto'); const hash=async()=>createHash('sha256').update(await readFile(file)).digest('hex'); const before=await hash(); await f.m.close();
 const Database=(await import('better-sqlite3')).default; const fixtureDb=new Database(join(f.root,'hub.sqlite')); fixtureDb.exec('DROP TABLE IF EXISTS sdk_hosts; DROP TABLE IF EXISTS native_clone_requests; DROP TABLE delete_requests; DROP TABLE rename_requests; DROP TABLE IF EXISTS directory_recoveries; DROP TABLE terminal_requests; DROP TABLE terminal_settings; DROP TABLE IF EXISTS recovery_requests; DROP TABLE IF EXISTS clone_requests; DROP TABLE IF EXISTS runtime_leases; DROP TABLE IF EXISTS launch_reservations; DROP TABLE classification_requests; DROP TABLE classification_state; DROP TABLE storage_locations; UPDATE sessions SET data=json_remove(data,\'$.sources\'); ALTER TABLE projects DROP COLUMN include_descendants; ALTER TABLE projects DROP COLUMN enabled; PRAGMA user_version=4;'); fixtureDb.close();
 const m=await f.open(); expect(value(await m.listProjects()).projects[0]).toMatchObject({id:p.id,includeDescendants:false,enabled:true}); expect(value(await m.listSessions({classification:'archive'}))).toHaveLength(1); const {readdir}=await import('node:fs/promises'); const backup=(await readdir(f.root)).find(n=>n.startsWith('hub.sqlite.backup-v4-'))!; expect(backup).toBeTruthy(); const restored=value(await openSessionManagement(join(f.root,backup),{sessionsRoot:f.sessionsRoot})); managers.push(restored); expect(value(await restored.listSessions({classification:'archive'}))).toHaveLength(1);
 await commit(m,(await scope(m,p,true,'expand'))!); value(await remove(m,p)); await m.close(); const restarted=await f.open(); expect(value(await restarted.listProjects()).projects).toEqual([]); const b=value(await restarted.prepareImport({requestId:'return',path:f.path}))!; expect(b.project).toMatchObject({id:p.id,includeDescendants:true}); await commit(restarted,b); expect(value(await restarted.listSessions({classification:'archive'}))).toHaveLength(1); expect(await hash()).toBe(before);
});
test('adding a nested project does not import history already covered by its active parent',async()=>{
 const f=await fixture(); const p=await add(f.m,f.path,'parent'); await commit(f.m,(await scope(f.m,p,true,'expand'))!); value(await f.m.cancelReconciliation()); await f.record('new-child',f.child); const b=value(await f.m.prepareImport({requestId:'nested',path:f.child}))!; expect((await settled(f.m,b.id)).candidates).toEqual([]); await commit(f.m,b); await reconciled(f.m); expect(value(await f.m.listSessions({classification:'main'}))).toMatchObject([{headerId:'new-child',projectId:b.project.id}]);
});

test('validated replacement of a hidden descendant stays unique in every snapshot across expansion and restart', async () => {
 const f = await fixture(); const file = await f.record('hidden', f.child);
 const p = await add(f.m, f.path, 'parent'); await commit(f.m, (await scope(f.m, p, true, 'first-expansion'))!);
 await scope(f.m, p, false, 'shrink'); await reconciled(f.m);
 const replacement = (await readFile(file, 'utf8')).replace('"id":"hidden"', '"id":"replacement"').replace(JSON.stringify(f.child), JSON.stringify(f.path));
 const snapshots: string[][] = []; const observe = (m: SessionManagement) => m.subscribe(-1, snapshot => snapshots.push(snapshot.sessions.map(s => s.sourcePath)));
 const stop = observe(f.m); await writeFile(file, replacement); await reconciled(f.m);
 expect(value(await f.m.listSessions({ classification: 'all' })).map(s => s.headerId)).toEqual(['replacement']);
 const expand = (await scope(f.m, p, true, 'expand-after-replacement'))!; expect((await settled(f.m, expand.id)).candidates).toEqual([]); await commit(f.m, expand);
 await reconciled(f.m); stop(); await f.m.close(); const restarted = await f.open(); const stopRestart = observe(restarted); await reconciled(restarted); stopRestart();
 expect(snapshots.every(paths => new Set(paths).size === paths.length)).toBe(true);
 expect(value(await restarted.listSessions({ classification: 'all' })).map(s => s.headerId)).toEqual(['replacement']);
 expect(value(await restarted.listSessions({ classification: 'archive' }))).toEqual([]);
 expect(await readFile(file, 'utf8')).toBe(replacement);
});

test.each(['missing', 'malformed', 'rollback', 'cancelled'])('hidden classification survives %s replacement evidence and restart', async failure => {
 const f = await fixture(); const file = await f.record('hidden', f.child); const original = await readFile(file, 'utf8');
 const p = await add(f.m, f.path, 'parent'); await commit(f.m, (await scope(f.m, p, true, 'expand'))!);
 const archived = value(await f.m.listSessions({ classification: 'archive' }))[0];
 await scope(f.m, p, false, 'shrink'); await reconciled(f.m); value(await f.m.cancelReconciliation());
 const replacement = original.replace('"id":"hidden"', '"id":"replacement"').replace(JSON.stringify(f.child), JSON.stringify(f.path));
 if (failure === 'missing') await rename(file, file + '.hidden');
 else await writeFile(file, replacement + (failure === 'malformed' ? 'BAD LINE\n' : ''));
 if (failure === 'rollback') {
  const Database = (await import('better-sqlite3')).default; const fault = new Database(join(f.root, 'hub.sqlite'));
  fault.exec("CREATE TRIGGER reject_replacement BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'test transaction failure'); END");
  value(await f.m.reconcile()); await expect.poll(async () => value(await f.m.getSnapshot()).discovery.state).toBe('error');
  fault.exec('DROP TRIGGER reject_replacement'); fault.close();
 } else if (failure === 'cancelled') {
  await appendFile(file, JSON.stringify({ type: 'custom', padding: 'x'.repeat(8 * 1024 * 1024) }) + '\n');
  value(await f.m.reconcile()); await expect.poll(async () => value(await f.m.getSnapshot()).discovery.inspected, { interval: 1 }).toBeGreaterThan(0);
  value(await f.m.cancelReconciliation());
 } else await reconciled(f.m);
 await f.m.close();
 if (failure === 'missing') await rename(file + '.hidden', file); else await writeFile(file, original);
 const restarted = await f.open(); const expand = (await scope(restarted, p, true, 'restore'))!;
 expect((await settled(restarted, expand.id)).candidates).toEqual([]); await commit(restarted, expand);
 expect(value(await restarted.listSessions({ classification: 'archive' }))).toMatchObject([{ key: archived.key, archiveWatermark: archived.archiveWatermark }]);
 expect(await readFile(file, 'utf8')).toBe(original);
}, 15000);

test.each(['ready', 'validating'])('opposite scope request explicitly conflicts with a %s expansion before the unchanged shortcut', async phase => {
 const f = await fixture(); const p = await add(f.m, f.path, 'parent'); const file = await f.record('candidate', f.child);
 await appendFile(file, JSON.stringify({ type: 'custom', padding: 'x'.repeat(8 * 1024 * 1024) }) + '\n');
 const b = (await scope(f.m, p, true, 'expand'))!; await settled(f.m, b.id);
 if (phase === 'validating') expect(value(await f.m.commitImport({ batchId: b.id })).state).toBe('validating');
 const opposite = await f.m.changeProjectScope({ requestId: 'opposite', projectId: p.id, expectedScopeRevision: value(await f.m.listProjects()).revision, includeDescendants: false });
 expect(opposite).toMatchObject({ status: 'failed', error: { code: 'SCOPE_CHANGED' } });
 if (opposite.status === 'failed') expect(opposite.error.message).toContain('取消');
 value(await f.m.cancelImport({ batchId: b.id }));
 expect(value(await f.m.listProjects()).projects[0].includeDescendants).toBe(false);
 expect(await f.m.commitImport({ batchId: b.id })).toMatchObject({ status: 'failed' });
 expect(value(await f.m.listSessions({ classification: 'all' }))).toEqual([]);
}, 15000);

test.each(['source', 'scope'])('opposite-request conflict does not bypass %s revalidation of the pending expansion', async change => {
 const f = await fixture(); const p = await add(f.m, f.path, 'parent'); const file = await f.record('candidate', f.child);
 await appendFile(file, JSON.stringify({ type: 'custom', padding: 'x'.repeat(8 * 1024 * 1024) }) + '\n');
 const b = (await scope(f.m, p, true, 'expand'))!; await settled(f.m, b.id);
 if (change === 'scope') value(await f.m.commitImport({ batchId: b.id }));
 expect(await f.m.changeProjectScope({ requestId: 'opposite', projectId: p.id, expectedScopeRevision: value(await f.m.listProjects()).revision, includeDescendants: false })).toMatchObject({ status: 'failed', error: { code: 'SCOPE_CHANGED' } });
 if (change === 'source') {
  await writeFile(file, (await readFile(file, 'utf8')).replace('"id":"candidate"', '"id":"replaced"'));
  value(await f.m.commitImport({ batchId: b.id }));
 } else value(await remove(f.m, p));
 expect((await settled(f.m, b.id)).error?.code).toBe(change === 'source' ? 'RECORD_CHANGED' : 'SCOPE_CHANGED');
 expect(value(await f.m.listSessions({ classification: 'all' }))).toEqual([]);
 expect(value(await f.m.listProjects()).projects.every(project => !project.includeDescendants)).toBe(true);
}, 15000);
