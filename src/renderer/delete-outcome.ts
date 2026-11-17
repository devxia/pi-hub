import type { DeleteOutcome } from '../session-management/interface';
/** Describe only the method established by this operation's receipt. */
export function deleteOutcomeMessage(outcome: DeleteOutcome): string {
  if (outcome.method === 'trash') return '原始会话已移入废纸篓。';
  if (outcome.method === 'permanent') return '原始会话已永久删除。';
  return '已确认原文件不在原位置，处理方式未能确认。';
}
