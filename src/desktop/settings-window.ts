import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import type { SettingsWindowState } from '../session-management/interface';

/** Owns a single non-modal renderer; its state never grants access to the main workspace APIs. */
export class SettingsWindow {
  private window: BrowserWindow | undefined;
  private state: SettingsWindowState = { category: 'terminal', dirty: false, busy: true };
  private closing: Promise<boolean> | undefined;
  private loadedURL = '';
  constructor(
    private rendererPath: string,
    private rendererURL: string,
  ) {}
  show() {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return;
    }
    this.state = { category: this.state.category, dirty: false, busy: true };
    this.loadedURL = this.rendererURL + '?view=settings&category=' + this.state.category;
    const window = (this.window = new BrowserWindow({
      title: 'Pi Hub 设置',
      width: 860,
      height: 640,
      minWidth: 640,
      minHeight: 480,
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#f7f8fa',
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    }));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.on('close', (event) => {
      event.preventDefault();
      void this.confirmClose().then((allowed) => {
        if (allowed && !window.isDestroyed()) window.destroy();
      });
    });
    window.on('closed', () => {
      if (this.window === window) this.window = undefined;
    });
    void window.loadFile(this.rendererPath, {
      query: { view: 'settings', category: this.state.category },
    });
  }
  trusted(event: IpcMainInvokeEvent) {
    return (
      !!this.window &&
      !this.window.isDestroyed() &&
      event.sender === this.window.webContents &&
      event.senderFrame === this.window.webContents.mainFrame &&
      event.senderFrame.url === this.loadedURL
    );
  }
  update(state: SettingsWindowState) {
    this.state = { ...state };
  }
  send(channel: string, value?: unknown) {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value);
  }
  close() {
    this.window?.close();
  }
  destroy() {
    this.window?.destroy();
  }
  confirmClose(): Promise<boolean> {
    if (this.closing) return this.closing;
    const window = this.window;
    if (!window || window.isDestroyed()) return Promise.resolve(true);
    this.closing = (async () => {
      if (this.state.busy) {
        await dialog.showMessageBox(window, {
          type: 'info',
          message: '请先完成当前设置操作',
          detail: '等待读取或保存完成；正在选择存储历史时，请先确认或取消添加。',
          buttons: ['返回设置'],
          defaultId: 0,
          cancelId: 0,
        });
        return false;
      }
      if (!this.state.dirty) return true;
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        message: '放弃未保存的设置？',
        detail: '终端或 Pi 启动设置中有未保存的更改。',
        buttons: ['继续编辑', '放弃更改'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    })()
      .catch(() => false)
      .finally(() => {
        this.closing = undefined;
      });
    return this.closing;
  }
}
