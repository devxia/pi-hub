import type { NativePiBridge, Reply } from '../remote/contract';
import type { TrashAdapterReply } from './trash-adapter';
import type {
  TerminalAdapterCommand,
  TerminalAdapterInputs,
  TerminalAdapterResults,
  TerminalAdapterReply,
} from './terminal-adapter-contract';
import type { TerminalAdapter } from '../session-management/terminal';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { openSessionManagement } from '../session-management/service';
import {
  failed,
  type ClassificationRequest,
  type StorageLocationRequest,
  type RemoveStorageRequest,
  type ProjectScopeRequest,
  type RemoveProjectRequest,
  type AddProjectRequest,
  type SessionManagement,
  type ImportRequest,
  type ImportSelectionRequest,
  type SessionListRequest,
  type PreviewRequest,
  type PreviewRuntime,
} from '../session-management/interface';

const port = process.parentPort;
if (!port) throw new Error('Session manager requires an Electron utility process');
const databasePath = process.argv[2];
let manager: SessionManagement | undefined;
let queue = Promise.resolve();
let adapterSequence = 0;
const nativeReplies = new Map<number, (reply: Reply) => void>();
const nativePi: NativePiBridge = (request) => new Promise((resolve) => {
  const id = ++adapterSequence;
  const finish = (reply: Reply) => {
    clearTimeout(timer);
    nativeReplies.delete(id);
    resolve(reply);
  };
  const timer = setTimeout(() => finish({ ok: false, error: '远端任务响应超时，请核对原操作。' }), 10000);
  nativeReplies.set(id, finish);
  port.postMessage({ nativePi: { id, request } });
});
const adapterReplies = new Map<
  number,
  {
    resolve: (value: TerminalAdapterResults[TerminalAdapterCommand]) => void;
    reject: (error: Error) => void;
  }
>();
function adapterRequest<C extends TerminalAdapterCommand>(
  command: C,
  descriptor: TerminalAdapterInputs[C],
  terminal: import('../session-management/interface').ExternalTerminal = 'Terminal',
): Promise<TerminalAdapterResults[C]> {
  const id = ++adapterSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      adapterReplies.delete(id);
      reject(Error('Terminal timeout'));
    }, 12000);
    adapterReplies.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        adapterReplies.delete(id);
        resolve(value as TerminalAdapterResults[C]);
      },
      reject: (error) => {
        clearTimeout(timer);
        adapterReplies.delete(id);
        reject(error);
      },
    });
    port!.postMessage({ terminalAdapter: { id, terminal, command, descriptor } });
  });
}
const adapterProxy = (
  terminal: import('../session-management/interface').ExternalTerminal,
): TerminalAdapter => ({
  closeExited: (i) => adapterRequest('closeExited', i, terminal),
  inspect: () => adapterRequest('inspect', undefined, terminal),
  launch: (d) => adapterRequest('launch', d, terminal),
  focus: (i) => adapterRequest('focus', i, terminal),
  reconcile: (r) => adapterRequest('reconcile', r, terminal),
  prepareManual: (d) => adapterRequest('prepareManual', d, terminal),
  inspectManual: (h) => adapterRequest('inspectManual', h, terminal),
  revokeManual: (h) => adapterRequest('revokeManual', h, terminal),
});
const trashReplies = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
const deletion: import('../session-management/session-deletes').DeleteAdapter = {
  trash: (source) => {
    const id = ++adapterSequence;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        trashReplies.delete(id);
        reject(Object.assign(Error('原生废纸篓回执超时。'), { outcomeUnknown: true }));
      }, 10000);
      trashReplies.set(id, {
        resolve: () => {
          clearTimeout(timer);
          trashReplies.delete(id);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          trashReplies.delete(id);
          reject(e);
        },
      });
      port.postMessage({ trashAdapter: { id, source } });
    });
  },
};
const terminalAdapter = adapterProxy('Terminal'),
  ghosttyAdapter = adapterProxy('Ghostty');
port.on(
  'message',
  ({
    data,
  }: {
    data: {
      id: number;
      command: string;
      request?: unknown;
      trashAdapterReply?: TrashAdapterReply;
      terminalAdapterReply?: TerminalAdapterReply;
      nativePiReply?: { id: number; reply: Reply };
    };
  }) => {
    if (data.nativePiReply) {
      nativeReplies.get(data.nativePiReply.id)?.(data.nativePiReply.reply);
      return;
    }
    const trash = data.trashAdapterReply;
    if (trash) {
      const pending = trashReplies.get(trash.id);
      if (trash.error)
        pending?.reject(
          Object.assign(Error(trash.error), { outcomeUnknown: trash.outcomeUnknown === true }),
        );
      else pending?.resolve();
      return;
    }
    const reply = data.terminalAdapterReply;
    if (reply) {
      const pending = adapterReplies.get(reply.id);
      if (pending) {
        if (reply.error) pending.reject(Object.assign(Error(reply.error.message), reply.error));
        else pending.resolve(reply.value);
      }
      return;
    }
    queue = queue
      .then(async () => {
        if (data.command === 'close') {
          await manager?.close();
          port.postMessage({ id: data.id, closed: true });
          process.exit(0);
        }
        if (!manager) {
          const opened = await openSessionManagement(databasePath, {
            sessionsRoot: process.env.PI_HUB_SESSIONS_ROOT,
            deletion,
            nativePi,
            terminal: {
              appData: dirname(databasePath),
              adapter: terminalAdapter,
              ghosttyAdapter,
              startupAssetPath: join(__dirname, '../terminal/sdk-host.mjs'),
            },
            runtime: {
              appData: dirname(databasePath),
              agentDir: process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
              hostAssetPath: join(__dirname, '../terminal/sdk-host.mjs'),
            },
          });
          if (opened.status === 'failed') {
            port.postMessage({ id: data.id, result: opened });
            return;
          }
          manager = opened.value;
          manager.subscribe(-1, (snapshot) => port.postMessage({ snapshot }));
        }
        // Graceful exit can wait for Pi cleanup without blocking workspace reads or menu state.
        if (data.command === 'exitSession') {
          void manager
            .exitSession(
              data.request as import('../session-management/interface').ExitSessionRequest,
            )
            .then(
              (result) => port.postMessage({ id: data.id, result }),
              () =>
                port.postMessage({
                  id: data.id,
                  result: failed('IMPORT_UNAVAILABLE', '退出结果尚未确认，请核对原终端。'),
                }),
            );
          return;
        }
        // Preview I/O must not hold the command queue: cancellation and new selections pass through.
        if (data.command === 'getPreview') {
          void manager
            .getPreview(data.request as PreviewRequest)
            .then((result) => port.postMessage({ id: data.id, result }));
          return;
        }
        const result =
          data.command === 'sessionTerminals'
            ? await manager.sessionTerminals(data.request as { key: string; identity: string })
            : data.command === 'getTerminalSettings'
              ? await manager.getTerminalSettings()
              : data.command === 'setDefaultTerminal'
                ? await manager.setDefaultTerminal(
                    data.request as {
                      terminal: import('../session-management/interface').ExternalTerminal | null;
                    },
                  )
                : data.command === 'openTerminal'
                  ? await manager.openTerminal(
                      data.request as import('../session-management/interface').OpenSessionRequest,
                    )
                  : data.command === 'prepareTerminalCommand'
                    ? await manager.prepareTerminalCommand(data.request as { requestId: string })
                    : data.command === 'cancelTerminalCommand'
                      ? await manager.cancelTerminalCommand(data.request as { requestId: string })
                      : data.command === 'retryTerminal'
                        ? await manager.retryTerminal(data.request as { requestId: string })
                        : data.command === 'getTerminalOutcome'
                          ? await manager.getTerminalOutcome(data.request as { requestId: string })
                          : data.command === 'prepareDelete'
                            ? await manager.prepareDelete(data.request as { key: string })
                            : data.command === 'deleteSession'
                              ? await manager.deleteSession(
                                  data.request as import('../session-management/interface').DeleteRequest,
                                )
                              : data.command === 'getDeleteOutcome'
                                ? await manager.getDeleteOutcome(
                                    data.request as { requestId: string },
                                  )
                                : data.command === 'prepareRename'
                                  ? await manager.prepareRename(data.request as { key: string })
                                  : data.command === 'renameSession'
                                    ? await manager.renameSession(
                                        data.request as import('../session-management/interface').RenameRequest,
                                      )
                                    : data.command === 'getRenameOutcome'
                                      ? await manager.getRenameOutcome(
                                          data.request as { requestId: string },
                                        )
                                      : data.command === 'prepareClone'
                                        ? await manager.prepareClone(
                                            data.request as { key: string },
                                          )
                                        : data.command === 'cloneSession'
                                          ? await manager.cloneSession(
                                              data.request as import('../session-management/interface').CloneRequest,
                                            )
                                          : data.command === 'getCloneOutcome'
                                            ? await manager.getCloneOutcome(
                                                data.request as { requestId: string },
                                              )
                                            : data.command === 'getPiStatus'
                                              ? await manager.getPiStatus()
                                              : data.command === 'inspectPi'
                                                ? await manager.inspectPi(
                                                    data.request as import('../session-management/interface').LaunchConfiguration,
                                                  )
                                                : data.command === 'savePiConfiguration'
                                                  ? await manager.savePiConfiguration(
                                                      data.request as { reviewId: string },
                                                    )
                                                  : data.command === 'locateSession'
                                                    ? await manager.locateSession(
                                                        data.request as { key: string },
                                                      )
                                                    : data.command === 'setSessionClassification'
                                                      ? await manager.setSessionClassification(
                                                          data.request as ClassificationRequest,
                                                        )
                                                      : data.command === 'getClassificationOutcome'
                                                        ? await manager.getClassificationOutcome(
                                                            data.request as { requestId: string },
                                                          )
                                                        : data.command === 'listStorageLocations'
                                                          ? await manager.listStorageLocations()
                                                          : data.command ===
                                                              'prepareStorageLocation'
                                                            ? await manager.prepareStorageLocation(
                                                                data.request as StorageLocationRequest,
                                                              )
                                                            : data.command ===
                                                                'removeStorageLocation'
                                                              ? await manager.removeStorageLocation(
                                                                  data.request as RemoveStorageRequest,
                                                                )
                                                              : data.command ===
                                                                  'changeProjectScope'
                                                                ? await manager.changeProjectScope(
                                                                    data.request as ProjectScopeRequest,
                                                                  )
                                                                : data.command === 'removeProject'
                                                                  ? await manager.removeProject(
                                                                      data.request as RemoveProjectRequest,
                                                                    )
                                                                  : data.command ===
                                                                      'updatePreviewRuntime'
                                                                    ? await manager.updatePreviewRuntime(
                                                                        data.request as PreviewRuntime,
                                                                      )
                                                                    : data.command ===
                                                                        'cancelPreview'
                                                                      ? await manager.cancelPreview(
                                                                          data.request as {
                                                                            requestId: string;
                                                                          },
                                                                        )
                                                                      : data.command ===
                                                                          'getSnapshot'
                                                                        ? await manager.getSnapshot()
                                                                        : data.command ===
                                                                            'reconcile'
                                                                          ? await manager.reconcile()
                                                                          : data.command ===
                                                                              'cancelReconciliation'
                                                                            ? await manager.cancelReconciliation()
                                                                            : data.command ===
                                                                                'listProjects'
                                                                              ? await manager.listProjects()
                                                                              : data.command ===
                                                                                    'addProject' &&
                                                                                  data.request
                                                                                ? await manager.addProject(
                                                                                    data.request as AddProjectRequest,
                                                                                  )
                                                                                : data.command ===
                                                                                    'prepareImport'
                                                                                  ? await manager.prepareImport(
                                                                                      data.request as AddProjectRequest,
                                                                                    )
                                                                                  : data.command ===
                                                                                      'listImports'
                                                                                    ? await manager.listImports()
                                                                                    : data.command ===
                                                                                        'getImport'
                                                                                      ? await manager.getImport(
                                                                                          data.request as ImportRequest,
                                                                                        )
                                                                                      : data.command ===
                                                                                          'selectImport'
                                                                                        ? await manager.selectImport(
                                                                                            data.request as ImportSelectionRequest,
                                                                                          )
                                                                                        : data.command ===
                                                                                            'commitImport'
                                                                                          ? await manager.commitImport(
                                                                                              data.request as ImportRequest,
                                                                                            )
                                                                                          : data.command ===
                                                                                              'cancelImport'
                                                                                            ? await manager.cancelImport(
                                                                                                data.request as ImportRequest,
                                                                                              )
                                                                                            : data.command ===
                                                                                                'retryImport'
                                                                                              ? await manager.retryImport(
                                                                                                  data.request as ImportRequest,
                                                                                                )
                                                                                              : data.command ===
                                                                                                  'listSessions'
                                                                                                ? await manager.listSessions(
                                                                                                    data.request as SessionListRequest,
                                                                                                  )
                                                                                                : failed(
                                                                                                    'INVALID_REQUEST',
                                                                                                    '无效的项目请求。',
                                                                                                  );
        port.postMessage({ id: data.id, result });
      })
      .catch((error) => {
        port.postMessage({
          id: data.id,
          result: failed('DATABASE_UNAVAILABLE', '项目操作失败，请重试。', String(error)),
        });
      });
  },
);
