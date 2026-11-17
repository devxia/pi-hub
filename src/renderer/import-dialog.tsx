import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Folder } from 'lucide-react';
import type { ImportBatch, Result } from '../session-management/interface';

export function ImportDialog({
  initial,
  onCancel,
  onComplete,
}: {
  initial: ImportBatch;
  onCancel: () => void;
  onComplete: (batch: ImportBatch) => Promise<void>;
}) {
  const [batch, setBatch] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [selectionDirty, setSelectionDirty] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resubmitting, setResubmitting] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const storage = batch.purpose === 'storage';
  const expanding = batch.purpose === 'expand';
  const returning = batch.purpose === 'return';
  const processing = batch.state === 'scanning' || batch.state === 'validating';
  const ready = batch.state === 'ready';
  const conflict = batch.error?.code === 'SCOPE_CHANGED' || batch.error?.code === 'RECORD_CHANGED';
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (!processing) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await window.sessionManagement.getImport({ batchId: batch.id });
        if (stopped) return;
        if (result.status === 'failed') {
          setError(result.error.message);
          setNeedsVerification(batch.state === 'validating');
          return;
        }
        setBatch(result.value);
        if (result.value.state === 'scanning' || result.value.state === 'validating')
          timer = setTimeout(poll, 250);
      } catch {
        if (!stopped) {
          setError('无法读取导入进度，请重新读取。');
          setNeedsVerification(batch.state === 'validating');
        }
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [batch.id, processing, pollGeneration]);
  async function run(action: () => Promise<Result<ImportBatch>>, submission = false) {
    setBusy(true);
    setError('');
    setRecoveryNotice('');
    try {
      const result = await action();
      if (result.status === 'failed') {
        setError(result.error.message);
        if (submission) setNeedsVerification(true);
        return null;
      }
      setBatch(result.value);
      return result.value;
    } catch {
      setError('暂时无法访问导入服务，选择已保留。');
      if (submission) setNeedsVerification(true);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function reread() {
    const result = await run(() => window.sessionManagement.getImport({ batchId: batch.id }));
    if (!result) return;
    setPollGeneration((generation) => generation + 1);
    if (needsVerification && result.state === 'ready') {
      setResubmitting(true);
      setRecoveryNotice('已核对：项目尚未提交，选择已保留。恢复存储访问后可重新提交。');
    }
    setNeedsVerification(false);
  }
  async function retry() {
    const result = await run(() => window.sessionManagement.retryImport({ batchId: batch.id }));
    if (result?.state === 'ready') {
      setResubmitting(true);
      setRecoveryNotice('项目尚未提交，选择已保留。可以重新提交。');
    }
  }
  async function finish() {
    setBusy(true);
    setError('');
    try {
      await onComplete(batch);
    } catch {
      setError('导入已保存，但列表尚未读取成功。请重新读取结果。');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (batch.state === 'completed') void finish();
  }, [batch.state]);
  async function cancel() {
    if (batch.state === 'cancelled') {
      onCancel();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await window.sessionManagement.cancelImport({ batchId: batch.id });
      if (result.status === 'failed') setError(result.error.message);
      else onCancel();
    } catch {
      setError('未能确认取消结果，请重新读取。');
    } finally {
      setBusy(false);
    }
  }
  async function select(keys: string[]) {
    setBatch({ ...batch, selectedKeys: keys });
    setSelectionDirty(true);
    if (
      await run(() =>
        window.sessionManagement.selectImport({ batchId: batch.id, selectedKeys: keys }),
      )
    )
      setSelectionDirty(false);
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog"
      aria-labelledby="import-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy && batch.state !== 'completed') void cancel();
      }}
    >
    <header>
        <div className="eyebrow">
          {storage
            ? '添加存储位置'
            : expanding
              ? '调整项目范围'
              : returning
                ? '重新添加项目'
                : '添加项目'} · {storage ? '已选项目' : batch.project.includeDescendants ? '包含子目录' : '仅当前目录'}
        </div>
        <h2 id="import-title">选择历史会话</h2>
        <div className="import-path" title={storage ? batch.location?.path : batch.project.path}>
          <Folder size={15} aria-hidden="true" />
          <span>{storage ? batch.location?.path : batch.project.path}</span>
        </div>
        <p>选中的加入主列表，其余保留在归档。原始会话文件保持原样。{(storage || expanding || returning) && '已管理的会话保留原分类，不再重复选择。'}
        </p>
      </header>
    <details className="import-identity">
        <summary>{storage ? '完整存储位置' : '完整项目路径'}</summary>
        <p>{storage ? batch.location?.path : batch.project.path}</p>
      </details>
    {processing && (
        <div className="import-progress" role="status">
          <strong>
            {batch.state === 'validating' ? '正在核对记录并保存…' : '正在查找历史会话…'}
          </strong>
          <p>已检查 {batch.progress.inspected} 个文件 · 已读取 {batch.progress.parsed} 条记录</p>
          <p>
            {storage
              ? '完成前不会启用此位置，你可以随时取消。'
              : expanding
                ? '完成前保留原范围，你可以随时取消。'
                : '完成前不会添加项目，你可以随时取消。'}
          </p>
        </div>
      )}
    {(error || batch.error) && (
        <div className="error-panel" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <div>
            <strong>{error || batch.error?.message}</strong>
            {needsVerification && <p>请先核对本次保存结果，再决定是否重新提交。</p>}
            {batch.error?.detail && (
              <details className="diagnostic-details">
                <summary>查看诊断详情</summary>
                <p className="error-detail">{batch.error.detail}</p>
              </details>
            )}
            {error && selectionDirty && (
              <button disabled={busy} onClick={() => select(batch.selectedKeys)}>重试保存选择</button>
            )}
            {error && !selectionDirty && batch.state !== 'completed' && (
              <button disabled={busy} onClick={reread}>
                {needsVerification ? '核对保存结果' : '重新读取'}
              </button>
            )}
            {batch.state === 'error' && !conflict && !needsVerification && (
              <button disabled={busy} onClick={retry}>重试导入</button>
            )}
          </div>
        </div>
      )}
    {recoveryNotice && (
        <p className="import-progress" role="status">
          {recoveryNotice}
        </p>
      )}
    {batch.validationNotice && !processing && (
        <div className="error-panel" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{batch.validationNotice}</span>
        </div>
      )}
    {storage && batch.projects && (
        <div className="storage-scope-report">
          {batch.projects.map((project) => (
            <p key={project.id} title={project.path}>
              <strong>{project.name}</strong> · {project.includeDescendants ? '包含子目录' : '仅当前目录'} · {
                batch.candidates.filter(
                  (c) =>
                    batch.candidateProjectIds?.[c.key] === project.id &&
                    batch.selectedKeys.includes(c.key),
                ).length
              } 条加入主列表 · {
                batch.candidates.filter(
                  (c) =>
                    batch.candidateProjectIds?.[c.key] === project.id &&
                    !batch.selectedKeys.includes(c.key),
                ).length
              } 条归档</p>
          ))}
        </div>
      )}
    {batch.state === 'completed' && (
        <div className="import-progress" role="status">
          {storage ? '存储位置已保存' : '项目已保存'}：{batch.outcome?.main} 条加入主列表，{batch.outcome?.archived} 条归档。{error && (
            <button onClick={finish} disabled={busy}>重新读取结果</button>
          )}
        </div>
      )}
    {batch.state === 'cancelled' && (
        <div className="import-progress" role="status">上次扫描已中断，本次添加未保存。请关闭后重新选择目录。</div>
      )}
    {batch.state === 'error' && batch.progress.phase !== 'validating' && (
        <p className="import-progress">候选结果尚未确定。恢复读取后再选择历史会话。</p>
      )}
    {!processing &&
        (ready || (batch.state === 'error' && batch.progress.phase === 'validating')) && (
          <>
      <div className="import-toolbar">
              <span>已选 {batch.selectedKeys.length} 条 · 其余 {batch.candidates.length - batch.selectedKeys.length} 条归档</span>
              <div>
                <button
                  disabled={!ready || busy || needsVerification}
                  onClick={() => select(batch.candidates.map((candidate) => candidate.key))}
                >全选</button>
                <button disabled={!ready || busy || needsVerification} onClick={() => select([])}>全不选</button>
              </div>
            </div>
      {batch.candidates.length === 0 && ready ? (
              <div className="import-empty">
                <h3>
                  {storage || expanding || returning
                    ? '没有需要选择的新历史会话'
                    : '没有已保存的历史会话'}
                </h3>
                <p>
                  {storage
                    ? '扫描完成，可以添加此位置。已有分类保持不变。'
                    : expanding
                      ? '扫描完成，可以保存范围。已有分类保持不变。'
                      : returning
                        ? '扫描完成，可以恢复项目及已有分类。'
                        : '扫描完成。你仍可添加这个项目。'}
                </p>
              </div>
            ) : (
              <div className="candidate-list">
                {batch.candidates.slice(page * 50, page * 50 + 50).map((candidate) => (
                  <label className="candidate-row" key={candidate.key}>
                    <input
                      type="checkbox"
                      aria-label={`${candidate.title} · ${candidate.headerId}`}
                      checked={batch.selectedKeys.includes(candidate.key)}
                      disabled={!ready || busy || needsVerification}
                      onChange={(event) =>
                        select(
                          event.target.checked
                            ? [...batch.selectedKeys, candidate.key]
                            : batch.selectedKeys.filter((key) => key !== candidate.key),
                        )
                      }
                    />
                    <span>
                      <strong title={candidate.title}>{candidate.title}</strong>
                      <small title={candidate.sourcePath}>
                        {storage &&
                          `${batch.projects?.find((p) => p.id === batch.candidateProjectIds?.[candidate.key])?.name ?? ''} · `}
                        {candidate.headerId.slice(0, 8)} · {candidate.lastMessageAt
                          ? new Date(candidate.lastMessageAt).toLocaleString('zh-CN')
                          : '对话时间未知'} · {candidate.sourcePath.split('/').at(-1)}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            )}
      {batch.candidates.length > 50 && (
              <div className="pagination">
                <button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
                <span>
                  {page + 1} / {Math.ceil(batch.candidates.length / 50)} 页 · 全选作用于全部 {batch.candidates.length} 条</span>
                <button
                  disabled={(page + 1) * 50 >= batch.candidates.length}
                  onClick={() => setPage(page + 1)}
                >下一页</button>
              </div>
            )}
    </>
        )}
    {batch.issues.length > 0 && (
        <details className="import-issues">
          <summary>
            {batch.issues.length} 个记录未能读取 · 查看原因</summary>
          <ul>
            {batch.issues.slice(0, 50).map((issue, index) => (
              <li key={index}>
                <span>{issue.path}</span>
                <p>{issue.message}</p>
              </li>
            ))}
          </ul>
          {batch.issues.length > 50 && <p>仅显示前 50 个错误。</p>}
          <p>这些记录不会被导入或归档；修复后可取消并重新扫描。</p>
        </details>
      )}
    <footer>
        <button onClick={cancel} disabled={busy || batch.state === 'completed'}>
          {batch.state === 'cancelled' ? '关闭' : expanding ? '取消范围调整' : '取消添加'}
        </button>
        <button
          className="primary"
          disabled={!ready || busy || selectionDirty || needsVerification}
          onClick={() =>
            run(() => window.sessionManagement.commitImport({ batchId: batch.id }), true)
          }
        >
          {batch.state === 'validating'
            ? '正在保存…'
            : resubmitting
              ? '重新提交'
              : storage
                ? '确认添加存储位置'
                : expanding
                  ? '确认调整范围'
                  : '确认添加项目'}
        </button>
      </footer>
  </dialog>
  );
}
