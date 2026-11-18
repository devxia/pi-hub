import React, { useState, useEffect, useLayoutEffect, useRef, createContext, useContext } from 'react';
import { X } from 'lucide-react';
import type { Operation, Server, Task, Attempt, ExecutionRef, ReviewPage, TransferProgress } from '../remote/contract';
import { showDialog } from './dialog-focus';
export const ErrorContext = createContext('');
const labels: Record<string, string> = {
  unknown: '未知，待核对',
  queued: '排队',
  running: '运行中',
  cancelling: '正在请求停止',
  succeeded: '已成功',
  failed: '已失败',
  cancelled: '已取消',
  preparing: '正在制作审核快照',
  review: '待审批',
  expired: '已过期',
  approved: '已批准',
  done: '已完成',
  denied: '已拒绝',
  blocked: '已阻止',
  submit: '提交',
  cancel: '停止',
  fetch: '取回',
  observe: '观察',
  adopt: '只读关联',
  unverified: '未验收',
  forbidden: '不支持',
  verified: '已验收',
  sluid: '稳定身份取消',
  constraints: '控制器约束取消',
};
export const label = (value: string) => labels[value] ?? value;
export function displayError(value: string): string {
  const known: [string, string][] = [
    [
      'Unsupported or dynamic SSH directive',
      '不支持此 SSH 配置项。请选取明确 Host 的静态字段，移除 Include、Match 和命令钩子。',
    ],
    ['Unsupported SSH', '不支持此 SSH 配置。请选择明确的静态连接字段。'],
    ['Review and trust every SSH hop', '请先逐跳审核主机指纹，再检测连接。'],
    ['Approve the public host key for every SSH hop', '请先逐跳审核主机指纹，再检测连接。'],
    ['Probe the approved server first', '请先核对主机指纹，再检测连接与能力。'],
    [
      'Managed Linux launch is blocked',
      '此主机尚未完成登录退出保留验收，暂不能启动受管任务。请使用独立验收工具保留实际证据。',
    ],
    ['Host-bound acceptance', '能力尚未通过此主机和启动代次的实际验收；提交或取消保持关闭。'],
    [
      'Logout retention and controller cancellation',
      '登录退出保留策略和控制器取消需要在已授权主机完成实际验收。',
    ],
    [
      'Profile path is too long',
      '此配置路径超过私有套接字长度限制。GUI 仍可使用；请使用路径较短的独立配置启用 CLI。',
    ],
    ['SSH stopped', 'SSH 连接已停止。请核对地址、逐跳主机指纹和指定的公钥身份后重试。'],
    [
      'different digest',
      '此请求标识已绑定另一份摘要。请核对原操作，使用新请求标识发起修改后的操作。',
    ],
    ['expired', '授权或审批已过期，请重新核对并授权。'],
    ['scope changed', '任务范围已改变，请重新核对并授权。'],
    ['explicitly allowed artifacts', '请选择本次执行原先声明的结果文件或目录。'],
    ['Use a relative path', '请填写项目内的相对路径，勿使用上级目录或绝对路径。'],
    ['absolute', '请填写明确的绝对路径，或使用文件选择器。'],
    ['ENOENT', '文件或目录不存在。请选择有效的文件或目录后重试。'],
    ['Input', '输入校验未通过。请重新选择项目内的普通文件或目录并核对快照。'],
    ['Unsafe', '文件或路径校验未通过。请重新选择自有普通文件，勿使用符号链接或特殊文件。'],
    ['No CLI launcher', '请先检测 Node 24+ 并创建此配置的启动器。'],
    ['CLI unavailable', '此配置的 CLI 暂不可用，请检查 Node 与私有启动器配置。'],
    ['not configured', '尚未配置 CLI。请选择 Node 24+ 后创建私有启动器。'],
    ['Awaiting', '正在等待核对；不会因重连自动重复写入操作。'],
    ['Review', '请核对服务器、执行身份、输入摘要和结果范围后审批。'],
    ['Denied', '操作已拒绝，未执行。'],
    ['Unknown', '当前证据不足，状态保持未知。请刷新并核对已有操作。'],
    ['Intent persisted', '操作意图已保存，等待远端核对。'],
  ];
  const entry = known.find(([key]) => value.toLowerCase().includes(key.toLowerCase()));
  if (entry) return entry[1];
  if (/[\u3400-\u9fff]/.test(value)) return value;
  return '请查看技术详情并核对连接、权限与执行记录；当前信息未证明操作成功。';
}
export function DiagnosticMessage({ value }: { value?: string }) {
  if (!value) return null;
  const translated = displayError(value);
  return (
    <>
      <span>{translated}</span>
      {translated !== value && (
        <details>
          <summary>技术详情</summary>
          <pre className="remote-review" tabIndex={0}>
            {value}
          </pre>
        </details>
      )}
    </>
  );
}

export function HostFingerprint({ hostKey }: { hostKey: string }) {
  const [value, setValue] = useState('');
  useEffect(() => {
    let alive = true;
    try {
      const bytes = Uint8Array.from(atob(hostKey.split(' ')[1]), (c) => c.charCodeAt(0));
      void crypto.subtle.digest('SHA-256', bytes).then((b) => {
        if (alive)
          setValue('SHA256:' + btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=+$/, ''));
      });
    } catch {
      setValue('公钥格式需要核对');
    }
    return () => {
      alive = false;
    };
  }, [hostKey]);
  return <code>{value}</code>;
}
export function DetailOverlay({
  children,
  narrow,
  open,
  covered,
  opener,
  close,
}: {
  children: React.ReactNode;
  narrow: boolean;
  open: boolean;
  covered: boolean;
  opener: React.RefObject<HTMLButtonElement | null>;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeModal = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    if (narrow && open) {
      if (closeModal.current) return;
      dialog.open = false;
      // A resize can move the detail pane under an already open form or review.
      if (!covered) {
        closeModal.current = showDialog(dialog, opener.current?.isConnected ? opener.current : undefined);
      }
      return;
    }
    closeModal.current?.();
    closeModal.current = null;
    dialog.open = !narrow;
  }, [narrow, open, covered, opener]);
  useLayoutEffect(() => () => {
    closeModal.current?.();
    closeModal.current = null;
  }, []);
  return (
    <dialog
      ref={ref}
      className="remote-detail-overlay"
      role={narrow ? undefined : 'presentation'}
      aria-label={narrow ? '任务详情' : undefined}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {narrow && (
        <button className="remote-overlay-close" aria-label="关闭详情" onClick={close}>
          <X size={18} />
        </button>
      )}
      {children}
    </dialog>
  );
}
export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const error = useContext(ErrorContext);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => showDialog(ref.current), []);
  return (
    <dialog
      ref={ref}
      className="remote-dialog"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button aria-label="关闭" onClick={close}>
          <X size={18} />
        </button>
      </header>
      {error && (
        <div role="alert">
          <DiagnosticMessage value={error} />
        </div>
      )}
      {children}
    </dialog>
  );
}
export const resourceFields = [
  ['partition', '分区'],
  ['account', '账户'],
  ['qos', 'QoS'],
  ['minutes', '时限（分钟）'],
  ['memoryMB', '内存（MB）'],
  ['cpus', 'CPU 数'],
  ['gpus', 'GPU 数'],
  ['nodes', '节点数'],
] as const;

export function TaskConfiguration({ task }: { task: Task }) {
  const resources = Object.entries(task.resources ?? {});
  const environment = Object.entries(task.environment ?? {});
  return (
    <>
      <dl>
        {resources.map(([key, value]) => (
          <React.Fragment key={key}>
            <dt>{resourceFields.find(([k]) => k === key)?.[1] ?? key}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {environment.length ? (
        <ul>
          {environment.map(([key, value]) => (
            <li key={key}>
              <code>
                {key}={value}
              </code>
            </li>
          ))}
        </ul>
      ) : (
        <span>使用所选服务器的环境；未添加覆盖变量。</span>
      )}
      {task.progressMapping && (
        <p>
          进度文件：{task.progressMapping.file} · 已完成字段：{task.progressMapping.completed} ·
          总量字段：{task.progressMapping.total}
        </p>
      )}
    </>
  );
}
export function ExecutionIdentity({ refValue }: { refValue?: ExecutionRef }) {
  if (!refValue) return <span>尚未取得执行身份</span>;
  return (
    <dl>
      <dt>任务系统</dt>
      <dd>{refValue.kind === 'slurm' ? 'Slurm' : 'Linux'}</dd>
      {refValue.kind === 'slurm' ? (
        <>
          <dt>完整作业 ID</dt>
          <dd>{refValue.jobId}</dd>
          <dt>所属账户</dt>
          <dd>{refValue.owner}</dd>
          <dt>集群</dt>
          <dd>{refValue.cluster}</dd>
          <dt>提交时间</dt>
          <dd>{refValue.submittedAt}</dd>
          <dt>唯一作业名</dt>
          <dd>{refValue.name}</dd>
        </>
      ) : (
        <>
          <dt>主机与账户</dt>
          <dd>
            {refValue.host} / {refValue.user}
          </dd>
          <dt>启动代次</dt>
          <dd>{refValue.bootId}</dd>
        </>
      )}
    </dl>
  );
}
export function TransferCounts({ transfer }: { transfer?: TransferProgress }) {
  if (!transfer) return null;
  const { preparedBytes, acknowledgedBytes, totalBytes, publishedBytes } = transfer;
  return <small className="remote-transfer-counts">
    {preparedBytes !== undefined && <span>本地快照 {preparedBytes.toLocaleString()} 字节 </span>}
    {acknowledgedBytes !== undefined && <span>传输已确认 {acknowledgedBytes.toLocaleString()}
      {totalBytes !== undefined && ` / ${totalBytes.toLocaleString()}`} 字节 </span>}
    {publishedBytes !== undefined && <span>结果已发布 {publishedBytes.toLocaleString()} 字节</span>}
  </small>;
}
function ManifestEntries({ requestId, digest }: { requestId: string; digest: string }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ReviewPage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    setPage(null);
    setError('');
    void window.remoteWorkspace.request<ReviewPage>({ command: 'reviewPage', requestId, digest, offset })
      .then((reply) => {
        if (stopped) return;
        if (reply.ok) setPage(reply.value);
        else setError(reply.error);
      }).catch(() => { if (!stopped) setError('暂时无法读取审核清单。'); });
    return () => { stopped = true; };
  }, [requestId, digest, offset]);
  return <>
    {error ? <DiagnosticMessage value={error} /> : !page ? <p role="status">正在读取清单…</p> : (
      <div className="remote-manifest">
        {page.entries.map((f) => (
          <div key={f.path}>
            <strong>{f.path}</strong>
            {'size' in f ? <><span>{f.size} 字节</span><code>{f.sha256}</code></> : <span>目录</span>}
          </div>
        ))}
        {!page.entries.length && <p>无输入文件或目录</p>}
      </div>
    )}
    {offset > 0 && <button onClick={() => setOffset(0)}>返回清单首页</button>}
    {page?.next != null && <button onClick={() => setOffset(page.next!)}>清单下一页</button>}
  </>;
}
export function ReviewDetails({ operation }: { operation: Operation }) {
  const r = operation.review as {
    server?: Server;
    task?: Task;
    attempt?: Attempt;
    manifest?: {
      fileCount: number;
      directoryCount: number;
      totalBytes: number;
    };
    destinationRevision?: string;
  };
  const action = operation.action;
  return (
    <div className="remote-review-details">
      <dl>
        <dt>服务器</dt>
        <dd>
          {r.server?.name} · 配置版本 {r.server?.revision}
        </dd>
        <dt>连接路径</dt>
        <dd>{r.server?.hops.map((h) => h.user + '@' + h.host + ':' + h.port).join(' → ')}</dd>
        <dt>主机密钥指纹</dt>
        <dd>
          {r.server?.hops.map(
            (h, i) => h.hostKey && <HostFingerprint key={i} hostKey={h.hostKey} />,
          )}
        </dd>
        <dt>私有工作区</dt>
        <dd>{r.server?.root}</dd>
        {r.task && (
          <>
            <dt>项目</dt>
            <dd>{r.task.project}</dd>
            <dt>来源关联</dt>
            <dd>
              {r.task.source?.projectId} {r.task.source?.sessionId}
            </dd>
            <dt>环境与资源</dt>
            <dd>
              <TaskConfiguration task={r.task} />
            </dd>
            <dt>前台程序与参数</dt>
            <dd>
              <code>{r.task.argv.map((a) => JSON.stringify(a)).join(' ')}</code>
            </dd>
          </>
        )}
        {r.attempt && (
          <>
            <dt>执行</dt>
            <dd>{r.attempt.executionId}</dd>
            <dt>执行身份</dt>
            <dd>
              <ExecutionIdentity refValue={r.attempt.ref} />
            </dd>
          </>
        )}
        {action.kind === 'fetch' && (
          <>
            <dt>本地目标</dt>
            <dd>{action.destination}</dd>
            <dt>发布方式</dt>
            <dd>
              {action.overwrite ? '原子替换已核对的目录；保留原目录备份' : '原子创建新的目录'}
            </dd>
            <dt>结果范围</dt>
            <dd>{action.paths.join('、')}</dd>
          </>
        )}
      </dl>
      {r.manifest && (
        <>
          <h3>不可变输入快照</h3>
          <p>
            {r.manifest.fileCount} 个文件 · {r.manifest.directoryCount} 个目录 · 共{' '}
            {r.manifest.totalBytes.toLocaleString()} 字节
          </p>
          <ManifestEntries requestId={operation.requestId} digest={operation.digest} />
        </>
      )}
      <details>
        <summary>查看审批摘要详情</summary>
        <pre className="remote-review" tabIndex={0}>
          {JSON.stringify({ action, review: operation.review }, null, 2)}
        </pre>
      </details>
    </div>
  );
}
