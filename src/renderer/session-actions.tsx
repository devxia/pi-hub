import React, { useEffect, useRef, useState } from 'react';
import type {
  ClassificationRequest,
  ExitSessionRequest,
  WorkspaceSnapshot,
} from '../session-management/interface';
import { showDialog } from './dialog-focus';
type Row = WorkspaceSnapshot['sessions'][number];
export function SessionActions({
  row,
  action,
  hostId,
  onClose,
  onChanged,
}: {
  row: Row;
  action: 'classify' | 'exit';
  hostId?: string;
  onClose: () => void;
  onChanged: (message: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState(false),
    [uncertain, setUncertain] = useState(false),
    id = useRef(crypto.randomUUID());
  const classification = useRef<ClassificationRequest>({
    requestId: id.current,
    key: row.key,
    classification: row.classification === 'archive' ? 'main' : 'archive',
    expectedRevision: row.classificationRevision ?? 0,
  });
  const exit = useRef<ExitSessionRequest>({
    requestId: id.current,
    key: row.key,
    identity: row.identity,
    hostId: hostId ?? '',
    stopBusy: false,
  });
  useEffect(() => {
    let stopped = false;
    void (async () => {
      if (action === 'exit') {
        const r = await window.sessionManagement.sessionTerminals({
          key: row.key,
          identity: row.identity,
        });
        if (stopped) return;
        if (r.status === 'failed') {
          setError(r.error.message);
          setBusy(false);
          return;
        }
        const instance = r.value.find((i) => i.hostId === hostId);
        if (!instance) {
          setError('所选终端实例已结束或切换会话。');
          setBusy(false);
          return;
        }
        if (instance.busy) {
          setConfirm(true);
          setBusy(false);
          return;
        }
      }
      await submit();
    })();
    return () => {
      stopped = true;
    };
  }, []);
  useEffect(() => {
    if (!error && !confirm) return;
    return showDialog(dialog.current);
  }, [!!error, confirm]);
  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (action === 'classify') {
        let result:
          | import('../session-management/interface').Result<
              import('../session-management/interface').ClassificationReceipt
            >
          | null;
        if (uncertain) {
          const r = await window.sessionManagement.getClassificationOutcome({
            requestId: id.current,
          });
          if (r.status === 'failed') throw Error(r.error.message);
          result = r.value;
        } else
          result = await window.sessionManagement.setSessionClassification(classification.current);
        if (!result) throw Error('尚未发现原分类结果，请继续核对原请求。');
        if (result.status === 'failed') {
          if (result.error.code === 'BACKGROUND_UNAVAILABLE') throw Error(result.error.message);
          setUncertain(false);
          setError(result.error.message);
          setBusy(false);
          return;
        }
        await onChanged(
          classification.current.classification === 'archive'
            ? '会话已归档。'
            : '会话已恢复到主列表。',
        );
        onClose();
      } else {
        const r = await window.sessionManagement.exitSession(exit.current);
        if (r.status === 'failed') {
          setError(r.error.message);
          if (r.error.message.includes('确认停止')) {
            exit.current.requestId = crypto.randomUUID();
            setConfirm(true);
          }
          return;
        }
        if (r.value.state === 'uncertain') {
          setError(r.value.message);
          setUncertain(true);
          return;
        }
        await onChanged(r.value.message);
        onClose();
      }
    } catch {
      setUncertain(true);
      setError(
        action === 'classify'
          ? '分类结果尚未确认，请核对同一请求。'
          : '退出结果尚未确认，请在原终端核对。',
      );
    } finally {
      setBusy(false);
    }
  }
  if (!error && !confirm) return null;
  return (
    <dialog
      ref={dialog}
      className="import-dialog project-settings"
      aria-labelledby="session-action-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2 id="session-action-title">
          {confirm ? '停止当前任务并退出？' : action === 'classify' ? '分类结果' : '退出会话'}
        </h2>
        <p>{row.title}</p>
      </header>
      <div className="settings-body">
        {confirm && <p>当前任务将停止，并关闭这个会话对应的终端标签页或窗格。会话记录保留。</p>}
        {error && (
          <p role="alert" className="storage-error">
            {error}
          </p>
        )}
      </div>
      <footer>
        <button disabled={busy} onClick={onClose}>
          {confirm ? '取消' : '关闭'}
        </button>
        {confirm ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              exit.current.stopBusy = true;
              void submit();
            }}
          >
            {busy ? '正在退出…' : '停止任务并退出'}
          </button>
        ) : (
          action === 'classify' &&
          uncertain && (
            <button className="primary" disabled={busy} onClick={() => void submit()}>
              {busy ? '正在核对…' : '核对分类结果'}
            </button>
          )
        )}
      </footer>
    </dialog>
  );
}
