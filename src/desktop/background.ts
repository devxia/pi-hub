import type { NativePiBridge, NativePiRequest } from '../remote/contract';
import { deletePublicationMatches } from '../session-management/delete-source-facts';
import { executeTerminalAdapter, type TerminalAdapterRequest } from './terminal-adapter-contract';
import { terminalAdapter } from './terminal-adapter';
import { ghosttyAdapter } from './ghostty-adapter';
import { executeTrash, type TrashAdapterRequest } from './trash-adapter';
import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import {
  failed,
  type ClassificationRequest,
  type ClassificationReceipt,
  type StorageSnapshot,
  type StorageLocationRequest,
  type RemoveStorageRequest,
  type ProjectScopeRequest,
  type RemoveProjectRequest,
  type AddProjectRequest,
  type AddProjectResult,
  type ProjectSnapshot,
  type Result,
  type ImportBatch,
  type ImportRequest,
  type ImportSelectionRequest,
  type ManagedSession,
  type SessionListRequest,
  type WorkspaceSnapshot,
  type DiscoveryState,
  type PreviewRequest,
  type SessionPreview,
  type PreviewRuntime,
} from '../session-management/interface';

export class BackgroundSessionManagement {
  private worker?: UtilityProcess;
  private publishedSnapshot?: WorkspaceSnapshot;
  private sequence = 0;
  private pending = new Map<number, (result: Result<unknown>) => void>();
  private stopping = false;
  constructor(
    private databasePath: string,
    private onSnapshot: (snapshot: WorkspaceSnapshot) => void,
    private nativePi: NativePiBridge,
  ) {}

  private request<T>(command: string, request?: unknown): Promise<Result<T>> {
    if (this.stopping) return Promise.resolve(failed('BACKGROUND_UNAVAILABLE', '应用正在退出。'));
    if (!this.worker) {
      const worker = utilityProcess.fork(join(__dirname, 'utility.cjs'), [this.databasePath], {
        serviceName: 'Pi Hub database',
      });
      this.worker = worker;
      worker.on(
        'message',
        (message: {
          id: number;
          result: Result<unknown>;
          snapshot?: WorkspaceSnapshot;
          trashAdapter?: TrashAdapterRequest;
          terminalAdapter?: TerminalAdapterRequest;
          nativePi?: { id: number; request: NativePiRequest };
        }) => {
          if (message.nativePi) {
            const { id, request } = message.nativePi;
            void this.nativePi(request).catch(() => ({ ok: false, error: '远端任务服务暂不可用。' }))
              .then((reply) => {
                if (this.worker === worker) worker.postMessage({ nativePiReply: { id, reply } });
              });
            return;
          }
          if (message.trashAdapter) {
            const r = message.trashAdapter;
            void (
              deletePublicationMatches(r.source, this.publishedSnapshot)
                ? executeTrash(r)
                : Promise.reject(
                    Object.assign(Error('源身份、占用或可访问性已变化，删除结果需要核对。'), {
                      outcomeUnknown: true,
                    }),
                  )
            ).then(
              () => worker.postMessage({ trashAdapterReply: { id: r.id } }),
              (error) =>
                worker.postMessage({
                  trashAdapterReply: {
                    id: r.id,
                    error: error instanceof Error ? error.message : '原生废纸篓操作失败。',
                    outcomeUnknown:
                      (error as { outcomeUnknown?: boolean })?.outcomeUnknown === true,
                  },
                }),
            );
            return;
          }
          if (message.terminalAdapter) {
            const r = message.terminalAdapter;
            void executeTerminalAdapter(
              r.terminal === 'Ghostty' ? ghosttyAdapter : terminalAdapter,
              r,
            ).then(
              (value) =>
                worker.postMessage({
                  terminalAdapterReply: { id: r.id, command: r.command, value },
                }),
              (error) => {
                const fault =
                  error instanceof Error && 'code' in error
                    ? (error as Error & {
                        code?: import('../session-management/interface').ErrorCode;
                        definitive?: boolean;
                      })
                    : undefined;
                worker.postMessage({
                  terminalAdapterReply: {
                    id: r.id,
                    command: r.command,
                    error: {
                      message: 'Terminal adapter failed',
                      code: fault?.code,
                      definitive: fault?.definitive,
                    },
                  },
                });
              },
            );
            return;
          }
          if (message.snapshot) {
            this.publishedSnapshot = message.snapshot;
            this.onSnapshot(message.snapshot);
            return;
          }
          this.pending.get(message.id)?.(message.result);
        },
      );
      worker.on('exit', () => {
        this.worker = undefined;
        this.publishedSnapshot = undefined;
        for (const resolve of this.pending.values())
          resolve(failed('BACKGROUND_UNAVAILABLE', '项目服务已中断，请重试。已保存的项目会保留。'));
      });
    }
    const id = ++this.sequence;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          // Terminate the unresponsive writer before permitting a replacement.
          this.worker?.kill();
          finish(
            failed('BACKGROUND_UNAVAILABLE', '项目服务未及时响应，请重试以核对已保存的项目。'),
          );
        },
        command === 'exitSession' ? 30000 : 15000,
      );
      const finish = (result: Result<unknown>) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(result as Result<T>);
      };
      this.pending.set(id, finish);
      this.worker!.postMessage({ id, command, request });
    });
  }
  sessionTerminals(request: { key: string; identity: string }) {
    return this.request<import('../session-management/interface').SessionTerminal[]>(
      'sessionTerminals',
      request,
    );
  }
  exitSession(request: import('../session-management/interface').ExitSessionRequest) {
    return this.request<import('../session-management/interface').ExitSessionOutcome>(
      'exitSession',
      request,
    );
  }
  getPiStatus() {
    return this.request<import('../session-management/interface').PiStatus>('getPiStatus');
  }
  inspectPi(request: import('../session-management/interface').LaunchConfiguration) {
    return this.request<import('../session-management/interface').PiStatus>('inspectPi', request);
  }
  savePiConfiguration(request: { reviewId: string }) {
    return this.request<import('../session-management/interface').PiStatus>(
      'savePiConfiguration',
      request,
    );
  }
  locateSession(request: { key: string }) {
    return this.request<import('../session-management/interface').TerminalOutcome>(
      'locateSession',
      request,
    );
  }
  getTerminalSettings() {
    return this.request<import('../session-management/interface').TerminalSettings>(
      'getTerminalSettings',
    );
  }
  setDefaultTerminal(request: {
    terminal: import('../session-management/interface').ExternalTerminal | null;
  }) {
    return this.request<import('../session-management/interface').TerminalSettings>(
      'setDefaultTerminal',
      request,
    );
  }
  openTerminal(request: import('../session-management/interface').OpenSessionRequest) {
    return this.request<import('../session-management/interface').TerminalOutcome>(
      'openTerminal',
      request,
    );
  }
  prepareTerminalCommand(request: { requestId: string }) {
    return this.request<import('../session-management/interface').TerminalOutcome>(
      'prepareTerminalCommand',
      request,
    );
  }
  cancelTerminalCommand(request: { requestId: string }) {
    return this.request<import('../session-management/interface').TerminalOutcome>(
      'cancelTerminalCommand',
      request,
    );
  }
  retryTerminal(request: { requestId: string }) {
    return this.request<import('../session-management/interface').TerminalOutcome>(
      'retryTerminal',
      request,
    );
  }
  getTerminalOutcome(request: { requestId: string }) {
    return this.request<import('../session-management/interface').TerminalOutcome | null>(
      'getTerminalOutcome',
      request,
    );
  }
  prepareDelete(request: { key: string }) {
    return this.request<import('../session-management/interface').DeletePreparation>(
      'prepareDelete',
      request,
    );
  }
  deleteSession(request: import('../session-management/interface').DeleteRequest) {
    return this.request<import('../session-management/interface').DeleteOutcome>(
      'deleteSession',
      request,
    );
  }
  getDeleteOutcome(request: { requestId: string }) {
    return this.request<import('../session-management/interface').DeleteOutcome | null>(
      'getDeleteOutcome',
      request,
    );
  }
  prepareRename(request: { key: string }) {
    return this.request<import('../session-management/interface').RenamePreparation>(
      'prepareRename',
      request,
    );
  }
  renameSession(request: import('../session-management/interface').RenameRequest) {
    return this.request<import('../session-management/interface').RenameOutcome>(
      'renameSession',
      request,
    );
  }
  getRenameOutcome(request: { requestId: string }) {
    return this.request<import('../session-management/interface').RenameOutcome | null>(
      'getRenameOutcome',
      request,
    );
  }
  prepareClone(request: { key: string }) {
    return this.request<import('../session-management/interface').ClonePreparation>(
      'prepareClone',
      request,
    );
  }
  cloneSession(request: import('../session-management/interface').CloneRequest) {
    return this.request<import('../session-management/interface').CloneOutcome>(
      'cloneSession',
      request,
    );
  }
  getCloneOutcome(request: { requestId: string }) {
    return this.request<import('../session-management/interface').CloneOutcome | null>(
      'getCloneOutcome',
      request,
    );
  }
  setSessionClassification(request: ClassificationRequest) {
    return this.request<ClassificationReceipt>('setSessionClassification', request);
  }
  getClassificationOutcome(request: { requestId: string }) {
    return this.request<Result<ClassificationReceipt> | null>('getClassificationOutcome', request);
  }
  listStorageLocations() {
    return this.request<StorageSnapshot>('listStorageLocations');
  }
  prepareStorageLocation(request: StorageLocationRequest) {
    return this.request<ImportBatch | null>('prepareStorageLocation', request);
  }
  removeStorageLocation(request: RemoveStorageRequest) {
    return this.request<null>('removeStorageLocation', request);
  }
  updatePreviewRuntime(request: PreviewRuntime) {
    return this.request<null>('updatePreviewRuntime', request);
  }
  getPreview(request: PreviewRequest) {
    return this.request<SessionPreview>('getPreview', request);
  }
  cancelPreview(request: { requestId: string }) {
    return this.request<null>('cancelPreview', request);
  }
  getSnapshot() {
    return this.request<WorkspaceSnapshot>('getSnapshot');
  }
  reconcile() {
    return this.request<DiscoveryState>('reconcile');
  }
  cancelReconciliation() {
    return this.request<DiscoveryState>('cancelReconciliation');
  }
  changeProjectScope(request: ProjectScopeRequest) {
    return this.request<ImportBatch | null>('changeProjectScope', request);
  }
  removeProject(request: RemoveProjectRequest) {
    return this.request<null>('removeProject', request);
  }
  listProjects() {
    return this.request<ProjectSnapshot>('listProjects');
  }
  addProject(request: AddProjectRequest) {
    return this.request<AddProjectResult>('addProject', request);
  }
  prepareImport(request: AddProjectRequest) {
    return this.request<ImportBatch | null>('prepareImport', request);
  }
  listImports() {
    return this.request<ImportBatch[]>('listImports');
  }
  getImport(request: ImportRequest) {
    return this.request<ImportBatch>('getImport', request);
  }
  selectImport(request: ImportSelectionRequest) {
    return this.request<ImportBatch>('selectImport', request);
  }
  commitImport(request: ImportRequest) {
    return this.request<ImportBatch>('commitImport', request);
  }
  cancelImport(request: ImportRequest) {
    return this.request<ImportBatch>('cancelImport', request);
  }
  retryImport(request: ImportRequest) {
    return this.request<ImportBatch>('retryImport', request);
  }
  listSessions(request: SessionListRequest) {
    return this.request<ManagedSession[]>('listSessions', request);
  }
  async close(): Promise<void> {
    this.stopping = true;
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => worker.kill(), 2000);
      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      worker.postMessage({ id: ++this.sequence, command: 'close' });
    });
  }
}
