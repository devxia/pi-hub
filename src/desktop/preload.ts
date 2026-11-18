import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopSessionManagement, WorkspaceSnapshot } from '../session-management/interface';
const api: DesktopSessionManagement = {
  showSettings: () => ipcRenderer.invoke('settings:show'),
  updateSettingsWindow: (state) => ipcRenderer.invoke('settings:state', state),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  onSettingsChanged: (listener) => {
    const changed = () => listener();
    ipcRenderer.on('settings:changed', changed);
    return () => ipcRenderer.removeListener('settings:changed', changed);
  },
  cancelTerminalCommand: (request) => ipcRenderer.invoke('terminal:cancelCommand', request),
  retryTerminal: (request) => ipcRenderer.invoke('terminal:retry', request),
  copyTerminalCommand: (request) => ipcRenderer.invoke('terminal:copyCommand', request),
  getPiStatus: () => ipcRenderer.invoke('pi:status'),
  inspectPi: (request) => ipcRenderer.invoke('pi:inspect', request),
  savePiConfiguration: (request) => ipcRenderer.invoke('pi:save', request),
  locateSession: (request) => ipcRenderer.invoke('terminal:locate', request),
  getTerminalSettings: () => ipcRenderer.invoke('terminal:settings'),
  setDefaultTerminal: (request) => ipcRenderer.invoke('terminal:default', request),
  showSessionMenu: (request) => ipcRenderer.invoke('sessions:menu', request),
  sessionTerminals: (request) => ipcRenderer.invoke('sessions:terminals', request),
  exitSession: (request) => ipcRenderer.invoke('sessions:exit', request),
  openTerminal: (request) => ipcRenderer.invoke('terminal:open', request),
  getTerminalOutcome: (request) => ipcRenderer.invoke('terminal:outcome', request),
  prepareClone: (request) => ipcRenderer.invoke('sessions:prepareClone', request),
  prepareDelete: (request) => ipcRenderer.invoke('sessions:prepareDelete', request),
  deleteSession: (request) => ipcRenderer.invoke('sessions:deleteSession', request),
  getDeleteOutcome: (request) => ipcRenderer.invoke('sessions:getDeleteOutcome', request),
  prepareRename: (request) => ipcRenderer.invoke('sessions:prepareRename', request),
  renameSession: (request) => ipcRenderer.invoke('sessions:renameSession', request),
  getRenameOutcome: (request) => ipcRenderer.invoke('sessions:getRenameOutcome', request),
  cloneSession: (request) => ipcRenderer.invoke('sessions:cloneSession', request),
  getCloneOutcome: (request) => ipcRenderer.invoke('sessions:getCloneOutcome', request),
  setSessionClassification: (request) =>
    ipcRenderer.invoke('sessions:setSessionClassification', request),
  getClassificationOutcome: (request) =>
    ipcRenderer.invoke('sessions:getClassificationOutcome', request),
  listStorageLocations: () => ipcRenderer.invoke('storage:list'),
  chooseStorageLocation: (request) => ipcRenderer.invoke('storage:choose', request),
  removeStorageLocation: (request) => ipcRenderer.invoke('storage:remove', request),
  changeProjectScope: (request) => ipcRenderer.invoke('projects:changeProjectScope', request),
  removeProject: (request) => ipcRenderer.invoke('projects:removeProject', request),
  getPreview: (request) => ipcRenderer.invoke('sessions:getPreview', request),
  cancelPreview: (request) => ipcRenderer.invoke('sessions:cancelPreview', request),
  getSnapshot: () => ipcRenderer.invoke('workspace:getSnapshot'),
  reconcile: () => ipcRenderer.invoke('workspace:reconcile'),
  cancelReconciliation: () => ipcRenderer.invoke('workspace:cancelReconciliation'),
  subscribe: (afterRevision, listener) => {
    let revision = afterRevision;
    let stopped = false;
    let reading = false;
    const deliver = (snapshot: WorkspaceSnapshot) => {
      if (!stopped && snapshot.revision > revision) {
        revision = snapshot.revision;
        listener(snapshot);
      }
    };
    const changed = (_event: Electron.IpcRendererEvent, snapshot: WorkspaceSnapshot) =>
      deliver(snapshot);
    const refresh = async () => {
      if (stopped || reading) return;
      reading = true;
      try {
        const result = await ipcRenderer.invoke('workspace:getSnapshot');
        if (result.status === 'completed') deliver(result.value);
      } catch {
        /* Retry the interrupted transport on the next reconnect poll. */
      } finally {
        reading = false;
      }
    };
    // Register before reading the snapshot; revisions reject late replies. Polling also reconnects a restarted utility.
    ipcRenderer.on('workspace:changed', changed);
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
      ipcRenderer.removeListener('workspace:changed', changed);
    };
  },
  listProjects: () => ipcRenderer.invoke('projects:list'),
  chooseProject: (request) => ipcRenderer.invoke('projects:choose', request),
  listImports: () => ipcRenderer.invoke('imports:list'),
  getImport: (request) => ipcRenderer.invoke('imports:getImport', request),
  selectImport: (request) => ipcRenderer.invoke('imports:selectImport', request),
  commitImport: (request) => ipcRenderer.invoke('imports:commitImport', request),
  cancelImport: (request) => ipcRenderer.invoke('imports:cancelImport', request),
  retryImport: (request) => ipcRenderer.invoke('imports:retryImport', request),
  listSessions: (request) => ipcRenderer.invoke('sessions:list', request),
};
contextBridge.exposeInMainWorld('sessionManagement', api);

contextBridge.exposeInMainWorld('remoteWorkspace', {
  request: (request) => ipcRenderer.invoke('remote:request', request),
  choose: (kind, project) => ipcRenderer.invoke('remote:choose', kind, project),
  previewDefaultSSH: () => ipcRenderer.invoke('remote:previewDefaultSSH'),
} satisfies import('../remote/contract').RemoteAPI);
