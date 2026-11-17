import { deleteOutcomeMessage } from './delete-outcome';
import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type {
  DeletePreparation,
  DeleteRequest,
  DeleteOutcome,
} from '../session-management/interface';
export function DeleteDialog({
  sourceKey,
  title,
  onClose,
  onDeleted,
}: {
  sourceKey: string;
  title: string;
  onClose: () => void;
  onDeleted: (outcome: DeleteOutcome) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    started = useRef(false);
  const [prepared, setPrepared] = useState<DeletePreparation | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [working, setWorking] = useState(false),
    [request, setRequest] = useState<DeleteRequest | null>(null),
    [uncertain, setUncertain] = useState(false),
    [finished, setFinished] = useState<DeleteOutcome | null>(null),
    [rejected, setRejected] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    if (started.current) return;
    started.current = true;
    void window.sessionManagement
      .prepareDelete({ key: sourceKey })
      .then((r) => {
        if (r.status === 'failed') setError(r.error.message);
        else {
          setPrepared(r.value);
          if (r.value.pending) {
            setRequest(r.value.request!);
            setUncertain(true);
            setError(r.value.pending.error ?? '删除结果尚待核对。');
          }
        }
      })
      .catch(() => setError('无法读取删除条件，请关闭后重试。'))
      .finally(() => setLoading(false));
  }, [sourceKey]);
  async function refresh(outcome: DeleteOutcome) {
    try {
      await onDeleted(outcome);
      onClose();
    } catch {
      setError('原始记录已删除，但列表与预览刷新失败。请重试刷新。');
    }
  }
  async function submit() {
    if (working || loading || !prepared || rejected) return;
    setWorking(true);
    setError('');
    try {
      if (finished) {
        await refresh(finished);
        return;
      }
      const intent = request ?? {
        requestId: crypto.randomUUID(),
        key: sourceKey,
        identity: prepared.identity,
        expectedRevision: prepared.expectedRevision,
        confirmed: true as const,
      };
      setRequest(intent);
      const r = uncertain
        ? await window.sessionManagement.getDeleteOutcome({ requestId: intent.requestId })
        : await window.sessionManagement.deleteSession(intent);
      if (r.status === 'failed') {
        if (
          ['BACKGROUND_UNAVAILABLE', 'DATABASE_UNAVAILABLE', 'DATABASE_BUSY'].includes(r.error.code)
        ) {
          setUncertain(true);
          setError('删除结果尚未确认，请核对原请求。');
        } else {
          setRejected(true);
          setError(r.error.message);
        }
      } else if (r.value?.state === 'completed') {
        setFinished(r.value);
        setUncertain(false);
        await refresh(r.value);
      } else if (r.value?.state === 'rejected') {
        setRejected(true);
        setUncertain(false);
        setError(r.value.error ?? '删除失败，条目与分类已保留。');
      } else if (!r.value) {
        setRequest(null);
        setUncertain(false);
        setError('已核对，本次未提交。可以手动确认删除。');
      } else {
        setUncertain(true);
        setError(r.value.error ?? '删除结果尚待核对，请勿再次删除。');
      }
    } catch {
      setUncertain(true);
      setError('尚未收到可靠回执，请核对同一请求。');
    } finally {
      setWorking(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog clone-dialog"
      aria-labelledby="delete-title"
      onKeyDown={(e) => e.stopPropagation()}
      onCancel={(e) => {
        e.preventDefault();
        if (!working) onClose();
      }}
    >
  <header>
        <h2 id="delete-title">删除原始会话</h2>
        <p>{title}</p>
      </header>
  <div className="import-body">
        {!finished && (
          <>
            <p>这会删除原始 Pi 会话文件，并清除管理器中的条目和分类。</p>
            <p>
              <strong>先移入废纸篓；如果失败且同一文件仍在，将自动永久删除，无法撤销。</strong>
            </p>
            <p className="muted">此操作直接删除原生Pi记录。请自行确认不再需要，并退出正在使用该记录的Pi；Hub不会检测或终止其他进程。</p>
          </>
        )}
        {finished && (
          <>
            <p role="status">{deleteOutcomeMessage(finished)}</p>
            <p className="muted">独立副本及其中已复制的历史保留。接下来仅刷新列表与预览，不会再次删除。</p>
          </>
        )}
        {prepared && (
          <p className="storage-path">原始记录：{prepared.sourcePath}
          </p>
        )}
        {loading && <p role="status">正在核对删除条件…</p>}
        {uncertain && <p className="muted">请恢复原存储位置与访问权限后核对。本请求只检查原操作结果，不会重复删除文件。</p>}
        {error && (
          <div className="error-panel" role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <p>{error}</p>
          </div>
        )}
        {uncertain && request && (
          <p className="clone-request">请求：{request.requestId}
          </p>
        )}
      </div>
  <footer>
        <button autoFocus disabled={working} onClick={onClose}>
          {uncertain ? '关闭，保留核对请求' : finished || rejected ? '关闭' : '取消'}
        </button>
        <button
          className="primary"
          disabled={loading || working || !prepared || rejected}
          onClick={() => void submit()}
        >
          {working
            ? '正在核对删除…'
            : finished
              ? '重试刷新'
              : uncertain
                ? '核对删除结果'
                : rejected
                  ? '请关闭后重新核对'
                  : '确认删除原始文件'}
        </button>
      </footer>
 </dialog>
  );
}
