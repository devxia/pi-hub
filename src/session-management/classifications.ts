import {
  validClassificationOutcomeRequest,
  validClassificationRequest,
} from './classification-request';
import type Database from 'better-sqlite3';
import { readIdentity, readRecord } from './history-reader';
import { activeSourcePath } from './storage';
import {
  completed,
  failed,
  type ClassificationRequest,
  type ClassificationReceipt,
  type ManagedSession,
  type Result,
} from './interface';

export function classifications(
  db: Database.Database,
  databaseFailure: (error: unknown) => Result<never>,
  commit: <T>(mutation: () => T) => T,
) {
  function outcome(requestId: string) {
    const row = db
      .prepare('SELECT request, outcome FROM classification_requests WHERE id=?')
      .get(requestId) as { request: string; outcome: string } | undefined;
    return row
      ? {
          request: JSON.parse(row.request) as ClassificationRequest,
          result: JSON.parse(row.outcome) as Result<ClassificationReceipt>,
        }
      : null;
  }
  return {
    async getClassificationOutcome(request: {
      requestId: string;
    }): Promise<Result<Result<ClassificationReceipt> | null>> {
      if (!validClassificationOutcomeRequest(request))
        return failed('INVALID_REQUEST', '无效的分类请求。');
      try {
        return completed(outcome(request.requestId)?.result ?? null);
      } catch (error) {
        return databaseFailure(error);
      }
    },
    async setSessionClassification(
      request: ClassificationRequest,
    ): Promise<Result<ClassificationReceipt>> {
      if (!validClassificationRequest(request))
        return failed('INVALID_REQUEST', '无效的会话分类请求。');
      const repeat = () => {
        const previous = outcome(request.requestId);
        if (!previous) return null;
        return previous.request.key === request.key &&
          previous.request.classification === request.classification &&
          previous.request.expectedRevision === request.expectedRevision
          ? previous.result
          : failed('INVALID_REQUEST', '请求身份已用于其他操作。');
      };
      try {
        const previous = repeat();
        if (previous) return previous;
        const row = db.prepare('SELECT data FROM sessions WHERE key=?').get(request.key) as
          { data: string } | undefined;
        const initial = row ? (JSON.parse(row.data) as ManagedSession) : undefined;
        // The finite read is the archive boundary, not a filesystem/SQLite transaction.
        // Unreadable sources use the last authoritative known dialogue watermark.
        let watermark = initial?.messageWatermark ?? [];
        if (initial && request.classification === 'archive') {
          try {
            const signal = new AbortController().signal;
            const identity = await readIdentity(activeSourcePath(db, initial), signal);
            if (identity.identity === initial.identity) {
              const record = await readRecord(identity, signal);
              watermark = [...new Set([...watermark, ...(record?.messageWatermark ?? [])])];
            }
          } catch {
            /* Classification remains safe when a source cannot be read. */
          }
        }
        return commit(() => {
          const previous = repeat();
          if (previous) return previous;
          const currentRow = db
            .prepare('SELECT data FROM sessions WHERE key=?')
            .get(request.key) as { data: string } | undefined;
          const current = currentRow ? (JSON.parse(currentRow.data) as ManagedSession) : undefined;
          let result: Result<ClassificationReceipt>;
          if (!current || (current.classificationRevision ?? 0) !== request.expectedRevision)
            result = failed('RECORD_CHANGED', '会话分类已变化，请核对当前分类后重试。');
          else {
            const revision = request.expectedRevision + 1;
            const updated: ManagedSession = {
              ...current,
              classification: request.classification,
              classificationRevision: revision,
              classificationChange: { revision, cause: 'manual' },
              archiveWatermark:
                request.classification === 'archive'
                  ? [...new Set([...watermark, ...current.messageWatermark])]
                  : null,
            };
            db.prepare('UPDATE sessions SET data=? WHERE key=?').run(
              JSON.stringify(updated),
              current.key,
            );
            db.prepare('UPDATE classification_state SET revision=revision+1').run();
            result = completed({
              key: current.key,
              classification: updated.classification,
              revision,
            });
          }
          db.prepare('INSERT INTO classification_requests(id,request,outcome) VALUES(?,?,?)').run(
            request.requestId,
            JSON.stringify(request),
            JSON.stringify(result),
          );
          return result;
        });
      } catch (error) {
        return databaseFailure(error);
      }
    },
  };
}
