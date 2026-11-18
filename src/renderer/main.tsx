import { RemoteWorkspace } from './remote-workspace';
import { WorkspaceColumns, useWorkspaceViewport } from './workspace-columns';
import { RenameDialog } from './rename-dialog';
import { CloneDialog } from './clone-dialog';
import { SessionActions } from './session-actions';
import { deleteOutcomeMessage } from './delete-outcome';
import { DeleteDialog } from './delete-dialog';
import { TerminalOperationDialog } from './terminal-operation-dialog';
import { DirectoryRecoveryDialog } from './directory-recovery-dialog';
import { TerminalSettings } from './terminal-settings';
import { SettingsApp } from './settings-app';
import { runtimeLabel } from './runtime-label';
import { useSessionOrder } from './session-order';
import React, { useEffect, useState, useRef, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive,
  Folder,
  FolderPlus,
  Inbox,
  PanelRight,
  Plus,
  Settings,
  AlertCircle,
  MessageSquare,
  Terminal,
  Search,
  GripVertical,
} from 'lucide-react';
import type {
  DesktopSessionManagement,
  Project,
  ManagedSession,
  ImportBatch,
  WorkspaceSnapshot,
  OpenSessionRequest,
} from '../session-management/interface';
import { selectSessions } from '../session-management/session-list';
import { PreviewPanel } from './preview-panel';
import { ProjectSettings } from './project-settings';
import { ImportDialog } from './import-dialog';
import './styles.css';
declare global {
  interface Window {
    sessionManagement: DesktopSessionManagement;
  }
}

function App() {
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [menuAction, setMenuAction] = useState<{
    row: WorkspaceSnapshot['sessions'][number];
    type: 'rename' | 'clone' | 'classify' | 'exit';
    hostId?: string;
  } | null>(null);
  const menuOpening = useRef(false);
  async function sessionMenu(key: string, point?: { x: number; y: number }) {
    if (menuOpening.current || menuAction || deleting) return;
    menuOpening.current = true;
    try {
      const result = await window.sessionManagement.showSessionMenu({ key, ...point });
      if (result.status === 'failed') {
        setNotice(result.error.message);
        return;
      }
      const choice = result.value;
      if (!choice) return;
      const snapshot = await loadWorkspace(),
        row = snapshot.sessions.find((s) => s.key === choice.key && s.identity === choice.identity);
      if (!row) {
        setNotice('会话已变化，请重新选择。');
        return;
      }
      if (choice.action === 'open') await openTerminal(row.projectId, row.key);
      else if (choice.action === 'locate') await locateSession(row.key);
      else if (choice.action === 'copy-id') setNotice('已复制完整 SessionID。');
      else if (choice.action === 'reveal') setNotice('已在访达中显示会话文件。');
      else if (choice.action === 'delete') {
        const index = visible.findIndex((s) => s.key === row.key);
        setDeleting({
          key: row.key,
          title: row.title,
          neighbors: [...visible.slice(index + 1), ...visible.slice(0, index).reverse()].map(
            (s) => s.key,
          ),
          scroll: listRef.current?.scrollTop ?? 0,
        });
      } else
        setMenuAction({
          row:
            choice.action === 'classify'
              ? {
                  ...row,
                  classification: choice.classification!,
                  classificationRevision: choice.classificationRevision,
                }
              : row,
          type: choice.action,
          ...(choice.hostId ? { hostId: choice.hostId } : {}),
        });
    } catch {
      setNotice('会话菜单未能打开，请重试。');
    } finally {
      menuOpening.current = false;
    }
  }
  function closeSessionAction() {
    const key = menuAction?.row.key;
    setMenuAction(null);
    requestAnimationFrame(() =>
      document.getElementById('session-' + key)?.focus({ preventScroll: true }),
    );
  }
  const completedDeleteFocus = useRef<{ key: string; scroll: number } | null>(null);
  const [deleting, setDeleting] = useState<{
    key: string;
    title: string;
    neighbors: string[];
    scroll: number;
  } | null>(null);
  useEffect(() => {
    if (deleting || !completedDeleteFocus.current) return;
    const target = completedDeleteFocus.current;
    completedDeleteFocus.current = null;
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = target.scroll;
      (document.getElementById(`session-${target.key}`) ?? searchRef.current)?.focus({
        preventScroll: true,
      });
    });
  }, [deleting]);
  const [terminalFeedback, setTerminalFeedback] = useState<{
    terminal?: import('../session-management/interface').ExternalTerminal;
    requestId: string;
    outcome: import('../session-management/interface').TerminalOutcome | null;
    error: string;
  } | null>(null);
  const [pendingTerminal, setPendingTerminal] = useState<{
    outcome: import('../session-management/interface').TerminalOutcome;
    started: number;
  } | null>(null);
  function terminalOutcome(
    outcome: import('../session-management/interface').TerminalOutcome,
    awaitConnection = false,
  ) {
    if (outcome.state === 'bound' || outcome.state === 'located') {
      setTerminalFeedback(null);
      setPendingTerminal(null);
      setTerminalCommandRequest('');
      setNotice('');
      return;
    }
    if (awaitConnection && outcome.state === 'uncertain' && !outcome.errorCode) {
      setTerminalFeedback(null);
      setPendingTerminal({ outcome, started: Date.now() });
      return;
    }
    setPendingTerminal(null);
    setTerminalFeedback({ requestId: outcome.requestId, outcome, error: '' });
    if (outcome.canRetry) setTerminalCommandRequest(outcome.requestId);
  }
  useEffect(() => {
    if (!pendingTerminal) return;
    let stopped = false,
      inFlight = false;
    const refresh = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const r = await window.sessionManagement.getTerminalOutcome({
          requestId: pendingTerminal.outcome.requestId,
        });
        if (stopped) return;
        if (
          r.status === 'completed' &&
          r.value &&
          (r.value.state !== 'uncertain' || r.value.errorCode)
        ) {
          terminalOutcome(r.value);
          return;
        }
        if (Date.now() - pendingTerminal.started >= 15000) {
          setPendingTerminal(null);
          setTerminalFeedback({
            requestId: pendingTerminal.outcome.requestId,
            outcome: pendingTerminal.outcome,
            error: r.status === 'failed' ? r.error.message : '',
          });
        }
      } catch {
        if (!stopped && Date.now() - pendingTerminal.started >= 15000) {
          setPendingTerminal(null);
          setTerminalFeedback({
            requestId: pendingTerminal.outcome.requestId,
            outcome: pendingTerminal.outcome,
            error: '启动回执尚未确认，请核对原请求。',
          });
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void refresh(), 750);
    void refresh();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingTerminal]);
  const [terminalCommandRequest, setTerminalCommandRequest] = useState('');
  const [recovering, setRecovering] = useState<OpenSessionRequest | null>(null);
  const [terminalPicker, setTerminalPicker] = useState<OpenSessionRequest | null>(null);
  const [terminalName, setTerminalName] = useState('终端');
  useEffect(() => {
    const read = () => {
      void window.sessionManagement
        .getTerminalSettings()
        .then((r) => {
          if (r.status === 'completed') setTerminalName(r.value.defaultTerminal ?? '终端');
        })
        .catch(() => {});
    };
    read();
    return window.sessionManagement.onSettingsChanged(read);
  }, []);
  const [newProjectPicker, setNewProjectPicker] = useState(false);
  const [newProjectId, setNewProjectId] = useState('');
  const newDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (newProjectPicker) newDialog.current?.showModal();
  }, [newProjectPicker]);
  const terminalBusy = useRef(new Set<string>());
  const [terminalWorking, setTerminalWorking] = useState(false);
  async function openTerminal(projectId: string, key?: string) {
    const session = latestWorkspace.current?.sessions.find((s) => s.key === key);
    await launchRequest({
      requestId: crypto.randomUUID(),
      intent: key ? 'resume' : 'new',
      projectId,
      ...(session ? { key: session.key, identity: session.identity } : {}),
    });
  }
  async function launchRequest(request: OpenSessionRequest) {
    const target = request.key ?? (request.remoteTaskId ? 'remote:' + request.remoteTaskId : 'new:' + request.projectId);
    if (terminalBusy.current.has(target)) return;
    terminalBusy.current.add(target);
    setTerminalWorking(true);
    setNotice('');
    setTerminalFeedback(null);
    setPendingTerminal(null);
    setTerminalCommandRequest('');
    try {
      const r = await window.sessionManagement.openTerminal(request);
      if (r.status === 'failed') {
        if (r.error.code === 'RECOVERY_REQUIRED' && request.key) {
          setTerminalFeedback(null);
          setNewProjectPicker(false);
          setRecovering(request);
        } else if (r.error.code === 'TERMINAL_MISSING') {
          setTerminalFeedback(null);
          setNewProjectPicker(false);
          setTerminalPicker(request);
        } else {
          setTerminalFeedback({
            requestId: request.requestId,
            outcome: null,
            error: r.error.message,
          });
          setNotice(r.error.message);
        }
      } else {
        if (r.value.terminal) setTerminalName(r.value.terminal);
        terminalOutcome(r.value, true);
        setNewProjectPicker(false);
      }
    } catch {
      setTerminalFeedback({
        requestId: request.requestId,
        outcome: null,
        error: '本次启动回执未确认，请核对原操作。',
      });
    } finally {
      terminalBusy.current.delete(target);
      setTerminalWorking(false);
    }
  }
  async function locateSession(key: string) {
    const r = await window.sessionManagement.locateSession({ key });
    if (r.status === 'failed') setNotice(r.error.message);
    else terminalOutcome(r.value);
  }
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const appliedRevision = useRef(-1);
  const latestWorkspace = useRef<WorkspaceSnapshot | null>(null);
  const [scope, setScope] = useState('all');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    title: string;
    message: string;
    retry: 'read' | 'choose';
    existingProjectId?: string;
  } | null>(null);
  const [createdCopyKey, setCreatedCopyKey] = useState('');
  const [notice, setNotice] = useState('');
  const [cancelledScan, setCancelledScan] = useState(false);
  const [settings, setSettings] = useState<Project | null>(null);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'recent' | 'name' | 'created' | 'manual'>('recent');
  const [allScope, setAllScope] = useState<'main' | 'all'>('main');
  const [archiveProject, setArchiveProject] = useState('');
  const viewport = useWorkspaceViewport();
  const { narrow } = viewport;
  const [selected, setSelected] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    setCreatedCopyKey((key) => (key === selected ? key : ''));
  }, [selected]);
  const positions = useRef(new Map<string, { page: number; scroll: number }>());
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const current = projects.find((project) => project.id === scope);
  const title = current?.name ?? (scope === 'archive' ? '归档' : '全部会话');
  const sessionScope = {
    classification:
      scope === 'archive' ? ('archive' as const) : current ? ('main' as const) : allScope,
    projectId: scope === 'archive' ? archiveProject : current?.id,
  };
  const displayOrder = useSessionOrder(listRef);
  const baseRows = selectSessions(sessions, projects, {
    ...sessionScope,
    search,
    sort: sort === 'manual' ? 'recent' : sort,
  });
  const visible = sort === 'manual' ? displayOrder.arrange(baseRows) : baseRows;
  const [dragging, setDragging] = useState(''),
    [dropTarget, setDropTarget] = useState('');
  const dragSource = useRef('');
  function reorder(source: string, target: string) {
    displayOrder.move(
      source,
      target,
      visible.slice(pageIndex * 50, pageIndex * 50 + 50).map((row) => row.key),
    );
    setSort('manual');
    setNotice('展示顺序已更新。可拖动或用 Option + 上下方向键调整。');
  }
  function endDrag() {
    dragSource.current = '';
    setDragging('');
    setDropTarget('');
  }
  const selectedSession = workspace?.sessions.find((session) => session.key === selected);
  const outsideScope =
    selectedSession && !selectSessions([selectedSession], projects, sessionScope).length;
  const outsideResults = selectedSession && !visible.some((session) => session.key === selected);
  const matchesSearch =
    selectedSession &&
    selectSessions([selectedSession], projects, { classification: 'all', search }).length > 0;
  const actualChange =
    selectedSession?.classificationChange?.revision === selectedSession?.classificationRevision
      ? selectedSession?.classificationChange
      : undefined;
  const retainedPreviewNotice =
    !previewOpen || !outsideResults
      ? ''
      : !matchesSearch
        ? '此会话不在当前搜索结果中；预览已保留。'
        : selectedSession?.classification === 'archive' &&
            sessionScope.classification === 'main' &&
            actualChange?.cause === 'manual'
          ? '此会话已归档，已移出当前主列表；预览已保留；可在归档列表的右键菜单恢复到主列表。'
          : selectedSession?.classification === 'main' && scope === 'archive' && actualChange
            ? `${actualChange.cause === 'message' ? '此会话新增对话，已自动恢复到主列表' : '此会话已手动恢复到主列表'}；已移出归档范围，预览已保留。`
            : '此会话不在当前范围中；预览已保留。';
  const pageIndex = Math.min(page, Math.max(0, Math.ceil(visible.length / 50) - 1));
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = positions.current.get(scope)?.scroll ?? 0;
  }, [scope]);
  function closePreview() {
    setPreviewOpen(false);
    requestAnimationFrame(() => {
      const button = document.getElementById(`session-${selected}`);
      (button ?? searchRef.current)?.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape' && previewOpen) {
        event.preventDefault();
        closePreview();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selected, previewOpen]);
  const archivedCount = sessions.filter(
    (session) =>
      session.classification === 'archive' && (!current || session.projectId === current.id),
  ).length;
  const emptyState =
    scope === 'archive'
      ? {
          Icon: Archive,
          heading: '暂无归档会话',
          description: '导入时未选择的历史会话会保留在这里。',
          canAdd: false,
        }
      : projects.length === 0
        ? {
            Icon: FolderPlus,
            heading: '从一个项目开始',
            description:
              '选择你的工作目录，再选择要加入主列表的历史会话。\n默认只包含所选目录本身。',
            canAdd: true,
          }
        : archivedCount > 0
          ? {
              Icon: Archive,
              heading: '历史会话已归档',
              description: `此范围有 ${archivedCount} 条归档会话，可在左侧「归档」中查看。`,
              canAdd: false,
            }
          : {
              Icon: Inbox,
              heading: '暂无已导入会话',
              description: '此范围尚无已导入的会话记录。',
              canAdd: false,
            };
  function applySnapshot(snapshot: WorkspaceSnapshot) {
    if (snapshot.revision < appliedRevision.current) return;
    appliedRevision.current = snapshot.revision;
    latestWorkspace.current = snapshot;
    setWorkspace(snapshot);
    setProjects(snapshot.projects);
    setSessions(snapshot.sessions);
    setLoaded(true);
    setScope((current) =>
      current === 'all' || current === 'archive' || snapshot.projects.some((p) => p.id === current)
        ? current
        : 'all',
    );
    setArchiveProject((current) =>
      snapshot.projects.some((p) => p.id === current) ? current : '',
    );
    setSelected((current) => (snapshot.sessions.some((s) => s.key === current) ? current : ''));
  }
  async function loadWorkspace() {
    const result = await window.sessionManagement.getSnapshot();
    if (result.status === 'failed') throw Error(result.error.message);
    applySnapshot(result.value);
    setError(null);
    return latestWorkspace.current ?? result.value;
  }
  async function scan(cancel = false) {
    if (!cancel) setCancelledScan(false);
    const result = await (cancel
      ? window.sessionManagement.cancelReconciliation()
      : window.sessionManagement.reconcile());
    if (result.status === 'failed')
      setError({ title: '同步未完成', message: result.error.message, retry: 'read' });
    else if (result.value.error)
      setError({ title: '同步未完成', message: result.value.error.message, retry: 'read' });
    else {
      setError(null);
      if (cancel && result.value.state === 'cancelled') setCancelledScan(true);
    }
  }
  async function refresh() {
    setBusy(true);
    try {
      await loadWorkspace();
      const imports = await window.sessionManagement.listImports();
      if (imports.status === 'failed') throw Error(imports.error.message);
      setBatch(imports.value.find((batch) => batch.purpose !== 'storage') ?? null);
      if (imports.value.some((batch) => batch.purpose === 'storage'))
        await window.sessionManagement.showSettings();
    } catch (error) {
      setError({
        title: '未能读取项目',
        message: `${String(error)} 已保存的项目未被更改。`,
        retry: 'read',
      });
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const unsubscribe = window.sessionManagement.subscribe(-1, applySnapshot);
    void refresh();
    return unsubscribe;
  }, []);
  function changeScope(next: string) {
    positions.current.set(scope, { page, scroll: listRef.current?.scrollTop ?? 0 });
    setCreatedCopyKey('');
    setSelected('');
    setScope(next);
    setPage(positions.current.get(next)?.page ?? 0);
    setPreviewOpen(false);
    setError((current) => (current?.existingProjectId === next ? null : current));
  }
  async function add() {
    setBusy(true);
    setNotice('');
    setError(null);
    try {
      const result = await window.sessionManagement.chooseProject({
        requestId: crypto.randomUUID(),
      });
      if (result.status === 'failed') {
        setError({
          title: '未能添加项目',
          message: `${result.error.message} 已有项目保持不变。`,
          existingProjectId: result.error.existingProjectId,
          retry: result.error.code === 'BACKGROUND_UNAVAILABLE' ? 'read' : 'choose',
        });
        return;
      }
      if (result.value) {
        setBatch(result.value);
      }
    } catch {
      setError({
        title: '尚未确认项目添加结果',
        message: '请重新读取项目，核对未完成的导入。已有项目保持不变。',
        retry: 'read',
      });
    } finally {
      setBusy(false);
    }
  }
  async function imported(done: ImportBatch) {
    await loadWorkspace();
    if (done.purpose !== 'storage' && (done.purpose !== 'expand' || scope !== done.project.id))
      changeScope(done.project.id);
    const outcome = done.outcome!;
    setNotice(
      `${
        done.purpose === 'storage'
          ? '存储位置已添加 · 添加时'
          : done.purpose === 'expand'
            ? '项目范围已更新 · 调整时'
            : '项目已添加 · 添加时'
      }：${outcome.main} 条加入主列表 · ${outcome.archived} 条归档${
        outcome.removed ? ` · ${outcome.removed} 条已删除，未导入` : ''
      }${outcome.queued ? ` · ${outcome.queued} 条新记录待同步` : ''}${
        done.purpose === 'storage'
          ? (done.scopeOutcomes ?? [])
              .map(
                (result) =>
                  ` · ${done.projects?.find((p) => p.id === result.projectId)?.name ?? ''}：主列表 ${result.main} / 归档 ${result.archived}`,
              )
              .join('')
          : ''
      }`,
    );
    setBatch(null);
    const pending = await window.sessionManagement.listImports();
    if (pending.status === 'completed')
      setBatch(pending.value.find((batch) => batch.purpose !== 'storage') ?? null);
  }
  const addButton = (primary = false) => (
    <button
      className={primary ? 'primary' : 'add-project'}
      onClick={add}
      disabled={busy || !loaded || !!batch}
    >
      <Plus size={16} aria-hidden="true" />添加项目</button>
  );
  const recoveringSession = recovering && workspace?.sessions.find((s) => s.key === recovering.key);
  const terminalDialogs = (
    <>
    {terminalFeedback && (
        <TerminalOperationDialog
          terminalName={terminalFeedback.terminal ?? (terminalWorking ? '外部终端' : terminalName)}
          initial={terminalFeedback.outcome}
          requestId={terminalFeedback.requestId}
          error={terminalFeedback.error}
          working={terminalWorking}
          onClose={() => setTerminalFeedback(null)}
          onChanged={terminalOutcome}
        />
      )}
    {recovering && recoveringSession && workspace && (
        <DirectoryRecoveryDialog
          terminalName={recovering.terminal ?? terminalName}
          session={recoveringSession}
          projects={workspace.projects}
          onClose={() => setRecovering(null)}
          onContinue={async (runtimeProjectId) => {
            const request = { ...recovering, runtimeProjectId };
            setRecovering(null);
            await launchRequest(request);
          }}
        />
      )}
    {terminalPicker && (
        <TerminalSettings
          onClose={() => setTerminalPicker(null)}
          onChoose={async (terminal, rememberTerminal) => {
            const request = { ...terminalPicker, terminal, rememberTerminal };
            setTerminalPicker(null);
            setTerminalName(terminal);
            await launchRequest(request);
          }}
        />
      )}
    </>
  );
  if (remoteOpen) return (
    <div className="app-shell">
      <div className="titlebar"><span>Pi Hub</span></div>
      <RemoteWorkspace
        viewport={viewport}
        back={() => setRemoteOpen(false)}
        openPi={(remoteTaskId) => void launchRequest({ requestId: crypto.randomUUID(), intent: 'new', remoteTaskId })}
        openSource={(source) => {
          setRemoteOpen(false);
          const matches = sessions.filter((s) => s.headerId === source.sessionId &&
            (!source.projectId || s.projectId === source.projectId) &&
            (!source.identity || s.identity === source.identity));
          if (matches.length === 1) void locateSession(matches[0].key);
          else setNotice(matches.length ? '来源 ID 对应多个物理会话，请在本地列表核对。' : '关联会话当前不可用；远端记录仍保留。');
        }}
      />
      {terminalDialogs}
    </div>
  );
  return (
    <div className="app-shell">
    <div className="titlebar">
        <span>Pi Hub</span>
      </div>
    <WorkspaceColumns kind="local" viewport={viewport} blocked={narrow && !!selectedSession && previewOpen}>
      <aside id="local-navigation" className="sidebar" aria-label="项目导航">
        <div className="workspace-brand">
            <span className="brand-mark">
              <Terminal size={20} strokeWidth={1.65} />
            </span>
            <div>
              <strong>Pi Hub</strong>
              <small>本地会话工作区</small>
            </div>
          </div>
          <div className="workspace-label">工作区</div>
        <nav aria-label="会话范围">
          <button className="nav-row" onClick={()=>setRemoteOpen(true)}><Terminal size={17} aria-hidden="true"/><span>远端任务</span></button>
          <button
              className={`nav-row ${scope === 'all' ? 'selected' : ''}`}
              aria-current={scope === 'all' ? 'page' : undefined}
              onClick={() => changeScope('all')}
            >
              <Inbox size={17} aria-hidden="true" />
              <span>全部会话</span>
            </button>
          <button
              className={`nav-row ${scope === 'archive' ? 'selected' : ''}`}
              aria-current={scope === 'archive' ? 'page' : undefined}
              onClick={() => changeScope('archive')}
            >
              <Archive size={17} aria-hidden="true" />
              <span>归档</span>
            </button>
        </nav>
        <div className="project-label">项目 <span>{loaded ? projects.length : '—'}</span>
          </div>
        <div className="project-list">
          {!loaded && !error && <p className="sidebar-hint">正在读取项目…</p>}
          {loaded && projects.length === 0 && (
              <p className="sidebar-hint">尚未添加项目</p>
            )}
          {projects.map((project) => (
              <button
                key={project.id}
                className={`project-row ${scope === project.id ? 'selected' : ''}`}
                aria-current={scope === project.id ? 'page' : undefined}
                title={project.path}
                onClick={() => changeScope(project.id)}
              >
                <Folder size={17} aria-hidden="true" />
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.path}</small>
                </span>
              </button>
            ))}
        </div>
        <div className="sidebar-bottom">
            {addButton()}
            <button
              className="add-project"
              onClick={() => {
                void window.sessionManagement
                  .showSettings()
                  .then((r) => {
                    if (r.status === 'failed') setNotice(r.error.message);
                  })
                  .catch(() => setNotice('设置窗口未能打开，请重试。'));
              }}
            >
              <Settings size={16} aria-hidden="true" />设置</button>
            <p>对话继续在外部终端中进行</p>
          </div>
      </aside>
      <main
          id="local-list"
          className="sessions"
          inert={narrow && previewOpen && !!workspace?.sessions.some((s) => s.key === selected)}
        >
        <header className="scope-header">
            <div>
              <h1 title={title}>{title}</h1>
              <span className="scope-count">
                {loaded ? `${visible.length} 条会话` : '正在读取…'}
              </span>
            </div>
            <span className="scope-badge">
              {current ? (current.includeDescendants ? '包含子目录' : '仅当前目录') : '项目工作区'}
            </span>
            {current && (
              <button
                className="settings-trigger"
                disabled={!!batch || busy}
                onClick={() => setSettings(current)}
              >项目设置</button>
            )}
          </header>
        <div className="browse-toolbar">
            <button
              className="new-session"
              disabled={terminalWorking || !projects.length || !!batch}
              onClick={() => {
                if (current) void openTerminal(current.id);
                else {
                  setNewProjectId('');
                  setNewProjectPicker(true);
                }
              }}
            >
              <Plus size={16} aria-hidden="true" />新建会话</button>
          <label className="session-search">
              <Search size={15} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                aria-label="搜索会话"
                placeholder="搜索名称、项目或路径"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
              <kbd aria-hidden="true">⌘F</kbd>
            </label>
          <select
              aria-label="排序"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as typeof sort);
                setPage(0);
              }}
            >
              <option value="recent">最近对话 ↓</option>
              <option value="name">名称 A–Z</option>
              <option value="created">创建时间 ↓</option>
              <option value="manual">手动排序</option>
            </select>
          {scope === 'all' && (
              <select
                aria-label="会话范围"
                value={allScope}
                onChange={(event) => {
                  setAllScope(event.target.value as typeof allScope);
                  setPage(0);
                }}
              >
                <option value="main">主列表</option>
                <option value="all">包含归档</option>
              </select>
            )}
          {scope === 'archive' && (
              <select
                aria-label="归档项目"
                value={archiveProject}
                onChange={(event) => {
                  setArchiveProject(event.target.value);
                  setPage(0);
                }}
              >
                <option value="">全部项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            )}
        </div>
        {current && (
            <div className="scope-path" title={current.path}>
              <Folder size={14} aria-hidden="true" />
              <span>{current.path}</span>
            </div>
          )}
        {workspace && projects.length > 0 && (
            <div className="sync-state" aria-live="polite">
          <span>
                {workspace.discovery.state === 'scanning'
                  ? `${cancelledScan ? '后台自动同步' : '正在扫描'} · 已检查 ${workspace.discovery.inspected} 个文件 · 已读取 ${workspace.discovery.parsed} 条记录`
                  : workspace.discovery.state === 'cancelled'
                    ? '本次扫描已取消 · 缓存已保留'
                    : workspace.discovery.state === 'completed'
                      ? `扫描完成 · 已检查 ${workspace.discovery.inspected} 个文件`
                      : workspace.discovery.state === 'error'
                        ? '同步未完成 · 显示已保存的记录'
                        : '已显示缓存 · 等待后台核对'}
              </span>
          <button onClick={() => void scan(workspace.discovery.state === 'scanning')}>
                {workspace.discovery.state === 'scanning' ? '取消扫描' : '重新扫描'}
              </button>
        </div>
          )}
        {cancelledScan && (
            <p className="scan-cancel-notice" role="status">
              {workspace?.discovery.state === 'cancelled'
                ? '本次扫描已取消，缓存保留；后台自动同步仍启用。'
                : '此前扫描已取消，缓存保留；后台自动同步仍启用。'}
            </p>
          )}
        {workspace?.discovery.error && (
            <div className="error-panel" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <div>
                <strong>
                  {workspace.discovery.state === 'idle'
                    ? '上次同步未完成 · 本次尚待核对'
                    : '会话同步未完成'}
                </strong>
                <p>
                  {workspace.discovery.state === 'idle' && '上次记录：'}
                  {workspace.discovery.error.message}
                </p>
              </div>
            </div>
          )}
        {workspace && workspace.discovery.issues.length > 0 && (
            <details className="scan-issues">
              <summary>
                {workspace.discovery.issues.length} 条记录暂不可读取 · 其余会话继续同步</summary>
              {workspace.discovery.issues.slice(0, 20).map((issue, index) => (
                <p key={index} title={issue.path}>
                  {issue.path.split('/').at(-1)}：{issue.message}
                </p>
              ))}
            </details>
          )}
        {workspace?.locations
            ?.filter((location) => location.availability.state === 'unavailable')
            .map((location) => (
              <div className="directory-warning" key={location.id}>
                <strong>存储位置不可用</strong>
                <p className="storage-path">{location.path}</p>
                <small>
                  {location.availability.reason}
                  {workspace.locations?.some(
                    (other) => other.id !== location.id && other.availability.state === 'available',
                  ) && ' 其他可用位置继续同步。'}
                </small>
              </div>
            ))}
        {workspace?.projects
            .filter(
              (project) =>
                project.availability.state === 'unavailable' &&
                (!current || current.id === project.id),
            )
            .map((project) => (
              <div className="directory-warning" key={project.id}>
                <strong>{project.name}</strong>
                <p>{project.availability.reason}</p>
                <small>
                  {workspace.sessions.some(
                    (s) =>
                      s.projectId === project.id &&
                      s.runtimeCapabilities.locate.allowed &&
                      s.runtimeCwd &&
                      s.runtimeCwd !== s.cwd,
                  )
                    ? '原记录目录仍不可用，不能在此新建。已核对的现有实例可定位，本次运行目录见会话身份。'
                    : '不能在此记录目录新建。已有会话仅在源记录与运行状态核对后，才可定位或选择目录恢复。'}
                </small>
              </div>
            ))}
        {error && (
            <div className="error-panel" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <div>
                <strong>{error.title}</strong>
                <p>{error.message}</p>
                <button onClick={error.retry === 'choose' ? add : refresh} disabled={busy}>
                  {error.retry === 'choose' ? '重新选择目录' : '重新读取项目'}
                </button>
              </div>
            </div>
          )}
        {!loaded && !error && (
            <p className="loading" role="status">正在读取已保存的项目与会话…</p>
          )}
        {loaded &&
            visible.length === 0 &&
            retainedPreviewNotice &&
            outsideScope &&
            matchesSearch && (
              <div className="empty-state">
                <h2>当前范围没有匹配会话</h2>
                <p>{retainedPreviewNotice}</p>
              </div>
            )}
        {loaded &&
            visible.length === 0 &&
            !(retainedPreviewNotice && outsideScope && matchesSearch) &&
            search.trim() && (
              <div className="empty-state">
                <h2>没有匹配的会话</h2>
                <p>请尝试其他名称、项目或路径。搜索不包含对话正文。</p>
                <button
                  onClick={() => {
                    setSearch('');
                    searchRef.current?.focus();
                  }}
                >清除搜索</button>
              </div>
            )}
        {loaded &&
            visible.length === 0 &&
            !(retainedPreviewNotice && outsideScope && matchesSearch) &&
            !search.trim() && (
              <div className="empty-state">
                <div className="empty-icon">
                  <emptyState.Icon size={30} strokeWidth={1.5} />
                </div>
                <h2>{emptyState.heading}</h2>
                <p>{emptyState.description}</p>
                {emptyState.canAdd && addButton(true)}
                {current && (
                  <div className="project-scope">
                    <Folder size={15} aria-hidden="true" />
                    <span>
                      {current.includeDescendants ? '当前目录及子目录' : '仅当前目录 · 不含子目录'}
                    </span>
                  </div>
                )}
              </div>
            )}
        {loaded && visible.length > 0 && (
            <ul className="session-list" ref={listRef} aria-label="会话列表">
              {visible.slice(pageIndex * 50, pageIndex * 50 + 50).map((session) => (
                <li
                  key={session.key}
                  data-session-key={session.key}
                  draggable
                  onDragStart={(event) => {
                    dragSource.current = session.key;
                    setDragging(session.key);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', session.key);
                  }}
                  onDragOver={(event) => {
                    if (dragSource.current && dragSource.current !== session.key) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      if (dropTarget !== session.key) setDropTarget(session.key);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragSource.current) reorder(dragSource.current, session.key);
                    endDrag();
                  }}
                  onDragEnd={endDrag}
                  className={`session-row ${
                    selected === session.key ? 'selected' : ''
                  } ${dragging === session.key ? 'is-dragging' : ''} ${
                    dropTarget === session.key ? 'drop-target' : ''
                  } ${
                    dropTarget === session.key &&
                    visible.findIndex((row) => row.key === dragging) >
                      visible.findIndex((row) => row.key === session.key)
                      ? 'drop-before'
                      : ''
                  }`}
                >
                  <button
                    id={`session-${session.key}`}
                    aria-pressed={selected === session.key}
                    onClick={() => {
                      setSelected(session.key);
                      setPreviewOpen(true);
                    }}
                    onDoubleClick={() => {
                      void openTerminal(session.projectId, session.key);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      void sessionMenu(session.key, {
                        x: Math.round(event.clientX),
                        y: Math.round(event.clientY),
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                        event.preventDefault();
                        const index = visible.findIndex((row) => row.key === session.key),
                          target = visible[index + (event.key === 'ArrowDown' ? 1 : -1)];
                        if (
                          target &&
                          Math.floor(index / 50) ===
                            Math.floor((index + (event.key === 'ArrowDown' ? 1 : -1)) / 50)
                        )
                          reorder(session.key, target.key);
                        return;
                      }
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        void sessionMenu(session.key, {
                          x: Math.round(rect.left + 20),
                          y: Math.round(rect.top + rect.height / 2),
                        });
                        return;
                      }
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        const buttons = Array.from(
                          listRef.current?.querySelectorAll('button') ?? [],
                        );
                        const index = buttons.indexOf(event.currentTarget);
                        buttons[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
                      }
                    }}
                  >
                    <span className="drag-handle" title="拖动排序 · Option + 上下方向键">
                      <GripVertical size={14} aria-hidden="true" />
                    </span>
                    <MessageSquare size={17} aria-hidden="true" />
                    <div>
                      <div className="session-heading">
                        <strong title={session.title}>{session.title}</strong>
                        <span
                          className="session-project"
                          title={projects.find((project) => project.id === session.projectId)?.path}
                        >
                          {projects.find((project) => project.id === session.projectId)?.name}
                        </span>
                      </div>
                      <div className="session-metadata">
                        <div className="session-statuses">
                          <span
                            className={`runtime-state ${workspace?.sessions.find((row) => row.key === session.key)?.runtimeState ?? 'unknown'}`}
                          >
                            <i aria-hidden="true" />
                            {session.classification === 'archive' ? '已归档 · ' : ''}
                            {runtimeLabel(
                              workspace?.sessions.find((row) => row.key === session.key)
                                ?.runtimeState,
                            )}
                          </span>
                          {session.identityConflict && (
                            <span className="storage-error" title={session.uniqueIdentity?.reason}>会话标识重复 · 部分操作不可用</span>
                          )}
                          {workspace?.sessions.find((row) => row.key === session.key)?.availability
                            .state === 'unavailable' && (
                            <span
                              title={
                                workspace.sessions.find((row) => row.key === session.key)
                                  ?.availability.reason
                              }
                            >记录暂不可读 · 显示缓存</span>
                          )}
                        </div>
                        <time>
                          {session.lastMessageAt
                            ? new Date(session.lastMessageAt).toLocaleString('zh-CN')
                            : '对话时间未知'}
                        </time>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        {visible.length > 50 && (
            <div className="pagination">
              <button disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>上一页</button>
              <span>
                {pageIndex + 1} / {Math.ceil(visible.length / 50)} 页</span>
              <button
                disabled={(pageIndex + 1) * 50 >= visible.length}
                onClick={() => setPage(pageIndex + 1)}
              >下一页</button>
            </div>
          )}
        <footer className="session-footer">
            {terminalCommandRequest && (
              <button
                onClick={() => {
                  void window.sessionManagement
                    .copyTerminalCommand({ requestId: terminalCommandRequest })
                    .then((r) =>
                      setNotice(
                        r.status === 'failed'
                          ? r.error.message
                          : '已复制手动启动命令，不包含临时接入凭据。结果未知时请先核对原窗口。',
                      ),
                    );
                }}
              >复制启动命令</button>
            )}
            <span role="status" tabIndex={notice ? 0 : undefined}>
              {notice}
            </span>
            <span>
              {loaded
                ? `${visible.length} 条会话 · ${projects.length} 个项目`
                : error
                  ? '项目未载入'
                  : '读取项目'}
            </span>
          </footer>
      </main>
      <PreviewPanel
          key={selected}
          session={selectedSession}
          projectName={projects.find((project) => project.id === selectedSession?.projectId)?.name}
          contextNotice={retainedPreviewNotice}
          open={previewOpen}
          onClose={closePreview}
          copyCreated={createdCopyKey === selected}
        />
    </WorkspaceColumns>
    {menuAction?.type === 'rename' && (
        <RenameDialog
          sourceKey={menuAction.row.key}
          title={menuAction.row.title}
          onClose={closeSessionAction}
          onRenamed={async () => {
            await loadWorkspace();
            setNotice('会话名称已更新。');
          }}
        />
      )}
    {menuAction?.type === 'clone' && (
        <CloneDialog
          sourceKey={menuAction.row.key}
          title={menuAction.row.title}
          onClose={closeSessionAction}
          onCreated={async (key) => {
            await loadWorkspace();
            setCreatedCopyKey(key);
            setSelected(key);
            setPreviewOpen(true);
            setNotice('已复制并切换到新会话。');
          }}
        />
      )}
    {menuAction && (menuAction.type === 'classify' || menuAction.type === 'exit') && (
        <SessionActions
          row={menuAction.row}
          action={menuAction.type}
          hostId={menuAction.hostId}
          onClose={closeSessionAction}
          onChanged={async (message) => {
            await loadWorkspace();
            setNotice(message);
          }}
        />
      )}
    {deleting && (
        <DeleteDialog
          sourceKey={deleting.key}
          title={deleting.title}
          onClose={() => {
            const key = deleting.key;
            setDeleting(null);
            if (completedDeleteFocus.current) return;
            requestAnimationFrame(() => {
              const target =
                document.getElementById(`delete-session-${key}`) ??
                listRef.current?.querySelector('button[aria-pressed="true"]') ??
                searchRef.current;
              target?.focus({ preventScroll: true });
            });
          }}
          onDeleted={async (outcome) => {
            setNotice(`${deleteOutcomeMessage(outcome)}独立副本保留。`);
            const snapshot = await loadWorkspace();
            const filtered = selectSessions(snapshot.sessions, snapshot.projects, {
              ...sessionScope,
              search,
              sort: sort === 'manual' ? 'recent' : sort,
            });
            const preserved =
              selected !== deleting.key && snapshot.sessions.some((s) => s.key === selected)
                ? selected
                : '';
            const next =
              preserved ||
              deleting.neighbors.find((key) => filtered.some((s) => s.key === key)) ||
              filtered[0]?.key ||
              '';
            completedDeleteFocus.current = { key: next, scroll: deleting.scroll };
            setSelected(next);
            if (!preserved) setPreviewOpen(!narrow && !!next);
          }}
        />
      )}
    {terminalDialogs}
    {newProjectPicker && (
        <dialog
          ref={newDialog}
          className="import-dialog project-settings"
          aria-labelledby="new-terminal-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!terminalWorking) setNewProjectPicker(false);
          }}
        >
          <header>
            <div className="eyebrow">新建会话</div>
            <h2 id="new-terminal-title">选择目标项目</h2>
          </header>
          <div className="settings-body">
            <p>在所选项目根目录打开 Pi，无需先命名。首条消息保存后会话才会出现。</p>
            <label>项目<select
                aria-label="新会话目标项目"
                disabled={terminalWorking}
                value={newProjectId}
                onChange={(event) => setNewProjectId(event.target.value)}
              >
                <option value="">请选择项目</option>
                {workspace?.projects.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.availability.state !== 'available'}>
                    {p.name} · {p.path}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <footer>
            <button disabled={terminalWorking} onClick={() => setNewProjectPicker(false)}>取消</button>
            <button
              className="primary"
              disabled={terminalWorking || !newProjectId}
              onClick={() => void openTerminal(newProjectId)}
            >
              {terminalWorking ? '正在核对…' : `在 ${terminalName} 新建`}
            </button>
          </footer>
        </dialog>
      )}
    {settings && (
        <ProjectSettings
          project={settings}
          onClose={() => setSettings(null)}
          onBatch={(next) => {
            setSettings(null);
            setBatch(next);
          }}
          onSaved={async (removed) => {
            await loadWorkspace();
            setSettings(null);
            setNotice(
              removed ? '项目已移除，原始文件与分类已保留。' : '项目范围已更新，已有分类已保留。',
            );
          }}
        />
      )}
    {batch && (
        <ImportDialog
          key={batch.id}
          initial={batch}
          onCancel={() => {
            setBatch(null);
            setNotice(
              batch.purpose === 'storage'
                ? '已取消添加，存储位置与分类保持不变。'
                : batch.purpose === 'expand'
                  ? '已取消范围调整，原范围保持不变。'
                  : '已取消添加，项目未保存。',
            );
          }}
          onComplete={imported}
        />
      )}
  </div>
  );
}
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).get('view') === 'settings' ? <SettingsApp /> : <App />,
);
