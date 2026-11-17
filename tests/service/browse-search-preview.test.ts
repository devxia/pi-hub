import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { openSessionManagement } from '../../src/session-management/service';
import type { Result, SessionManagement, ImportBatch } from '../../src/session-management/interface';
const roots: string[] = [], managers: SessionManagement[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.close(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const value = <T>(r: Result<T>): T => { if (r.status === 'failed') throw Error(JSON.stringify(r.error)); return r.value; };
async function settle(m: SessionManagement, id: string) { let b!: ImportBatch; await expect.poll(async () => { b = value(await m.getImport({ batchId: id })); return b.state; }).not.toMatch(/scanning|validating/); return b; }
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'pi-hub-04-')); roots.push(root); const project = join(root, '中文项目'); const sessionsRoot = join(root, 'sessions'); const folder = join(sessionsRoot, '--fixture--'); await mkdir(project); await mkdir(folder, { recursive: true });
 const open = async () => { const m = value(await openSessionManagement(join(root, 'hub.sqlite'), { sessionsRoot, reconciliationIntervalMs: 60000 })); managers.push(m); return m; };
 const record = async (id: string, created: string, entries: unknown[]) => { const file = join(folder, `${id}.jsonl`); await writeFile(file, [{ type: 'session', version: 3, id, cwd: project, timestamp: created }, ...entries].map(e => JSON.stringify(e)).join('\n') + '\n'); return file; };
 const m = await open();
 const imported = async (selected: string[]) => { const b = await settle(m, value(await m.prepareImport({ requestId: 'import', path: project }))!.id); value(await m.selectImport({ batchId: b.id, selectedKeys: b.candidates.filter(c => selected.includes(c.headerId)).map(c => c.key) })); value(await m.commitImport({ batchId: b.id })); expect((await settle(m, b.id)).state).toBe('completed'); };
 return { root, project, folder, m, open, record, imported };
}
const msg = (id: string, parentId: string | null, role: string, content: unknown, timestamp = 1767225600000) => ({ type: 'message', id, parentId, timestamp: new Date(timestamp).toISOString(), message: { role, content, timestamp } });
test('explicit scopes search names, automatic titles, project and paths, never body; stable sorts use header creation', async () => {
 const f = await fixture();
 const file = await f.record('a', '2020-01-01T00:00:00Z', [msg('u', null, 'user', '自动标题'), msg('a', 'u', 'assistant', '正文秘密'), { type: 'session_info', id: 'n', parentId: 'a', name: '重名' }]);
 await f.record('b', '2024-01-01T00:00:00Z', [msg('u', null, 'user', '另一个标题', 1767225700000), { type: 'session_info', id: 'n', parentId: 'u', name: '重名' }]);
 await f.record('c', '2022-01-01T00:00:00Z', [msg('u', null, 'user', '归档标题')]); await f.imported(['a', 'b']);
 const query = async (request: Parameters<SessionManagement['listSessions']>[0]) => value(await f.m.listSessions(request));
 expect((await query({ classification: 'all' })).map(s => s.headerId).sort()).toEqual(['a', 'b', 'c']);
 expect((await query({ classification: 'main' })).map(s => s.headerId)).toEqual(['b', 'a']);
 expect((await query({ classification: 'main', search: '正文秘密' }))).toEqual([]);
 expect((await query({ classification: 'main', search: '自动标题' })).map(s => s.headerId)).toEqual(['a']);
 expect(await query({ classification: 'main', search: '中文项目' })).toHaveLength(2);
 expect((await query({ classification: 'all', search: 'c.jsonl' })).map(s => s.headerId)).toEqual(['c']);
 expect((await query({ classification: 'main', sort: 'created' })).map(s => s.headerId)).toEqual(['b', 'a']);
 const names = await query({ classification: 'main', sort: 'name' }); expect(names.map(s => s.key)).toEqual([...names.map(s => s.key)].sort());
 await appendFile(file, JSON.stringify({ type: 'session_info', id: 'n2', parentId: 'n', name: '改名' }) + '\n'); await utimes(file, new Date(), new Date()); value(await f.m.reconcile()); await expect.poll(async () => value(await f.m.getSnapshot()).discovery.state).not.toBe('scanning');
 expect((await query({ classification: 'main' })).map(s => s.headerId)).toEqual(['b', 'a']); await expect.poll(async () => (await query({ classification: 'main', search: '改名' }))[0]?.createdAt).toBe('2020-01-01T00:00:00.000Z');
});
test('preview follows Pi restored branch, effective compaction and edits, preserves original anchor, hides tools/thinking and never writes', async () => {
 const f = await fixture(); const file = await f.record('preview', '2020-01-01T00:00:00Z', [
 msg('u1', null, 'user', '原始问题'), msg('a1', 'u1', 'assistant', '旧回答'), msg('u2', 'a1', 'user', '第二轮'), msg('a2', 'u2', 'assistant', [{ type: 'thinking', thinking: '隐藏思考' }, { type: 'text', text: '保留回答' }]),
 msg('alternative', 'u1', 'assistant', '另一分支'),
 { type: 'compaction', id: 'c', parentId: 'a2', summary: '模型摘要', firstKeptEntryId: 'u2', tokensBefore: 100, timestamp: '2026-01-01T00:00:00Z' },
 { type: 'context_edit', id: 'e', parentId: 'c', targetId: 'u2', replacement: { content: '修改后的第二轮' } },
 msg('u3', 'e', 'user', [{ type: 'image', data: 'secret', mimeType: 'image/png' }]), msg('tool', 'u3', 'toolResult', '工具秘密'), msg('a3', 'tool', 'assistant', '最近回答'),
 { type: 'context_edit', id: 'remove', parentId: 'a3', targetId: 'a2', replacement: null },
 ]); await f.imported(['preview']); const row = value(await f.m.listSessions({ classification: 'main' }))[0];
 const before = createHash('sha256').update(await readFile(file)).digest('hex');
 const preview = value(await f.m.getPreview({ key: row.key, requestId: 'preview-1' }));
 expect(preview.messages.map(m => m.text)).toEqual(['原始问题', '修改后的第二轮', '无文本内容（图片、音频或附件）', '最近回答']);
 expect(preview.messages[0].kind).toBe('original'); expect(preview.leafId).toBe('remove');
 value(await f.m.updatePreviewRuntime({ key: row.key, identity: row.identity, generation: 1, connected: true, leafId: 'alternative' }));
 expect(value(await f.m.getPreview({ key: row.key, requestId: 'preview-2' })).messages.map(m => m.text)).toEqual(['原始问题', '另一分支']);
 expect(await f.m.updatePreviewRuntime({ key: row.key, identity: row.identity, generation: 0, connected: true, leafId: 'a2' })).toMatchObject({ status: 'failed' });
 value(await f.m.updatePreviewRuntime({ key: row.key, identity: row.identity, generation: 2, connected: false, leafId: null }));
 expect(value(await f.m.getPreview({ key: row.key, requestId: 'preview-3' })).leafId).toBe('remove');
 expect(createHash('sha256').update(await readFile(file)).digest('hex')).toBe(before);
}, 15000); // Real Pi SDK cold-load plus projection I/O can exceed 5s under full-suite contention.
test('v3 cache migration reprojects unchanged source metadata without losing archive classification', async () => {
 const f = await fixture(); const file = await f.record('legacy', '2001-02-03T04:05:06Z', [msg('u', null, 'user', '原始标题'), { type: 'session_info', id: 'n', parentId: 'u', name: '别名' }]); await f.imported([]);
 value(await f.m.reconcile()); await expect.poll(async () => value(await f.m.getSnapshot()).discovery.state).not.toBe('scanning'); const archived = value(await f.m.listSessions({ classification: 'archive' }))[0]; await f.m.close();
 const db = new Database(join(f.root, 'hub.sqlite')); db.exec("DROP TABLE IF EXISTS sdk_hosts; DROP TABLE IF EXISTS native_clone_requests; DROP TABLE delete_requests; DROP TABLE rename_requests; DROP TABLE IF EXISTS directory_recoveries; DROP TABLE terminal_requests; DROP TABLE terminal_settings; DROP TABLE IF EXISTS recovery_requests; DROP TABLE IF EXISTS clone_requests; DROP TABLE IF EXISTS runtime_leases; DROP TABLE IF EXISTS launch_reservations; DROP TABLE classification_requests; DROP TABLE classification_state; DROP TABLE storage_locations; ALTER TABLE projects DROP COLUMN include_descendants; ALTER TABLE projects DROP COLUMN enabled; UPDATE sessions SET data=json_remove(data,'$.sources','$.createdAt','$.automaticTitle','$.name','$.projectionVersion'); PRAGMA user_version=3;"); db.close();
 const bytes = await readFile(file); const restarted = await f.open();
 await expect.poll(async () => value(await restarted.listSessions({ classification: 'archive' }))[0]?.createdAt).toBe('2001-02-03T04:05:06.000Z');
 expect(value(await restarted.listSessions({ classification: 'archive', search: '原始标题' }))[0]).toMatchObject({ key: archived.key, archiveWatermark: archived.archiveWatermark, title: '别名' }); expect(await readFile(file)).toEqual(bytes);
});
test('latest three rounds deduplicate unchanged first user but distinguish edited original; cancellation and bad trees fail safely', async () => {
 const f = await fixture(); const file = await f.record('rounds', '2020-01-01T00:00:00Z', [msg('u1', null, 'user', 'original'), msg('a1', 'u1', 'assistant', 'one'), { type: 'context_edit', id: 'e', parentId: 'a1', targetId: 'u1', replacement: { content: 'edited' } }]); await f.imported(['rounds']); const row = value(await f.m.listSessions({ classification: 'main' }))[0];
 expect(value(await f.m.getPreview({ key: row.key, requestId: 'edited' })).messages.map(m => [m.text, m.kind])).toEqual([['original', 'original'], ['edited', 'recent'], ['one', 'recent']]);
 await appendFile(file, [msg('u2', 'e', 'user', 'two'), msg('u3', 'u2', 'user', 'three'), msg('u4', 'u3', 'user', 'four'), msg('a4', 'u4', 'assistant', 'last')].map(e => JSON.stringify(e)).join('\n') + '\n');
 expect(value(await f.m.getPreview({ key: row.key, requestId: 'rounds' })).messages.map(m => m.text)).toEqual(['original', 'two', 'three', 'four', 'last']);
 const pending = f.m.getPreview({ key: row.key, requestId: 'cancel' }); value(await f.m.cancelPreview({ requestId: 'cancel' })); expect(await pending).toMatchObject({ status: 'failed', error: { message: '预览已取消。' } });
 expect(await f.m.getPreview({ key: 'missing', requestId: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'RECORD_CHANGED' } });
 await appendFile(file, JSON.stringify({ type: 'custom', id: 'cycle', parentId: 'cycle' }) + '\n'); expect(await f.m.getPreview({ key: row.key, requestId: 'cycle' })).toMatchObject({ status: 'failed' });
});
test('legacy format migrates only private parsed copy and leaves source bytes unchanged', async () => {
 const f = await fixture(); const file = await f.record('v1', '2020-01-01T00:00:00Z', [msg('u', null, 'user', 'old question'), msg('a', 'u', 'assistant', 'old answer')]); let source = (await readFile(file, 'utf8')).replace('"version":3', '"version":1'); await writeFile(file, source); await f.imported(['v1']); const row = value(await f.m.listSessions({ classification: 'main' }))[0];
 expect(value(await f.m.getPreview({ key: row.key, requestId: 'v1' })).messages.map(m => m.text)).toEqual(['old question', 'old answer']); expect(await readFile(file, 'utf8')).toBe(source);
});
test('assistant multimodal attachments use neutral text while thinking and tool-call-only messages stay hidden', async () => {
 const f = await fixture(); await f.record('media', '2020-01-01T00:00:00Z', [msg('u', null, 'user', 'show image'), msg('a1', 'u', 'assistant', [{ type: 'thinking', thinking: 'private' }]), msg('a2', 'a1', 'assistant', [{ type: 'toolCall', id: 't', name: 'bash', arguments: {} }]), msg('a3', 'a2', 'assistant', [{ type: 'image', data: 'secret', mimeType: 'image/png' }])]); await f.imported(['media']); const row = value(await f.m.listSessions({ classification: 'main' }))[0];
 expect(value(await f.m.getPreview({ key: row.key, requestId: 'media' })).messages.map(m => [m.role, m.text])).toEqual([['user', 'show image'], ['assistant', '无文本内容（图片、音频或附件）']]);
});
test('accepted runtime updates publish per-session preview invalidation and reject obsolete requests without touching source', async () => {
 const f = await fixture(); const file = await f.record('live-preview', '2020-01-01T00:00:00Z', [msg('u', null, 'user', 'question'), msg('a', 'u', 'assistant', 'branch A'), msg('b', 'u', 'assistant', 'branch B')]); await f.record('other', '2020-01-01T00:00:00Z', [msg('u', null, 'user', 'other')]); await f.imported(['live-preview', 'other']);
 value(await f.m.reconcile()); await expect.poll(async () => value(await f.m.getSnapshot()).discovery.state).not.toBe('scanning');
 const initial = value(await f.m.getSnapshot()); const session = initial.sessions.find(s => s.headerId === 'live-preview')!; const other = initial.sessions.find(s => s.headerId === 'other')!;
 const bytes = await readFile(file); const updates: import('../../src/session-management/interface').WorkspaceSnapshot[] = []; const stop = f.m.subscribe(initial.revision, snapshot => updates.push(snapshot));
 const displayed = value(await f.m.getPreview({ key: session.key, requestId: 'offline' })); expect(displayed.messages.at(-1)?.text).toBe('branch B');
 value(await f.m.updatePreviewRuntime({ key: session.key, identity: session.identity, connected: true, leafId: 'a', generation: 1 }));
 expect(updates.length).toBeGreaterThan(0); const changed = updates.at(-1)!; const current = changed.sessions.find(s => s.key === session.key)!;
 expect(current.previewRevision).not.toBe(session.previewRevision); expect(changed.sessions.find(s => s.key === other.key)?.previewRevision).toBe(other.previewRevision);
 expect(await f.m.getPreview({ key: session.key, requestId: 'obsolete', expectedPreviewRevision: session.previewRevision })).toMatchObject({ status: 'failed', error: { code: 'RECORD_CHANGED' } });
 const active = value(await f.m.getPreview({ key: session.key, requestId: 'active', expectedPreviewRevision: current.previewRevision })); expect(active).toMatchObject({ previewRevision: current.previewRevision, generation: 1 }); expect(active.messages.at(-1)?.text).toBe('branch A');
 const inFlight = f.m.getPreview({ key: session.key, requestId: 'in-flight', expectedPreviewRevision: current.previewRevision });
 value(await f.m.updatePreviewRuntime({ key: session.key, identity: session.identity, connected: false, leafId: null, generation: 2 }));
 expect(await inFlight).toMatchObject({ status: 'failed', error: { code: 'RECORD_CHANGED' } });
 const disconnected = value(await f.m.getSnapshot()).sessions.find(s => s.key === session.key)!; expect(disconnected.previewRevision).not.toBe(current.previewRevision);
 const restored = value(await f.m.getPreview({ key: session.key, requestId: 'disconnected', expectedPreviewRevision: disconnected.previewRevision })); expect(restored.generation).toBeNull(); expect(restored.messages.at(-1)?.text).toBe('branch B');
 const revision = value(await f.m.getSnapshot()).revision;
 expect(await f.m.updatePreviewRuntime({ key: session.key, identity: session.identity, connected: true, leafId: 'a', generation: 1 })).toMatchObject({ status: 'failed' }); expect(value(await f.m.getSnapshot()).revision).toBe(revision);
 stop(); await f.m.close(); const restarted = await f.open(); const fresh = value(await restarted.getSnapshot()).sessions.find(s => s.key === session.key)!; expect(fresh.previewRevision).not.toBe(disconnected.previewRevision); expect(value(await restarted.getPreview({ key: session.key, requestId: 'restart' })).messages.at(-1)?.text).toBe('branch B'); expect(await readFile(file)).toEqual(bytes);
});
