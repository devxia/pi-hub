import type { ManagedSession, Project, SessionListRequest } from './interface';

export const isVisibleSession = (session: ManagedSession) => session.hasMessages !== false;
export const compareSessions = (a: ManagedSession, b: ManagedSession) =>
  (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || a.key.localeCompare(b.key);

/** Shared query semantics for cached snapshots and the public query Interface. */
export function selectSessions<T extends ManagedSession>(
  sessions: T[],
  projects: Project[],
  request: SessionListRequest,
): T[] {
  const search = request.search?.trim().toLocaleLowerCase() ?? '';
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return sessions
    .filter(isVisibleSession)
    .filter(
      (s) =>
        (request.classification === 'all' || s.classification === request.classification) &&
        (!request.projectId || request.projectId === s.projectId) &&
        (!search ||
          [s.name, s.title, s.automaticTitle, names.get(s.projectId), s.cwd, s.sourcePath].some(
            (text) => text?.toLocaleLowerCase().includes(search),
          )),
    )
    .sort((a, b) =>
      request.sort === 'name'
        ? a.title.localeCompare(b.title, 'zh-CN') || a.key.localeCompare(b.key)
        : request.sort === 'created'
          ? (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.key.localeCompare(b.key)
          : compareSessions(a, b),
    )
    .slice(
      request.offset ?? 0,
      request.limit === undefined ? undefined : (request.offset ?? 0) + request.limit,
    );
}
export function validSessionQuery(request: SessionListRequest): boolean {
  return (
    !!request &&
    ['main', 'archive', 'all'].includes(request.classification) &&
    (request.projectId === undefined || typeof request.projectId === 'string') &&
    (request.search === undefined ||
      (typeof request.search === 'string' && request.search.length <= 1000)) &&
    (request.sort === undefined || ['recent', 'name', 'created'].includes(request.sort)) &&
    [request.offset, request.limit].every(
      (n) => n === undefined || (Number.isSafeInteger(n) && n >= 0),
    )
  );
}
