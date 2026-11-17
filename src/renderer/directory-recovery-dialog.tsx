import React, { useEffect, useRef, useState } from 'react';
import type { WorkspaceSnapshot } from '../session-management/interface';
import { showDialog } from './dialog-focus';
export function DirectoryRecoveryDialog({
  session,
  projects,
  terminalName,
  onClose,
  onContinue,
}: {
  session: WorkspaceSnapshot['sessions'][number];
  projects: WorkspaceSnapshot['projects'];
  terminalName: string;
  onClose: () => void;
  onContinue: (projectId: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [target, setTarget] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => showDialog(dialog.current), []);
  async function submit() {
    if (!target || busy) return;
    setBusy(true);
    setError('');
    try {
      await onContinue(target);
    } catch {
      setError('启动回执未确认，请核对原终端。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog project-settings"
      aria-labelledby="recovery-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <div className="eyebrow">临时继续 · {terminalName}
        </div>
        <h2 id="recovery-title">原目录不可用</h2>
        <p className="storage-path">记录目录：{session.cwd}
        </p>
      </header>
      <div className="settings-body">
        <p>选择本次运行目录，继续原会话。原ID、JSONL文件和记录目录不变，不创建副本、不迁移项目文件；下次仍按原记录目录确认。</p>
        <label>本次运行项目<select
            aria-label="本次运行项目"
            value={target}
            disabled={busy}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">请选择项目</option>
            {projects
              .filter((p) => p.availability.state === 'available')
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.path}
                </option>
              ))}
          </select>
        </label>
        {target && (
          <p className="storage-path">本次运行目录：{projects.find((p) => p.id === target)?.path}
          </p>
        )}
        {error && (
          <p role="alert" className="storage-error">
            {error}
          </p>
        )}
      </div>
      <footer>
        <button disabled={busy} onClick={onClose}>取消</button>
        <button className="primary" disabled={busy || !target} onClick={() => void submit()}>
          {busy ? '正在打开…' : '临时继续原会话'}
        </button>
      </footer>
    </dialog>
  );
}
