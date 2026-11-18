import React, { useEffect, useRef, useState, createContext, useContext } from 'react';
import {
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  FolderDown,
  Square,
  Play,
  KeyRound,
  X,
} from 'lucide-react';
import { RemoteSidebar } from './remote-sidebar';
import { WorkspaceColumns } from './workspace-columns';
import type { useWorkspaceViewport } from './workspace-columns';
import { SSHImportDialog } from './ssh-import-dialog';
import type {
  Action,
  Attempt,
  Grant,
  Hop,
  Operation,
  OperationPage,
  AttemptPage,
  Reply,
  Request,
  Server,
  Snapshot,
  Task,
} from '../remote/contract';
import {
  ErrorContext,
  HostFingerprint,
  DetailOverlay,
  Modal,
  resourceFields,
  label,
  displayError,
  DiagnosticMessage,
  ExecutionIdentity,
  ReviewDetails,
  TransferCounts,
} from './remote-presentation';
const formEnvironment = (f: FormData, name: string) =>
  Object.fromEntries(
    lines(f.get(name)).map((line) => {
      const n = line.indexOf('=');
      return [n > 0 ? line.slice(0, n) : '', n > 0 ? line.slice(n + 1) : ''];
    }),
  );
const formResources = (f: FormData, prefix = '') =>
  Object.fromEntries(
    resourceFields.flatMap(([key]) =>
      val(f, prefix + key)
        ? [
            [
              key,
              ['partition', 'account', 'qos'].includes(key)
                ? val(f, prefix + key)
                : Number(val(f, prefix + key)),
            ],
          ]
        : [],
    ),
  );
const lines = (s: FormDataEntryValue | null) =>
  String(s ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
const val = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
export function RemoteWorkspace({
  back,
  openSource,
  openPi,
  viewport,
}: {
  back: () => void;
  openSource?: (source: NonNullable<Task['source']>) => void;
  openPi: (taskId: string) => void;
  viewport: ReturnType<typeof useWorkspaceViewport>;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(''),
    [selected, setSelected] = useState(''),
    [taskId, setTaskId] = useState(''),
    [attemptId, setAttemptId] = useState(''),
    [dialog, setDialog] = useState<
      'server' | 'import' | 'task' | 'grant' | 'cli' | 'fetch' | 'adopt' | 'capability' | null
    >(null),
    [reviewId, setReviewId] = useState<string | null>(null),
    [requestedReview, setRequestedReview] = useState<Operation | null>(null),
    [operationHistory, setOperationHistory] = useState<OperationPage | null>(null),
    [attemptHistory, setAttemptHistory] = useState<(AttemptPage & {serverId: string}) | null>(null),
    [editing, setEditing] = useState<Server | null>(null),
    [busy, setBusy] = useState(false),
    [adopting, setAdopting] = useState<import('../remote/contract').ExecutionRef | null>(null);
  const [agentKeys, setAgentKeys] = useState<{
    index: number;
    values: { key: string; fingerprint: string }[];
    form: HTMLFormElement;
  } | null>(null);
  const [candidates, setCandidates] = useState<{
    index: number;
    values: { key: string; fingerprint: string }[];
    form: HTMLFormElement;
  } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false),
    [phaseFilter, setPhaseFilter] = useState('all'),
    [editingTask, setEditingTask] = useState<Task | null>(null);
  const detailOpener = useRef<HTMLButtonElement>(null);
  const epoch = useRef<string | null>(null),
    sequence = useRef(0),
    retired = useRef(new Set<string>());
  async function call<T = unknown>(r: Request): Promise<T | undefined> {
    try {
      const result = await window.remoteWorkspace.request<T>(r);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!['snapshot', 'watch'].includes(r.command)) setError('');
      return result.value;
    } catch {
      setError('远端工作区暂时不可用，请稍后刷新。');
    }
  }
  async function choose(
    form: HTMLFormElement,
    name: string,
    kind: import('../remote/contract').RemoteChoice,
    project?: string,
  ) {
    const r = await window.remoteWorkspace.choose(kind, project);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (!r.value.paths.length) return;
    const control = form.elements.namedItem(name) as HTMLInputElement;
    control.value = r.value.text ?? r.value.paths.join('\n');
    control.dispatchEvent(new Event('input', { bubbles: true }));
  }
  async function discoverHop(form: HTMLFormElement, index: number) {
    const f = new FormData(form),
      hops = (editing?.hops ?? [{ alias: 'destination', host: '', user: '', port: 22 }]).map(
        (h, i) => ({
          ...h,
          alias: val(f, `alias-${i}`),
          host: val(f, `host-${i}`),
          user: val(f, `user-${i}`),
          port: Number(val(f, `port-${i}`)),
          identityFile: val(f, `keyfile-${i}`) || undefined,
          hostKey: val(f, `hostkey-${i}`) || undefined,
          agent: f.get(`agent-${i}`) === 'on' ? ('environment' as const) : undefined,
          agentIdentity: val(f, `agentkey-${i}`) || undefined,
        }),
      );
    const result = await call<{ key: string; fingerprint: string }[]>({
      command: 'discoverHost',
      server: {
        id: editing?.id ?? crypto.randomUUID(),
        revision: 0,
        name: val(f, 'name') || '待核对主机',
        backend: 'linux',
        root: val(f, 'root') || '/tmp/pi-hub-discovery',
        hops,
      },
      hop: index,
    });
    if (result) setCandidates({ index, values: result, form });
  }
  async function load() {
    const s = await call<Snapshot>({ command: 'snapshot' });
    if (!s || retired.current.has(s.generation)) return;
    if (epoch.current !== s.generation) {
      if (epoch.current) retired.current.add(epoch.current);
      epoch.current = s.generation;
      sequence.current = 0;
    }
    if (s.sequence <= sequence.current) return;
    sequence.current = s.sequence;
    setSnapshot(s);
    setSelected((previous) => previous || s.servers[0]?.id || '');
  }
  useEffect(() => {
    let running = false,
      stopped = false;
    const poll = async () => {
      if (running || stopped) return;
      running = true;
      await load();
      running = false;
    };
    void poll();
    const timer = setInterval(() => {
      if (!document.hidden) void poll();
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    void window.remoteWorkspace.request({
      command: 'watch',
      serverId: selected || null,
      attemptId: attemptId || null,
    });
    return () => {
      void window.remoteWorkspace.request({
        command: 'watch',
        serverId: null,
        attemptId: null,
      });
    };
  }, [selected, attemptId]);
  useEffect(() => {
    if (!reviewId) return;
    let stopped = false;
    let running = false;
    const poll = async () => {
      if (running || stopped) return;
      running = true;
      const reply = await window.remoteWorkspace.request<Operation>({
        command: 'operation', requestId: reviewId,
      }).catch(() => undefined);
      running = false;
      if (!stopped && reply?.ok) setRequestedReview(reply.value);
    };
    void poll();
    const timer = setInterval(() => void poll(), 750);
    return () => { stopped = true; clearInterval(timer); };
  }, [reviewId]);
  const review = requestedReview?.requestId === reviewId ? requestedReview : null;
  const closeReview = () => { setReviewId(null); setRequestedReview(null); };
  const shownAttemptHistory = attemptHistory?.serverId === selected ? attemptHistory : null;
  async function loadAttemptPage(offset: number) {
    const result = await call<AttemptPage>({ command: 'attempts', serverId: selected, offset });
    if (result) setAttemptHistory({ ...result, serverId: selected });
  }
  async function loadOperationPage(offset: number) {
    const result = await call<OperationPage>({ command: 'operations', offset });
    if (result) setOperationHistory(result);
  }
  const server = snapshot?.servers.find((s) => s.id === selected),
    tasks = snapshot?.tasks.filter((t) => t.serverId === selected) ?? [],
    task = tasks.find((t) => t.id === taskId),
    recentAttempts = snapshot?.attempts.filter((a) => a.server.id === selected) ?? [],
    attempts = shownAttemptHistory?.attempts ?? recentAttempts,
    attempt = recentAttempts.find((a) => a.id === attemptId) ?? attempts.find((a) => a.id === attemptId);
  async function propose(action: Action) {
    setBusy(true);
    const op = await call<Operation>({
      command: 'propose',
      requestId: crypto.randomUUID(),
      action,
    });
    setBusy(false);
    if (op) {
      setRequestedReview(op);
      setReviewId(op.requestId);
      await load();
    }
  }
  async function saveServer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget),
      hops: Hop[] = (
        editing?.hops ?? [{ alias: 'destination', host: '', user: '', port: 22 }]
      ).map((h, i) => ({
        alias: val(f, `alias-${i}`),
        host: val(f, `host-${i}`),
        user: val(f, `user-${i}`),
        port: Number(val(f, `port-${i}`)),
        ...(val(f, `keyfile-${i}`) ? { identityFile: val(f, `keyfile-${i}`) } : {}),
        ...(val(f, `cert-${i}`) ? { certificateFile: val(f, `cert-${i}`) } : {}),
        ...(f.get(`agent-${i}`) === 'on'
          ? { agent: 'environment' as const, agentIdentity: val(f, `agentkey-${i}`) }
          : {}),
        ...(val(f, `hostkey-${i}`) ? { hostKey: val(f, `hostkey-${i}`) } : {}),
      }));
    const s: Server = {
      disabled: f.get('disabled') === 'on',
      id: editing?.id ?? crypto.randomUUID(),
      revision: editing?.revision ?? 0,
      name: val(f, 'name'),
      backend: val(f, 'backend') as Server['backend'],
      root: val(f, 'root'),
      hops,
      defaults: {
        environment: formEnvironment(f, 'defaultEnvironment'),
        resources: formResources(f, 'default-'),
      },
    };
    const result = await call({ command: 'saveServer', server: s });
    if (result) {
      setDialog(null);
      setSelected(s.id);
      await load();
    }
  }
  const displayTask = attempt ? attempt.taskSnapshot : task;
  const resultPaths = attempt?.taskSnapshot?.artifacts;
  const detail = (
    <aside className="remote-detail" aria-label="任务详情">
      <header>
        <h2>{attempt ? '执行详情' : displayTask ? '任务详情' : '任务与审批'}</h2>
      </header>
      {displayTask && (
        <>
          <h3>{displayTask.name}</h3>
          <code>{displayTask.argv.join(' ')}</code>
          <p>{displayTask.project}</p>
          <p>输入：{displayTask.inputs.join('、') || '无'}</p>
          {displayTask.source && (
            <p>
              来源：{displayTask.source.projectId} {displayTask.source.sessionId}
              {displayTask.source.sessionId &&
                displayTask.source.kind !== 'external' &&
                openSource && (
                  <button onClick={() => openSource(displayTask.source!)}>
                    查看关联的本地会话
                  </button>
                )}
            </p>
          )}
          <p>
            配置版本：{displayTask.serverRevision}
            {!attempt && server && displayTask.serverRevision !== server.revision
              ? ' · 请编辑并核对新的服务器配置'
              : ''}
          </p>
          <p>结果范围：{displayTask.artifacts.join('、') || '无'}</p>
          {!attempt && (
            <>
              <button onClick={() => openPi(displayTask.id)}>
                <Terminal size={15} />
                在 Pi 中打开
              </button>
              <button
                onClick={() => {
                  setEditingTask(displayTask);
                  setDialog('task');
                }}
              >
                编辑任务与配置版本…
              </button>
              <button
                disabled={busy}
                onClick={() => void propose({ kind: 'submit', taskId: displayTask.id })}
              >
                <Play size={15} />
                准备提交
              </button>
            </>
          )}
        </>
      )}
      {attempt && (
        <>
          <h3>{label(attempt.phase)}</h3>
          {attempt.scopeEnded && (
            <p>
              前台作用域已结束；主程序退出码：{attempt.mainExit?.code ?? '未知'}
              。信号与取消原因仅按可证实的记录显示。
            </p>
          )}
          <div>
            <DiagnosticMessage value={attempt.detail} />
          </div>
          <dl>
            <dt>执行身份</dt>
            <dd>{attempt.executionId}</dd>
            <dt>输入摘要</dt>
            <dd>{attempt.inputDigest || '外部任务'}</dd>
          </dl>
          {attempt.owned && (
            <div className="remote-actions">
              <button
                disabled={busy || !attempt.ref}
                onClick={() =>
                  void propose({ kind: 'cancel', attemptId: attempt.id, force: false })
                }
              >
                <Square size={14} />
                请求停止
              </button>
              {attempt.ref?.kind === 'linux' && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void propose({ kind: 'cancel', attemptId: attempt.id, force: true })
                  }
                >
                  强制结束…
                </button>
              )}
              {resultPaths?.length ? (
                <button disabled={busy} onClick={() => setDialog('fetch')}>
                  <FolderDown size={15} />
                  取回结果…
                </button>
              ) : (
                <p>
                  {resultPaths ? '本次执行未声明可取回的结果。' : '本次执行缺少原始结果声明。'}
                </p>
              )}
            </div>
          )}
          {attempt.progress && (
            <section>
              <h3>{attempt.progress.stage}</h3>
              <progress max={attempt.progress.total} value={attempt.progress.completed} />
              <p>
                {attempt.progress.completed} / {attempt.progress.total} ·{' '}
                {new Date(attempt.progress.updatedAt).toLocaleString()}
              </p>
              <p>进度由程序报告；100% 仍需等待执行结束的权威记录。</p>
              {Object.entries(attempt.progress.metrics).map(([key, value]) => (
                <p key={key}>
                  {key}：{value}
                </p>
              ))}
            </section>
          )}
          <h3>日志</h3>
          <pre tabIndex={0} className="remote-log">
            {attempt.log || '暂无日志。离线时保留最后观察，未知不代表失败或完成。'}
          </pre>
        </>
      )}
      {!displayTask && !attempt && (
        <p>选择任务查看命令、输入和执行记录。连接断开后，任务状态保留最后一次观察。</p>
      )}
      {server && (
        <div className="remote-grants">
          <h3>Agent 授权</h3>
          <button disabled={!task} onClick={() => setDialog('grant')}>
            <KeyRound size={15} />
            授权所选任务…
          </button>
          {snapshot?.grants
            .filter((g) => g.serverId === server.id)
            .map((g) => (
              <div key={g.id}>
                <p>
                  {g.actions.map(label).join(' / ')} ·{' '}
                  {g.revoked ? '已撤销' : new Date(g.expiresAt).toLocaleString()}
                </p>
                <code>{g.tokenPath}</code>
                <button
                  disabled={g.revoked}
                  onClick={async () => {
                    await call({ command: 'revoke', grantId: g.id });
                    await load();
                  }}
                >
                  撤销
                </button>
              </div>
            ))}
        </div>
      )}
    </aside>
  );
  return (
    <ErrorContext.Provider value={error}>
      <WorkspaceColumns kind="remote" viewport={viewport} blocked={!!(dialog || reviewId || (viewport.narrow && detailOpen))}>
        <RemoteSidebar
          servers={snapshot?.servers}
          selected={selected}
          back={back}
          select={(id) => {
            setSelected(id);
            setTaskId('');
            setAttemptId('');
          }}
          add={() => {
            setEditing(null);
            setDialog('server');
          }}
          importAlias={() => {
            setError('');
            setDialog('import');
          }}
          openCli={() => setDialog('cli')}
        />
        <main id="remote-list" className="remote-tasks">
          <header className="scope-header">
            <div>
              <h1>{server?.name ?? '远端任务'}</h1>
              <span className="scope-count">
                {server
                  ? `${server.backend === 'linux' ? '普通 Linux' : 'Slurm'} · 配置版本 ${server.revision}`
                  : '连接、审批与执行状态分开记录'}
              </span>
            </div>
            {server && (
              <button
                className="settings-trigger"
                onClick={() => {
                  setEditing(server);
                  setDialog('server');
                }}
              >
                服务器设置
              </button>
            )}
          </header>
          {error && (
            <div className="remote-notice" role="alert">
              <DiagnosticMessage value={error} />
              <button aria-label="关闭提示" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {!snapshot && <p className="remote-empty">正在打开独立远端工作区…</p>}
          {server && (
            <>
              <section className="remote-capability">
                <div>
                  <ShieldCheck size={18} />
                  <strong>{server.capability ? '主机已观察' : '尚未检测主机'}</strong>
                </div>
                <p>
                  {server.capability
                    ? `${server.capability.host} · ${server.capability.user} · Linux 保留能力：${label(server.capability.retention)} · 取消能力：${label(server.capability.cancel)}`
                    : '为每一跳填写并核对公钥后，才能连接。检测不提交任务。'}
                </p>
                <div>
                  <DiagnosticMessage value={server.capability?.reason} />
                </div>
                {server.lastError && (
                  <div role="status">
                    <DiagnosticMessage value={server.lastError} />
                  </div>
                )}
                <div className="remote-actions">
                  <button onClick={() => setDialog('capability')}>查看能力验收要求</button>
                  <button onClick={() => void call({ command: 'probe', serverId: server.id })}>
                    检测连接与能力
                  </button>
                  <button
                    onClick={() => void call({ command: 'interrupt', serverId: server.id })}
                  >
                    中断当前连接
                  </button>
                  <button
                    onClick={() => void call({ command: 'refresh', serverId: server.id })}
                  >
                    <RefreshCw size={14} />
                    刷新任务状态
                  </button>
                </div>
              </section>
              <section className="remote-operations">
                <h2>服务器队列 · 只读</h2>
                <form
                  className="remote-lookup"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await call({
                      command: 'lookup',
                      serverId: server.id,
                      identifier: val(new FormData(e.currentTarget), 'identifier'),
                    });
                  }}
                >
                  <label>
                    查找已有 {server.backend === 'slurm' ? '完整 JobID' : 'PID'}
                    <input name="identifier" required pattern="[0-9_+]+" />
                  </label>
                  <button>查找并核对身份</button>
                </form>
                <p>
                  <DiagnosticMessage
                    value={
                      snapshot?.queues.find((q) => q.serverId === server.id)?.detail ??
                      '点击刷新任务状态，观察当前用户的队列。'
                    }
                  />
                </p>
                {snapshot?.queues
                  .find((q) => q.serverId === server.id)
                  ?.rows.map((row, i) => (
                    <button
                      className="remote-row"
                      key={i}
                      onClick={() => {
                        setAdopting(row.ref);
                        setDialog('adopt');
                      }}
                    >
                      <strong title={row.name} className="remote-row-heading">
                        <span className="remote-row-title">{row.name}</span>
                        <span>{label(row.phase)}</span>
                      </strong>
                      <small>关联只读记录</small>
                    </button>
                  ))}
              </section>
              <div className="remote-section-title">
                <h2>任务</h2>
                <button
                  onClick={() => {
                    setEditingTask(null);
                    setDialog('task');
                  }}
                >
                  <Plus size={15} />
                  新建任务
                </button>
              </div>
              <div className="remote-list">
                {tasks.map((t) => (
                  <button
                    key={t.id}
                    className={`remote-row ${taskId === t.id ? 'selected' : ''}`}
                    onClick={(event) => {
                      detailOpener.current = event.currentTarget;
                      setTaskId(t.id);
                      setAttemptId('');
                      setDetailOpen(true);
                    }}
                  >
                    <strong className="remote-row-title" title={t.name}>{t.name}</strong>
                    <span>{t.argv.join(' ')}</span>
                    <small>{t.project}</small>
                  </button>
                ))}
                {tasks.length === 0 && (
                  <p className="remote-empty">
                    新建任务，选择输入和允许取回的结果。每次提交都会生成独立执行记录。
                  </p>
                )}
              </div>
              <div className="remote-section-title">
                <h2>执行记录</h2>
                <select
                  aria-label="筛选执行状态"
                  value={phaseFilter}
                  onChange={(e) => setPhaseFilter(e.target.value)}
                >
                  <option value="all">全部</option>
                  <option value="queued">排队</option>
                  <option value="running">运行</option>
                  <option value="ended">结束</option>
                  <option value="attention">需要处理</option>
                </select>
                <span>{attempts.length}</span>
              </div>
              <div className="remote-list">
                {attempts
                  .filter(
                    (a) =>
                      phaseFilter === 'all' ||
                      (phaseFilter === 'ended' &&
                        ['succeeded', 'failed', 'cancelled'].includes(a.phase)) ||
                      (phaseFilter === 'attention' &&
                        ['unknown', 'cancelling'].includes(a.phase)) ||
                      a.phase === phaseFilter,
                  )
                  .map((a) => (
                    <button
                      key={a.id}
                      className={`remote-row ${attemptId === a.id ? 'selected' : ''}`}
                      onClick={(event) => {
                        detailOpener.current = event.currentTarget;
                        setAttemptId(a.id);
                        setTaskId(a.taskId);
                        setDetailOpen(true);
                      }}
                    >
                      <strong className="remote-row-heading">
                        <span className="remote-row-title" title={a.taskSnapshot?.name}>{a.taskSnapshot?.name ?? '已有任务'}</span>
                        <span className="remote-phase">{label(a.phase)}</span>
                      </strong>
                      <span>
                        {a.ref?.kind === 'slurm' ? a.ref.jobId : a.id.slice(0, 8)} ·{' '}
                        {a.owned ? 'Hub 管理' : '只读关联'}
                      </span>
                      <small>
                        {a.lastObservedAt
                          ? new Date(a.lastObservedAt).toLocaleString()
                          : '尚无远端观察'}
                      </small>
                    </button>
                  ))}
              </div>
              {shownAttemptHistory && (
                <button onClick={() => setAttemptHistory(null)}>返回近期执行</button>
              )}
              {(shownAttemptHistory ? shownAttemptHistory.next :
                snapshot?.watchingServer === selected ? snapshot.nextAttemptPage : null) != null && (
                <button onClick={() => void loadAttemptPage(
                  (shownAttemptHistory ? shownAttemptHistory.next : snapshot?.nextAttemptPage)!,
                )}>更早的执行</button>
              )}
            </>
          )}
          <section className="remote-operations">
            <h2>待审与近期操作</h2>
            {(operationHistory?.operations ?? snapshot?.operations)?.map((op) => (
                <button
                  className="remote-row"
                  key={op.requestId}
                  onClick={() => setReviewId(op.requestId)}
                >
                  <strong>
                    {label(op.action.kind)} · {label(op.status)}
                  </strong>
                  <small>{displayError(op.detail)}</small>
                  <TransferCounts transfer={op.transfer} />
                </button>
              ))}
            {operationHistory && (
              <button onClick={() => setOperationHistory(null)}>返回近期待审</button>
            )}
            {(operationHistory ? operationHistory.next : snapshot?.nextOperationPage) != null && (
              <button onClick={() => void loadOperationPage(
                (operationHistory ? operationHistory.next : snapshot?.nextOperationPage)!,
              )}>更早的操作</button>
            )}
            {snapshot?.operations.length === 0 && (
              <p>Agent 的写入请求也会在这里等待你的审批。</p>
            )}
          </section>
        </main>
        <DetailOverlay
          narrow={viewport.narrow}
          open={detailOpen}
          covered={!!(dialog || reviewId)}
          opener={detailOpener}
          close={() => setDetailOpen(false)}
        >
          {detail}
        </DetailOverlay>
      </WorkspaceColumns>
      {dialog === 'capability' && server && (
          <Modal title="能力验收要求" close={() => setDialog(null)}>
            <p>
              普通 Linux 的登录退出保留策略和 Slurm
              的安全取消需要在获授权的实际主机验收。未确认或过期时，相应操作保持关闭。
            </p>
            <h3>{server.backend === 'linux' ? 'Linux 受管前台任务' : 'Slurm 稳定取消'}</h3>
            <p>
              {server.backend === 'linux'
                ? '必须验证最后 SSH 登录退出后的持续运行、主程序先退出后的辅助进程意外丢失、TERM 后代、KILL 后代、两级 ECHILD、崩溃后不重发、自然完成与取消竞态。仅支持不自行 daemonize 或脱离进程组的前台程序。'
                : '必须验证 controller 原子约束、JobID 复用、owner/cluster 不匹配、唯一作业名，并记录 controller 版本。外部登记的作业始终只读。'}
            </p>
            <p>
              授权操作方使用 Agent CLI
              设置中提供的独立验收启动器，显式指定已核对的服务器配置与新证据目录。工具运行实际检查、保存原始证据，全部通过后才能发布{' '}
              {server.backend === 'linux' ? 'linux-capability.json' : 'slurm-capability.json'}
              。记录使用 schema=1，绑定以下主机身份、当前 supervisor
              摘要，工具生成一天的有效期；重启、资源更新或到期后重新核对。此窗口不会代写通过记录。
            </p>
            <dl>
              <dt>主机与账户</dt>
              <dd>
                {server.capability?.host ?? '先检测连接'} /{' '}
                {server.capability?.user ?? '先检测连接'}
              </dd>
              <dt>启动代次</dt>
              <dd>{server.capability?.bootId ?? '先检测连接'}</dd>
              <dt>监督程序摘要</dt>
              <dd>
                <code>{server.capability?.supervisorHash ?? '先检测连接'}</code>
              </dd>
              <dt>私有工作区</dt>
              <dd>{server.root}</dd>
            </dl>
            <p>
              发布实际记录后，选择「检测连接与能力」重新核对。没有主机验收时，仍可使用只读观察、任务草稿与审批准备。
            </p>
            <details>
              <summary>验收工具的静态服务器配置</summary>
              <p>
                仅保存到此任务专用的私有文件；所有跳点必须已核对。不要把配置作为 Agent 授权。
              </p>
              <pre className="remote-review" tabIndex={0}>
                {JSON.stringify(
                  {
                    id: server.id,
                    revision: server.revision,
                    name: server.name,
                    backend: server.backend,
                    root: server.root,
                    hops: server.hops,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </Modal>
        )}
        {dialog === 'server' && (
          <Modal
            title={editing?.revision ? '服务器设置' : '添加服务器'}
            close={() => setDialog(null)}
          >
            <form onSubmit={saveServer}>
              <label>
                名称
                <input name="name" required maxLength={120} defaultValue={editing?.name} />
              </label>
              <label>
                任务系统
                <select name="backend" defaultValue={editing?.backend ?? 'linux'}>
                  <option value="linux">普通 Linux</option>
                  <option value="slurm">Slurm</option>
                </select>
              </label>
              <label className="remote-check">
                <input type="checkbox" name="disabled" defaultChecked={editing?.disabled} />
                停用此服务器（保留观察记录）
              </label>
              <label>
                私有远端工作目录
                <input
                  name="root"
                  required
                  placeholder="/home/user/pi-hub"
                  defaultValue={editing?.root}
                />
              </label>
              {(editing?.hops ?? [{ alias: 'destination', host: '', user: '', port: 22 }]).map(
                (h, i) => (
                  <fieldset key={i}>
                    <legend>
                      {i === (editing?.hops.length ?? 1) - 1 ? '目标主机' : `跳板 ${i + 1}`}
                    </legend>
                    <label>
                      别名
                      <input name={`alias-${i}`} required defaultValue={h.alias} />
                    </label>
                    <label>
                      主机
                      <input name={`host-${i}`} required defaultValue={h.host} />
                    </label>
                    <label>
                      用户
                      <input name={`user-${i}`} required defaultValue={h.user} />
                    </label>
                    <label>
                      端口
                      <input
                        name={`port-${i}`}
                        type="number"
                        min={1}
                        max={65535}
                        required
                        defaultValue={h.port}
                      />
                    </label>
                    <label>
                      私钥路径（不读取密钥内容）
                      <input
                        name={`keyfile-${i}`}
                        defaultValue={h.identityFile}
                        placeholder="/absolute/path/to/key"
                      />
                    </label>
                    <label>
                      证书路径（可选）
                      <input name={`cert-${i}`} defaultValue={h.certificateFile} />
                    </label>
                    <label className="remote-check">
                      <input
                        type="checkbox"
                        name={`agent-${i}`}
                        defaultChecked={h.agent === 'environment'}
                      />
                      显式使用当前 SSH Agent（仅允许下方选定的公钥）
                    </label>
                    <label>
                      Agent 公钥（使用 Agent 时必填）
                      <input
                        name={`agentkey-${i}`}
                        defaultValue={h.agentIdentity}
                        placeholder="ssh-ed25519 AAAA…"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={async (e) => {
                        const form = e.currentTarget.form!;
                        const keys = await call<{ key: string; fingerprint: string }[]>({
                          command: 'agentIdentities',
                        });
                        if (keys) setAgentKeys({ index: i, values: keys, form });
                      }}
                    >
                      选择 Agent 身份…
                    </button>
                    <button
                      type="button"
                      onClick={(e) =>
                        void choose(e.currentTarget.form!, `keyfile-${i}`, 'identity')
                      }
                    >
                      选择身份文件…
                    </button>
                    <label>
                      已核对的主机公钥
                      <input
                        name={`hostkey-${i}`}
                        defaultValue={h.hostKey}
                        placeholder="ssh-ed25519 AAAA…"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={(e) => void discoverHop(e.currentTarget.form!, i)}
                    >
                      获取候选主机指纹…
                    </button>
                    <button
                      type="button"
                      onClick={async (e) => {
                        const form = e.currentTarget.form!;
                        const r = await window.remoteWorkspace.choose('knownHosts');
                        if (!r.ok) {
                          setError(r.error);
                          return;
                        }
                        const host = (form.elements.namedItem(`host-${i}`) as HTMLInputElement)
                            .value,
                          port = (form.elements.namedItem(`port-${i}`) as HTMLInputElement)
                            .value;
                        const names = new Set([host, `[${host}]:${port}`, h.alias]);
                        const keys = (r.value.text ?? '').split(/\r?\n/).flatMap((line) => {
                          const words = line.trim().split(/\s+/);
                          return words[0]?.split(',').some((n) => names.has(n)) &&
                            /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)$/.test(words[1])
                            ? [{ key: words.slice(1, 3).join(' '), fingerprint: '' }]
                            : [];
                        });
                        if (!keys.length)
                          setError(
                            '没有与当前地址匹配的显式 known_hosts 条目；哈希条目请通过候选指纹核对。',
                          );
                        else setCandidates({ index: i, values: keys, form });
                      }}
                    >
                      选择 known_hosts 核对…
                    </button>
                    {h.hostKey && <HostFingerprint hostKey={h.hostKey} />}
                    <p>
                      请从可信渠道核对每一跳的完整主机公钥。保存后修改公钥会产生新的配置版本，旧审批失效。
                    </p>
                  </fieldset>
                ),
              )}
              <fieldset>
                <legend>新任务默认环境与 Slurm 资源</legend>
                <label>
                  默认环境（每行 NAME=value）
                  <textarea
                    name="defaultEnvironment"
                    defaultValue={Object.entries(editing?.defaults?.environment ?? {})
                      .map(([k, v]) => k + '=' + v)
                      .join('\n')}
                  />
                </label>
                {resourceFields.map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      name={'default-' + key}
                      defaultValue={editing?.defaults?.resources?.[key]}
                    />
                  </label>
                ))}
              </fieldset>
              <footer>
                <button type="button" onClick={() => setDialog(null)}>
                  取消
                </button>
                <button type="submit">保存服务器</button>
              </footer>
            </form>
          </Modal>
        )}
        {(candidates || agentKeys) && (
          <Modal
            title={candidates ? '核对候选主机指纹' : '选择允许的 Agent 身份'}
            close={() => {
              setCandidates(null);
              setAgentKeys(null);
            }}
          >
            <p>
              {candidates
                ? '候选公钥尚未受信任。请通过管理员等独立渠道核对完整 SHA256 指纹，然后明确选择。更换已有公钥将使旧审批失效。'
                : '只会使用明确选择的公钥，不会尝试 Agent 内其他身份。'}
            </p>
            {(candidates ?? agentKeys)!.values.map((k) => (
              <div className="remote-row" key={k.key}>
                <HostFingerprint hostKey={k.key} />
                <code>{k.key}</code>
                <button
                  onClick={() => {
                    const item = (candidates ?? agentKeys)!;
                    const field = item.form.elements.namedItem(
                      `${candidates ? 'hostkey' : 'agentkey'}-${item.index}`,
                    ) as HTMLInputElement;
                    field.value = k.key;
                    if (agentKeys)
                      (
                        item.form.elements.namedItem(`agent-${item.index}`) as HTMLInputElement
                      ).checked = true;
                    setCandidates(null);
                    setAgentKeys(null);
                  }}
                >
                  已核对，使用此公钥
                </button>
              </div>
            ))}
          </Modal>
        )}
        {dialog === 'import' && (
          <SSHImportDialog
            close={() => setDialog(null)}
            select={(hops) => {
              setEditing({
                id: crypto.randomUUID(),
                revision: 0,
                name: hops.at(-1)!.alias,
                backend: 'linux',
                root: '',
                hops,
              });
              setDialog('server');
            }}
          />
        )}
        {dialog === 'task' && server && (
          <Modal title={editingTask ? '编辑任务' : '新建任务'} close={() => setDialog(null)}>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const t: Task = {
                  id: editingTask?.id ?? crypto.randomUUID(),
                  serverId: server.id,
                  serverRevision: server.revision,
                  name: val(f, 'name'),
                  project: val(f, 'project'),
                  argv: [val(f, 'executable'), ...lines(f.get('args'))],
                  inputs: lines(f.get('inputs')),
                  artifacts: lines(f.get('artifacts')),
                  ...(val(f, 'progressFile')
                    ? {
                        progressMapping: {
                          file: val(f, 'progressFile'),
                          stage: val(f, 'progressStage') || undefined,
                          completed: val(f, 'progressCompleted'),
                          total: val(f, 'progressTotal'),
                          metrics: formEnvironment(f, 'progressMetrics'),
                        },
                      }
                    : {}),
                  environment: formEnvironment(f, 'environment'),
                  resources: server.backend === 'slurm' ? formResources(f) : {},
                  ...(val(f, 'sourceProject') || val(f, 'sourceSession')
                    ? {
                        source: {
                          kind: val(f, 'sourceKind') as 'native' | 'external',
                          ...(val(f, 'sourceIdentity')
                            ? { identity: val(f, 'sourceIdentity') }
                            : {}),
                          ...(val(f, 'sourceProject')
                            ? { projectId: val(f, 'sourceProject') }
                            : {}),
                          ...(val(f, 'sourceSession')
                            ? { sessionId: val(f, 'sourceSession') }
                            : {}),
                        },
                      }
                    : {}),
                };
                if (await call({ command: 'saveTask', task: t })) {
                  setDialog(null);
                  setTaskId(t.id);
                  setDetailOpen(true);
                  await load();
                }
              }}
            >
              <p>将保存为当前服务器配置版本 {server.revision}。已开始的执行保留原配置。</p>
              <label>
                名称
                <input name="name" required defaultValue={editingTask?.name} />
              </label>
              <label>
                本地项目目录
                <input
                  name="project"
                  required
                  defaultValue={editingTask?.project}
                  placeholder="/absolute/project"
                />
              </label>
              <button
                type="button"
                onClick={(e) => void choose(e.currentTarget.form!, 'project', 'project')}
              >
                选择项目目录…
              </button>
              <label>
                前台可执行程序
                <input
                  name="executable"
                  required
                  defaultValue={editingTask?.argv[0]}
                  placeholder="python3"
                />
              </label>
              <label>
                参数（每行一个）
                <textarea
                  name="args"
                  rows={3}
                  defaultValue={editingTask?.argv.slice(1).join('\n')}
                  placeholder="train.py"
                />
              </label>
              <label>
                输入文件或目录（相对项目，每行一个）
                <textarea
                  name="inputs"
                  rows={4}
                  defaultValue={editingTask?.inputs.join('\n')}
                />
              </label>
              <button
                type="button"
                onClick={(e) => {
                  const form = e.currentTarget.form!;
                  void choose(form, 'inputs', 'inputs', val(new FormData(form), 'project'));
                }}
              >
                选择输入文件或目录…
              </button>
              <p>
                目录会递归展开；快照跳过常见凭据与缓存目录，拒绝符号链接、硬链接和特殊文件。审批显示完整清单和总量。
              </p>
              <label>
                允许取回的结果（相对输出目录，每行一个）
                <textarea
                  name="artifacts"
                  rows={3}
                  defaultValue={editingTask?.artifacts.join('\n')}
                  placeholder="stdout.log"
                />
              </label>
              <fieldset>
                <legend>已有 JSON 指标映射（可选）</legend>
                <label>
                  输出 JSON 文件（也需加入结果范围）
                  <input
                    name="progressFile"
                    defaultValue={editingTask?.progressMapping?.file}
                  />
                </label>
                <label>
                  阶段字段
                  <input
                    name="progressStage"
                    defaultValue={editingTask?.progressMapping?.stage}
                  />
                </label>
                <label>
                  已完成字段
                  <input
                    name="progressCompleted"
                    defaultValue={editingTask?.progressMapping?.completed ?? 'completed'}
                  />
                </label>
                <label>
                  总量字段
                  <input
                    name="progressTotal"
                    defaultValue={editingTask?.progressMapping?.total ?? 'total'}
                  />
                </label>
                <label>
                  指标映射（每行 名称=JSON.字段）
                  <textarea
                    name="progressMetrics"
                    defaultValue={Object.entries(editingTask?.progressMapping?.metrics ?? {})
                      .map(([k, v]) => k + '=' + v)
                      .join('\n')}
                  />
                </label>
              </fieldset>
              <label>
                环境变量（每行 NAME=value）
                <textarea
                  name="environment"
                  rows={3}
                  defaultValue={Object.entries(
                    editingTask?.environment ?? server.defaults?.environment ?? {},
                  )
                    .map(([k, v]) => k + '=' + v)
                    .join('\n')}
                  placeholder="OMP_NUM_THREADS=4"
                />
              </label>
              <p>
                允许
                LANG、LC_ALL、OMP_NUM_THREADS、MKL_NUM_THREADS、OPENBLAS_NUM_THREADS、CUDA_VISIBLE_DEVICES、NVIDIA_VISIBLE_DEVICES、TOKENIZERS_PARALLELISM。
              </p>
              {server.backend === 'slurm' && (
                <fieldset>
                  <legend>Slurm 资源（可选，留空使用集群默认值）</legend>
                  {resourceFields.map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        name={key}
                        defaultValue={
                          (editingTask?.resources ?? server.defaults?.resources)?.[key]
                        }
                      />
                    </label>
                  ))}
                </fieldset>
              )}
              <label>
                来源类型
                <select name="sourceKind" defaultValue={editingTask?.source?.kind ?? 'native'}>
                  <option value="native">本地 Pi 会话</option>
                  <option value="external">外部 Agent 标签</option>
                </select>
              </label>
              <label>
                来源物理身份（可选、用于同 ID 消歧）
                <input name="sourceIdentity" defaultValue={editingTask?.source?.identity} />
              </label>
              <label>
                来源项目 ID（可选、仅关联）
                <input name="sourceProject" defaultValue={editingTask?.source?.projectId} />
              </label>
              <label>
                来源 Pi 会话 ID（可选、仅关联）
                <input name="sourceSession" defaultValue={editingTask?.source?.sessionId} />
              </label>
              <p>
                仅支持不自行脱离进程组的前台程序。程序可通过 PI_HUB_OUTPUT
                写入输出目录。每次提交先制作独立的输入快照并审批。
              </p>
              <footer>
                <button type="button" onClick={() => setDialog(null)}>
                  取消
                </button>
                <button type="submit">保存任务</button>
              </footer>
            </form>
          </Modal>
        )}
        {dialog === 'fetch' && attempt && resultPaths?.length ? (
          <Modal title="取回结果" close={() => setDialog(null)}>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                setDialog(null);
                await propose({
                  kind: 'fetch',
                  attemptId: attempt.id,
                  paths: lines(f.get('paths')),
                  destination: val(f, 'destination'),
                  overwrite: f.get('overwrite') === 'on',
                });
              }}
            >
              <label>
                结果路径（每行一个）
                <textarea name="paths" required defaultValue={resultPaths.join('\n')} />
              </label>
              <label>
                新的本地目录
                <input name="destination" required placeholder="/absolute/results/run-1" />
              </label>
              <button
                type="button"
                onClick={(e) =>
                  void choose(e.currentTarget.form!, 'destination', 'destination')
                }
              >
                选择结果目录…
              </button>
              <label className="remote-check">
                <input type="checkbox" name="overwrite" />
                替换已存在的结果目录（单独核对目录版本）
              </label>
              <p>
                仅取回允许的普通文件，不解压或执行。替换会原子交换整个目录，原目录保留在旁边的私有备份路径。
              </p>
              <footer>
                <button type="button" onClick={() => setDialog(null)}>
                  取消
                </button>
                <button>准备取回</button>
              </footer>
            </form>
          </Modal>
        ) : null}
        {dialog === 'grant' && task && server && (
          <Modal title="授权 Agent" close={() => setDialog(null)}>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const grant = {
                  serverId: server.id,
                  project: task.project,
                  taskIds: [task.id],
                  actions: f.getAll('actions') as Grant['actions'],
                  expiresAt: Date.now() + Number(f.get('minutes')) * 60000,
                };
                if (await call({ command: 'grant', grant })) {
                  setDialog(null);
                  await load();
                }
              }}
            >
              <p>
                授权仅适用于 {server.name} / {task.name}。写入请求仍需在本窗口核对并审批。
              </p>
              {['observe', 'submit', 'cancel', 'fetch', 'adopt'].map((a) => (
                <label className="remote-check" key={a}>
                  <input
                    type="checkbox"
                    name="actions"
                    value={a}
                    defaultChecked={a === 'observe'}
                  />
                  {label(a)}
                </label>
              ))}
              <label>
                有效分钟数
                <input name="minutes" type="number" min={1} max={1440} defaultValue={30} />
              </label>
              <footer>
                <button type="button" onClick={() => setDialog(null)}>
                  取消
                </button>
                <button>创建私有授权文件</button>
              </footer>
            </form>
          </Modal>
        )}
        {dialog === 'cli' && (
          <Modal title="Agent CLI" close={() => setDialog(null)}>
            <div>
              <DiagnosticMessage value={snapshot?.cli.detail} />
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                await call({ command: 'configureCLI', nodePath: val(f, 'node') });
                await load();
              }}
            >
              <label>
                Node 24+ 可执行文件
                <input name="node" required placeholder="/absolute/path/to/node" />
              </label>
              <button>检测并创建此配置的启动器</button>
            </form>
            {snapshot?.cli.acceptanceLauncher && (
              <>
                <p>独立能力验收启动器（只用于明确授权的合成资源）</p>
                <code>{snapshot.cli.acceptanceLauncher}</code>
                <p>
                  显式参数：
                  <code>
                    --authorize-owned-resources --server-file /absolute/server.json
                    --evidence-dir /new/evidence --publish
                  </code>
                  。Slurm 还需显式指定已授权的第二集群。
                </p>
              </>
            )}
            {snapshot?.cli.launcher && (
              <>
                <p>在终端使用此启动器；授权令牌从私有文件读取。</p>
                <code>{snapshot.cli.launcher}</code>
                <p>
                  <code>--grant-file /absolute/grant.json list</code>
                </p>
                <p>
                  <code>
                    --grant-file /absolute/grant.json propose request-id '
                    {'{"kind":"submit","taskId":"…"}'}'
                  </code>
                </p>
              </>
            )}
          </Modal>
        )}
        {dialog === 'adopt' && server && adopting && (
          <Modal title="关联已有任务（只读）" close={() => setDialog(null)}>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                if (
                  await call({
                    command: 'adopt',
                    serverId: server.id,
                    job: adopting,
                    logs: lines(f.get('logs')),
                  })
                ) {
                  setDialog(null);
                  await load();
                }
              }}
            >
              <p>
                此执行不会获得提交、取消或取回权限。日志只读取明确指定的、自有普通文件；不读取管道。
              </p>
              <ExecutionIdentity refValue={adopting} />
              <details>
                <summary>技术详情</summary>
                <pre className="remote-review">{JSON.stringify(adopting, null, 2)}</pre>
              </details>
              <label>
                远端日志绝对路径（可选，最多两个）
                <textarea name="logs" rows={2} />
              </label>
              <button>关联只读任务</button>
            </form>
          </Modal>
        )}
        {reviewId && (
          <Modal title="核对远端操作" close={closeReview}>
            {!review ? <p role="status">正在读取操作状态…</p> : <>
            <p>
              {review.action.kind === 'cancel' && review.action.force
                ? '强制结束会向整个已核对的前台作用域发送 KILL。请单独核对。'
                : displayError(review.detail)}
            </p>
            <p>
              状态：{label(review.status)} · 有效至{' '}
              {new Date(review.expiresAt).toLocaleString()}
            </p>
            <TransferCounts transfer={review.transfer} />
            <ReviewDetails key={review.requestId + ':' + review.digest} operation={review} />
            {review.digest && <label>
              审批摘要<code>{review.digest}</code>
            </label>}
            <footer>
              <button onClick={closeReview}>关闭</button>
              {review.status === 'review' && (
                <>
                  <button
                    onClick={async () => {
                      await call({
                        command: 'approve',
                        requestId: review.requestId,
                        digest: review.digest,
                        allow: false,
                      });
                      closeReview();
                      await load();
                    }}
                  >
                    拒绝
                  </button>
                  <button
                    disabled={review.expiresAt <= Date.now()}
                    onClick={async () => {
                      const r = await call({
                        command: 'approve',
                        requestId: review.requestId,
                        digest: review.digest,
                        allow: true,
                      });
                      if (r) {
                        closeReview();
                        await load();
                      }
                    }}
                  >
                    批准此操作
                  </button>
                </>
              )}
            </footer>
            </>}
          </Modal>
        )}
    </ErrorContext.Provider>
  );
}
