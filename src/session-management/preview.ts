import { tracked, activeSourcePath } from './storage';
import { readProjects, owner } from './project-scope';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { open } from 'node:fs/promises';
import type { SessionEntry, FileEntry } from '@earendil-works/pi-coding-agent';
import { readIdentity, sourceFingerprint } from './history-reader';
import {
  completed,
  failed,
  type ManagedSession,
  type PreviewMessage,
  type PreviewRequest,
  type PreviewRuntime,
  type SessionPreview,
  type Result,
} from './interface';

const visibleText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n')
      : '';
const neutral = '无文本内容（图片、音频或附件）';
export function previews(db: Database.Database, onChanged: () => void) {
  const epoch = randomUUID();
  const revisions = new Map<string, number>();
  const getRevision = (key: string) => `${epoch}:${revisions.get(key) ?? 0}`;
  const jobs = new Map<
    string,
    { controller: AbortController; promise: Promise<Result<SessionPreview>> }
  >();
  const runtime = new Map<string, PreviewRuntime>();
  const row = (key: string): ManagedSession | undefined => {
    const found = db.prepare('SELECT data FROM sessions WHERE key=?').get(key) as
      { data: string } | undefined;
    return found ? JSON.parse(found.data) : undefined;
  };
  async function read(
    request: PreviewRequest,
    signal: AbortSignal,
  ): Promise<Result<SessionPreview>> {
    try {
      const session = row(request.key);
      if (!session || !tracked(db, session) || !owner(readProjects(db), session.cwd))
        return failed('RECORD_CHANGED', '会话已不在当前列表，请重新选择。');
      session.sourcePath = activeSourcePath(db, session);
      const previewRevision = getRevision(session.key);
      if (
        request.expectedPreviewRevision !== undefined &&
        request.expectedPreviewRevision !== previewRevision
      )
        return failed('RECORD_CHANGED', '活动分支已更新，请重试预览。');
      const observation = runtime.get(session.key);
      const active = observation?.connected ? observation : undefined;
      const identity = await readIdentity(session.sourcePath, signal);
      if (identity.identity !== session.identity)
        return failed('RECORD_CHANGED', '会话记录已变化，请重新扫描。');
      const file = await open(session.sourcePath, 'r');
      const entries: FileEntry[] = [];
      try {
        const before = await file.stat();
        let pending = '';
        signal.throwIfAborted();
        const stream = file.createReadStream({
          encoding: 'utf8',
          autoClose: false,
          start: 0,
          end: Math.max(0, before.size - 1),
          highWaterMark: 32768,
          signal,
        });
        for await (const chunk of stream) {
          signal.throwIfAborted();
          pending += chunk;
          let newline;
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (line.trim()) entries.push(JSON.parse(line));
          }
          if (pending.length > 16 * 1024 * 1024) throw Error('单条记录过大。');
        }
        if (sourceFingerprint(before) !== sourceFingerprint(await file.stat()))
          throw Error('读取期间记录发生变化，请重试。');
      } finally {
        await file.close();
      }
      signal.throwIfAborted();
      if ((await readIdentity(session.sourcePath, signal)).identity !== session.identity)
        throw Error('记录身份已变化。');
      // Public Pi 1.5.2 pure functions only. Migrations mutate this private parsed copy, never the source.
      const { migrateSessionEntries, buildSessionProjection } =
        await import('@earendil-works/pi-coding-agent');
      const header = entries[0];
      if (header?.type !== 'session' || (header.version ?? 1) > 3)
        throw Error('此会话格式尚不支持预览。');
      migrateSessionEntries(entries);
      const tree = entries.filter((e): e is SessionEntry => e.type !== 'session');
      const index = new Map<string, SessionEntry>();
      for (const entry of tree) {
        if (!entry || typeof entry.id !== 'string' || index.has(entry.id))
          throw Error('会话分支身份无效。');
        index.set(entry.id, entry);
      }
      // Pi _buildIndex restores the last non-header entry, including metadata; memory tree selections are not persisted.
      const leafId = active ? active.leafId : (tree.at(-1)?.id ?? null);
      if (leafId !== null && !index.has(leafId)) throw Error('当前活动分支尚未保存，请稍后重试。');
      const path: SessionEntry[] = [];
      const seen = new Set<string>();
      let cursor = leafId ? index.get(leafId) : undefined;
      while (cursor) {
        signal.throwIfAborted();
        if (seen.has(cursor.id)) throw Error('会话分支存在循环。');
        seen.add(cursor.id);
        path.push(cursor);
        if (cursor.parentId && !index.has(cursor.parentId)) throw Error('会话分支不完整。');
        cursor = cursor.parentId ? index.get(cursor.parentId) : undefined;
      }
      path.reverse();
      const first = path.find((e) => e.type === 'message' && e.message.role === 'user');
      const projection = buildSessionProjection(tree, leafId, index);
      const rounds: PreviewMessage[][] = [];
      for (const entry of projection.entries)
        for (const message of entry.messages) {
          if (message.role !== 'user' && message.role !== 'assistant') continue;
          const text = visibleText(message.content);
          // Thinking-only and tool-call-only assistant entries are not visible replies.
          const hasAttachment =
            Array.isArray(message.content) &&
            message.content.some((part) =>
              ['image', 'audio', 'video', 'file', 'attachment'].includes(part.type),
            );
          if (message.role === 'assistant' && !text.trim() && !hasAttachment) continue;
          if (message.role === 'user' || !rounds.length) rounds.push([]);
          rounds
            .at(-1)!
            .push({
              sourceId: entry.sourceEntry.id,
              role: message.role,
              text: text.trim() ? text : neutral,
              kind: 'recent',
            });
        }
      const messages = rounds.slice(-3).flat();
      if (first?.type === 'message' && first.message.role === 'user') {
        const originalText = visibleText(first.message.content);
        const text = originalText.trim() ? originalText : neutral;
        const match = messages.find((m) => m.sourceId === first.id && m.text === text);
        if (match) match.kind = 'original-and-recent';
        else messages.unshift({ sourceId: first.id, role: 'user', text, kind: 'original' });
      }
      signal.throwIfAborted();
      if (!tracked(db, session) || !owner(readProjects(db), session.cwd))
        return failed('SCOPE_CHANGED', '会话已不在当前项目范围。');
      if (getRevision(session.key) !== previewRevision)
        return failed('RECORD_CHANGED', '活动分支已更新，请重试预览。');
      return completed({
        previewRevision,
        key: request.key,
        requestId: request.requestId,
        leafId,
        generation: active?.generation ?? null,
        messages,
      });
    } catch (error) {
      return failed(
        'IMPORT_UNAVAILABLE',
        signal.aborted ? '预览已取消。' : '无法读取此会话的预览，请重新扫描或重试。',
        String(error),
      );
    }
  }
  function applyRuntime(requests: PreviewRuntime[]): Result<null> {
    const oldRuntime = new Map(runtime),
      oldRevisions = new Map(revisions);
    const restore = () => {
      runtime.clear();
      for (const [key, value] of oldRuntime) runtime.set(key, value);
      revisions.clear();
      for (const [key, value] of oldRevisions) revisions.set(key, value);
    };
    let changed = false;
    for (const request of requests) {
      const session = request && row(request.key);
      const previous = runtime.get(request?.key);
      if (
        !session ||
        session.identity !== request.identity ||
        !(typeof request.generation === 'number'
          ? Number.isSafeInteger(request.generation) &&
            request.generation >= 0 &&
            (!previous ||
              (typeof previous.generation === 'number' && request.generation > previous.generation))
          : typeof request.generation === 'string' &&
            !!request.runtimeIdentity &&
            Number.isSafeInteger(request.sequence) &&
            (!previous ||
              previous.runtimeIdentity !== request.runtimeIdentity ||
              previous.generation !== request.generation ||
              request.sequence! > previous.sequence!)) ||
        typeof request.connected !== 'boolean' ||
        (request.leafId !== null && typeof request.leafId !== 'string')
      ) {
        restore();
        return failed('RECORD_CHANGED', '活动分支身份或代次已失效。');
      }
      if (
        previous &&
        previous.identity === request.identity &&
        previous.generation === request.generation &&
        previous.runtimeIdentity === request.runtimeIdentity &&
        previous.connected === request.connected &&
        previous.leafId === request.leafId &&
        previous.state === request.state
      ) {
        runtime.set(request.key, { ...request });
        continue;
      }
      const revision = revisions.get(request.key) ?? 0;
      runtime.set(request.key, { ...request });
      revisions.set(request.key, revision + 1);
      changed = true;
    }
    try {
      if (changed) onChanged();
    } catch (error) {
      restore();
      return failed('DATABASE_UNAVAILABLE', '无法发布活动分支更新，请重试。', String(error));
    }
    return completed(null);
  }
  return {
    getRevision,
    getRuntimeCwd(key: string) {
      const r = runtime.get(key);
      return r?.connected ? r.runtimeCwd : undefined;
    },
    getRuntimeState(key: string) {
      const r = runtime.get(key);
      return r?.state ?? (r?.connected ? ('connected' as const) : ('unknown' as const));
    },
    getPreview(request: PreviewRequest): Promise<Result<SessionPreview>> {
      if (
        !request ||
        typeof request.key !== 'string' ||
        typeof request.requestId !== 'string' ||
        !request.requestId ||
        jobs.has(request.requestId)
      )
        return Promise.resolve(failed('INVALID_REQUEST', '无效的预览请求。'));
      const controller = new AbortController();
      const promise = read(request, controller.signal).finally(() =>
        jobs.delete(request.requestId),
      );
      jobs.set(request.requestId, { controller, promise });
      return promise;
    },
    async cancelPreview(request: { requestId: string }) {
      if (!request || typeof request.requestId !== 'string')
        return failed('INVALID_REQUEST', '无效的取消请求。');
      jobs.get(request.requestId)?.controller.abort();
      return completed(null);
    },
    applyRuntime,
    async updatePreviewRuntime(request: PreviewRuntime) {
      return applyRuntime([request]);
    },
    async close() {
      for (const job of jobs.values()) job.controller.abort();
      await Promise.allSettled([...jobs.values()].map((j) => j.promise));
      runtime.clear();
    },
  };
}
