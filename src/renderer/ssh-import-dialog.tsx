import { useState } from 'react';
import type { DefaultSSHPreview, Hop, Reply } from '../remote/contract';
import { ErrorContext, Modal } from './remote-presentation';

type Preview = { source: 'default'; result: DefaultSSHPreview } | { source: 'manual'; aliases: Hop[][] };

export function SSHImportDialog({ close, select }: { close: () => void; select: (hops: Hop[]) => void }) {
  const [config, setConfig] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState<'default' | 'file' | 'manual' | null>(null);
  const [error, setError] = useState('');

  async function load<T>(
    mode: NonNullable<typeof pending>,
    read: () => Promise<Reply<T>>,
    show: (value: T) => void,
  ) {
    setPending(mode);
    setError('');
    if (mode !== 'file') setPreview(null);
    try {
      const reply = await read();
      if (reply.ok) show(reply.value);
      else setError(reply.error);
    } catch {
      setError('暂时无法预览 SSH 配置，请重试。');
    } finally {
      setPending(null);
    }
  }

  function editConfig(value: string) {
    setConfig(value);
    setPreview(null);
    setError('');
  }

  const aliases = preview?.source === 'default' ? preview.result.aliases : preview?.aliases;
  const defaults = preview?.source === 'default' ? preview.result : null;
  return (
    <ErrorContext.Provider value={error}>
      <Modal title="导入 SSH 别名" close={close}>
        <p>从终端默认的 ~/.ssh/config 预览别名，也可以选择其他配置文件或粘贴片段。</p>
        <div className="remote-actions">
          <button
            type="button"
            className="primary"
            disabled={pending !== null}
            onClick={() => void load('default', () => window.remoteWorkspace.previewDefaultSSH(),
              (result) => setPreview({ source: 'default', result }))}
          >
            {pending === 'default' ? '正在读取默认配置…' : '使用默认 SSH 配置'}
          </button>
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void load('file', () => window.remoteWorkspace.choose('config'),
              (file) => { if (file.paths.length) editConfig(file.text ?? ''); })}
          >
            选择 SSH 配置文件…
          </button>
        </div>
        {preview && (
          <section aria-label="SSH 别名预览">
            <p role="status">
              {aliases?.length ? `选择要导入的别名（${aliases.length} 个）。` : '此来源没有可导入的别名。'}
              {defaults?.omitted.length ? ` 预览仅使用主文件中的静态声明，未解析 ${defaults.omitted.join('、')}。请核对连接地址和跳板。` : ''}
            </p>
            {aliases?.map((hops) => (
              <button
                type="button"
                className="remote-row"
                key={hops.at(-1)!.alias}
                disabled={pending !== null}
                onClick={() => select(hops)}
              >
                <strong>{hops.at(-1)!.alias}</strong>
                <span>{hops.map((hop) => `${hop.user}@${hop.host}${hop.port === 22 ? '' : `:${hop.port}`}`).join(' → ')}</span>
              </button>
            ))}
            {!!defaults?.skipped.length && (
              <details open={!aliases?.length}>
                <summary>{defaults.skipped.length} 个别名需要手动核对</summary>
                <ul>
                  {defaults.skipped.map(({ alias, reason }) => <li key={alias}>{alias}：{reason}</li>)}
                </ul>
              </details>
            )}
          </section>
        )}
        <form onSubmit={(event) => {
          event.preventDefault();
          void load('manual', () => window.remoteWorkspace.request<Hop[][]>({ command: 'importSSH', text: config }),
            (result) => setPreview({ source: 'manual', aliases: result }));
        }}>
          <label>
            SSH 配置片段
            <textarea name="config" required rows={8} value={config} disabled={pending !== null}
              onChange={(event) => editConfig(event.target.value)} />
          </label>
          <button type="submit" disabled={pending !== null}>预览别名</button>
        </form>
      </Modal>
    </ErrorContext.Provider>
  );
}
