import React, { useEffect, useRef, useState } from 'react';
import type { PiStatus } from '../session-management/interface';
export function PiSettings({ onState }: { onState: (dirty: boolean, busy: boolean) => void }) {
  const [status, setStatus] = useState<PiStatus | null>(null),
    [piPath, setPiPath] = useState(''),
    [nodePath, setNodePath] = useState(''),
    [saved, setSaved] = useState({ piPath: '', nodePath: '' }),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const dirty = piPath !== saved.piPath || nodePath !== saved.nodePath,
    dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => onState(dirty, busy), [dirty, busy, onState]);
  async function read() {
    setBusy(true);
    setError('');
    try {
      const r = await window.sessionManagement.getPiStatus();
      if (r.status === 'failed') setError(r.error.message);
      else {
        setStatus(r.value);
        const paths = {
          piPath: r.value.launch?.piPath ?? '',
          nodePath: r.value.launch?.nodePath ?? '',
        };
        if (!dirtyRef.current) {
          setPiPath(paths.piPath);
          setNodePath(paths.nodePath);
        }
        setSaved(paths);
      }
    } catch {
      setError('无法读取启动配置，请重试。');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void read();
  }, []);
  async function inspect() {
    setBusy(true);
    setError('');
    setNotice('');
    setStatus((s) => (s ? { ...s, reviewId: undefined } : s));
    try {
      const r = await window.sessionManagement.inspectPi({ mode: 'launcher', piPath, nodePath });
      if (r.status === 'failed') setError(r.error.message);
      else {
        setStatus(r.value);
        setPiPath(r.value.launch?.piPath ?? piPath);
        setNodePath(r.value.launch?.nodePath ?? nodePath);
      }
    } catch {
      setError('检测未完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!status?.reviewId || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await window.sessionManagement.savePiConfiguration({ reviewId: status.reviewId });
      if (r.status === 'failed') setError(r.error.message);
      else {
        setStatus(r.value);
        const paths = {
          piPath: r.value.launch?.piPath ?? piPath,
          nodePath: r.value.launch?.nodePath ?? nodePath,
        };
        setPiPath(paths.piPath);
        setNodePath(paths.nodePath);
        setSaved(paths);
        setNotice('启动配置已保存。');
      }
    } catch {
      setError('保存结果尚未确认，请重新读取配置后核对。');
    } finally {
      setBusy(false);
    }
  }
  async function refreshInstances() {
    setBusy(true);
    try {
      const r = await window.sessionManagement.getPiStatus();
      if (r.status === 'failed') setError(r.error.message);
      else setStatus((s) => (s ? { ...s, instances: r.value.instances } : r.value));
    } catch {
      setError('无法读取已连接实例，请重试。');
    } finally {
      setBusy(false);
    }
  }
  const edit = () => {
    setStatus((s) => (s ? { ...s, reviewId: undefined } : s));
    setNotice('');
  };
  return (
    <>
      <header className="settings-header">
        <h1>Pi 启动</h1>
        <p>默认自动查找 Pi 和 Node；需要排查启动问题时，可在这里手动检测。</p>
      </header>
      <div className="settings-content pi-preferences">
 <p className="settings-hint">
          {status?.configured
            ? '已保存启动配置。'
            : '尚未保存手动配置。打开会话时会自动查找常见安装位置。'}
        </p>
 <label>Pi 启动文件<input
            disabled={busy}
            value={piPath}
            onChange={(e) => {
              setPiPath(e.target.value);
              edit();
            }}
            placeholder="留空自动查找，或填写绝对路径"
          />
        </label>
        <label>Node 可执行文件<input
            disabled={busy}
            value={nodePath}
            onChange={(e) => {
              setNodePath(e.target.value);
              edit();
            }}
            placeholder="留空自动检测 Node 24+"
          />
        </label>
 <button className="settings-secondary" disabled={busy} onClick={() => void inspect()}>
          {busy ? '正在读取或检测…' : '检测 Pi 启动配置'}
        </button>
 {error && (
          <div role="alert" className="error-panel">
            <p>{error}</p>
            <button disabled={busy} onClick={() => void read()}>重新读取启动配置</button>
          </div>
        )}
        {status?.compatibility === 'incompatible' && (
          <p className="storage-error" role="alert">
            {status.error ?? '此入口目前支持 Pi 1.5.2 公开 SDK。'}
          </p>
        )}
 {status?.reviewId && (
          <section className="settings-review">
            <h2>检测结果</h2>
            <p>Pi {status.version}
            </p>
            <code>{status.launch?.piPath}</code>
            <code>{status.launch?.nodePath}</code>
            <p>保存后用于后续启动；保留用户自己的 Pi 扩展、模型设置和会话格式。</p>
            {status.legacyExtensionConfigured && <p>保存时仅移除旧版 Hub 登记的扩展路径，其他扩展和配置保持原样。</p>}
          </section>
        )}
 <details className="settings-instances">
          <summary>已连接实例</summary>
          <p className="settings-hint">这里显示由 Hub 启动的实例。Hub 退出后，外部终端继续运行。</p>
          {status?.instances.length ? (
            <ul className="runtime-instances">
              {status.instances.map((i) => (
                <li key={i.hostId ?? i.pid}>
                  <strong>
                    {i.state === 'busy'
                      ? '会话已开启 · 处理中'
                      : i.state === 'connected'
                        ? '会话已开启 · 空闲'
                        : '会话未连接'}
                  </strong>
                  <p>PID {i.pid} · {i.sessionId}
                  </p>
                  <p>{i.cwd}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p>暂无已连接实例。</p>
          )}
          <button
            className="settings-secondary"
            disabled={busy}
            onClick={() => void refreshInstances()}
          >重新读取实例</button>
        </details>
 </div>
      <footer className="settings-footer">
        <span role="status">{notice || (dirty ? '有未保存的更改' : '')}</span>
        <button
          className="primary"
          disabled={busy || !status?.reviewId}
          onClick={() => void save()}
        >保存启动配置</button>
      </footer>
    </>
  );
}
