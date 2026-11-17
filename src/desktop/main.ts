import { SettingsWindow } from './settings-window';
import { showSessionMenu } from './session-menu';
import {
  validClassificationOutcomeRequest,
  validClassificationRequest,
} from '../session-management/classification-request';
import {
  app,
  BrowserWindow,
  dialog,
  clipboard,
  ipcMain,
  Menu,
  type IpcMainInvokeEvent,
} from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BackgroundSessionManagement } from './background';
import { validSessionQuery } from '../session-management/session-list';
import type { SessionListRequest } from '../session-management/interface';
import { failed, completed } from '../session-management/interface';

/** Main-process bridge for trusted runtime adapters; never exposed by preload or renderer IPC. */
export let background: BackgroundSessionManagement;

app.setName('Pi Hub');
const profile = app.commandLine.getSwitchValue('user-data-dir');
const dataDirectory = profile || join(homedir(), '.pi-hub');
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
app.setPath('userData', dataDirectory);
app.setPath('sessionData', dataDirectory);
app.setAppLogsPath(join(dataDirectory, 'logs'));
app.setPath('crashDumps', join(dataDirectory, 'Crashpad'));
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
else {
  const rendererPath = join(__dirname, '../renderer/index.html');
  const rendererURL = pathToFileURL(rendererPath).href;
  let window: BrowserWindow | undefined;
  const settings = new SettingsWindow(rendererPath, rendererURL);
  let quitting = false;
  let checkingQuit = false;
  let pickerOpen = false;

  function showWindow() {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return;
    }
    window = new BrowserWindow({
      title: 'Pi Hub',
      width: 1200,
      height: 780,
      minWidth: 760,
      minHeight: 540,
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#f7f8fa',
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    window.on('closed', () => {
      window = undefined;
    });
    void window.loadFile(rendererPath);
  }
  function trusted(event: IpcMainInvokeEvent, allowSettings = false) {
    return (
      (!!window &&
        !window.isDestroyed() &&
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame &&
        event.senderFrame.url === rendererURL) ||
      (allowSettings && settings.trusted(event))
    );
  }
  function settingsChanged() {
    if (window && !window.isDestroyed()) window.webContents.send('settings:changed');
    settings.send('settings:changed');
  }
  app.on('second-instance', () => {
    if (app.isReady()) showWindow();
  });
  app.on('activate', () => {
    if (app.isReady()) showWindow();
  });
  app.on('window-all-closed', () => {
    /* macOS keeps the single writer alive until explicit Quit. */
  });
  app.on('before-quit', (event) => {
    if (quitting || !background) return;
    event.preventDefault();
    if (checkingQuit) return;
    checkingQuit = true;
    void settings
      .confirmClose()
      .then((allowed) => {
        if (!allowed) return;
        quitting = true;
        settings.destroy();
        return background.close().finally(() => app.quit());
      })
      .finally(() => {
        checkingQuit = false;
      });
  });
  void app.whenReady().then(() => {
    background = new BackgroundSessionManagement(
      join(app.getPath('userData'), 'projects.sqlite'),
      (snapshot) => {
        if (window && !window.isDestroyed()) window.webContents.send('workspace:changed', snapshot);
        settings.send('workspace:changed', snapshot);
      },
    );
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Pi Hub',
          submenu: [
            { role: 'about', label: '关于 Pi Hub' },
            { type: 'separator' },
            { label: '设置…', accelerator: 'Command+,', click: () => settings.show() },
            { type: 'separator' },
            { role: 'hide', label: '隐藏 Pi Hub' },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '显示全部' },
            { type: 'separator' },
            { role: 'quit', label: '退出 Pi Hub' },
          ],
        },
        {
          label: '编辑',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: '窗口',
          submenu: [
            { role: 'minimize', label: '最小化' },
            { role: 'close', label: '关闭窗口' },
            { label: '显示主窗口', click: showWindow },
          ],
        },
      ]),
    );
    ipcMain.handle('settings:show', (event, ...args: unknown[]) => {
      if (!trusted(event) || args.length) return failed('INVALID_REQUEST', '无效设置请求。');
      settings.show();
      return completed(null);
    });
    ipcMain.handle('settings:close', (event, ...args: unknown[]) => {
      if (!settings.trusted(event) || args.length)
        return failed('INVALID_REQUEST', '无效设置请求。');
      settings.close();
      return completed(null);
    });
    ipcMain.handle('settings:state', (event, state: any, ...extra: unknown[]) => {
      if (
        !settings.trusted(event) ||
        extra.length ||
        !state ||
        Object.keys(state).length !== 3 ||
        !['terminal', 'storage', 'pi'].includes(state.category) ||
        typeof state.dirty !== 'boolean' ||
        typeof state.busy !== 'boolean'
      )
        return failed('INVALID_REQUEST', '无效设置状态。');
      settings.update(state);
      return completed(null);
    });
    for (const command of ['getSnapshot', 'reconcile', 'cancelReconciliation'] as const) {
      ipcMain.handle(`workspace:${command}`, (event, ...args: unknown[]) => {
        if (!trusted(event, command === 'getSnapshot') || args.length)
          return failed('INVALID_REQUEST', '无效的同步请求。');
        return background[command]();
      });
    }
    for (const command of ['changeProjectScope', 'removeProject'] as const) {
      ipcMain.handle(`projects:${command}`, (event, request: unknown, ...extra: unknown[]) => {
        const keys =
          command === 'changeProjectScope'
            ? ['requestId', 'projectId', 'expectedScopeRevision', 'includeDescendants']
            : ['requestId', 'projectId', 'expectedScopeRevision'];
        if (
          !trusted(event) ||
          extra.length ||
          !request ||
          typeof request !== 'object' ||
          Object.keys(request).some((key) => !keys.includes(key)) ||
          !('requestId' in request) ||
          typeof request.requestId !== 'string' ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId) ||
          !('projectId' in request) ||
          typeof request.projectId !== 'string' ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(request.projectId) ||
          !('expectedScopeRevision' in request) ||
          !Number.isSafeInteger(request.expectedScopeRevision)
        )
          return failed('INVALID_REQUEST', '无效的项目设置请求。');
        const target = {
          requestId: request.requestId,
          projectId: request.projectId,
          expectedScopeRevision: request.expectedScopeRevision as number,
        };
        if (command === 'removeProject') return background.removeProject(target);
        if (!('includeDescendants' in request) || typeof request.includeDescendants !== 'boolean')
          return failed('INVALID_REQUEST', '无效的项目范围。');
        return background.changeProjectScope({
          ...target,
          includeDescendants: request.includeDescendants,
        });
      });
    }
    ipcMain.handle('projects:list', (event, ...args: unknown[]) => {
      if (!trusted(event) || args.length) return failed('INVALID_REQUEST', '无效的项目请求。');
      return background.listProjects();
    });
    ipcMain.handle('imports:list', async (event, ...args: unknown[]) => {
      if (!trusted(event, true) || args.length)
        return failed('INVALID_REQUEST', '无效的导入请求。');
      const result = await background.listImports();
      return settings.trusted(event) && result.status === 'completed'
        ? completed(result.value.filter((batch) => batch.purpose === 'storage'))
        : result;
    });
    for (const command of [
      'getImport',
      'selectImport',
      'commitImport',
      'cancelImport',
      'retryImport',
    ] as const) {
      ipcMain.handle(`imports:${command}`, async (event, request: unknown, ...extra: unknown[]) => {
        const keys = command === 'selectImport' ? ['batchId', 'selectedKeys'] : ['batchId'];
        if (
          !trusted(event, true) ||
          extra.length ||
          !request ||
          typeof request !== 'object' ||
          Object.keys(request).some((key) => !keys.includes(key)) ||
          !('batchId' in request) ||
          typeof request.batchId !== 'string' ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(request.batchId)
        )
          return failed('INVALID_REQUEST', '无效的导入请求。');
        if (settings.trusted(event)) {
          const target = await background.getImport({ batchId: request.batchId });
          if (target.status === 'failed') return target;
          if (target.value.purpose !== 'storage')
            return failed('INVALID_REQUEST', '此导入属于主工作区。');
        }
        if (command === 'selectImport') {
          if (
            !('selectedKeys' in request) ||
            !Array.isArray(request.selectedKeys) ||
            request.selectedKeys.length > 100000 ||
            request.selectedKeys.some(
              (key) => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key),
            )
          )
            return failed('INVALID_REQUEST', '无效的导入选择。');
          return background.selectImport({
            batchId: request.batchId,
            selectedKeys: request.selectedKeys,
          });
        }
        return background[command]({ batchId: request.batchId });
      });
    }
    for (const command of ['prepareDelete', 'deleteSession', 'getDeleteOutcome'] as const) {
      ipcMain.handle(`sessions:${command}`, (event, request: any, ...extra: unknown[]) => {
        const keys =
          command === 'prepareDelete'
            ? ['key']
            : command === 'getDeleteOutcome'
              ? ['requestId']
              : ['requestId', 'key', 'identity', 'expectedRevision', 'confirmed'];
        if (
          !trusted(event) ||
          extra.length ||
          !request ||
          typeof request !== 'object' ||
          Array.isArray(request) ||
          Object.keys(request).some((k) => !keys.includes(k)) ||
          keys
            .filter((k) => k !== 'confirmed')
            .some(
              (k) => typeof request[k] !== 'string' || !request[k] || request[k].length > 128,
            ) ||
          (command === 'deleteSession' && request.confirmed !== true)
        )
          return failed('INVALID_REQUEST', '无效的删除确认。');
        if (command === 'prepareDelete') return background.prepareDelete(request);
        if (command === 'getDeleteOutcome') return background.getDeleteOutcome(request);
        return background.deleteSession(request);
      });
    }
    for (const command of ['prepareRename', 'renameSession', 'getRenameOutcome'] as const) {
      ipcMain.handle(`sessions:${command}`, (event, request: any, ...extra: unknown[]) => {
        const keys =
          command === 'prepareRename'
            ? ['key']
            : command === 'getRenameOutcome'
              ? ['requestId']
              : ['requestId', 'key', 'identity', 'expectedRevision', 'name'];
        if (
          !trusted(event) ||
          extra.length ||
          !request ||
          typeof request !== 'object' ||
          Array.isArray(request) ||
          Object.keys(request).some((k) => !keys.includes(k)) ||
          keys.some((k) => typeof request[k] !== 'string')
        )
          return failed('INVALID_REQUEST', '无效的改名请求。');
        if (command === 'prepareRename') return background.prepareRename(request);
        if (command === 'getRenameOutcome') return background.getRenameOutcome(request);
        return background.renameSession(request);
      });
    }
    for (const command of ['prepareClone', 'cloneSession', 'getCloneOutcome'] as const) {
      ipcMain.handle(`sessions:${command}`, (event, request: any, ...extra: unknown[]) => {
        const keys =
          command === 'prepareClone'
            ? ['key']
            : command === 'getCloneOutcome'
              ? ['requestId']
              : ['requestId', 'key'];
        if (
          !trusted(event) ||
          extra.length ||
          !request ||
          typeof request !== 'object' ||
          Object.keys(request).some((k) => !keys.includes(k)) ||
          keys.some((k) => typeof request[k] !== 'string' || !request[k] || request[k].length > 500)
        )
          return failed('INVALID_REQUEST', '无效的复制请求。');
        if (command === 'prepareClone') return background.prepareClone(request);
        if (command === 'getCloneOutcome') return background.getCloneOutcome(request);
        return background.cloneSession(request);
      });
    }
    for (const command of ['setSessionClassification', 'getClassificationOutcome'] as const) {
      ipcMain.handle(`sessions:${command}`, (event, request: unknown, ...extra: unknown[]) => {
        const keys =
          command === 'getClassificationOutcome'
            ? ['requestId']
            : ['requestId', 'key', 'classification', 'expectedRevision'];
        if (
          !trusted(event) ||
          extra.length ||
          !validClassificationOutcomeRequest(request) ||
          Object.keys(request).some((key) => !keys.includes(key))
        )
          return failed('INVALID_REQUEST', '无效的分类请求。');
        if (command === 'getClassificationOutcome')
          return background.getClassificationOutcome({ requestId: request.requestId });
        if (!validClassificationRequest(request))
          return failed('INVALID_REQUEST', '无效的会话分类请求。');
        return background.setSessionClassification(request);
      });
    }
    ipcMain.handle('sessions:list', (event, request: SessionListRequest, ...extra: unknown[]) => {
      if (
        !trusted(event) ||
        extra.length ||
        !request ||
        typeof request !== 'object' ||
        Object.keys(request).some(
          (key) =>
            !['classification', 'projectId', 'search', 'sort', 'offset', 'limit'].includes(key),
        ) ||
        !validSessionQuery(request)
      )
        return failed('INVALID_REQUEST', '无效的会话范围。');
      return background.listSessions(request);
    });
    for (const command of ['getPreview', 'cancelPreview'] as const) {
      ipcMain.handle(`sessions:${command}`, (event, request: unknown, ...extra: unknown[]) => {
        const keys =
          command === 'getPreview'
            ? ['key', 'requestId', 'expectedPreviewRevision']
            : ['requestId'];
        if (
          !trusted(event) ||
          extra.length ||
          !request ||
          typeof request !== 'object' ||
          Object.keys(request).some((key) => !keys.includes(key)) ||
          !('requestId' in request) ||
          typeof request.requestId !== 'string' ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId)
        )
          return failed('INVALID_REQUEST', '无效的预览请求。');
        if (command === 'cancelPreview')
          return background.cancelPreview({ requestId: request.requestId });
        if (
          !('key' in request) ||
          typeof request.key !== 'string' ||
          !/^[a-f0-9]{64}$/.test(request.key)
        )
          return failed('INVALID_REQUEST', '无效的会话身份。');
        if (
          'expectedPreviewRevision' in request &&
          (typeof request.expectedPreviewRevision !== 'string' ||
            request.expectedPreviewRevision.length > 128)
        )
          return failed('INVALID_REQUEST', '无效的预览修订。');
        return background.getPreview({
          key: request.key,
          requestId: request.requestId,
          expectedPreviewRevision:
            'expectedPreviewRevision' in request
              ? (request.expectedPreviewRevision as string)
              : undefined,
        });
      });
    }
    ipcMain.handle('storage:list', (event, ...args: unknown[]) =>
      trusted(event, true) && !args.length
        ? background.listStorageLocations()
        : failed('INVALID_REQUEST', '无效的存储位置请求。'),
    );
    ipcMain.handle('storage:remove', (event, request: unknown, ...extra: unknown[]) => {
      if (
        !trusted(event, true) ||
        extra.length ||
        !request ||
        typeof request !== 'object' ||
        Object.keys(request).some(
          (k) => !['requestId', 'locationId', 'expectedScopeRevision'].includes(k),
        ) ||
        !('requestId' in request) ||
        typeof request.requestId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId) ||
        !('locationId' in request) ||
        typeof request.locationId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(request.locationId) ||
        !('expectedScopeRevision' in request) ||
        !Number.isSafeInteger(request.expectedScopeRevision)
      )
        return failed('INVALID_REQUEST', '无效的存储位置请求。');
      return background.removeStorageLocation({
        requestId: request.requestId,
        locationId: request.locationId,
        expectedScopeRevision: request.expectedScopeRevision as number,
      });
    });
    ipcMain.handle('storage:choose', async (event, request: unknown, ...extra: unknown[]) => {
      if (
        !trusted(event, true) ||
        extra.length ||
        !request ||
        typeof request !== 'object' ||
        Object.keys(request).some((k) => !['requestId', 'enumeration'].includes(k)) ||
        !('requestId' in request) ||
        typeof request.requestId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId) ||
        !('enumeration' in request) ||
        !['flat', 'encoded'].includes(request.enumeration as string)
      )
        return failed('INVALID_REQUEST', '无效的存储位置请求。');
      if (pickerOpen) return failed('INVALID_REQUEST', '请先完成当前目录选择。');
      pickerOpen = true;
      try {
        const selected = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
          title: '添加会话存储位置',
          message: '选择存放 Pi 会话记录的目录。项目归属仍依据记录中的工作目录。',
          buttonLabel: '选择存储位置',
          properties: ['openDirectory', 'noResolveAliases'],
        });
        return await background.prepareStorageLocation({
          requestId: request.requestId,
          path: selected.canceled ? null : (selected.filePaths[0] ?? null),
          enumeration: request.enumeration as 'flat' | 'encoded',
        });
      } catch (error) {
        return failed('DIRECTORY_UNAVAILABLE', '无法选择存储位置，请重试。', String(error));
      } finally {
        pickerOpen = false;
      }
    });
    ipcMain.handle('projects:choose', async (event, request: unknown, ...extra: unknown[]) => {
      if (
        !trusted(event) ||
        extra.length ||
        !request ||
        typeof request !== 'object' ||
        Object.keys(request).length !== 1 ||
        !('requestId' in request) ||
        typeof request.requestId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId)
      )
        return failed('INVALID_REQUEST', '无效的项目请求。');
      if (pickerOpen) return failed('INVALID_REQUEST', '请先完成当前目录选择。');
      pickerOpen = true;
      try {
        const selected = await dialog.showOpenDialog(window!, {
          title: '添加项目',
          message: '选择项目目录，默认只包含此目录本身。',
          buttonLabel: '选择目录',
          properties: ['openDirectory', 'noResolveAliases'],
        });
        return await background.prepareImport({
          requestId: request.requestId,
          path: selected.canceled ? null : (selected.filePaths[0] ?? null),
        });
      } catch (error) {
        return failed('DIRECTORY_UNAVAILABLE', '无法选择项目目录，请重试。', String(error));
      } finally {
        pickerOpen = false;
      }
    });
    ipcMain.handle('pi:status', (event, ...args: unknown[]) =>
      trusted(event, true) && !args.length
        ? background.getPiStatus()
        : failed('INVALID_REQUEST', '无效Pi设置请求。'),
    );
    ipcMain.handle('pi:inspect', (event, request: unknown, ...extra: unknown[]) => {
      if (
        !trusted(event, true) ||
        extra.length ||
        !request ||
        typeof request !== 'object' ||
        Object.keys(request).some((k) => !['mode', 'piPath', 'nodePath'].includes(k)) ||
        !('piPath' in request) ||
        typeof request.piPath !== 'string' ||
        !('nodePath' in request) ||
        typeof request.nodePath !== 'string' ||
        ('mode' in request && !['launcher', 'node'].includes(request.mode as string))
      )
        return failed('INVALID_REQUEST', '无效Pi启动配置。');
      return background.inspectPi(
        request as import('../session-management/interface').LaunchConfiguration,
      );
    });
    ipcMain.handle('pi:save', async (event, request: any, ...extra: unknown[]) => {
      if (
        !trusted(event, true) ||
        extra.length ||
        !request ||
        Object.keys(request).length !== 1 ||
        typeof request.reviewId !== 'string'
      )
        return failed('INVALID_REQUEST', '请先检测Pi入口。');
      const result = await background.savePiConfiguration(request);
      if (result.status === 'completed') settingsChanged();
      return result;
    });
    ipcMain.handle('terminal:locate', (event, request: any, ...extra: unknown[]) =>
      trusted(event) &&
      !extra.length &&
      request &&
      Object.keys(request).length === 1 &&
      typeof request.key === 'string' &&
      /^[a-f0-9]{64}$/.test(request.key)
        ? background.locateSession(request)
        : failed('INVALID_REQUEST', '无效定位请求。'),
    );
    ipcMain.handle('terminal:copyCommand', async (event, request: any, ...extra: unknown[]) => {
      if (
        !trusted(event) ||
        extra.length ||
        !request ||
        Object.keys(request).length !== 1 ||
        typeof request.requestId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId)
      )
        return failed('INVALID_REQUEST', '无效命令请求。');
      const result = await background.prepareTerminalCommand(request);
      if (result.status === 'failed') return result;
      if (result.value?.state !== 'awaiting-paste')
        return failed('IMPORT_UNAVAILABLE', '手动启动已领取或仍需核对，暂不能重复复制。');
      if (!result.value?.command)
        return failed('INVALID_REQUEST', '此请求没有可复制的手动启动命令。');
      try {
        await clipboard.writeText(result.value.command);
        return completed(null);
      } catch {
        return failed(
          'STARTUP_IO',
          '启动命令已准备，但复制未完成；请再次复制同一命令，本次预约保持。',
        );
      }
    });
    ipcMain.handle('sessions:menu', (event, request: any, ...extra: unknown[]) =>
      trusted(event) &&
      !extra.length &&
      request &&
      Object.keys(request).every((k) => ['key', 'x', 'y'].includes(k)) &&
      typeof request.key === 'string' &&
      /^[a-f0-9]{64}$/.test(request.key) &&
      ((request.x === undefined && request.y === undefined) ||
        (Number.isSafeInteger(request.x) &&
          Number.isSafeInteger(request.y) &&
          request.x >= 0 &&
          request.y >= 0 &&
          request.x <= window!.getContentBounds().width &&
          request.y <= window!.getContentBounds().height))
        ? showSessionMenu(
            window!,
            background,
            request.key,
            request.x === undefined ? undefined : { x: request.x, y: request.y },
          )
        : failed('INVALID_REQUEST', '无效会话菜单目标。'),
    );
    ipcMain.handle('sessions:terminals', (event, request: any, ...extra: unknown[]) =>
      trusted(event) &&
      !extra.length &&
      request &&
      Object.keys(request).length === 2 &&
      ['key', 'identity'].every(
        (k) => typeof request[k] === 'string' && /^[a-f0-9]{64}$/.test(request[k]),
      )
        ? background.sessionTerminals(request)
        : failed('INVALID_REQUEST', '无效会话实例目标。'),
    );
    ipcMain.handle('sessions:exit', (event, request: any, ...extra: unknown[]) =>
      trusted(event) &&
      !extra.length &&
      request &&
      Object.keys(request).length === 5 &&
      ['key', 'identity'].every(
        (k) => typeof request[k] === 'string' && /^[a-f0-9]{64}$/.test(request[k]),
      ) &&
      ['requestId', 'hostId'].every(
        (k) => typeof request[k] === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(request[k]),
      ) &&
      typeof request.stopBusy === 'boolean'
        ? background.exitSession(request)
        : failed('INVALID_REQUEST', '无效退出请求。'),
    );
    ipcMain.handle('terminal:settings', (event, ...extra: unknown[]) =>
      trusted(event, true) && !extra.length
        ? background.getTerminalSettings()
        : failed('INVALID_REQUEST', '无效终端设置请求。'),
    );
    ipcMain.handle('terminal:default', async (event, request: any, ...extra: unknown[]) => {
      if (
        !trusted(event, true) ||
        extra.length ||
        !request ||
        Object.keys(request).length !== 1 ||
        !(request.terminal === null || ['Terminal', 'Ghostty'].includes(request.terminal))
      )
        return failed('INVALID_REQUEST', '无效终端设置。');
      const result = await background.setDefaultTerminal({ terminal: request.terminal });
      if (result.status === 'completed') settingsChanged();
      return result;
    });
    ipcMain.handle('terminal:cancelCommand', (event, request: any, ...extra: unknown[]) =>
      trusted(event) &&
      !extra.length &&
      request &&
      Object.keys(request).length === 1 &&
      typeof request.requestId === 'string' &&
      /^[a-zA-Z0-9-]{1,128}$/.test(request.requestId)
        ? background.cancelTerminalCommand(request)
        : failed('INVALID_REQUEST', '无效取消请求。'),
    );
    ipcMain.handle('terminal:retry', (event, request: any, ...extra: unknown[]) =>
      trusted(event) &&
      !extra.length &&
      request &&
      Object.keys(request).length === 1 &&
      typeof request.requestId === 'string' &&
      /^[a-zA-Z0-9-]{1,128}$/.test(request.requestId)
        ? background.retryTerminal(request)
        : failed('INVALID_REQUEST', '无效重试请求。'),
    );
    ipcMain.handle('terminal:outcome', (event, request: any, ...extra: unknown[]) =>
      trusted(event) &&
      !extra.length &&
      request &&
      Object.keys(request).length === 1 &&
      typeof request.requestId === 'string' &&
      /^[a-zA-Z0-9-]{1,128}$/.test(request.requestId)
        ? background.getTerminalOutcome({ requestId: request.requestId })
        : failed('INVALID_REQUEST', '无效结果请求。'),
    );
    ipcMain.handle('terminal:open', (event, request: any, ...extra: unknown[]) => {
      if (
        !trusted(event) ||
        extra.length ||
        !request ||
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
        ) ||
        typeof request.requestId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId) ||
        typeof request.projectId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(request.projectId) ||
        !['resume', 'new'].includes(request.intent) ||
        (request.intent === 'resume' &&
          (!/^[a-f0-9]{64}$/.test(request.key) || !/^[a-f0-9]{64}$/.test(request.identity)))
      )
        return failed('INVALID_REQUEST', '无效终端打开请求。');
      if (
        (request.terminal !== undefined && !['Terminal', 'Ghostty'].includes(request.terminal)) ||
        (request.rememberTerminal !== undefined &&
          (typeof request.rememberTerminal !== 'boolean' || !request.terminal))
      )
        return failed('INVALID_REQUEST', '无效的本次终端选择。');
      if (
        request.runtimeProjectId !== undefined &&
        (typeof request.runtimeProjectId !== 'string' ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(request.runtimeProjectId))
      )
        return failed('INVALID_REQUEST', '无效临时运行目录。');
      return background.openTerminal(request);
    });
    showWindow();
  });
}
