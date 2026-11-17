import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, link, symlink, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSessionManagement } from '../../src/session-management/service';
import type { SessionManagement, Result, ImportBatch, WorkspaceSnapshot } from '../../src/session-management/interface';

const roots: string[] = []; const managers: SessionManagement[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function value<T>(result: Result<T>): T { if (result.status === 'failed') throw Error(JSON.stringify(result.error)); return result.value; }
async function settled(manager: SessionManagement, id: string) {
  let batch!: ImportBatch;
  await expect.poll(async () => { batch = value(await manager.getImport({ batchId: id })); return batch.state; }, { timeout: 10000, interval: 5 }).not.toMatch(/^(scanning|validating)$/);
  return batch;
}
async function reconcile(manager: SessionManagement) {
  value(await manager.reconcile());
  await expect.poll(async () => value(await manager.getSnapshot()).discovery.state, { timeout: 10000, interval: 5 }).toMatch(/^(completed|error)$/);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-06-review-')); roots.push(root);
  const project = join(root, 'project'); const standard = join(root, 'standard'); const encoded = join(standard, 'encoded'); const custom = join(root, 'custom');
  for (const path of [project, encoded, custom]) await mkdir(path, { recursive: true });
  const manager = value(await openSessionManagement(join(root, 'hub.sqlite'), { sessionsRoot: standard, reconciliationIntervalMs: 60000 })); managers.push(manager);
  const batch = value(await manager.prepareImport({ requestId: 'project', path: project }))!; await settled(manager, batch.id); value(await manager.commitImport({ batchId: batch.id })); expect((await settled(manager, batch.id)).state).toBe('completed');
  await reconcile(manager); value(await manager.cancelReconciliation());
  async function record(folder: string, id: string, large = false) {
    const file = join(folder, id + '.jsonl');
    const entries = [{ type: 'session', version: 3, id, cwd: project, timestamp: '2026-01-01T00:00:00Z' }, { type: 'message', id: 'm-' + id, parentId: null, message: { role: 'user', content: 'Review ' + id, timestamp: 1767225600000 } }];
    await writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    if (large) await appendFile(file, JSON.stringify({ type: 'custom', padding: 'x'.repeat(8 * 1024 * 1024) }) + '\n');
    return file;
  }
  return { root, project, standard, encoded, custom, manager, record };
}

test.each(['overlap', 'hardlink', 'symlink'])('pending %s storage history stays out of every discovery snapshot and deselection archives the latest source revision', async alias => {
  const f = await fixture(); const folder = alias === 'overlap' ? f.encoded : f.custom;
  const file = await f.record(folder, 'candidate', true);
  if (alias === 'hardlink') await link(file, join(f.encoded, 'alias.jsonl'));
  if (alias === 'symlink') await symlink(file, join(f.encoded, 'alias.jsonl'));
  const snapshots: WorkspaceSnapshot[] = []; const stop = f.manager.subscribe(-1, snapshot => snapshots.push(snapshot));
  try {
    const batch = value(await f.manager.prepareStorageLocation({ requestId: 'pending', path: folder, enumeration: 'flat' }))!;
    expect(value(await f.manager.getSnapshot()).sessions).toEqual([]);
    value(await f.manager.reconcile()); const ready = await settled(f.manager, batch.id);
    expect(ready.candidates.map(record => record.headerId)).toEqual(['candidate']);
    await reconcile(f.manager); expect(value(await f.manager.listSessions({ classification: 'all' }))).toEqual([]);
    expect(snapshots.every(snapshot => snapshot.sessions.length === 0)).toBe(true);
    await appendFile(file, JSON.stringify({ type: 'message', id: 'new-message', parentId: 'm-candidate', message: { role: 'user', content: 'Latest revision', timestamp: 1767225601000 } }) + '\n');
    const expectedBytes = await readFile(file); await reconcile(f.manager);
    value(await f.manager.selectImport({ batchId: batch.id, selectedKeys: [] }));
    expect(value(await f.manager.commitImport({ batchId: batch.id })).state).toBe('validating');
    value(await f.manager.reconcile()); expect((await settled(f.manager, batch.id)).state).toBe('completed');
    await reconcile(f.manager);
    const archived = value(await f.manager.listSessions({ classification: 'archive' }));
    expect(archived).toHaveLength(1); expect(archived[0].messageWatermark).toHaveLength(2);
    expect(archived[0].sourceFingerprint).not.toBe(ready.candidates[0].sourceFingerprint);
    expect(snapshots.every(snapshot => snapshot.sessions.every(record => record.classification === 'archive'))).toBe(true);
    expect(await readFile(file)).toEqual(expectedBytes);
  } finally { stop(); }
}, 15000);

test.each(['ready', 'validating'])('cancelling an overlapping %s import has no prematurely published candidate', async phase => {
  const f = await fixture(); await f.record(f.encoded, 'cancelled', true);
  const snapshots: WorkspaceSnapshot[] = []; const stop = f.manager.subscribe(-1, snapshot => snapshots.push(snapshot));
  try {
    const batch = value(await f.manager.prepareStorageLocation({ requestId: 'pending', path: f.encoded, enumeration: 'flat' }))!; await settled(f.manager, batch.id);
    await reconcile(f.manager);
    if (phase === 'validating') { value(await f.manager.commitImport({ batchId: batch.id })); value(await f.manager.reconcile()); }
    expect(snapshots.every(snapshot => snapshot.sessions.length === 0)).toBe(true);
    expect(value(await f.manager.cancelImport({ batchId: batch.id })).state).toBe('cancelled');
    expect(value(await f.manager.listStorageLocations()).locations).toHaveLength(1);
    expect(value(await f.manager.getSnapshot()).sessions).toEqual([]);
  } finally { stop(); }
}, 15000);

test('a pending candidate changed in place stays shielded through a physical alias and fails source identity validation', async () => {
  const f = await fixture(); const file = await f.record(f.custom, 'candidate'); await link(file, join(f.encoded, 'alias.jsonl'));
  const batch = value(await f.manager.prepareStorageLocation({ requestId: 'pending', path: f.custom, enumeration: 'flat' }))!; await settled(f.manager, batch.id);
  await writeFile(file, (await readFile(file, 'utf8')).replace('"id":"candidate"', '"id":"replacement"'));
  await reconcile(f.manager); expect(value(await f.manager.getSnapshot()).sessions).toEqual([]);
  value(await f.manager.commitImport({ batchId: batch.id })); expect((await settled(f.manager, batch.id)).error?.code).toBe('RECORD_CHANGED');
  await reconcile(f.manager); expect(value(await f.manager.listSessions({ classification: 'all' }))).toEqual([]);
}, 15000);

test.each(['missing', 'permission', 'rollback'])('late root-A %s failure preserves its cache while healthy B commits with its own deletion evidence', async failure => {
  const f = await fixture(); const cachedFile = await f.record(f.encoded, 'cached-a'); await reconcile(f.manager);
  const original = value(await f.manager.listSessions({ classification: 'all' }))[0];
  const batch = value(await f.manager.prepareStorageLocation({ requestId: 'custom', path: f.custom, enumeration: 'flat' }))!;
  await settled(f.manager, batch.id); value(await f.manager.commitImport({ batchId: batch.id })); expect((await settled(f.manager, batch.id)).state).toBe('completed');
  await reconcile(f.manager); value(await f.manager.cancelReconciliation());
  await rm(cachedFile); const healthyFile = await f.record(f.custom, 'healthy-b', true);
  const Database = (await import('better-sqlite3')).default; const fault = new Database(join(f.root, 'hub.sqlite'));
  if (failure === 'rollback') fault.exec("CREATE TRIGGER reject_healthy BEFORE INSERT ON sessions WHEN json_extract(NEW.data,'$.headerId')='healthy-b' BEGIN SELECT RAISE(ABORT,'review rollback'); END");
  let triggered = false; let mutation = Promise.resolve();
  const stop = f.manager.subscribe(-1, snapshot => {
    if (snapshot.discovery.state === 'scanning' && snapshot.discovery.inspected === 1 && !triggered) {
      // A had zero files. The first inspected path is in B, after A's enumeration succeeded.
      triggered = true;
      mutation = failure === 'permission' ? chmod(f.standard, 0) : rename(f.standard, f.standard + '-held');
    }
  });
  try {
    value(await f.manager.reconcile()); await expect.poll(() => triggered, { timeout: 10000, interval: 1 }).toBe(true); await mutation;
    await expect.poll(async () => value(await f.manager.getSnapshot()).discovery.state, { timeout: 10000, interval: 5 }).toMatch(/^(completed|error)$/);
    if (failure === 'rollback') {
      expect(value(await f.manager.getSnapshot()).discovery.state).toBe('error');
      expect(value(await f.manager.listSessions({ classification: 'all' })).map(record => record.headerId)).toEqual(['cached-a']);
      fault.exec('DROP TRIGGER reject_healthy'); await reconcile(f.manager);
    }
    const snapshot = value(await f.manager.getSnapshot());
    expect(snapshot.discovery.state).toBe('completed');
    expect(snapshot.locations?.find(location => location.id === 'standard')?.availability.state).toBe('unavailable');
    expect(snapshot.sessions.find(record => record.headerId === 'cached-a')).toMatchObject({ key: original.key, classification: original.classification, sourceFingerprint: original.sourceFingerprint, availability: { state: 'unavailable' } });
    expect(snapshot.sessions.find(record => record.headerId === 'healthy-b')?.availability.state).toBe('available');
    await rm(healthyFile); await reconcile(f.manager);
    expect(value(await f.manager.listSessions({ classification: 'all' })).map(record => record.headerId)).toEqual(['cached-a']);
  } finally { stop(); fault.close(); if (failure === 'permission') await chmod(f.standard, 0o700); }
}, 15000);

test('a new workspace reports a pending storage check rather than a confirmed location failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-06-pending-')); roots.push(root);
  const standard = join(root, 'standard'); await mkdir(standard);
  const manager = value(await openSessionManagement(join(root, 'hub.sqlite'), { sessionsRoot: standard, reconciliationIntervalMs: 60000 })); managers.push(manager);
  expect(value(await manager.getSnapshot()).locations?.[0].availability.state).toBe('pending');
  await reconcile(manager);
  expect(value(await manager.getSnapshot()).locations?.[0].availability.state).toBe('pending');
  const project = join(root, 'project'); await mkdir(project);
  const batch = value(await manager.prepareImport({ requestId: 'project', path: project }))!; await settled(manager, batch.id); value(await manager.commitImport({ batchId: batch.id })); await settled(manager, batch.id);
  await reconcile(manager);
  expect(value(await manager.getSnapshot()).locations?.[0].availability.state).toBe('available');
});

test('staging while an older discovery reads a source invalidates that scan before it can publish history', async () => {
  const f = await fixture(); await f.record(f.encoded, 'in-flight', true);
  const snapshots: WorkspaceSnapshot[] = []; const stop = f.manager.subscribe(-1, snapshot => snapshots.push(snapshot));
  try {
    value(await f.manager.reconcile());
    await expect.poll(async () => value(await f.manager.getSnapshot()).discovery.inspected, { interval: 1 }).toBe(1);
    const batch = value(await f.manager.prepareStorageLocation({ requestId: 'staged-later', path: f.encoded, enumeration: 'flat' }))!;
    expect((await settled(f.manager, batch.id)).candidates.map(record => record.headerId)).toEqual(['in-flight']);
    await reconcile(f.manager); expect(snapshots.every(snapshot => snapshot.sessions.length === 0)).toBe(true);
    value(await f.manager.commitImport({ batchId: batch.id })); expect((await settled(f.manager, batch.id)).state).toBe('completed'); await reconcile(f.manager);
    expect(value(await f.manager.listSessions({ classification: 'archive' })).map(record => record.headerId)).toEqual(['in-flight']);
    expect(snapshots.every(snapshot => snapshot.sessions.every(record => record.classification === 'archive'))).toBe(true);
  } finally { stop(); }
}, 15000);

test('a failed overlapping storage transaction keeps its historical decision shield until a successful retry', async () => {
  const f = await fixture(); await f.record(f.encoded, 'rollback');
  const batch = value(await f.manager.prepareStorageLocation({ requestId: 'pending', path: f.encoded, enumeration: 'flat' }))!; await settled(f.manager, batch.id);
  const Database = (await import('better-sqlite3')).default; const fault = new Database(join(f.root, 'hub.sqlite'));
  fault.exec("CREATE TRIGGER reject_import BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'review rollback'); END");
  try {
    value(await f.manager.commitImport({ batchId: batch.id })); expect((await settled(f.manager, batch.id)).state).toBe('error');
    expect(value(await f.manager.listStorageLocations()).locations).toHaveLength(1);
    await reconcile(f.manager); expect(value(await f.manager.getSnapshot()).sessions).toEqual([]);
    fault.exec('DROP TRIGGER reject_import'); value(await f.manager.retryImport({ batchId: batch.id }));
    value(await f.manager.commitImport({ batchId: batch.id })); expect((await settled(f.manager, batch.id)).state).toBe('completed');
    await reconcile(f.manager); expect(value(await f.manager.listSessions({ classification: 'archive' })).map(record => record.headerId)).toEqual(['rollback']);
  } finally { fault.close(); }
});

test('a root failing its final recheck publishes neither its new records nor its updated source projection', async () => {
  const f = await fixture(); const cachedFile = await f.record(f.encoded, 'cached-a'); await reconcile(f.manager);
  const original = value(await f.manager.listSessions({ classification: 'all' }))[0];
  const batch = value(await f.manager.prepareStorageLocation({ requestId: 'custom', path: f.custom, enumeration: 'flat' }))!;
  await settled(f.manager, batch.id); value(await f.manager.commitImport({ batchId: batch.id })); await settled(f.manager, batch.id); await reconcile(f.manager); value(await f.manager.cancelReconciliation());
  await appendFile(cachedFile, JSON.stringify({ type: 'message', id: 'new-a', parentId: 'm-cached-a', message: { role: 'user', content: 'Unvalidated change', timestamp: 1767225601000 } }) + '\n');
  await f.record(f.encoded, 'unvalidated-new-a'); await f.record(f.custom, 'healthy-b', true);
  let triggered = false; let mutation = Promise.resolve(); let unavailableRootGrantedSource = false;
  const stop = f.manager.subscribe(-1, snapshot => {
    if(snapshot.locations?.find(location=>location.id==='standard')?.availability.state==='unavailable'&&snapshot.sessions.some(session=>session.headerId==='cached-a'&&session.availability.state==='available'))unavailableRootGrantedSource=true;
    if (snapshot.discovery.state === 'scanning' && snapshot.discovery.inspected === 3 && !triggered) { triggered = true; mutation = rename(f.standard, f.standard + '-held'); }
  });
  try {
    value(await f.manager.reconcile()); await expect.poll(() => triggered, { timeout: 10000, interval: 1 }).toBe(true); await mutation;
    await expect.poll(async () => value(await f.manager.getSnapshot()).discovery.state, { timeout: 10000, interval: 5 }).toBe('completed');
    const records = value(await f.manager.listSessions({ classification: 'all' }));
    expect(records.map(record => record.headerId).sort()).toEqual(['cached-a', 'healthy-b']);
    expect(records.find(record => record.headerId === 'cached-a')).toMatchObject({ key: original.key, sourceFingerprint: original.sourceFingerprint, messageWatermark: original.messageWatermark });
    expect(unavailableRootGrantedSource).toBe(false);
  } finally { stop(); }
}, 15000);

test('a cached source restored during another root scan cannot be deleted using earlier absence evidence', async () => {
  const f = await fixture(); const cachedFile = await f.record(f.encoded, 'restored-a');
  const history = value(await f.manager.prepareStorageLocation({ requestId: 'history', path: f.encoded, enumeration: 'flat' }))!;
  await settled(f.manager, history.id); value(await f.manager.commitImport({ batchId: history.id })); await settled(f.manager, history.id); await reconcile(f.manager);
  const original = value(await f.manager.listSessions({ classification: 'archive' }))[0]; expect(original).toBeTruthy();
  const custom = value(await f.manager.prepareStorageLocation({ requestId: 'custom', path: f.custom, enumeration: 'flat' }))!;
  await settled(f.manager, custom.id); value(await f.manager.commitImport({ batchId: custom.id })); await settled(f.manager, custom.id); await reconcile(f.manager); value(await f.manager.cancelReconciliation());
  const held = join(f.root, 'held.jsonl'); await rename(cachedFile, held); await f.record(f.custom, 'healthy-b', true);
  let triggered = false; let restoration = Promise.resolve(); const snapshots: WorkspaceSnapshot[] = [];
  const stop = f.manager.subscribe(-1, snapshot => {
    snapshots.push(snapshot);
    if (snapshot.discovery.state === 'scanning' && snapshot.discovery.inspected === 1 && !triggered) { triggered = true; restoration = rename(held, cachedFile); }
  });
  try {
    value(await f.manager.reconcile()); await expect.poll(() => triggered, { timeout: 10000, interval: 1 }).toBe(true); await restoration;
    await expect.poll(async () => value(await f.manager.getSnapshot()).discovery.state, { timeout: 10000, interval: 5 }).toBe('completed');
    expect(snapshots.every(snapshot => snapshot.sessions.some(record => record.key === original.key && record.classification === 'archive'))).toBe(true);
    expect(value(await f.manager.listSessions({ classification: 'archive' })).map(record => record.key)).toEqual([original.key]);
  } finally { stop(); }
}, 15000);

test('a ready storage decision stays shielded across restart even when its physical alias changes header revision', async () => {
  const f = await fixture(); const file = await f.record(f.custom, 'restart-candidate'); await link(file, join(f.encoded, 'alias.jsonl'));
  const batch = value(await f.manager.prepareStorageLocation({ requestId: 'pending', path: f.custom, enumeration: 'flat' }))!; await settled(f.manager, batch.id); await f.manager.close();
  await writeFile(file, (await readFile(file, 'utf8')).replace('"id":"restart-candidate"', '"id":"replacement"'));
  const manager = value(await openSessionManagement(join(f.root, 'hub.sqlite'), { sessionsRoot: f.standard, reconciliationIntervalMs: 60000 })); managers.push(manager);
  await reconcile(manager); expect(value(await manager.getSnapshot()).sessions).toEqual([]);
  expect(value(await manager.getImport({ batchId: batch.id })).state).toBe('ready');
  value(await manager.commitImport({ batchId: batch.id })); expect((await settled(manager, batch.id)).error?.code).toBe('RECORD_CHANGED');
  await reconcile(manager); expect(value(await manager.listSessions({ classification: 'all' }))).toEqual([]);
});

test('a failed location identity enumeration does not withhold healthy-root additions', async () => {
  const f = await fixture(); const denied = join(f.custom, 'denied'); await mkdir(denied); await chmod(denied, 0);
  try {
    const batch = value(await f.manager.prepareStorageLocation({ requestId: 'unavailable', path: f.custom, enumeration: 'encoded' }))!;
    expect((await settled(f.manager, batch.id)).state).toBe('error');
    await f.record(f.encoded, 'healthy-after-failure'); await reconcile(f.manager);
    expect(value(await f.manager.listSessions({ classification: 'main' })).map(record => record.headerId)).toEqual(['healthy-after-failure']);
  } finally { await chmod(denied, 0o700); }
});
