import React, { useEffect, useState } from 'react';
import { AlertCircle, Folder } from 'lucide-react';
import type {
  ImportBatch,
  StorageLocation,
  StorageSnapshot,
  WorkspaceSnapshot,
} from '../session-management/interface';

export function StorageSettings({
  workspace,
  refreshVersion,
  onBatch,
  onSaved,
  onState,
}: {
  workspace: WorkspaceSnapshot | null;
  refreshVersion: number;
  onBatch: (batch: ImportBatch) => void;
  onSaved: () => Promise<void>;
  onState: (dirty: boolean, busy: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<StorageSnapshot | null>(null);
  const [enumeration, setEnumeration] = useState<StorageLocation['enumeration']>('flat');
  const [removing, setRemoving] = useState<StorageLocation | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  async function read() {
    setBusy(true);
    try {
      const result = await window.sessionManagement.listStorageLocations();
      if (result.status === 'failed') setError(result.error.message);
      else {
        setSnapshot(result.value);
        setError('');
      }
    } catch {
      setError('无法读取存储位置，请重新读取后核对。');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void read();
  }, [refreshVersion]);
  useEffect(() => onState(false, busy), [busy, onState]);
  async function add() {
    setBusy(true);
    setError('');
    try {
      const result = await window.sessionManagement.chooseStorageLocation({
        requestId: crypto.randomUUID(),
        enumeration,
      });
      if (result.status === 'failed') setError(result.error.message);
      else if (result.value) onBatch(result.value);
    } catch {
      setError('尚未确认添加结果，请关闭设置并重新读取工作区，核对未完成的导入。');
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!snapshot || !removing) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.sessionManagement.removeStorageLocation({
        requestId: crypto.randomUUID(),
        locationId: removing.id,
        expectedScopeRevision: snapshot.revision,
      });
      if (result.status === 'failed') {
        setError(result.error.message);
        setSnapshot(null);
        return;
      }
      await onSaved();
      setRemoving(null);
      await read();
    } catch {
      setSnapshot(null);
      setError('尚未确认移除结果，请重新读取设置后核对。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
    <header className="settings-header">
        <h1>{removing ? '移除存储位置？' : '会话存储'}</h1>
        <p>存储位置用于查找会话记录，项目工作目录决定会话归属。</p>
      </header>
    <div className="settings-content">
    {removing ? (
          <div>
            <div className="import-path">
              <Folder size={15} />
              <span>{removing.path}</span>
            </div>
            <p>仅停止跟踪这个入口，不会删除原始会话文件。其他启用的入口仍可提供同一记录。</p>
            <p>没有启用入口的会话会隐藏，主列表与归档分类会保留。重新添加后恢复分类，仅询问首次发现的历史。</p>
          </div>
        ) : (
          <div>
      <ul className="storage-list">
              {snapshot?.locations.map((location) => {
                const availability = workspace?.locations?.find(
                  (l) => l.id === location.id,
                )?.availability;
                return (
                  <li key={location.id}>
                    <div>
                      <strong>{location.kind === 'standard' ? '标准位置' : '自定义位置'}</strong>
                      <p className="storage-path">{location.path}</p>
                      <small>
                        {location.enumeration === 'flat'
                          ? '当前目录中的 JSONL（Pi --session-dir）'
                          : '编码目录下的 JSONL（Pi 标准布局）'}
                      </small>
                      {availability?.state === 'unavailable' && (
                        <p className="storage-error">{availability.reason}</p>
                      )}
                    </div>
                    {location.kind === 'custom' && (
                      <button disabled={busy} onClick={() => setRemoving(location)}>移除</button>
                    )}
                  </li>
                );
              })}
            </ul>
      <div className="storage-add">
              <label>新位置的枚举方式<select
                  aria-label="新位置的枚举方式"
                  value={enumeration}
                  disabled={busy}
                  onChange={(event) => setEnumeration(event.target.value as typeof enumeration)}
                >
                  <option value="flat">当前目录中的 JSONL</option>
                  <option value="encoded">编码目录下的 JSONL</option>
                </select>
              </label>
              <p>仅枚举所选层级，不搜索其他磁盘目录。添加后为已选项目选择新历史，原有分类保持不变。</p>
              <button className="primary" disabled={busy || !snapshot} onClick={() => void add()}>选择并添加存储位置</button>
            </div>
    </div>
        )}
    {error && (
          <div className="error-panel" role="alert">
            <AlertCircle size={18} />
            <div>
              <p>{error}</p>
              <button disabled={busy} onClick={() => void read()}>重新读取设置</button>
            </div>
          </div>
        )}
    </div>
      <footer className="settings-footer">
        <span role="status">{busy ? '正在读取或保存…' : '添加和移除位置会在确认后立即生效。'}</span>
        {removing && (
          <>
            <button onClick={() => setRemoving(null)} disabled={busy}>返回设置</button>
            <button className="primary" disabled={busy || !snapshot} onClick={() => void remove()}>确认移除存储位置</button>
          </>
        )}
      </footer>
  </>
  );
}
