import { shell } from 'electron';
import {
  validDeleteSourceProof,
  verifyDeleteSourceProof,
  type DeleteSourceProof,
} from '../session-management/delete-source-facts';
export interface TrashAdapterReply {
  id: number;
  error?: string;
  outcomeUnknown?: boolean;
}
export interface TrashAdapterRequest {
  id: number;
  source: DeleteSourceProof;
}
/** Private utility→main channel only. No renderer-supplied paths reach shell.trashItem. */
export async function executeTrash(request: TrashAdapterRequest): Promise<void> {
  if (!Number.isSafeInteger(request?.id) || !validDeleteSourceProof(request?.source))
    throw Error('无效的原生废纸篓请求。');
  // One synchronous turn from the final pinned facts to native dispatch; no Pi history parsing.
  verifyDeleteSourceProof(request.source);
  await shell.trashItem(request.source.path);
}
