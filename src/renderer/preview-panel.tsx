import { runtimeLabel } from './runtime-label';
import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, PanelRight, X } from 'lucide-react';
import type { SessionPreview, WorkspaceSnapshot } from '../session-management/interface';
type Session = WorkspaceSnapshot['sessions'][number];
export function PreviewPanel({
  session,
  projectName,
  contextNotice,
  open,
  onClose,
  copyCreated,
}: {
  session?: Session;
  projectName?: string;
  contextNotice: string;
  open: boolean;
  onClose: () => void;
  copyCreated: boolean;
}) {
  const [preview, setPreview] = useState<SessionPreview | null>(null),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0),
    generation = useRef(0),
    closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width:1050px)'),
      focus = () => {
        if (open && session && media.matches) closeRef.current?.focus();
      };
    focus();
    media.addEventListener('change', focus);
    return () => media.removeEventListener('change', focus);
  }, [open, session?.key]);
  useEffect(() => {
    const current = ++generation.current;
    setPreview(null);
    setError('');
    if (!open || !session) return;
    const requestId = crypto.randomUUID(),
      key = session.key;
    void window.sessionManagement
      .getPreview({ requestId, key, expectedPreviewRevision: session.previewRevision })
      .then((r) => {
        if (generation.current !== current) return;
        if (r.status === 'failed') setError(r.error.message);
        else if (
          r.value.requestId === requestId &&
          r.value.key === key &&
          r.value.previewRevision === session.previewRevision
        )
          setPreview(r.value);
      })
      .catch(() => {
        if (generation.current === current) setError('预览服务未响应，请重试。');
      });
    return () => {
      generation.current++;
      void window.sessionManagement.cancelPreview({ requestId });
    };
  }, [session?.key, session?.sourceFingerprint, session?.previewRevision, open, retry]);
  const current = preview?.previewRevision === session?.previewRevision ? preview : null;
  return (
    <aside className={`preview ${open && session ? 'preview-open' : ''}`} aria-label="只读预览">
      <header>
        <PanelRight size={16} aria-hidden="true" />
        <span>只读预览</span>
        {open && session && (
          <button ref={closeRef} aria-label="关闭预览" onClick={onClose}>
            <X size={16} />
          </button>
        )}
      </header>
      {!open || !session ? (
        <div className="preview-empty">
          <h2>选择会话查看预览</h2>
          <p>首条用户消息与最近三轮对话。<br />对话继续在外部终端中进行。</p>
        </div>
      ) : (
        <>
 <div className="preview-identity" role="region" aria-label="会话身份" tabIndex={0}>
            <h2 title={session.title}>{session.title}</h2>
            <p className="preview-state">
              {runtimeLabel(session.runtimeState)}
              <span>{session.classification === 'archive' ? '已归档' : '主列表'}</span>
            </p>
            <p className="preview-project">项目：{projectName ?? '项目不可用'}
            </p>
            <p className="preview-cwd" title={session.cwd}>记录目录：{session.cwd}
            </p>
            {session.runtimeCwd && session.runtimeCwd !== session.cwd && (
              <p className="preview-cwd" title={session.runtimeCwd}>本次运行目录：{session.runtimeCwd}
              </p>
            )}
            <small>SessionID：{session.headerId}
            </small>
            <details>
              <summary>完整名称与记录位置</summary>
              <p>完整名称：{session.title}
              </p>
              <p>记录目录：{session.cwd}
              </p>
              {session.runtimeCwd && session.runtimeCwd !== session.cwd && (
                <p>本次运行目录：{session.runtimeCwd}
                </p>
              )}
              <p>记录位置：{session.sourcePath}
              </p>
            </details>
          </div>
 {contextNotice && (
            <p className="preview-context" role="status">
              {contextNotice}
            </p>
          )}
 <div
            className="preview-content"
            role="region"
            aria-label="预览正文"
            tabIndex={0}
            aria-live="polite"
          >
            {copyCreated && (
              <section className="preview-message clone-completed">
                <p role="status">已执行原生/clone，当前终端已切换到此副本。原记录保留。</p>
              </section>
            )}
            {error ? (
              <div className="error-panel" role="alert">
                <AlertCircle size={18} aria-hidden="true" />
                <div>
                  <strong>预览未完成</strong>
                  <p>{error}</p>
                  <button onClick={() => setRetry((n) => n + 1)}>重试预览</button>
                </div>
              </div>
            ) : !current ? (
              <p role="status">正在读取预览…</p>
            ) : (
              <>
                <p className="preview-explanation">首条保留原文；最近对话反映当前分支的压缩与编辑。</p>
                {current.messages.length === 0 && <p>当前分支没有可见对话。</p>}
                {current.messages.map((message) => (
                  <section
                    className={`preview-message ${message.role}`}
                    key={`${message.sourceId}-${message.kind}`}
                  >
                    <h3>
                      {message.role === 'user' ? '用户' : '助手'}
                      <span>
                        {message.kind === 'original'
                          ? '首条 · 原文'
                          : message.kind === 'original-and-recent'
                            ? '首条 · 最近对话'
                            : '最近对话'}
                      </span>
                    </h3>
                    {message.text.length > 800 ? (
                      <details>
                        <summary>
                          {message.text.replace(/\s+/g, ' ').slice(0, 180)}… <span>展开全文</span>
                        </summary>
                        <div className="message-text">{message.text}</div>
                      </details>
                    ) : (
                      <div className="message-text">{message.text}</div>
                    )}
                  </section>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
