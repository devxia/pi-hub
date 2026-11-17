import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type { RenamePreparation, RenameRequest } from '../session-management/interface';
export function RenameDialog({
  sourceKey,
  title,
  onClose,
  onRenamed,
}: {
  sourceKey: string;
  title: string;
  onClose: () => void;
  onRenamed: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null),
    started = useRef(false);
  const [prepared, setPrepared] = useState<RenamePreparation | null>(null),
    [name, setName] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [request, setRequest] = useState<RenameRequest | null>(null),
    [uncertain, setUncertain] = useState(false),
    [needsReopen, setNeedsReopen] = useState(false),
    [confirmed, setConfirmed] = useState<'completed' | 'superseded' | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    if (started.current) return;
    started.current = true;
    void window.sessionManagement
      .prepareRename({ key: sourceKey })
      .then((r) => {
        if (r.status === 'failed') setError(r.error.message);
        else {
          setPrepared(r.value);
          setName(r.value.name);
          if (r.value.pending) {
            setRequest(r.value.request!);
            setUncertain(true);
            setError(r.value.pending.error ?? '改名结果尚待核对。');
          }
        }
      })
      .catch(() => setError('无法读取改名条件，请关闭后重试。'))
      .finally(() => setLoading(false));
  }, [sourceKey]);
  useEffect(() => {
    if (!loading && !uncertain) {
      input.current?.focus();
      input.current?.select();
    }
  }, [loading]);
  async function refreshConfirmed(state: 'completed' | 'superseded') {
    try {
      await onRenamed();
      if (state === 'completed') onClose();
      else {
        setNeedsReopen(true);
        setError('此请求后名称已再次修改，已保留最新名称。请关闭后重新改名。');
      }
    } catch {
      setError(
        state === 'completed'
          ? '名称已保存，但列表与预览刷新失败。请重试刷新。'
          : '已核对并保留最新名称，但列表与预览刷新失败。请重试刷新。',
      );
    }
  }
  async function submit() {
    if (saving || loading || !prepared || needsReopen) return;
    setSaving(true);
    setError('');
    if (confirmed) {
      try {
        await refreshConfirmed(confirmed);
      } finally {
        setSaving(false);
      }
      return;
    }
    const selection = {
      start: input.current?.selectionStart ?? 0,
      end: input.current?.selectionEnd ?? 0,
    };
    const intent = request ?? {
      requestId: crypto.randomUUID(),
      key: sourceKey,
      identity: prepared.identity,
      expectedRevision: prepared.expectedRevision,
      name,
    };
    setRequest(intent);
    try {
      const result = uncertain
        ? await window.sessionManagement.getRenameOutcome({ requestId: intent.requestId })
        : await window.sessionManagement.renameSession(intent);
      if (result.status === 'failed') {
        if (
          ['BACKGROUND_UNAVAILABLE', 'DATABASE_UNAVAILABLE', 'DATABASE_BUSY'].includes(
            result.error.code,
          )
        ) {
          setUncertain(true);
          setError('尚未确认改名结果，请先核对原请求。');
        } else {
          setError(result.error.message);
          setRequest(null);
          if (result.error.code === 'RECORD_CHANGED') setNeedsReopen(true);
        }
      } else if (result.value?.state === 'completed') {
        setConfirmed('completed');
        setUncertain(false);
        await refreshConfirmed('completed');
      } else if (result.value?.state === 'superseded') {
        setConfirmed('superseded');
        setUncertain(false);
        await refreshConfirmed('superseded');
      } else if (result.value?.state === 'rejected') {
        setUncertain(false);
        setRequest(null);
        setError(result.value.error ?? '改名被拒绝，未排队。请核对状态后手动重试。');
      } else if (!result.value) {
        setUncertain(false);
        setRequest(null);
        setError('已核对，本次未提交。可以手动重试。');
      } else {
        setUncertain(true);
        setError(result.value.error ?? '改名结果尚待核对，请勿重复提交。');
      }
    } catch {
      setUncertain(true);
      setError('尚未收到可靠回执，请先核对原请求。');
    } finally {
      setSaving(false);
      requestAnimationFrame(() => {
        if (input.current && !input.current.disabled) {
          input.current.focus({ preventScroll: true });
          input.current.setSelectionRange(selection.start, selection.end);
        }
      });
    }
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog clone-dialog"
      aria-labelledby="rename-title"
      onKeyDown={(e) => e.stopPropagation()}
      onCancel={(e) => {
        e.preventDefault();
        if (!saving) onClose();
      }}
    >
  <header>
        <h2 id="rename-title">重命名会话</h2>
        <p>{title}</p>
      </header>
  <div className="import-body">
        <form
          id="rename-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="clone-name">会话名称<input
              ref={input}
              value={name}
              disabled={loading || saving || uncertain || !!confirmed || !prepared}
              onChange={(e) => {
                setName(e.target.value);
                setRequest(null);
              }}
            />
          </label>
        </form>
        <p className="muted">与 Pi /name 同步，可以重名。清空后使用首条消息的自动标题。</p>
        {confirmed && (
          <p role="status">
            {confirmed === 'completed' ? '名称已保存。' : '已核对并保留最新名称。'}
          </p>
        )}
        {uncertain && <p className="muted">请核对原Pi记录或Hub宿主连接后重读；如已在原Pi用/name再次改名，核对不会重新发送旧命令。本请求不会自动重发。</p>}
        {error && (
          <div className="error-panel" role="alert">
            <AlertCircle size={18} />
            <p>{error}</p>
          </div>
        )}
        {uncertain && request && (
          <p className="clone-request">请求：{request.requestId}
          </p>
        )}
      </div>
  <footer>
        <button disabled={saving} onClick={onClose}>
          {uncertain ? '关闭，保留核对请求' : confirmed ? '关闭' : '取消'}
        </button>
        <button
          type="submit"
          form="rename-form"
          className={needsReopen ? undefined : 'primary'}
          disabled={loading || saving || !prepared || needsReopen}
        >
          {saving
            ? '正在核对名称…'
            : uncertain
              ? '核对改名结果'
              : needsReopen
                ? '请关闭后重新改名'
                : confirmed
                  ? '重试刷新'
                  : '保存名称'}
        </button>
      </footer>
 </dialog>
  );
}
