import React, { useCallback, useEffect, useState } from 'react';
import { Terminal, Folder, Cpu } from 'lucide-react';
import type {
  ImportBatch,
  SettingsCategory,
  WorkspaceSnapshot,
} from '../session-management/interface';
import { TerminalSettingsPanel } from './terminal-settings';
import { StorageSettings } from './storage-settings';
import { PiSettings } from './pi-settings';
import { ImportDialog } from './import-dialog';
const categories = [
  { id: 'terminal', name: '终端', Icon: Terminal },
  { id: 'storage', name: '会话存储', Icon: Folder },
  { id: 'pi', name: 'Pi 启动', Icon: Cpu },
] as const;
const initialCategory = (): SettingsCategory => {
  const value = new URLSearchParams(location.search).get('category');
  return value === 'storage' || value === 'pi' ? value : 'terminal';
};
export function SettingsApp() {
  const [category, setCategory] = useState(initialCategory),
    [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null),
    [batch, setBatch] = useState<ImportBatch | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [refreshVersion, setRefreshVersion] = useState(0);
  const [panels, setPanels] = useState({
    terminal: { dirty: false, busy: true },
    storage: { dirty: false, busy: true },
    pi: { dirty: false, busy: true },
  });
  const terminalState = useCallback(
    (dirty: boolean, busy: boolean) => setPanels((s) => ({ ...s, terminal: { dirty, busy } })),
    [],
  );
  const storageState = useCallback(
    (dirty: boolean, busy: boolean) => setPanels((s) => ({ ...s, storage: { dirty, busy } })),
    [],
  );
  const piState = useCallback(
    (dirty: boolean, busy: boolean) => setPanels((s) => ({ ...s, pi: { dirty, busy } })),
    [],
  );
  const dirty = Object.values(panels).some((p) => p.dirty),
    busy = loading || !!batch || Object.values(panels).some((p) => p.busy);
  useEffect(() => {
    void window.sessionManagement.updateSettingsWindow({ category, dirty, busy });
  }, [category, dirty, busy]);
  async function refreshWorkspace() {
    const result = await window.sessionManagement.getSnapshot();
    if (result.status === 'failed') throw Error(result.error.message);
    setWorkspace((s) => (!s || result.value.revision >= s.revision ? result.value : s));
  }
  async function pendingImports() {
    const result = await window.sessionManagement.listImports();
    if (result.status === 'failed') throw Error(result.error.message);
    const pending = result.value.find((b) => b.purpose === 'storage') ?? null;
    setBatch(pending);
    if (pending) setCategory('storage');
  }
  async function read() {
    setLoading(true);
    setError('');
    try {
      await refreshWorkspace();
      await pendingImports();
    } catch (error) {
      setError(String(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    document.title = 'Pi Hub 设置';
    void read();
    return window.sessionManagement.subscribe(-1, (snapshot) =>
      setWorkspace((s) => (!s || snapshot.revision >= s.revision ? snapshot : s)),
    );
  }, []);
  async function imported(done: ImportBatch) {
    await refreshWorkspace();
    await pendingImports();
    setRefreshVersion((v) => v + 1);
    const outcome = done.outcome!;
    setNotice(`存储位置已添加：${outcome.main} 条加入主列表 · ${outcome.archived} 条归档。`);
  }
  return (
    <div className="settings-app">
      <div className="titlebar">
        <span>Pi Hub 设置</span>
      </div>
      <div className="settings-workspace">
 <aside className="settings-nav">
          <nav aria-label="设置类目">
            {categories.map(({ id, name, Icon }) => (
              <button
                className={`nav-row ${id === category ? 'selected' : ''}`}
                key={id}
                aria-label={name}
                aria-current={id === category ? 'page' : undefined}
                onClick={() => setCategory(id)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>
                  {name}
                  {panels[id].dirty && <small aria-hidden="true">未保存</small>}
                </span>
              </button>
            ))}
          </nav>
          <button
            className="settings-close"
            onClick={() => void window.sessionManagement.closeSettings()}
          >关闭设置</button>
        </aside>
 <main className="settings-main">
          {error && (
            <div className="error-panel settings-global-error" role="alert">
              <p>{error}</p>
              <button disabled={loading} onClick={() => void read()}>重新读取设置</button>
            </div>
          )}
 <section
            className="settings-panel"
            aria-label="终端设置"
            hidden={category !== 'terminal'}
          >
            <TerminalSettingsPanel onState={terminalState} />
          </section>
 <section
            className="settings-panel"
            aria-label="会话存储设置"
            hidden={category !== 'storage'}
          >
            {notice && (
              <p className="settings-import-notice" role="status">
                {notice}
              </p>
            )}
            <StorageSettings
              workspace={workspace}
              refreshVersion={refreshVersion}
              onState={storageState}
              onBatch={(next) => {
                setBatch(next);
                setNotice('');
              }}
              onSaved={refreshWorkspace}
            />
          </section>
 <section className="settings-panel" aria-label="Pi 启动设置" hidden={category !== 'pi'}>
            <PiSettings onState={piState} />
          </section>
 </main>
      </div>
 {batch && (
        <ImportDialog
          key={batch.id}
          initial={batch}
          onCancel={() => {
            setBatch(null);
            setRefreshVersion((v) => v + 1);
            setNotice('已取消添加，存储位置与分类保持不变。');
          }}
          onComplete={imported}
        />
      )}
 </div>
  );
}
