import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openSessionManagement } from '../../src/session-management/service';
import type { Result, SessionManagement, ImportBatch } from '../../src/session-management/interface';
const roots: string[] = [];
const managers: SessionManagement[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function value<T>(result: Result<T>): T { expect(result.status, JSON.stringify(result)).toBe('completed'); if (result.status === 'failed') throw Error(result.error.message); return result.value; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-import-')); roots.push(root);
  const path = join(root, '项目'); const sessionsRoot = join(root, 'agent', 'sessions');
  await mkdir(path); await mkdir(join(sessionsRoot, '--misleading--'), { recursive: true });
  const databasePath = join(root, 'hub.sqlite');
  const open = async () => { const m = value(await openSessionManagement(databasePath, { sessionsRoot })); managers.push(m); return m; };
  const record = async (id: string, cwd = path, messages = true, filename = id) => {
    const file = join(sessionsRoot, '--misleading--', `${filename}.jsonl`);
    await writeFile(file, JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: '2026-01-01T00:00:00Z' }) + '\n' + (messages ? JSON.stringify({ type: 'message', id: `msg-${id}`, message: { role: 'user', content: [{ type: 'text', text: `对话 ${id}` }], timestamp: 1767225600000 } }) + '\n' : ''));
    return file;
  };
  return { root, path, sessionsRoot, databasePath, open, record, manager: await open() };
}
async function settled(manager: SessionManagement, id: string) {
  let batch!: ImportBatch;
  await expect.poll(async () => { batch = value(await manager.getImport({ batchId: id })); return batch.state; }, { timeout: 10000 }).not.toMatch(/^(scanning|validating)$/);
  return batch;
}
test('header-first discovery uses exact cwd, excludes empty records and isolates malformed records', async () => {
  const f = await fixture();
  const source = await f.record('a'); const before = await readFile(source);
  await f.record('b', `${f.path}/child`); await f.record('c', `${f.path}-other`); await f.record('empty', f.path, false);
  const unrelated = await f.record('unrelated', '/unrelated');
  await writeFile(unrelated, (await readFile(unrelated, 'utf8')).split('\n')[0] + '\nBAD BODY\n');
  const bad = await f.record('bad'); await writeFile(bad, (await readFile(bad, 'utf8')) + 'BAD LINE\n');
  const batch = value(await f.manager.prepareImport({ requestId: 'first', path: f.path }));
  expect(batch?.state).toBe('scanning');
  const ready = await settled(f.manager, batch!.id);
  expect(ready.state).toBe('ready');
  expect(ready.candidates.map(c => c.headerId)).toEqual(['a']);
  expect(ready.issues).toHaveLength(1);
  expect(ready.progress.inspected).toBe(6);
  expect(value(await f.manager.listProjects()).projects).toEqual([]);
  expect(await readFile(source)).toEqual(before);
});

test.each(['part', 'all', 'none'])('%s selection commits project and classifications atomically and survives restart without source writes', async choice => {
  const f = await fixture(); const a = await f.record('a'); const b = await f.record('b');
  const before = await Promise.all([readFile(a), readFile(b)]);
  const hashes = before.map(bytes => createHash('sha256').update(bytes).digest('hex'));
  const batch = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'select', path: f.path }))!.id);
  const keys = batch.candidates.filter(c => choice === 'all' || choice === 'part' && c.headerId === 'a').map(c => c.key);
  value(await f.manager.selectImport({ batchId: batch.id, selectedKeys: keys }));
  value(await f.manager.commitImport({ batchId: batch.id }));
  const done = await settled(f.manager, batch.id); expect(done.state).toBe('completed');
  expect(value(await f.manager.listProjects()).projects).toHaveLength(1);
  await f.manager.close(); const restarted = await f.open();
  const main = value(await restarted.listSessions({ classification: 'main' }));
  const archived = value(await restarted.listSessions({ classification: 'archive' }));
  expect(main.map(c => c.headerId).sort()).toEqual(choice === 'all' ? ['a', 'b'] : choice === 'part' ? ['a'] : []);
  expect(archived).toHaveLength(2 - keys.length);
  expect(archived.every(c => c.archiveWatermark?.length === 1)).toBe(true);
  const after = await Promise.all([readFile(a), readFile(b)]);
  expect(after).toEqual(before);
  expect(after.map(bytes => createHash('sha256').update(bytes).digest('hex'))).toEqual(hashes);
});

test('snapshot survives restart, updated candidates stay in choice, deleted candidates are counted and queued records join main after commit', async () => {
  const f = await fixture(); const a = await f.record('a'); const b = await f.record('b');
  const batch = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'changing', path: f.path }))!.id);
  value(await f.manager.selectImport({ batchId: batch.id, selectedKeys: batch.candidates.filter(c => c.headerId === 'b').map(c => c.key) }));
  await f.manager.close(); const restarted = await f.open();
  expect(value(await restarted.listImports())[0].selectedKeys).toHaveLength(1);
  const { appendFile, unlink, utimes } = await import('node:fs/promises');
  await appendFile(a, JSON.stringify({ type: 'message', id: 'a2', message: { role: 'assistant', content: 'new response', timestamp: 1767225601000 } }) + '\n');
  await unlink(b); const fresh = await f.record('new'); await utimes(fresh, new Date(0), new Date(0));
  value(await restarted.commitImport({ batchId: batch.id }));
  const done = await settled(restarted, batch.id);
  expect(done.outcome).toEqual({ main: 0, archived: 1, removed: 1, queued: 1 });
  await expect.poll(async () => value(await restarted.listSessions({ classification: 'main' })).map(c => c.headerId)).toEqual(['new']);
  expect(value(await restarted.listSessions({ classification: 'archive' }))[0]).toMatchObject({ headerId: 'a', archiveWatermark: expect.any(Array) });
  expect(value(await restarted.listSessions({ classification: 'archive' }))[0].archiveWatermark).toHaveLength(2);
  expect(value(await restarted.listQueuedRecords())).toEqual([]);
});

test('cancel stops asynchronous work without publishing projects or classifications; ready selection is recoverable', async () => {
  const f = await fixture(); await f.record('a');
  const scanning = value(await f.manager.prepareImport({ requestId: 'cancel-scan', path: f.path }))!;
  expect(value(await f.manager.cancelImport({ batchId: scanning.id })).state).toBe('cancelled');
  const ready = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'cancel-ready', path: f.path }))!.id);
  value(await f.manager.selectImport({ batchId: ready.id, selectedKeys: ready.candidates.map(c => c.key) }));
  await f.manager.close(); const restarted = await f.open();
  expect(value(await restarted.listImports())[0]).toMatchObject({ state: 'ready', selectedKeys: ready.candidates.map(c => c.key) });
  value(await restarted.cancelImport({ batchId: ready.id }));
  expect(value(await restarted.listProjects()).projects).toEqual([]);
  expect(value(await restarted.listSessions({ classification: 'main' }))).toEqual([]);
  expect(value(await restarted.listSessions({ classification: 'archive' }))).toEqual([]);
});

test.each(['identity', 'scope', 'storage'])('%s change refuses commit and keeps the project unpublished', async change => {
  const f = await fixture(); const source = await f.record('a');
  const batch = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'conflict', path: f.path }))!.id);
  if (change === 'identity') await writeFile(source, (await readFile(source, 'utf8')).replace('"id":"a"', '"id":"different"'));
  if (change === 'scope') { const other = join(f.root, 'other'); await mkdir(other); value(await f.manager.addProject({ requestId: 'other', path: other })); }
  if (change === 'storage') await rm(f.sessionsRoot, { recursive: true });
  value(await f.manager.commitImport({ batchId: batch.id }));
  const error = await settled(f.manager, batch.id);
  expect(error.state).toBe('error');
  expect(error.error?.code).toBe(change === 'identity' ? 'RECORD_CHANGED' : change === 'scope' ? 'SCOPE_CHANGED' : 'IMPORT_UNAVAILABLE');
  expect(value(await f.manager.listProjects()).projects.some(p => p.path === f.path)).toBe(false);
  expect(value(await f.manager.listSessions({ classification: 'archive' }))).toEqual([]);
});

test('an actual SQLite transaction failure rolls back project and all classifications and can be retried', async () => {
  const f = await fixture(); await f.record('a'); await f.record('b');
  const batch = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'transaction', path: f.path }))!.id);
  const Database = (await import('better-sqlite3')).default;
  // Fault injection is at SQLite's boundary; all assertions remain on the public service.
  const fault = new Database(f.databasePath);
  fault.exec("CREATE TRIGGER reject_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END");
  value(await f.manager.commitImport({ batchId: batch.id }));
  expect((await settled(f.manager, batch.id)).state).toBe('error');
  expect(value(await f.manager.listProjects()).projects).toEqual([]);
  expect(value(await f.manager.listSessions({ classification: 'archive' }))).toEqual([]);
  fault.exec('DROP TRIGGER reject_session'); fault.close();
  await f.manager.close(); const restarted = await f.open();
  value(await restarted.retryImport({ batchId: batch.id })); value(await restarted.commitImport({ batchId: batch.id }));
  expect((await settled(restarted, batch.id)).outcome?.archived).toBe(2);
});

test('different files with identical header IDs retain separate source identities and duplicate requests are idempotent', async () => {
  const f = await fixture(); await f.record('same', f.path, true, 'one'); await f.record('same', f.path, true, 'two');
  const batch = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'identity', path: f.path }))!.id);
  expect(batch.candidates).toHaveLength(2); expect(new Set(batch.candidates.map(c => c.key)).size).toBe(2);
  expect(value(await f.manager.prepareImport({ requestId: batch.id, path: f.path }))!.id).toBe(batch.id);
  value(await f.manager.commitImport({ batchId: batch.id })); expect((await settled(f.manager, batch.id)).outcome?.archived).toBe(2);
  expect(value(await f.manager.commitImport({ batchId: batch.id })).state).toBe('completed');
  expect(value(await f.manager.listSessions({ classification: 'archive' }))).toHaveLength(2);
});

test('an inaccessible storage root reports a recoverable error instead of an empty history', async () => {
  const f = await fixture(); await rm(f.sessionsRoot, { recursive: true }); await writeFile(f.sessionsRoot, 'not a directory');
  const batch = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'retry', path: f.path }))!.id);
  expect(batch.state).toBe('error');
  await rm(f.sessionsRoot); await mkdir(join(f.sessionsRoot, '--misleading--'), { recursive: true }); await f.record('a');
  value(await f.manager.retryImport({ batchId: batch.id }));
  expect((await settled(f.manager, batch.id)).candidates.map(c => c.headerId)).toEqual(['a']);
});

test('v1 migration preserves projects and a usable backup; incompatible v1 is preserved byte-for-byte', async () => {
  const f = await fixture(); const Database = (await import('better-sqlite3')).default;
  const legacyPath = join(f.root, 'legacy.sqlite'); const legacy = new Database(legacyPath);
  legacy.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE); PRAGMA user_version=1');
  legacy.prepare('INSERT INTO projects VALUES (?, ?)').run('legacy-project', f.path); legacy.close();
  const migrated = value(await openSessionManagement(legacyPath, { sessionsRoot: f.sessionsRoot })); managers.push(migrated);
  expect(value(await migrated.listProjects()).projects[0].id).toBe('legacy-project');
  const { readdir, copyFile } = await import('node:fs/promises');
  const backup = (await readdir(f.root)).find(file => file.startsWith('legacy.sqlite.backup-v1-'))!;
  const restoredPath = join(f.root, 'restored.sqlite'); await copyFile(join(f.root, backup), restoredPath);
  const restored = value(await openSessionManagement(restoredPath, { sessionsRoot: f.sessionsRoot })); managers.push(restored);
  expect(value(await restored.listProjects()).projects[0].id).toBe('legacy-project');
  const brokenPath = join(f.root, 'incompatible.sqlite'); const broken = new Database(brokenPath);
  broken.exec('CREATE TABLE projects (unrecognized TEXT); PRAGMA user_version=1'); broken.close();
  const bytes = await readFile(brokenPath);
  expect((await openSessionManagement(brokenPath, { sessionsRoot: f.sessionsRoot })).status).toBe('failed');
  expect(await readFile(brokenPath)).toEqual(bytes);
});

test('discovery exposes progress, is cancellable before reading bodies, and an interrupted batch never publishes a project', async () => {
  const f = await fixture();
  for (let index = 0; index < 40; index++) {
    const source = await f.record(`slow-${index}`);
    const text = await readFile(source, 'utf8');
    await writeFile(source, text.replace('"version":3', `"padding":"${'x'.repeat(60000)}","version":3`));
  }
  const batch = value(await f.manager.prepareImport({ requestId: 'progress', path: f.path }))!;
  await expect.poll(async () => value(await f.manager.getImport({ batchId: batch.id })).progress.inspected).toBeGreaterThan(1);
  const progress = value(await f.manager.getImport({ batchId: batch.id }));
  expect(progress.state).toBe('scanning'); expect(progress.progress.parsed).toBe(0);
  expect(value(await f.manager.cancelImport({ batchId: batch.id })).state).toBe('cancelled');
  expect(value(await f.manager.listProjects()).projects).toEqual([]);
  const interrupted = value(await f.manager.prepareImport({ requestId: 'interrupted', path: f.path }))!;
  await f.manager.close(); const restarted = await f.open();
  expect(value(await restarted.getImport({ batchId: interrupted.id })).state).toBe('cancelled');
  expect(value(await restarted.listProjects()).projects).toEqual([]);
});

test('a partial trailing line is deferred and old readable formats are imported without migration', async () => {
  const f = await fixture(); const source = await f.record('old');
  const original = (await readFile(source, 'utf8')).replace('"version":3', '"version":1') + '{"type":"message","id":"partial';
  await writeFile(source, original);
  const batch = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'old', path: f.path }))!.id);
  expect(batch.issues).toEqual([]); expect(batch.candidates).toHaveLength(1);
  value(await f.manager.commitImport({ batchId: batch.id })); expect((await settled(f.manager, batch.id)).state).toBe('completed');
  expect(await readFile(source, 'utf8')).toBe(original);
});

test('candidates replaced while another large record is being verified cannot be committed under their old identity', async () => {
  const f = await fixture(); const source = await f.record('a'); await f.record('b');
  const batch = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'late-replacement', path: f.path }))!.id);
  const { appendFile } = await import('node:fs/promises');
  // The queued file is a bounded slow I/O fixture, making the race observable without internal hooks.
  const slow = await f.record('queued');
  await appendFile(slow, JSON.stringify({ type: 'custom', padding: 'x'.repeat(8 * 1024 * 1024) }) + '\n');
  value(await f.manager.commitImport({ batchId: batch.id }));
  await expect.poll(async () => value(await f.manager.getImport({ batchId: batch.id })).progress.parsed, { interval: 1 }).toBe(2);
  await writeFile(source, (await readFile(source, 'utf8')).replace('"id":"a"', '"id":"replaced"'));
  expect((await settled(f.manager, batch.id)).error?.code).toBe('RECORD_CHANGED');
  expect(value(await f.manager.listProjects()).projects).toEqual([]);
});

test('interruption after identity discovery resumes the same snapshot and queues records discovered later', async () => {
  const f = await fixture(); const source = await f.record('a');
  const { appendFile } = await import('node:fs/promises');
  await appendFile(source, JSON.stringify({ type: 'custom', padding: 'x'.repeat(4 * 1024 * 1024) }) + '\n');
  const batch = value(await f.manager.prepareImport({ requestId: 'resume-scan', path: f.path }))!;
  await expect.poll(async () => value(await f.manager.getImport({ batchId: batch.id })).progress.phase, { interval: 1 }).toBe('reading');
  await f.manager.close(); await f.record('new');
  const restarted = await f.open();
  expect(value(await restarted.getImport({ batchId: batch.id })).state).toBe('error');
  value(await restarted.retryImport({ batchId: batch.id }));
  const ready = await settled(restarted, batch.id);
  expect(ready.candidates.map(c => c.headerId)).toEqual(['a']);
  value(await restarted.commitImport({ batchId: batch.id }));
  expect((await settled(restarted, batch.id)).outcome).toEqual({ main: 0, archived: 1, removed: 0, queued: 1 });
});

test('changing the configured storage root across restart cannot commit a snapshot from the previous scope', async () => {
  const f = await fixture(); await f.record('a');
  const batch = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'storage-scope', path: f.path }))!.id);
  await f.manager.close(); const otherRoot = join(f.root, 'other-agent', 'sessions'); await mkdir(otherRoot, { recursive: true });
  const restarted = value(await openSessionManagement(f.databasePath, { sessionsRoot: otherRoot })); managers.push(restarted);
  value(await restarted.commitImport({ batchId: batch.id }));
  expect((await settled(restarted, batch.id)).error?.code).toBe('SCOPE_CHANGED');
  expect(value(await restarted.listProjects()).projects).toEqual([]);
});

test('corruption after discovery excludes only the bad candidate, preserves selection and requests review before publication', async () => {
  const f = await fixture(); const good = await f.record('good'); const bad = await f.record('bad'); await f.record('archived');
  const batch = await settled(f.manager, value(await f.manager.prepareImport({ requestId: 'late-corruption', path: f.path }))!.id);
  value(await f.manager.selectImport({ batchId: batch.id, selectedKeys: batch.candidates.filter(c => c.headerId !== 'archived').map(c => c.key) }));
  const { appendFile } = await import('node:fs/promises'); await appendFile(bad, 'BAD LINE\n');
  const before = await Promise.all([readFile(good), readFile(bad)]);
  value(await f.manager.commitImport({ batchId: batch.id }));
  const review = await settled(f.manager, batch.id);
  expect(review.state).toBe('ready');
  expect(review.candidates.map(c => c.headerId).sort()).toEqual(['archived', 'good']);
  expect(review.selectedKeys).toEqual([batch.candidates.find(c => c.headerId === 'good')!.key]);
  expect(review.issues).toContainEqual(expect.objectContaining({ path: bad }));
  expect(review.validationNotice).toContain('1');
  expect(value(await f.manager.listProjects()).projects).toEqual([]);
  await f.manager.close(); const restarted = await f.open();
  expect(value(await restarted.getImport({ batchId: batch.id })).selectedKeys).toEqual(review.selectedKeys);
  value(await restarted.commitImport({ batchId: batch.id }));
  expect((await settled(restarted, batch.id)).state).toBe('completed');
  expect(value(await restarted.listSessions({ classification: 'main' })).map(c => c.headerId)).toEqual(['good']);
  expect(value(await restarted.listSessions({ classification: 'archive' })).map(c => c.headerId)).toEqual(['archived']);
  expect(await Promise.all([readFile(good), readFile(bad)])).toEqual(before);
});
