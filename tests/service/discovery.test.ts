import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, rename, chmod, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSessionManagement } from '../../src/session-management/service';
import type { Result, SessionManagement, ImportBatch } from '../../src/session-management/interface';
const roots: string[] = []; const managers: SessionManagement[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.close(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
function value<T>(r: Result<T>): T { if (r.status === 'failed') throw Error(JSON.stringify(r.error)); return r.value; }
async function settled(m: SessionManagement, id: string) { let b!: ImportBatch; await expect.poll(async () => { b = value(await m.getImport({ batchId: id })); return b.state; }, { timeout: 10000 }).not.toMatch(/scanning|validating/); return b; }
async function fixture(interval = 60000) {
 const root = await mkdtemp(join(tmpdir(), 'pi-hub-discovery-')); roots.push(root);
 const project = join(root, '项目'); const sessionsRoot = join(root, 'sessions'); const folder = join(sessionsRoot, '--fixture--');
 await mkdir(project); await mkdir(folder, { recursive: true });
 const open = async () => { const m = value(await openSessionManagement(join(root, 'hub.sqlite'), { sessionsRoot, reconciliationIntervalMs: interval })); managers.push(m); return m; };
 const record = async (id: string, message = true) => { const path = join(folder, `${id}.jsonl`); await writeFile(path, JSON.stringify({ type: 'session', version: 3, id, cwd: project }) + '\n' + (message ? JSON.stringify({ type: 'message', id: `${id}-1`, message: { role: 'user', content: `对话 ${id}`, timestamp: 1767225600000 } }) + '\n' : '')); return path; };
 const manager = await open();
 const imported = async () => { const b = await settled(manager, value(await manager.prepareImport({ requestId: 'import', path: project }))!.id); value(await manager.commitImport({ batchId: b.id })); expect((await settled(manager, b.id)).state).toBe('completed'); };
 return { root, project, sessionsRoot, folder, open, record, manager, imported };
}
const main = async (m: SessionManagement) => value(await m.listSessions({ classification: 'main' }));
test('watcher discovers saved messages only after managed import; startup fills offline additions without changing archives', async () => {
 const f = await fixture(); const old = await f.record('old'); const bytes = await readFile(old); await f.imported();
 await f.record('empty', false); await f.record('live');
 await expect.poll(async () => (await main(f.manager)).map(s => s.headerId)).toEqual(['live']);
 await f.manager.close(); await f.record('offline'); const restarted = await f.open();
 await expect.poll(async () => (await main(restarted)).map(s => s.headerId).sort()).toEqual(['live', 'offline']);
 expect(value(await restarted.listSessions({ classification: 'archive' })).map(s => s.headerId)).toEqual(['old']);
 expect(await readFile(old)).toEqual(bytes);
});
async function reconcile(m: SessionManagement) { value(await m.reconcile()); await expect.poll(async () => value(await m.getSnapshot()).discovery.state, { timeout: 10000 }).not.toBe('scanning'); }
test('partial tails defer, complete bad lines isolate, metadata never changes message time or archive watermark, and rewrites preserve classification', async () => {
 const f = await fixture(); const file = await f.record('old'); await f.imported(); await reconcile(f.manager);
 const original = await readFile(file, 'utf8');
 const archived = () => f.manager.listSessions({ classification: 'archive' }).then(value);
 const watermark = (await archived())[0].archiveWatermark;
 await appendFile(file, '{"type":"message"'); await reconcile(f.manager);
 expect(value(await f.manager.getSnapshot()).discovery.issues).toEqual([]);
 await appendFile(file, ' BROKEN\n'); await f.record('good'); await reconcile(f.manager);
 expect(value(await f.manager.getSnapshot()).sessions.find(s => s.headerId === 'old')?.availability.state).toBe('unavailable');
 expect((await main(f.manager)).map(s => s.headerId)).toEqual(['good']);
 await writeFile(file, original + JSON.stringify({ type: 'session_info', name: '新名称' }) + '\n'); await utimes(file, new Date(), new Date()); await reconcile(f.manager);
 expect((await archived())[0]).toMatchObject({ title: '新名称', lastMessageAt: '2026-01-01T00:00:00.000Z', archiveWatermark: watermark });
 await writeFile(file, original.split('\n')[0] + '\n'); await reconcile(f.manager);
 expect(await archived()).toEqual([]);
 await writeFile(file, original); await reconcile(f.manager);
 expect((await archived())[0].archiveWatermark).toEqual(watermark);
 expect(await readFile(file, 'utf8')).toBe(original);
});
test('absent root, permission failure, cancellation and unavailable project retain cache; only confirmed deletion clears archive choice', async () => {
 const f = await fixture(); const file = await f.record('old'); await f.imported(); await reconcile(f.manager);
 const kept = join(f.root, 'kept'); await rename(f.sessionsRoot, kept); await reconcile(f.manager);
 expect(value(await f.manager.getSnapshot()).sessions[0]).toMatchObject({ classification: 'archive', availability: { state: 'unavailable' }, runtimeState: 'unknown' });
 await f.manager.close(); const restarted = await f.open();
 expect(value(await restarted.getSnapshot()).sessions[0].classification).toBe('archive');
 await rename(kept, f.sessionsRoot); await chmod(f.folder, 0); await reconcile(restarted);
 expect(value(await restarted.getSnapshot()).discovery.state).toBe('error'); expect(value(await restarted.listSessions({ classification: 'archive' }))).toHaveLength(1);
 await chmod(f.folder, 0o700); await rename(f.project, `${f.project}-away`); await reconcile(restarted);
 expect(value(await restarted.getSnapshot()).projects[0].newSession.reason).toContain('项目目录不可用');
 expect(value(await restarted.getSnapshot()).sessions[0].openSession.reason).toContain('项目目录不可用');
 await rename(`${f.project}-away`, f.project); await reconcile(restarted);
 await rm(file); value(await restarted.reconcile()); value(await restarted.cancelReconciliation());
 expect(value(await restarted.listSessions({ classification: 'archive' }))).toHaveLength(1);
 await reconcile(restarted); expect(value(await restarted.listSessions({ classification: 'archive' }))).toEqual([]);
 await f.record('old'); await reconcile(restarted); expect((await main(restarted))[0].classification).toBe('main');
});
test('pending import candidates never leak; committed queue is consumed and revision subscriptions reconnect across restart', async () => {
 const f = await fixture(); await f.record('candidate');
 const b = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'pending', path: f.project }))!.id);
 await f.record('queued'); await reconcile(f.manager); expect(await main(f.manager)).toEqual([]);
 const cached = value(await f.manager.getSnapshot()); const events: number[] = [];
 const stop = f.manager.subscribe(cached.revision, s => events.push(s.revision));
 value(await f.manager.commitImport({ batchId: b.id })); await settled(f.manager, b.id);
 await expect.poll(async () => (await main(f.manager)).map(s => s.headerId)).toEqual(['queued']);
 expect(value(await f.manager.listQueuedRecords())).toEqual([]);
 const last = value(await f.manager.getSnapshot()); expect(events.at(-1)).toBe(last.revision); stop();
 await f.manager.close(); await f.record('offline'); const restarted = await f.open();
 const replay: number[] = []; const unsubscribe = restarted.subscribe(cached.revision, s => replay.push(s.revision));
 expect(replay[0]).toBeGreaterThan(cached.revision);
 await expect.poll(async () => (await main(restarted)).map(s => s.headerId).sort()).toEqual(['offline', 'queued']);
 expect(replay.at(-1)).toBe(value(await restarted.getSnapshot()).revision); unsubscribe();
});
test('periodic recovery finds a reconnected root; a replacement identity is new and actual SQLite failure preserves the old cache across restart', async () => {
 const f = await fixture(200); const file = await f.record('old'); await f.imported(); await reconcile(f.manager);
 const kept = join(f.root, 'kept'); await rename(f.sessionsRoot, kept); await reconcile(f.manager);
 await rename(kept, f.sessionsRoot); await f.record('reconnected');
 await expect.poll(async () => (await main(f.manager)).map(s => s.headerId)).toEqual(['reconnected']);
 const original = await readFile(file, 'utf8'); await writeFile(file, original.replace('"id":"old"', '"id":"replacement"'));
 await reconcile(f.manager); expect((await main(f.manager)).map(s => s.headerId).sort()).toEqual(['reconnected', 'replacement']);
 const Database = (await import('better-sqlite3')).default; const fault = new Database(join(f.root, 'hub.sqlite'));
 fault.exec("CREATE TRIGGER reject_discovery BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
 await rm(file); await f.record('new'); await reconcile(f.manager);
 expect((await main(f.manager)).map(s => s.headerId).sort()).toEqual(['reconnected', 'replacement']);
 fault.exec('DROP TRIGGER reject_discovery'); fault.close(); await f.manager.close(); const restarted = await f.open();
 expect((await main(restarted)).map(s => s.headerId).sort()).toEqual(['reconnected', 'replacement']);
 await expect.poll(async () => (await main(restarted)).map(s => s.headerId).sort()).toEqual(['new', 'reconnected']);
});
test('coalesced reconciliation exposes cancellable progress and never commits an incomplete scan', async () => {
 const f = await fixture(); await f.record('old'); await f.imported(); await reconcile(f.manager);
 const large = await f.record('large'); await appendFile(large, JSON.stringify({ type: 'custom', padding: 'x'.repeat(12 * 1024 * 1024) }) + '\n');
 const events: string[] = []; const stop = f.manager.subscribe(-1, snapshot => events.push(snapshot.discovery.state));
 value(await f.manager.reconcile()); value(await f.manager.reconcile()); value(await f.manager.reconcile());
 expect(value(await f.manager.getSnapshot()).discovery.state).toBe('scanning');
 value(await f.manager.cancelReconciliation());
 expect(value(await f.manager.getSnapshot()).discovery.state).toBe('cancelled');
 expect(value(await f.manager.listSessions({ classification: 'archive' }))).toHaveLength(1);
 expect(events).toContain('scanning'); expect(events).toContain('cancelled');
 await reconcile(f.manager); expect((await main(f.manager)).map(s => s.headerId)).toEqual(['large']); stop();
}, 15000); // Includes writing and fully rereading 12MB; cancellation assertions and poll limits stay unchanged.
test('completed partial dialogue appends reactivate archives only after the complete message is saved', async () => {
 const f = await fixture(); const file = await f.record('old'); await f.imported(); await reconcile(f.manager);
 const archived = () => f.manager.listSessions({ classification: 'archive' }).then(value);
 const old = (await archived())[0]; const message = JSON.stringify({ type: 'message', id: 'assistant-2', message: { role: 'assistant', content: '已保存的回复', timestamp: 1767312000000 } });
 await appendFile(file, message.slice(0, 30)); await reconcile(f.manager);
 expect((await archived())[0].messageWatermark).toEqual(old.messageWatermark);
 await appendFile(file, message.slice(30) + '\n'); await reconcile(f.manager);
 expect(await archived()).toEqual([]);
 expect((await main(f.manager))[0]).toMatchObject({ classification: 'main', lastMessageAt: '2026-01-02T00:00:00.000Z', archiveWatermark: null });
 expect((await main(f.manager))[0].messageWatermark).toHaveLength(2);
 const bytes = await readFile(file); await f.manager.close(); const restarted = await f.open(); await reconcile(restarted); expect(await readFile(file)).toEqual(bytes);
});
test('an accessible empty replacement of an unavailable root is not proof that cached sources were deleted', async () => {
 const f = await fixture(); await f.record('old'); await f.imported(); await reconcile(f.manager);
 const kept = `${f.sessionsRoot}-kept`; await rename(f.sessionsRoot, kept); await mkdir(f.sessionsRoot); await reconcile(f.manager);
 const snapshot = value(await f.manager.getSnapshot());
 expect(snapshot.sessions).toHaveLength(1); expect(snapshot.sessions[0]).toMatchObject({ classification: 'archive', availability: { state: 'unavailable' } });
 await f.manager.close(); const restarted = await f.open(); await reconcile(restarted); expect(value(await restarted.getSnapshot()).sessions).toHaveLength(1);
 await rm(f.sessionsRoot, { recursive: true }); await rename(kept, f.sessionsRoot); await reconcile(restarted);
 expect(value(await restarted.getSnapshot()).sessions[0]).toMatchObject({ classification: 'archive', availability: { state: 'available' } });
});
test('each revision identifies one stable snapshot while background file reads advance', async () => {
 const f = await fixture(); await f.record('old'); await f.imported(); await reconcile(f.manager);
 const file = await f.record('large'); await appendFile(file, JSON.stringify({ type: 'custom', padding: 'x'.repeat(4 * 1024 * 1024) }) + '\n');
 const snapshots = new Map<number, unknown>();
 const stop = f.manager.subscribe(-1, s => snapshots.set(s.revision, s));
 value(await f.manager.reconcile());
 for (let i = 0; i < 70; i++) {
   const s = value(await f.manager.getSnapshot());
   if (snapshots.has(s.revision)) expect(s).toEqual(snapshots.get(s.revision));
   else snapshots.set(s.revision, s);
   await new Promise(resolve => setTimeout(resolve, 2));
 }
 stop(); await reconcile(f.manager);
});

async function v2Fixture() {
 const f = await fixture(); const file = await f.record('legacy'); await f.imported();
 const archived = value(await f.manager.listSessions({ classification: 'archive' }));
 const imports = value(await f.manager.getImport({ batchId: 'import' }));
 await f.manager.close();
 // Build the released v2 persistence format, with no discovery metadata. SQLite is fixture setup only.
 const Database = (await import('better-sqlite3')).default;
 await rm(join(f.root, 'hub.sqlite'));
 const db = new Database(join(f.root, 'hub.sqlite'));
 db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE);
 CREATE TABLE sessions(key TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
 CREATE TABLE import_batches(id TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE import_queue(key TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id), data TEXT NOT NULL);
 CREATE TABLE scope_state(revision INTEGER NOT NULL); INSERT INTO scope_state VALUES(1); PRAGMA user_version=2;`);
 db.prepare('INSERT INTO projects VALUES(?,?)').run(imports.project.id, f.project);
 db.prepare('INSERT INTO import_batches VALUES(?,?)').run(imports.id, JSON.stringify({ ...imports, storageRoot: f.sessionsRoot }));
 const legacy = { key: archived[0].key, identity: archived[0].identity, headerId: archived[0].headerId, sourcePath: file, cwd: f.project, title: '对话 legacy', lastMessageAt: archived[0].lastMessageAt, messageWatermark: archived[0].messageWatermark, archiveWatermark: archived[0].archiveWatermark, classification: 'archive', projectId: imports.project.id };
 db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(legacy.key, legacy.projectId, JSON.stringify(legacy)); db.close();
 return { ...f, file, archived: legacy, bytes: await readFile(file) };
}
test('v2 migration cannot treat an empty replacement root as deletion evidence, across repeated scans and restart', async () => {
 const f = await v2Fixture(); const kept = `${f.sessionsRoot}-original`;
 await rename(f.sessionsRoot, kept); await mkdir(f.folder, { recursive: true });
 let manager = await f.open();
 for (let i = 0; i < 3; i++) {
   await reconcile(manager);
   expect(value(await manager.listSessions({ classification: 'archive' }))).toEqual([f.archived]);
   expect(value(await manager.getSnapshot()).sessions[0].availability.state).toBe('unavailable');
 }
 await manager.close(); manager = await f.open(); await reconcile(manager);
 expect(value(await manager.listSessions({ classification: 'archive' }))).toEqual([f.archived]);
 // Observing an unrelated new source must not grant authority to delete the absent legacy source.
 const fresh = await f.record('replacement-new'); await reconcile(manager);
 expect((await main(manager)).map(s => s.headerId)).toEqual(['replacement-new']);
 await rm(fresh); await reconcile(manager); expect(await main(manager)).toEqual([]);
 expect(value(await manager.listSessions({ classification: 'archive' }))).toEqual([f.archived]);
 await rm(f.sessionsRoot, { recursive: true }); await rename(kept, f.sessionsRoot);
 await reconcile(manager);
 expect(value(await manager.getSnapshot()).sessions[0]).toMatchObject({ classification: 'archive', availability: { state: 'available' }, archiveWatermark: f.archived.archiveWatermark });
 expect(await readFile(f.file)).toEqual(f.bytes);
 await manager.close(); manager = await f.open(); await rm(f.file); await reconcile(manager);
 expect(value(await manager.listSessions({ classification: 'archive' }))).toEqual([]);
 await writeFile(f.file, f.bytes); await reconcile(manager);
 expect((await main(manager))[0].classification).toBe('main'); expect(await readFile(f.file)).toEqual(f.bytes);
});
test('import establishes deletion evidence before its first reconciliation completes', async () => {
 const f = await fixture(); const file = await f.record('imported');
 await appendFile(file, JSON.stringify({ type: 'custom', padding: 'x'.repeat(8 * 1024 * 1024) }) + '\n');
 const bytes = await readFile(file);
 const batch = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'baseline-import', path: f.project }))!.id);
 value(await f.manager.commitImport({ batchId: batch.id }));
 await expect.poll(async () => value(await f.manager.getImport({ batchId: batch.id })).state, { interval: 1, timeout: 10000 }).toBe('completed');
 expect(value(await f.manager.cancelReconciliation()).state).toBe('cancelled');
 expect(await readFile(file)).toEqual(bytes);
 await f.manager.close(); await rm(file);
 const restarted = await f.open(); await reconcile(restarted);
 expect(value(await restarted.listSessions({ classification: 'archive' }))).toEqual([]);
}, 15000);
test('empty startup and empty imports still discover new sources and confirm their later deletion', async () => {
 const f = await fixture(); await rm(f.sessionsRoot, { recursive: true }); await f.imported();
 expect(value(await f.manager.getSnapshot()).sessions).toEqual([]);
 await mkdir(f.folder, { recursive: true }); const file = await f.record('new'); const bytes = await readFile(file);
 await reconcile(f.manager); expect((await main(f.manager)).map(s => s.headerId)).toEqual(['new']);
 expect(await readFile(file)).toEqual(bytes);
 await f.manager.close(); await rm(file); const restarted = await f.open(); await reconcile(restarted);
 expect(await main(restarted)).toEqual([]);
});
