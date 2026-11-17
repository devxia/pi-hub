import { AlertCircle } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { TerminalOutcome } from '../session-management/interface';
export function TerminalOperationDialog({
  terminalName,
  initial,
  requestId,
  working,
  error,
  onClose,
  onChanged,
}: {
  terminalName: string;
  initial: TerminalOutcome | null;
  requestId: string;
  working: boolean;
  error: string;
  onClose: () => void;
  onChanged: (value: TerminalOutcome) => void;
}) {
  const operationTerminal = initial?.terminal ?? terminalName;
  const dialog = useRef<HTMLDialogElement>(null),
    [busy, setBusy] = useState(false),
    [localError, setLocalError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (initial?.state !== 'awaiting-paste') setNotice('');
  }, [initial?.state]);
  useEffect(() => {
    if (working || busy || (initial?.state !== 'uncertain' && initial?.state !== 'awaiting-paste'))
      return;
    let stopped = false,
      inFlight = false;
    async function refresh() {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const r = await window.sessionManagement.getTerminalOutcome({ requestId });
        if (!stopped && r.status === 'completed' && r.value) onChanged(r.value);
      } catch {
        /* Keep the explicit reconciliation action available. */
      } finally {
        inFlight = false;
      }
    }
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [requestId, working, busy, initial?.state]);
  async function check(retry = false) {
    setBusy(true);
    setLocalError('');
    try {
      const r = retry
        ? await window.sessionManagement.retryTerminal({ requestId })
        : await window.sessionManagement.getTerminalOutcome({ requestId });
      if (r.status === 'failed') setLocalError(r.error.message);
      else if (r.value) onChanged(r.value);
      else setLocalError('尚未发现已执行的启动请求。请关闭后重新执行原操作。');
    } catch {
      setLocalError('结果读取未完成，请继续核对同一请求。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog project-settings"
      aria-labelledby="terminal-operation-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!working && !busy) onClose();
      }}
    >
      <header>
        <div className="eyebrow">{operationTerminal}</div>
        <h2 id="terminal-operation-title">{working ? '正在重试终端' : '终端打开结果'}</h2>
      </header>
      <div className="settings-body">
        {!initial?.errorCode && (!notice || initial?.state !== 'awaiting-paste') && (
          <p role="status">{working ? '正在核对项目、运行实例与终端接入…' : initial?.message}</p>
        )}
        {initial?.errorCode && (
          <div className="error-panel" role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <p>
              {busy ? '上次结果：' : ''}
              {initial.message}
            </p>
          </div>
        )}
        {(error || localError) && (
          <div className="error-panel" role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <p>{localError || error}</p>
          </div>
        )}
        {initial?.manualNotice && <p>{initial.manualNotice}</p>}
        {(initial?.canRetry || initial?.state === 'awaiting-paste') && (
          <button
            disabled={busy || !(initial.canRetry || initial.state === 'awaiting-paste')}
            onClick={() => {
              setBusy(true);
              setLocalError('');
              void window.sessionManagement
                .copyTerminalCommand({ requestId })
                .then(async (r) => {
                  if (r.status === 'failed') setLocalError(r.error.message);
                  else {
                    setNotice(
                      `命令已复制，请粘贴到 ${operationTerminal}。此命令仅供本次启动；重复粘贴同一命令不会再次启动Pi。新的明确打开操作不受此限制。`,
                    );
                    const current = await window.sessionManagement.getTerminalOutcome({
                      requestId,
                    });
                    if (current.status === 'completed' && current.value) onChanged(current.value);
                  }
                })
                .catch(() => setLocalError('复制结果尚未确认，请核对同一请求。'))
                .finally(() => setBusy(false));
            }}
          >复制手动启动命令</button>
        )}
        {notice && <p role="status">{notice}</p>}
        {initial?.state === 'awaiting-paste' && (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setLocalError('');
              void window.sessionManagement
                .cancelTerminalCommand({ requestId })
                .then((r) => {
                  if (r.status === 'failed') setLocalError(r.error.message);
                  else onChanged(r.value);
                })
                .catch(() => setLocalError('取消结果尚未确认，请核对这条命令。'))
                .finally(() => setBusy(false));
            }}
          >取消尚未领取的启动命令</button>
        )}
      </div>
      <footer>
        <button disabled={working || busy} onClick={onClose}>关闭</button>
        {initial?.canRetry ? (
          <button className="primary" disabled={working || busy} onClick={() => void check(true)}>
            {busy ? '正在重试…' : '重试同一启动请求'}
          </button>
        ) : (
          <button className="primary" disabled={working || busy} onClick={() => void check()}>
            {busy ? '正在核对…' : '核对启动结果'}
          </button>
        )}
      </footer>
    </dialog>
  );
}
