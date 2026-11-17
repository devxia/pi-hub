import type { ErrorCode, TerminalIdentity, TerminalTarget } from '../session-management/interface';
import type { ManualHandoff, ManualInspection } from '../session-management/manual-handoff';
import type {
  TerminalAdapter,
  TerminalLaunchDescriptor,
  TerminalReconciliation,
} from '../session-management/terminal';
export interface TerminalAdapterInputs {
  closeExited: import('../session-management/terminal').TerminalCloseTarget;
  inspect: undefined;
  launch: TerminalLaunchDescriptor;
  focus: { pid: number; startIdentity: string; tty: string; target?: TerminalTarget };
  reconcile: Parameters<NonNullable<TerminalAdapter['reconcile']>>[0];
  prepareManual: TerminalLaunchDescriptor;
  inspectManual: ManualHandoff;
  revokeManual: ManualHandoff;
}
export interface TerminalAdapterResults {
  closeExited: void;
  inspect: TerminalIdentity;
  launch: TerminalTarget;
  focus: TerminalTarget;
  reconcile: TerminalReconciliation;
  prepareManual: ManualHandoff;
  inspectManual: ManualInspection;
  revokeManual: ManualInspection;
}
export type TerminalAdapterCommand = keyof TerminalAdapterInputs;
export type TerminalAdapterRequest = {
  [C in TerminalAdapterCommand]: {
    id: number;
    terminal?: import('../session-management/interface').ExternalTerminal;
    command: C;
    descriptor: TerminalAdapterInputs[C];
  };
}[TerminalAdapterCommand];
export type TerminalAdapterReply = {
  [C in TerminalAdapterCommand]:
    | { id: number; command: C; value: TerminalAdapterResults[C]; error?: never }
    | {
        id: number;
        command: C;
        value?: never;
        error: { message: string; code?: ErrorCode; definitive?: boolean };
      };
}[TerminalAdapterCommand];
export async function executeTerminalAdapter(
  adapter: TerminalAdapter,
  request: TerminalAdapterRequest,
): Promise<TerminalAdapterResults[TerminalAdapterCommand]> {
  switch (request.command) {
    case 'closeExited':
      if (adapter.closeExited) return adapter.closeExited(request.descriptor);
      break;
    case 'inspect':
      return adapter.inspect();
    case 'launch':
      if (adapter.launch) return adapter.launch(request.descriptor);
      break;
    case 'focus':
      if (adapter.focus) return adapter.focus(request.descriptor);
      break;
    case 'reconcile':
      if (adapter.reconcile) return adapter.reconcile(request.descriptor);
      break;
    case 'prepareManual':
      if (adapter.prepareManual) return adapter.prepareManual(request.descriptor);
      break;
    case 'inspectManual':
      if (adapter.inspectManual) return adapter.inspectManual(request.descriptor);
      break;
    case 'revokeManual':
      if (adapter.revokeManual) return adapter.revokeManual(request.descriptor);
      break;
  }
  throw Error('Terminal adapter operation unavailable');
}
