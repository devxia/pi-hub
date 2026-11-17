import React, { useEffect, useRef, useState } from 'react';
import { showDialog } from './dialog-focus';
import { AlertCircle, Folder } from 'lucide-react';
import type { ImportBatch, Project } from '../session-management/interface';

export function ProjectSettings({
  project,
  onClose,
  onBatch,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onBatch: (batch: ImportBatch) => void;
  onSaved: (removed: boolean) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [includeDescendants, setIncludeDescendants] = useState(project.includeDescendants);
  const [revision, setRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState('');
  async function readSettings() {
    setBusy(true);
    try {
      const result = await window.sessionManagement.listProjects();
      if (result.status === 'failed') {
        setError(result.error.message);
        return;
      }
      if (!result.value.projects.some((p) => p.id === project.id)) {
        setError('项目已被移除，请关闭设置后重新选择。');
        return;
      }
      setRevision(result.value.revision);
      setError('');
    } catch {
      setError('无法读取项目设置，请重试。输入已保留。');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const restoreFocus = showDialog(dialog.current);
    void readSettings();
    return restoreFocus;
  }, []);
  async function save(removed = false) {
    if (revision === null) return;
    setBusy(true);
    setError('');
    try {
      const target = {
        requestId: crypto.randomUUID(),
        projectId: project.id,
        expectedScopeRevision: revision,
      };
      const result = removed
        ? await window.sessionManagement.removeProject(target)
        : await window.sessionManagement.changeProjectScope({ ...target, includeDescendants });
      if (result.status === 'failed') {
        setError(result.error.message);
        if (result.error.code === 'SCOPE_CHANGED') setRevision(null);
        return;
      }
      if (result.value) onBatch(result.value);
      else await onSaved(removed);
    } catch {
      setError('尚未确认保存结果，请重新读取项目设置后核对。输入已保留。');
      setRevision(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog project-settings"
      aria-labelledby="settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
    <header>
        <div className="eyebrow">项目设置</div>
        <h2 id="settings-title">{confirmRemove ? '移除项目？' : project.name}</h2>
        <div className="import-path" title={project.path}>
          <Folder size={15} aria-hidden="true" />
          <span>{project.path}</span>
        </div>
      </header>
    {confirmRemove ? (
        <div className="settings-body">
          <p>移除后停止跟踪此项目，不会删除原始会话文件。已有主列表与归档分类会保留。</p>
          <p>仍被其他项目覆盖的会话由其接管；重新添加同一路径可恢复分类。</p>
        </div>
      ) : (
        <div className="settings-body">
          <label className="scope-option">
            <input
              type="checkbox"
              checked={includeDescendants}
              disabled={busy}
              onChange={(event) => setIncludeDescendants(event.target.checked)}
            />包含子目录</label>
          <p>默认仅管理当前目录。开启后，只对新纳入的历史会话询问导入选择；已有分类保持不变。</p>
          <p>关闭后，超出范围的会话会隐藏并保留分类。范围重叠时，会话归属路径最具体的项目。</p>
          <button className="remove-project" disabled={busy} onClick={() => setConfirmRemove(true)}>移除项目</button>
        </div>
      )}
    {error && (
        <div className="error-panel" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <div>
            <p>{error}</p>
            {revision === null && (
              <button disabled={busy} onClick={readSettings}>重新读取设置</button>
            )}
          </div>
        </div>
      )}
    <footer>
        <button
          disabled={busy}
          onClick={() => (confirmRemove ? setConfirmRemove(false) : onClose())}
        >
          {confirmRemove ? '返回设置' : '取消'}
        </button>
        <button
          className="primary"
          disabled={busy || revision === null}
          onClick={() => void save(confirmRemove)}
        >
          {busy ? '正在核对…' : confirmRemove ? '确认移除项目' : '保存范围'}
        </button>
      </footer>
  </dialog>
  );
}
