import {
  Menu,
  clipboard,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from 'electron';
import type { BackgroundSessionManagement } from './background';
import {
  completed,
  failed,
  type Result,
  type SessionMenuSelection,
  type SessionMenuAction,
} from '../session-management/interface';
import { matchesSourceIdentity } from '../session-management/source-identity';
export async function showSessionMenu(
  window: BrowserWindow,
  manager: BackgroundSessionManagement,
  key: string,
  point?: { x: number; y: number },
): Promise<Result<SessionMenuSelection | null>> {
  const snapshot = await manager.getSnapshot();
  if (snapshot.status === 'failed') return snapshot;
  const row = snapshot.value.sessions.find((s) => s.key === key);
  if (!row) return failed('RECORD_CHANGED', '会话已不在当前列表。');
  const terminal = await manager.getTerminalSettings();
  if (terminal.status === 'failed') return terminal;
  const instances = await manager.sessionTerminals({ key, identity: row.identity });
  if (instances.status === 'failed') return instances;
  return new Promise((resolve) => {
    let chosen = false;
    const choose = (action: SessionMenuAction, hostId?: string) => {
      chosen = true;
      void (async () => {
        const current = await manager.getSnapshot();
        if (current.status === 'failed') {
          resolve(current);
          return;
        }
        const record = current.value.sessions.find(
          (s) => s.key === key && s.identity === row.identity,
        );
        if (!record) {
          resolve(failed('RECORD_CHANGED', '菜单中的会话已被替换。'));
          return;
        }
        if (action === 'copy-id') clipboard.writeText(record.headerId);
        if (action === 'reveal') {
          if (
            record.availability.state !== 'available' ||
            !matchesSourceIdentity(record.sourcePath, record.identity)
          ) {
            resolve(failed('RECORD_CHANGED', '原会话文件当前不可用。'));
            return;
          }
          shell.showItemInFolder(record.sourcePath);
        }
        resolve(
          completed({
            key,
            identity: row.identity,
            action,
            ...(hostId ? { hostId } : {}),
            ...(action === 'classify'
              ? {
                  classification: row.classification,
                  classificationRevision: row.classificationRevision ?? 0,
                }
              : {}),
          }),
        );
      })().catch(() => resolve(failed('IMPORT_UNAVAILABLE', '会话菜单操作未完成，请重试。')));
    };
    const item = (
        id: SessionMenuAction,
        label: string,
        enabled = true,
        hostId?: string,
      ): MenuItemConstructorOptions => ({ id, label, enabled, click: () => choose(id, hostId) }),
      permits = row.runtimeCapabilities;
    const entries: MenuItemConstructorOptions[] = [
      item('open', `在 ${terminal.value.defaultTerminal ?? '终端'} 打开`, row.openSession.allowed),
    ];
    if (instances.value.length) entries.push(item('locate', '定位终端', permits.locate.allowed));
    entries.push(
      { type: 'separator' },
      item(
        'rename',
        permits.rename.code === 'RENAME_PENDING' ? '核对改名…' : '重命名…',
        permits.rename.allowed || permits.rename.code === 'RENAME_PENDING',
      ),
      item('clone', '复制并切换…', permits.clone.allowed),
      item(
        'classify',
        row.classification === 'archive' ? '恢复到主列表' : '归档会话',
        permits.classify.allowed,
      ),
      { type: 'separator' },
      item('copy-id', '复制 SessionID'),
      item('reveal', '在访达中显示会话文件', row.availability.state === 'available'),
    );
    if (instances.value.length) {
      entries.push({ type: 'separator' });
      if (instances.value.length === 1)
        entries.push(item('exit', '退出会话', true, instances.value[0].hostId));
      else
        entries.push({
          id: 'exit',
          label: '退出会话',
          submenu: instances.value.map((i) => ({
            id: 'exit-' + i.hostId,
            label: `${i.terminal} · ${i.tty.split('/').at(-1)}${i.busy ? ' · 处理中' : ''}`,
            click: () => choose('exit', i.hostId),
          })),
        });
    }
    entries.push(
      { type: 'separator' },
      item(
        'delete',
        permits.delete.code === 'DELETE_PENDING' ? '核对删除…' : '删除会话…',
        permits.delete.allowed || permits.delete.code === 'DELETE_PENDING',
      ),
    );
    const menu = Menu.buildFromTemplate(entries);
    menu.popup({
      window,
      ...point,
      callback: () => {
        setImmediate(() => {
          if (!chosen) resolve(completed(null));
        });
      },
    });
  });
}
