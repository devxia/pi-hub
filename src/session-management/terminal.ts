import type Database from 'better-sqlite3';
import { statSync, readFileSync, accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { matchesSourceIdentity } from './source-identity';
import { inspectSessionSource } from './session-source';
import { observeProcess } from './runtime-process';
import { requireMissingCwd } from './missing-cwd';
import type { RuntimeOptions, piConfiguration } from './pi-configuration';
import type { runtimeHosts } from './runtime-hosts';
import type { ManualHandoff, ManualInspection } from './manual-handoff';
import {
  completed,
  failed,
  type OpenSessionRequest,
  type TerminalOutcome,
  type TerminalTarget,
  type TerminalSettings,
  type TerminalIdentity,
  type WorkspaceSnapshot,
  type Result,
  type ExternalTerminal,
} from './interface';
export class TerminalAdapterFailure extends Error {
  constructor(
    public code: import('./interface').ErrorCode,
    public definitive: boolean,
  ) {
    super(code);
  }
}
export interface TerminalReconciliation {
  state: 'running' | 'not-started' | 'exited' | 'unknown';
  target?: TerminalTarget;
  errorCode?: import('./interface').ErrorCode;
  message?: string;
}
export interface TerminalCloseTarget {
  pid: number;
  startIdentity: string;
  tty: string;
  target: TerminalTarget;
}
export interface TerminalAdapter {
  prepareManual?(descriptor: TerminalLaunchDescriptor): Promise<ManualHandoff>;
  inspectManual?(handoff: ManualHandoff): Promise<ManualInspection>;
  revokeManual?(handoff: ManualHandoff): Promise<ManualInspection>;
  inspect(): Promise<TerminalIdentity>;
  reconcile?(request: {
    requestId: string;
    attemptId?: string;
    statusPath?: string;
    target?: TerminalTarget;
    instance?: { pid: number; startIdentity: string; tty: string };
  }): Promise<TerminalReconciliation>;
  closeExited?(instance: TerminalCloseTarget): Promise<void>;
  focus?(instance: {
    pid: number;
    startIdentity: string;
    tty: string;
    target?: TerminalTarget;
  }): Promise<TerminalTarget>;
  launch?(descriptor: TerminalLaunchDescriptor): Promise<TerminalTarget>;
}
export interface TerminalLaunchDescriptor {
  hostId: string;
  credentialPath: string;
  cliPath?: string;
  cliHash?: string;
  attemptId?: string;
  statusPath: string;
  runtimeNodePath: string;
  startupAssetPath: string;
  sdk: import('./interface').ExternalPiSdk;
  sessionDir: string;
  source?: { path: string; identity: string; hash: string };
  targetIdentity: string;
  requestId: string;
  cwd: string;
  executable: string;
  argv: string[];
  env: Record<string, string>;
  appData: string;
}
export interface TerminalOptions {
  appData: string;
  startupAssetPath?: string;
  adapter: TerminalAdapter;
  ghosttyAdapter?: TerminalAdapter;
}
interface Operation {
  request: OpenSessionRequest;
  terminal: ExternalTerminal;
  installed: TerminalIdentity;
  descriptor?: TerminalLaunchDescriptor;
  manual?: ManualHandoff;
  outcome: TerminalOutcome;
}
export function terminalSettings(
  db: Database.Database,
  options: TerminalOptions | undefined,
  configuration: ReturnType<typeof piConfiguration> | undefined,
  hosts: Awaited<ReturnType<typeof runtimeHosts>> | undefined,
  snapshot: () => Promise<Result<WorkspaceSnapshot>>,
  runtime: RuntimeOptions | undefined,
  sessionsRoot: string,
  changed: () => void,
) {
  const read = (id: string) => {
    const r = db.prepare('SELECT data FROM terminal_requests WHERE id=?').get(id) as
      { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Operation) : undefined;
  };
  const save = (o: Operation) => {
    db.prepare('INSERT OR REPLACE INTO terminal_requests(id,data) VALUES(?,?)').run(
      o.request.requestId,
      JSON.stringify(o),
    );
    changed();
  };
  const get = (): Omit<TerminalSettings, 'available'> => {
    const r = db.prepare('SELECT data FROM terminal_settings WHERE id=1').get() as
      { data: string } | undefined;
    return r ? JSON.parse(r.data) : { defaultTerminal: null };
  };
  const adapter = (t: ExternalTerminal) =>
    t === 'Ghostty' ? options?.ghosttyAdapter : options?.adapter;
  const certified = (i: TerminalIdentity, t: ExternalTerminal) =>
    t === 'Terminal'
      ? i.bundleId === 'com.apple.Terminal' &&
        i.version === '2.14' &&
        i.path === '/System/Applications/Utilities/Terminal.app'
      : i.bundleId === 'com.mitchellh.ghostty' &&
        i.version === '1.4.0' &&
        i.capability === 'stable-terminal-ids';
  async function settingsSnapshot(): Promise<TerminalSettings> {
    const available: TerminalSettings['available'] = [];
    for (const terminal of ['Terminal', 'Ghostty'] as const) {
      try {
        const installed = await adapter(terminal)?.inspect();
        if (installed && certified(installed, terminal)) available.push({ terminal, installed });
      } catch {
        /* An absent or unsupported terminal is not a selectable candidate. */
      }
    }
    return { ...get(), available };
  }
  function storeDefault(terminal: ExternalTerminal | null, installed?: TerminalIdentity) {
    db.prepare('INSERT OR REPLACE INTO terminal_settings(id,data) VALUES(1,?)').run(
      JSON.stringify({ defaultTerminal: terminal, ...(installed ? { installed } : {}) }),
    );
  }
  const active = new Map<string, { request: string; job: Promise<Result<TerminalOutcome>> }>();
  async function run(
    request: OpenSessionRequest,
    retry = false,
    manual = false,
  ): Promise<Result<TerminalOutcome>> {
    const running = active.get(request?.requestId),
      encoded = JSON.stringify(request);
    if (running)
      return running.request === encoded
        ? running.job
        : failed('RECORD_CHANGED', '请求ID已用于另一目标。');
    const job = open(request, retry, manual).catch(() =>
      failed('STARTUP_IO', '启动未完成，请核对本次请求。'),
    );
    active.set(request?.requestId, { request: encoded, job });
    try {
      return await job;
    } finally {
      active.delete(request?.requestId);
    }
  }
  async function check(o: Operation): Promise<Result<TerminalOutcome>> {
    try {
      const i = await adapter(o.terminal)?.inspect();
      if (!i || JSON.stringify(i) !== JSON.stringify(o.installed))
        return failed('TERMINAL_PROTOCOL', '原终端身份已变化，请重新检测。');
      const h = hosts?.reportFor(o.request.requestId);
      let state: any;
      try {
        state = JSON.parse(readFileSync(o.descriptor!.statusPath, 'utf8'));
      } catch {}
      if (o.manual) {
        const manual = await adapter(o.terminal)?.inspectManual?.(o.manual);
        if (manual?.state === 'pending')
          o.outcome = {
            ...o.outcome,
            state: 'awaiting-paste',
            canRetry: false,
            command: o.manual.command,
            message: '命令已准备，请粘贴到原终端；领取前可以取消。',
          };
        else if (manual?.state === 'revoked')
          o.outcome = {
            ...o.outcome,
            state: 'not-started',
            canRetry: true,
            command: undefined,
            message: '旧命令已取消，不能再启动Pi。',
          };
      }
      if (h?.connected)
        o.outcome = {
          ...o.outcome,
          state: 'bound',
          canRetry: false,
          command: undefined,
          message: 'Pi已在 ' + o.terminal + ' 接入。',
        };
      else if (state?.phase === 'exited')
        o.outcome = {
          ...o.outcome,
          state: 'ended',
          canRetry: true,
          command: undefined,
          message: '本次Pi宿主已结束。',
        };
      else if (state?.phase === 'not-started')
        o.outcome = {
          ...o.outcome,
          state: 'not-started',
          canRetry: true,
          command: undefined,
          errorCode: state.errorCode,
          message: state.message ?? '本次未能启动Pi，请纠正后重试。',
        };
      const previous = read(o.request.requestId);
      if (JSON.stringify(previous?.outcome) !== JSON.stringify(o.outcome)) save(o);
      return completed(o.outcome);
    } catch {
      return failed('BACKGROUND_UNAVAILABLE', '无法核对本次终端结果，请保留原请求。');
    }
  }
  async function open(
    request: OpenSessionRequest,
    retry = false,
    manual = false,
  ): Promise<Result<TerminalOutcome>> {
    if (
      !request ||
      typeof request.requestId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId) ||
      !['new', 'resume'].includes(request.intent) ||
      typeof request.projectId !== 'string' ||
      Object.keys(request).some(
        (k) =>
          ![
            'requestId',
            'intent',
            'projectId',
            'key',
            'identity',
            'runtimeProjectId',
            'terminal',
            'rememberTerminal',
          ].includes(k),
      )
    )
      return failed('INVALID_REQUEST', '无效启动请求。');
    if (
      (request.intent === 'new' &&
        (request.key !== undefined ||
          request.identity !== undefined ||
          request.runtimeProjectId !== undefined)) ||
      (request.intent === 'resume' &&
        (typeof request.key !== 'string' || typeof request.identity !== 'string'))
    )
      return failed('INVALID_REQUEST', '新建与继续原记录的字段不能混用。');
    if (
      (request.terminal !== undefined && !['Terminal', 'Ghostty'].includes(request.terminal)) ||
      (request.rememberTerminal !== undefined &&
        (typeof request.rememberTerminal !== 'boolean' || !request.terminal))
    )
      return failed('INVALID_REQUEST', '无效的本次终端选择。');
    const old = read(request.requestId);
    if (old && JSON.stringify(old.request) !== JSON.stringify(request))
      return failed('RECORD_CHANGED', '请求ID已用于另一目标。');
    if (old && !retry) return check(old);
    if (old && retry && !old.outcome.canRetry)
      return failed('IMPORT_UNAVAILABLE', '本次结果尚未确认，不会重复执行同一图形操作。');
    const settings = get(),
      selected = old?.terminal ?? request.terminal ?? settings.defaultTerminal,
      a = selected ? adapter(selected) : undefined;
    if (!selected || !a || !options)
      return failed('TERMINAL_MISSING', '请选择本次打开使用的终端。');
    if (!configuration || !hosts || !runtime)
      return failed('PI_MISSING', '请先在Pi启动设置中保存Pi1.5.2入口。');
    let inspected: TerminalIdentity;
    try {
      inspected = await a.inspect();
    } catch {
      return failed('TERMINAL_MISSING', '所选终端当前不可用，请重新选择。');
    }
    if (!certified(inspected, selected))
      return failed('TERMINAL_PROTOCOL', '此终端身份或版本尚未验证。');
    if (old && JSON.stringify(old.installed) !== JSON.stringify(inspected))
      return failed('TERMINAL_PROTOCOL', '原终端身份已变化。');
    if (request.rememberTerminal === true && !old) storeDefault(selected, inspected);
    const status = await configuration.ensureConfiguration();
    if (status.status === 'failed') return status;
    const launch = status.value.launch;
    if (!status.value.configured || !launch?.externalSdk)
      return failed('PI_MISSING', '请先检测并保存Pi1.5.2启动配置。');
    const result = await snapshot();
    if (result.status === 'failed') return result;
    const project = result.value.projects.find((p) => p.id === request.projectId),
      s = result.value.sessions.find((s) => s.key === request.key);
    if (!project) return failed('RECORD_CHANGED', '目标项目已变化。');
    if (
      request.intent === 'resume' &&
      (!s ||
        s.identity !== request.identity ||
        s.projectId !== project.id ||
        s.availability.state !== 'available' ||
        s.identityConflict)
    )
      return failed('RECORD_CHANGED', '原会话身份或记录位置已变化。');
    let cwd = request.intent === 'resume' ? s!.cwd : project.path;
    try {
      if (!statSync(cwd).isDirectory()) throw Error();
    } catch {
      if (request.intent === 'new')
        return failed('DIRECTORY_UNAVAILABLE', '不能在不可用项目中新建。');
      try {
        requireMissingCwd(cwd);
      } catch {
        return failed('DIRECTORY_UNAVAILABLE', '原记录目录无法确认缺失，请恢复访问后重试。');
      }
      if (!request.runtimeProjectId)
        return failed('RECOVERY_REQUIRED', '原目录已丢失，请明确选择本次运行目录。');
      const target = result.value.projects.find((p) => p.id === request.runtimeProjectId);
      if (!target || target.availability.state !== 'available')
        return failed('DIRECTORY_UNAVAILABLE', '本次运行目录不可用。');
      cwd = target.path;
    }
    if (request.runtimeProjectId && cwd === s?.cwd)
      return failed('INVALID_REQUEST', '原记录目录可用，不需要临时覆盖。');
    const target = statSync(cwd);
    accessSync(cwd, constants.R_OK | constants.X_OK);
    if (s && !matchesSourceIdentity(s.sourcePath, s.identity))
      return failed('RECORD_CHANGED', '原记录身份已变化。');
    let sourceBytes: string | undefined;
    if (s) {
      try {
        sourceBytes = inspectSessionSource(s.sourcePath, s.identity).bytes;
      } catch (error) {
        return failed('RECORD_CHANGED', String((error as Error).message));
      }
    }
    const attemptId = randomUUID(),
      statusPath = join(
        runtime.appData,
        'terminal-launches',
        request.requestId + '.' + attemptId + '.status.json',
      ),
      hostId = hosts.register(request.requestId, statusPath);
    const descriptor: TerminalLaunchDescriptor = {
      hostId,
      credentialPath: hosts.credentialPath,
      requestId: request.requestId,
      attemptId,
      statusPath,
      cwd,
      targetIdentity: `${target.dev}:${target.ino}`,
      runtimeNodePath: launch.nodePath,
      startupAssetPath: runtime.hostAssetPath,
      sdk: launch.externalSdk,
      sessionDir:
        request.intent === 'resume'
          ? dirname(s!.sourcePath)
          : join(sessionsRoot, `--${project.path.slice(1).replaceAll('/', '-')}--`),
      executable: launch.nodePath,
      argv: [],
      appData: runtime.appData,
      source: s
        ? {
            path: s.sourcePath,
            identity: s.identity,
            hash: createHash('sha256').update(sourceBytes!).digest('hex'),
          }
        : undefined,
      env: {
        HOME: process.env.HOME ?? '',
        SHELL: process.env.SHELL ?? userInfo().shell ?? '/bin/zsh',
        PATH: [dirname(launch.nodePath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
        PI_CODING_AGENT_DIR: runtime.agentDir,
        ...(process.env.PI_OFFLINE ? { PI_OFFLINE: process.env.PI_OFFLINE } : {}),
      },
    };
    const operation: Operation = {
      request,
      terminal: selected,
      installed: inspected,
      descriptor,
      outcome: {
        requestId: request.requestId,
        terminal: selected,
        state: 'uncertain',
        canRetry: false,
        message: '正在打开原生Pi；是否重复使用同一会话由你自行确认。',
      },
    };
    save(operation);
    if (manual) {
      if (!a.prepareManual) return failed('STARTUP_IO', '手动启动服务不可用。');
      operation.manual = await a.prepareManual(descriptor);
      operation.outcome = {
        ...operation.outcome,
        state: 'awaiting-paste',
        command: operation.manual.command,
        message: '命令已复制，请粘贴到 ' + selected + '。',
        canRetry: false,
      };
      save(operation);
      return completed(operation.outcome);
    }
    try {
      operation.outcome.target = await a.launch!(descriptor);
    } catch (e) {
      const error = e as TerminalAdapterFailure;
      operation.outcome = {
        ...operation.outcome,
        errorCode: error.code,
        state: error.definitive ? 'not-started' : 'uncertain',
        canRetry: error.definitive === true,
        message:
          error.code === 'AUTOMATION_DENIED'
            ? `${selected}自动化授权被拒绝，请在系统设置允许Pi Hub控制该终端。`
            : '终端启动结果尚未确认，请核对本次请求。',
      };
    }
    save(operation);
    return check(operation);
  }
  const exits = new Map<
    string,
    { request: string; job: Promise<Result<import('./interface').ExitSessionOutcome>> }
  >();
  async function sessionTerminals(request: { key: string; identity: string }) {
    if (
      !request ||
      Object.keys(request).some((k) => !['key', 'identity'].includes(k)) ||
      typeof request.key !== 'string' ||
      typeof request.identity !== 'string'
    )
      return failed('INVALID_REQUEST', '无效会话实例目标。');
    const r = await snapshot();
    if (r.status === 'failed') return r;
    const row = r.value.sessions.find(
      (s) => s.key === request.key && s.identity === request.identity,
    );
    if (!row) return failed('RECORD_CHANGED', '会话记录已变化。');
    const operations = (
      db.prepare('SELECT data FROM terminal_requests').all() as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Operation);
    return completed(
      (hosts?.connectedFor(row.sourcePath) ?? []).flatMap((h) => {
        const o = operations.find((o) => o.request.requestId === h.requestId);
        return o && h.tty && o.outcome.target
          ? [{ hostId: h.hostId, terminal: o.terminal, pid: h.pid, tty: h.tty, busy: h.busy }]
          : [];
      }),
    );
  }
  async function exitSession(
    request: import('./interface').ExitSessionRequest,
  ): Promise<Result<import('./interface').ExitSessionOutcome>> {
    if (
      !request ||
      Object.keys(request).some(
        (k) => !['requestId', 'key', 'identity', 'hostId', 'stopBusy'].includes(k),
      ) ||
      typeof request.requestId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId) ||
      typeof request.key !== 'string' ||
      typeof request.identity !== 'string' ||
      typeof request.hostId !== 'string' ||
      typeof request.stopBusy !== 'boolean'
    )
      return failed('INVALID_REQUEST', '无效退出请求。');
    const existing = exits.get(request.requestId),
      encoded = JSON.stringify(request);
    if (existing)
      return existing.request === encoded
        ? existing.job
        : failed('RECORD_CHANGED', '退出请求已用于另一实例。');
    const job = (async () => {
      const r = await snapshot();
      if (r.status === 'failed') return r;
      const row = r.value.sessions.find(
        (s) => s.key === request.key && s.identity === request.identity,
      );
      if (!row || !hosts) return failed('RECORD_CHANGED', '会话身份已变化。');
      const h = hosts.connectedFor(row.sourcePath).find((h) => h.hostId === request.hostId);
      if (!h?.tty) return failed('RECORD_CHANGED', '所选实例已断开或切换会话。');
      if (h.busy && !request.stopBusy)
        return failed('INVALID_REQUEST', '会话正在处理任务，请确认停止当前任务并退出。');
      const operation = db
        .prepare('SELECT data FROM terminal_requests WHERE id=?')
        .get(h.requestId) as { data: string } | undefined;
      const o = operation ? (JSON.parse(operation.data) as Operation) : undefined;
      if (!o?.outcome.target || !adapter(o.terminal)?.closeExited)
        return failed('IMPORT_UNAVAILABLE', '无法核对原终端对象，请在终端中退出。');
      const installed = await adapter(o.terminal)!.inspect();
      if (JSON.stringify(installed) !== JSON.stringify(o.installed))
        return failed('TERMINAL_PROTOCOL', '原终端应用身份已变化。');
      const os = await observeProcess(h.pid);
      if (os.startIdentity !== h.startIdentity || os.tty !== h.tty)
        return failed('RECORD_CHANGED', '原运行实例身份已变化。');
      const current = hosts
        .connectedFor(row.sourcePath)
        .find(
          (r) =>
            r.hostId === h.hostId &&
            r.pid === h.pid &&
            r.startIdentity === h.startIdentity &&
            r.tty === h.tty &&
            r.sessionId === h.sessionId,
        );
      if (!current) return failed('RECORD_CHANGED', '所选实例已断开或切换会话。');
      if (current.busy && !request.stopBusy)
        return failed('INVALID_REQUEST', '会话正在处理任务，请确认停止当前任务并退出。');
      // Public InteractiveMode handles SIGTERM gracefully: abort, extension shutdown, credential settling and terminal restore.
      // This also works for still-running Hub hosts created before the menu feature was installed.
      process.kill(h.pid, 'SIGTERM');
      const deadline = Date.now() + 8000;
      let gone = false;
      while (Date.now() < deadline) {
        try {
          const current = await observeProcess(h.pid);
          if (current.startIdentity !== h.startIdentity) {
            gone = true;
            break;
          }
        } catch {
          gone = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!gone)
        return completed({
          requestId: request.requestId,
          state: 'uncertain' as const,
          message: 'Pi已收到正常退出请求，尚未确认结束；请在原终端核对，不会强制终止。',
        });
      try {
        await adapter(o.terminal)!.closeExited!({
          pid: h.pid,
          startIdentity: h.startIdentity,
          tty: h.tty,
          target: o.outcome.target,
        });
        return completed({
          requestId: request.requestId,
          state: 'completed' as const,
          message: '会话已退出，原记录保留。',
        });
      } catch {
        return completed({
          requestId: request.requestId,
          state: 'uncertain' as const,
          message: 'Pi已退出，但终端对象关闭未确认；请自行核对原标签页或窗格。',
        });
      }
    })().catch(() => failed('IMPORT_UNAVAILABLE', '退出未能确认，请核对原终端。'));
    exits.set(request.requestId, { request: encoded, job });
    return job;
  }
  return {
    sessionTerminals,
    exitSession,
    async getTerminalSettings() {
      return completed(await settingsSnapshot());
    },
    async setDefaultTerminal(request: { terminal: ExternalTerminal | null }) {
      if (
        !request ||
        (request.terminal !== null && !['Terminal', 'Ghostty'].includes(request.terminal)) ||
        Object.keys(request).some((k) => k !== 'terminal')
      )
        return failed('INVALID_REQUEST', '请选择支持的终端。');
      try {
        if (request.terminal === null) {
          storeDefault(null);
          return completed(await settingsSnapshot());
        }
        const installed = await adapter(request.terminal)?.inspect();
        if (!installed) return failed('TERMINAL_MISSING', '未安装所选终端。');
        if (!certified(installed, request.terminal))
          return failed('TERMINAL_PROTOCOL', '所选终端版本不支持。');
        storeDefault(request.terminal, installed);
        return completed(await settingsSnapshot());
      } catch {
        return failed('TERMINAL_MISSING', '无法读取终端身份。');
      }
    },
    async openTerminal(request: OpenSessionRequest) {
      return run(request);
    },
    async getTerminalOutcome(request: { requestId: string }) {
      if (!request || typeof request.requestId !== 'string')
        return failed('INVALID_REQUEST', '无效请求。');
      const o = read(request.requestId);
      return o ? check(o) : completed(null);
    },
    async retryTerminal(request: { requestId: string }) {
      const o = read(request?.requestId);
      return o ? run(o.request, true) : failed('INVALID_REQUEST', '原请求不存在。');
    },
    async prepareTerminalCommand(request: { requestId: string }) {
      const o = read(request?.requestId);
      if (!o) return failed('INVALID_REQUEST', '原请求不存在。');
      if (o.manual) return check(o);
      if (!o.outcome.canRetry)
        return failed('IMPORT_UNAVAILABLE', '原结果未确认，不准备另一份启动。');
      return run(o.request, true, true);
    },
    async cancelTerminalCommand(request: { requestId: string }) {
      const o = read(request?.requestId);
      if (!o?.manual) return failed('INVALID_REQUEST', '没有未领取的命令。');
      const result = await adapter(o.terminal)?.revokeManual?.(o.manual);
      if (result?.state !== 'revoked')
        return failed('IMPORT_UNAVAILABLE', '命令已领取或状态不明，请核对原终端。');
      o.outcome = {
        ...o.outcome,
        state: 'not-started',
        canRetry: true,
        command: undefined,
        message: '旧命令已取消，不能再启动Pi。',
      };
      save(o);
      return completed(o.outcome);
    },
    async locateSession(request: { key: string }) {
      const s = await snapshot();
      if (s.status === 'failed') return s;
      const row = s.value.sessions.find((s) => s.key === request.key);
      if (!row) return failed('RECORD_CHANGED', '记录不在当前列表。');
      const operations = (
        db.prepare('SELECT data FROM terminal_requests').all() as { data: string }[]
      )
        .map((r) => JSON.parse(r.data) as Operation)
        .reverse();
      for (const o of operations) {
        const h = hosts?.reportFor(o.request.requestId);
        if (h?.file !== row.sourcePath || !h.connected || !h.tty) continue;
        try {
          const i = await adapter(o.terminal)?.inspect();
          if (JSON.stringify(i) !== JSON.stringify(o.installed)) throw Error();
          const target = await adapter(o.terminal)!.focus!({
            pid: h.pid,
            startIdentity: h.startIdentity,
            tty: h.tty,
            target: o.outcome.target,
          });
          return completed({
            ...o.outcome,
            state: 'located' as const,
            target,
            message: '已定位Hub启动的原 ' + o.terminal + ' 窗口。',
          });
        } catch {
          return failed('IMPORT_UNAVAILABLE', '无法核对这个Hub终端，请自行切换。');
        }
      }
      return failed('IMPORT_UNAVAILABLE', '没有可定位的Hub终端。');
    },
  };
}
