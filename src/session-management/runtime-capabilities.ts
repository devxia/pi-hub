import type { Capability, RuntimeState, RuntimeCapabilities } from './interface';
/** Runtime state is information about Hub's own hosts, not a session occupancy policy. */
export function runtimeCapabilities(
  state: RuntimeState,
  problem?: Capability,
): RuntimeCapabilities {
  const allowed = { allowed: true };
  const host = state === 'connected' || state === 'busy';
  return {
    read: allowed,
    classify: allowed,
    rename: problem ?? allowed,
    delete: problem ?? allowed,
    launch: problem ?? allowed,
    clone:
      problem ??
      (host
        ? allowed
        : {
            allowed: false,
            code: 'HOST_REQUIRED',
            reason: '从Hub打开此会话后，可执行原生/clone并切换到副本。',
          }),
    locate:
      problem ??
      (host ? allowed : { allowed: false, code: 'UNBOUND', reason: '没有已连接的Hub终端。' }),
  };
}
