import type { RuntimeState } from '../session-management/interface';
export const runtimeLabel = (state: RuntimeState = 'unknown') =>
  state === 'connected'
    ? '会话已开启 · 空闲'
    : state === 'busy'
      ? '会话已开启 · 处理中'
      : '会话未连接';
