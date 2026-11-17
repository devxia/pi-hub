import React, { useEffect, useRef, useState } from 'react';
import type { CloneOutcome } from '../session-management/interface';
import { showDialog } from './dialog-focus';
export function CloneDialog({
  sourceKey,
  title,
  onClose,
  onCreated,
}: {
  sourceKey: string;
  title: string;
  onClose: () => void;
  onCreated: (key: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [outcome, setOutcome] = useState<CloneOutcome | null>(null),
    [refreshOnly, setRefreshOnly] = useState(false),
    request = useRef({ requestId: crypto.randomUUID(), key: sourceKey });
  useEffect(() => showDialog(dialog.current), []);
  async function finish(value: CloneOutcome) {
    if (value.state === 'completed' && value.key) {
      setRefreshOnly(true);
      try {
        await onCreated(value.key);
        onClose();
      } catch {
        setError('Pi已复制并切换，但列表刷新失败，请重试刷新。');
      }
    } else setError(value.error ?? '结果尚未确认，请核对同一原生操作。');
  }
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (refreshOnly && outcome) {
        await finish(outcome);
        return;
      }
      const r = outcome
        ? await window.sessionManagement.getCloneOutcome({ requestId: request.current.requestId })
        : await window.sessionManagement.cloneSession(request.current);
      if (r.status === 'failed') setError(r.error.message);
      else if (r.value) {
        setOutcome(r.value);
        await finish(r.value);
      }
    } catch {
      setError('原生复制回执未确认，请核对原操作。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog clone-dialog"
      aria-labelledby="clone-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2 id="clone-title">复制并切换会话</h2>
        <p>{title}</p>
      </header>
      <div className="import-body">
        <p>对应Pi原生 <code>/clone</code>：复制当前活动分支为新会话，并让当前终端切换到副本。</p>
        <p>原记录保留。Hub不会预先命名或生成镜像；需要名称时再使用重命名，对应 <code>/name</code>。</p>
        {error && (
          <p role="alert" className="storage-error">
            {error}
          </p>
        )}
        {outcome && (
          <p className="clone-request">请求：{request.current.requestId}
          </p>
        )}
      </div>
      <footer>
        <button disabled={busy} onClick={onClose}>
          {outcome ? '关闭' : '取消'}
        </button>
        <button className="primary" disabled={busy} onClick={() => void submit()}>
          {busy
            ? '正在执行…'
            : refreshOnly
              ? '重试刷新'
              : outcome
                ? '核对原生复制结果'
                : '执行 /clone'}
        </button>
      </footer>
    </dialog>
  );
}
