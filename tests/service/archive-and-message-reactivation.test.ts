import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, rename, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openSessionManagement } from '../../src/session-management/service';
import type { Result, SessionManagement, ImportBatch, ManagedSession } from '../../src/session-management/interface';
const roots: string[] = []; const managers: SessionManagement[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.close(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
function value<T>(r: Result<T>): T { if (r.status === 'failed') throw Error(JSON.stringify(r.error)); return r.value; }
async function settled(m: SessionManagement, id: string) { let b!: ImportBatch; await expect.poll(async () => { b = value(await m.getImport({ batchId: id })); return b.state; }, { timeout: 10000, interval: 5 }).not.toMatch(/scanning|validating/); return b; }
async function scan(m: SessionManagement) { value(await m.reconcile()); await expect.poll(async () => value(await m.getSnapshot()).discovery.state, { timeout: 10000, interval: 5 }).toMatch(/completed|error/); }
const all = async (m: SessionManagement) => value(await m.listSessions({ classification: 'all' }));
const message = (id: string, role = 'user', content: unknown = 'Dialogue ' + id, timestamp = 1767225600000) => ({ type: 'message', id, parentId: null, message: { role, content, timestamp } });
const lines = (...entries: unknown[]) => entries.map(e => JSON.stringify(e)).join('\n') + '\n';
async function fixture(selected = true) {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-07-')); roots.push(root);
  const project = join(root, '项目'); const standard = join(root, 'sessions'); const encoded = join(standard, 'encoded');
  await mkdir(project); await mkdir(encoded, { recursive: true });
  const file = join(encoded, 'session.jsonl'); const header = { type: 'session', version: 3, id: 'session', cwd: project };
  await writeFile(file, lines(header, message('old')));
  const open = async () => { const m = value(await openSessionManagement(join(root, 'hub.sqlite'), { sessionsRoot: standard, reconciliationIntervalMs: 60000 })); managers.push(m); return m; };
  const manager = await open();
  const batch = await settled(manager, value(await manager.prepareImport({ requestId: 'history', path: project }))!.id);
  if (selected) value(await manager.selectImport({ batchId: batch.id, selectedKeys: batch.candidates.map(c => c.key) }));
  value(await manager.commitImport({ batchId: batch.id })); expect((await settled(manager, batch.id)).state).toBe('completed'); await scan(manager); value(await manager.cancelReconciliation());
  return { root, project, standard, encoded, file, header, manager, open };
}
const change = (m: SessionManagement, s: ManagedSession, classification: 'main' | 'archive', requestId: string = crypto.randomUUID()) => m.setSessionClassification({ requestId, key: s.key, classification, expectedRevision: s.classificationRevision ?? 0 });

test('manual archive/restore is persistent, source-preserving, idempotent and rejects stale revisions', async () => {
  const f = await fixture(); const original = (await all(f.manager))[0]; const bytes = await readFile(f.file);
  const request = { requestId: 'archive', key: original.key, classification: 'archive' as const, expectedRevision: original.classificationRevision ?? 0 };
  const receipt = value(await f.manager.setSessionClassification(request));
  expect(receipt).toMatchObject({ key: original.key, classification: 'archive', revision: 1 });
  expect(value(await f.manager.getSnapshot()).sessions[0]).toMatchObject({ classification: 'archive', runtimeState: 'unknown' });
  const archived = (await all(f.manager))[0]; expect(archived.archiveWatermark).toEqual(archived.messageWatermark);
  value(await change(f.manager, archived, 'main', 'restore'));
  expect(await f.manager.setSessionClassification(request)).toEqual({ status: 'completed', value: receipt });
  expect((await all(f.manager))[0].classification).toBe('main');
  expect(await change(f.manager, original, 'archive', 'stale')).toMatchObject({ status: 'failed', error: { code: 'RECORD_CHANGED' } });
  await f.manager.close(); const restarted = await f.open();
  expect(value(await restarted.getClassificationOutcome({ requestId: 'archive' }))).toEqual({ status: 'completed', value: receipt });
  expect((await all(restarted))[0]).toMatchObject({ classification: 'main', classificationRevision: 2 });
  expect(await readFile(f.file)).toEqual(bytes);
});

test.each(['user', 'assistant'])('imported archive ignores metadata/noise/old rewritten messages; actual new %s dialogue restores once', async role => {
  const f = await fixture(false); const old = (await all(f.manager))[0];
  await appendFile(f.file, lines({ type: 'session_info', name: 'Metadata rename' }, message('tool', 'toolResult'), message('system', 'system'), message('thinking', 'assistant', [{ type: 'thinking', thinking: 'private' }]), message('tool-call', 'assistant', [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }])));
  await scan(f.manager); expect((await all(f.manager))[0]).toMatchObject({ classification: 'archive', archiveWatermark: old.archiveWatermark });
  // Formatting, provider metadata, parent references and noise changes are not new dialogue.
  const rewritten = { ...message('old'), parentId: 'different-parent', extra: 'metadata' };
  await writeFile(f.file, JSON.stringify(f.header, null, 0) + '\n' + JSON.stringify(rewritten, null, 0) + '\n');
  await scan(f.manager); expect((await all(f.manager))[0].classification).toBe('archive');
  await writeFile(f.file, lines(f.header)); await scan(f.manager); expect(await all(f.manager)).toEqual([]);
  await writeFile(f.file, lines(f.header, rewritten)); await scan(f.manager); expect((await all(f.manager))[0].classification).toBe('archive');
  // Rewrite to fewer bytes and the same entry count: content/entry/time, not size/count, decide.
  await writeFile(f.file, lines(f.header, message('new', role, 'New', 1767312000000)));
  await scan(f.manager); const restored = (await all(f.manager))[0];
  expect(restored).toMatchObject({ classification: 'main', classificationRevision: 1 });
  await scan(f.manager); expect((await all(f.manager))[0].classificationRevision).toBe(1);
  await f.manager.close(); const reopened = await f.open(); expect((await all(reopened))[0].classification).toBe('main');
});

test('archive captures messages already on disk before scanning; later messages win after the archive boundary', async () => {
  const f = await fixture(); const original = (await all(f.manager))[0];
  value(await f.manager.cancelReconciliation());
  await appendFile(f.file, lines(message('before', 'assistant', 'Already saved before archive')));
  value(await change(f.manager, original, 'archive'));
  await scan(f.manager); expect((await all(f.manager))[0].classification).toBe('archive');
  expect((await all(f.manager))[0].archiveWatermark).toHaveLength(2);
  await appendFile(f.file, lines(message('after', 'user', 'Saved after archive')));
  await scan(f.manager); expect((await all(f.manager))[0]).toMatchObject({ classification: 'main', classificationRevision: 2 });
});

test('a SQLite failure rolls back classification, receipt and notifications; restart verifies actual state', async () => {
  const f = await fixture(); const original = (await all(f.manager))[0];
  const fault = new Database(join(f.root, 'hub.sqlite'));
  fault.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON classification_requests BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
  const states: string[] = []; const stop = f.manager.subscribe(-1, s => states.push(s.sessions[0].classification));
  try {
    expect(await change(f.manager, original, 'archive', 'rollback')).toMatchObject({ status: 'failed', error: { code: 'DATABASE_UNAVAILABLE' } });
    expect((await all(f.manager))[0].classification).toBe('main');
    expect(value(await f.manager.getSnapshot()).sessions[0].classification).toBe('main');
    expect(value(await f.manager.getClassificationOutcome({ requestId: 'rollback' }))).toBeNull();
    expect(states.every(state => state === 'main')).toBe(true);
    fault.exec('DROP TRIGGER reject_receipt');
    value(await change(f.manager, original, 'archive', 'rollback'));
    await f.manager.close(); const reopened = await f.open();
    expect((await all(reopened))[0]).toMatchObject({ classification: 'archive', classificationRevision: 1 });
    expect(value(await reopened.getClassificationOutcome({ requestId: 'rollback' }))).toMatchObject({ status: 'completed', value: { classification: 'archive' } });
  } finally { stop(); fault.close(); }
});

test('an older scan cannot overwrite archive or its authoritative watermark while reading another large record', async () => {
  const f = await fixture(); const original = (await all(f.manager))[0];
  const large = join(f.encoded, 'large.jsonl');
  await writeFile(large, lines({ ...f.header, id: 'large' }, message('large'), { type: 'custom', padding: 'x'.repeat(4 * 1024 * 1024) }));
  let pending: Promise<unknown> | undefined;
  const stop = f.manager.subscribe(-1, snapshot => {
    if (snapshot.discovery.state === 'scanning' && snapshot.discovery.inspected === 1 && !pending) pending = change(f.manager, original, 'archive', 'racing').then(value);
  });
  try {
    await scan(f.manager); await pending; expect(pending).toBeDefined();
    await scan(f.manager); expect((await all(f.manager)).find(s => s.key === original.key)).toMatchObject({ classification: 'archive', classificationRevision: 1, archiveWatermark: original.messageWatermark });
    const bytes = await readFile(f.file);
    await f.manager.close(); const reopened = await f.open(); await scan(reopened);
    expect((await all(reopened)).find(s => s.key === original.key)?.classification).toBe('archive'); expect(await readFile(f.file)).toEqual(bytes);
  } finally { stop(); }
}, 15000);

test('same entry replay stays archived; changed content, timestamp or entry identity each count as new dialogue', async () => {
  const f = await fixture(false);
  for (const entry of [message('old', 'user', 'Changed content'), message('old', 'user', 'Changed content', 1767312000000), message('different', 'user', 'Changed content', 1767312000000)]) {
    await writeFile(f.file, lines(f.header, entry)); await scan(f.manager);
    expect((await all(f.manager))[0].classification).toBe('main');
    value(await change(f.manager, (await all(f.manager))[0], 'archive'));
    await writeFile(f.file, lines(f.header, entry)); await scan(f.manager);
    expect((await all(f.manager))[0].classification).toBe('archive');
  }
});

test.each(['hardlink', 'symlink'])('classification is safe with an unavailable root and %s aliases; same-ID conflicts remain separate', async alias => {
  const f = await fixture(); const key = (await all(f.manager))[0].key; const custom = join(f.root, 'flat'); await mkdir(custom);
  await (alias === 'hardlink' ? link(f.file, join(custom, 'alias.jsonl')) : symlink(f.file, join(custom, 'alias.jsonl')));
  await writeFile(join(custom, 'conflict.jsonl'), lines(f.header, message('other')));
  const batch = await settled(f.manager, value(await f.manager.prepareStorageLocation({ requestId: 'custom', path: custom, enumeration: 'flat' }))!.id);
  value(await f.manager.commitImport({ batchId: batch.id })); await settled(f.manager, batch.id); await scan(f.manager);
  const original = (await all(f.manager)).find(s => s.key === key)!;
  expect(original.identityConflict).toBe(true);
  await rename(f.standard, f.standard + '-held'); await scan(f.manager);
  value(await change(f.manager, original, 'archive')); await scan(f.manager);
  expect((await all(f.manager))).toHaveLength(2);
  expect((await all(f.manager)).find(s => s.key === original.key)?.classification).toBe('archive');
  value(await change(f.manager, (await all(f.manager)).find(s => s.key === original.key)!, 'main'));
  expect((await all(f.manager)).find(s => s.key === original.key)?.classification).toBe('main');
});

test.each(['user', 'assistant', 'unchanged', 'metadata', 'ambiguous-rewrite'])('schema06 migration maps raw archived dialogue before first reread: %s', async kind => {
  const f = await fixture(false); const original = (await all(f.manager))[0]; const before = await readFile(f.file, 'utf8'); await f.manager.close();
  const { createHash } = await import('node:crypto');
  const legacy = createHash('sha256').update(before.trim().split('\n')[1]).digest('hex');
  const db = new Database(join(f.root, 'hub.sqlite'));
  db.exec('DROP TABLE IF EXISTS sdk_hosts; DROP TABLE IF EXISTS native_clone_requests; DROP TABLE delete_requests; DROP TABLE rename_requests; DROP TABLE IF EXISTS directory_recoveries; DROP TABLE terminal_requests; DROP TABLE terminal_settings; DROP TABLE IF EXISTS recovery_requests; DROP TABLE IF EXISTS clone_requests; DROP TABLE IF EXISTS runtime_leases; DROP TABLE IF EXISTS launch_reservations; DROP TABLE classification_requests; DROP TABLE classification_state; PRAGMA user_version=6');
  db.prepare('UPDATE sessions SET data=? WHERE key=?').run(JSON.stringify({ ...original, projectionVersion: 4, messageWatermark: [legacy], archiveWatermark: [legacy] }), original.key); db.close();
  if (kind === 'user' || kind === 'assistant') await appendFile(f.file, lines(message('offline-new', kind, 'Saved offline before upgrade')));
  if (kind === 'metadata') await appendFile(f.file, lines({ type: 'session_info', name: 'Metadata only' }));
  if (kind === 'ambiguous-rewrite') await writeFile(f.file, lines(f.header, { ...message('old'), providerMetadata: 'changed' }));
  const bytes = await readFile(f.file); const reopened = await f.open(); await scan(reopened);
  const record = (await all(reopened))[0];
  expect(record.classification).toBe(kind === 'user' || kind === 'assistant' ? 'main' : 'archive');
  if (kind === 'ambiguous-rewrite') expect(record.archiveBaselineUncertain).toBe(true);
  expect(await readFile(f.file)).toEqual(bytes);
});

test('failed message reactivation keeps archive and its watermark across restart until a later successful transaction', async () => {
  const f = await fixture(false); const original = (await all(f.manager))[0];
  const fault = new Database(join(f.root, 'hub.sqlite'));
  fault.exec("CREATE TRIGGER reject_reactivation BEFORE INSERT ON sessions WHEN json_extract(NEW.data,'$.classification')='main' BEGIN SELECT RAISE(ABORT,'reactivation rollback'); END");
  try {
    await appendFile(f.file, lines(message('actual-new', 'assistant', 'Saved dialogue'))); const bytes = await readFile(f.file);
    await scan(f.manager); expect((await all(f.manager))[0]).toMatchObject({ classification: 'archive', archiveWatermark: original.archiveWatermark });
    expect(value(await f.manager.getSnapshot()).sessions[0].classification).toBe('archive');
    await f.manager.close(); const reopened = await f.open(); expect((await all(reopened))[0].classification).toBe('archive');
    fault.exec('DROP TRIGGER reject_reactivation'); await scan(reopened);
    expect((await all(reopened))[0]).toMatchObject({ classification: 'main', classificationRevision: 1 }); expect(await readFile(f.file)).toEqual(bytes);
  } finally { fault.close(); }
});

test('classification snapshots preserve the actual manual or message cause through metadata scans and restart', async () => {
  const f = await fixture(); const original = (await all(f.manager))[0];
  value(await change(f.manager, original, 'archive'));
  expect((await all(f.manager))[0].classificationChange).toEqual({ revision: 1, cause: 'manual' });
  await appendFile(f.file, lines({ type: 'session_info', name: 'Metadata only' })); await scan(f.manager);
  expect((await all(f.manager))[0].classificationChange).toEqual({ revision: 1, cause: 'manual' });
  await appendFile(f.file, lines(message('new-cause', 'assistant', 'Actual reply'))); await scan(f.manager);
  expect(value(await f.manager.getSnapshot()).sessions[0]).toMatchObject({ classification: 'main', classificationChange: { revision: 2, cause: 'message' } });
  await f.manager.close(); const reopened = await f.open(); await scan(reopened);
  expect((await all(reopened))[0].classificationChange).toEqual({ revision: 2, cause: 'message' });
  value(await change(reopened, (await all(reopened))[0], 'archive'));
  expect((await all(reopened))[0].classificationChange).toEqual({ revision: 3, cause: 'manual' });
});

test('classification commands reject malformed fields without changing the managed record', async () => {
  const f = await fixture(); const original = (await all(f.manager))[0];
  const valid = { requestId: 'invalid-fields', key: original.key, classification: 'archive' as const, expectedRevision: 0 };
  for (const patch of [{ requestId: '' }, { key: '../source.jsonl' }, { classification: 'deleted' }, { expectedRevision: -1 }, { expectedRevision: 0.5 }]) {
    expect(await f.manager.setSessionClassification({ ...valid, ...patch } as typeof valid)).toMatchObject({ status: 'failed', error: { code: 'INVALID_REQUEST' } });
  }
  expect((await all(f.manager))[0]).toEqual(original);
});
