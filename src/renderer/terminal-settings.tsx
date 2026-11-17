import React, { useEffect, useRef, useState } from 'react';
import { showDialog } from './dialog-focus';
import type {
  ExternalTerminal,
  TerminalSettings as Settings,
} from '../session-management/interface';

// This dialog belongs to an individual launch request, separate from persistent preferences.
export function TerminalSettings({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (terminal: ExternalTerminal, remember: boolean) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [settings, setSettings] = useState<Settings | null>(null),
    [selected, setSelected] = useState<ExternalTerminal | ''>(''),
    [remember, setRemember] = useState(false),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    const restore = showDialog(dialog.current);
    let active = true;
    void window.sessionManagement
      .getTerminalSettings()
      .then((r) => {
        if (!active) return;
        if (r.status === 'failed') setError(r.error.message);
        else {
          setSettings(r.value);
          setSelected(
            r.value.available.find((t) => t.terminal === r.value.defaultTerminal)?.terminal ??
              r.value.available[0]?.terminal ??
              '',
          );
        }
      })
      .catch(() => {
        if (active) setError('无法读取已安装的终端，请关闭后重试。');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      restore();
    };
  }, []);
  async function submit() {
    if (!selected || busy) return;
    setBusy(true);
    setError('');
    try {
      await onChoose(selected, remember);
    } catch {
      setError('终端选择未能完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog project-settings"
      aria-labelledby="terminal-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <div className="eyebrow">打开会话</div>
        <h2 id="terminal-title">选择终端</h2>
      </header>
      <div className="settings-body">
        {busy && !settings && <p role="status">正在查找已安装的终端…</p>}
        {settings && (
          <>
            <fieldset className="terminal-choices" disabled={busy}>
              <legend>已安装的终端</legend>
              {settings.available.map(({ terminal, installed }) => (
                <label key={terminal}>
                  <input
                    type="radio"
                    name="terminal-choice"
                    value={terminal}
                    checked={selected === terminal}
                    onChange={() => setSelected(terminal)}
                  />
                  <span>
                    {terminal} <small>{installed.version}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            {!settings.available.length && <p role="alert">没有找到可用的受支持终端。当前支持 Terminal 2.14 和 Ghostty 1.4.0。</p>}
            <label className="terminal-remember">
              <input
                type="checkbox"
                disabled={busy || !selected}
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />以当前选择为默认终端</label>
          </>
        )}
        {error && (
          <div className="error-panel" role="alert">
            <p>{error}</p>
          </div>
        )}
      </div>
      <footer>
        <button disabled={busy} onClick={onClose}>取消</button>
        <button className="primary" disabled={busy || !selected} onClick={() => void submit()}>
          {busy ? '正在处理…' : '打开会话'}
        </button>
      </footer>
    </dialog>
  );
}

export function TerminalSettingsPanel({
  onState,
}: {
  onState: (dirty: boolean, busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [selected, setSelected] = useState<ExternalTerminal | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const dirty = !!settings && selected !== settings.defaultTerminal,
    dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => onState(dirty, busy), [dirty, busy, onState]);
  async function read() {
    setBusy(true);
    try {
      const result = await window.sessionManagement.getTerminalSettings();
      if (result.status === 'failed') setError(result.error.message);
      else {
        setSettings(result.value);
        if (!dirtyRef.current) setSelected(result.value.defaultTerminal);
        setError('');
      }
    } catch {
      setError('无法读取已安装的终端，请重试。');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void read();
    return window.sessionManagement.onSettingsChanged(() => void read());
  }, []);
  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.sessionManagement.setDefaultTerminal({ terminal: selected });
      if (result.status === 'failed') setError(result.error.message);
      else {
        setSettings(result.value);
        setSelected(result.value.defaultTerminal);
        setNotice('终端设置已保存。');
      }
    } catch {
      setError('保存结果尚未确认，请重新读取设置后核对。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="settings-header">
        <h1>终端</h1>
        <p>选择从 Pi Hub 打开会话时使用的终端。</p>
      </header>
      <div className="settings-content">
 {busy && !settings && <p role="status">正在查找已安装的终端…</p>}
 {settings && (
          <>
            <fieldset className="terminal-choices" disabled={busy}>
              <legend>默认终端</legend>
              {settings.available.map(({ terminal, installed }) => (
                <label key={terminal}>
                  <input
                    type="radio"
                    name="default-terminal"
                    checked={selected === terminal}
                    onChange={() => {
                      setSelected(terminal);
                      setNotice('');
                    }}
                  />
                  <span>
                    {terminal}
                    <small>版本 {installed.version}
                    </small>
                  </span>
                </label>
              ))}
              <label>
                <input
                  type="radio"
                  name="default-terminal"
                  checked={selected === null}
                  onChange={() => {
                    setSelected(null);
                    setNotice('');
                  }}
                />
                <span>每次打开时选择<small>不保存默认终端</small>
                </span>
              </label>
            </fieldset>
            {settings.defaultTerminal &&
              !settings.available.some((t) => t.terminal === settings.defaultTerminal) && (
                <p className="storage-error" role="alert">已保存的 {settings.defaultTerminal} 当前不可用，请选择其他终端。</p>
              )}
            {!settings.available.length && <p>没有找到受支持的终端。当前支持 Terminal 2.14 和 Ghostty 1.4.0。</p>}
            <p className="settings-hint">保存后用于后续打开操作。正在运行的会话继续使用原终端。</p>
          </>
        )}
 {error && (
          <div className="error-panel" role="alert">
            <p>{error}</p>
            <button disabled={busy} onClick={() => void read()}>重新读取终端设置</button>
          </div>
        )}
      </div>
      <footer className="settings-footer">
        <span role="status">{notice || (dirty ? '有未保存的更改' : '')}</span>
        <button
          className="primary"
          disabled={
            busy ||
            !dirty ||
            (!!selected && !settings?.available.some((t) => t.terminal === selected))
          }
          onClick={() => void save()}
        >
          {busy ? '正在读取或保存…' : '保存终端设置'}
        </button>
      </footer>
    </>
  );
}
