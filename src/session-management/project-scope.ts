import type Database from 'better-sqlite3';
import { basename, resolve, sep } from 'node:path';
import type { ManagedSession, Project } from './interface';

export function readProjects(db: Database.Database, includeInactive = false): Project[] {
  return (
    db
      .prepare(
        `SELECT id, path, include_descendants, enabled FROM projects ${includeInactive ? '' : 'WHERE enabled=1'} ORDER BY rowid`,
      )
      .all() as { id: string; path: string; include_descendants: number; enabled: number }[]
  ).map((p) => ({
    id: p.id,
    path: p.path,
    name: basename(p.path) || p.path,
    includeDescendants: !!p.include_descendants,
    enabled: !!p.enabled,
  }));
}
function coversPath(project: Project, path: string): boolean {
  return (
    path === project.path ||
    (project.includeDescendants &&
      path.startsWith(project.path.endsWith(sep) ? project.path : project.path + sep))
  );
}
export function covers(project: Project, cwd: string): boolean {
  return coversPath(project, resolve(cwd));
}
export function owner(projects: Project[], cwd: string): Project | undefined {
  const path = resolve(cwd);
  let found: Project | undefined;
  for (const project of projects)
    if (
      project.enabled !== false &&
      coversPath(project, path) &&
      (!found || project.path.length > found.path.length)
    )
      found = project;
  return found;
}
export function activeSessions<T extends ManagedSession>(sessions: T[], projects: Project[]): T[] {
  const owners = new Map<string, Project | undefined>();
  return sessions.flatMap((s) => {
    if (!owners.has(s.cwd)) owners.set(s.cwd, owner(projects, s.cwd));
    const project = owners.get(s.cwd);
    return project ? [{ ...s, projectId: project.id }] : [];
  });
}
/** Ownership changes never recreate records or touch their management classification. */
export function reassignSessions(db: Database.Database) {
  const projects = readProjects(db);
  for (const row of db.prepare('SELECT data FROM sessions').all() as { data: string }[]) {
    const session = JSON.parse(row.data) as ManagedSession;
    const project = owner(projects, session.cwd);
    if (project && project.id !== session.projectId)
      db.prepare('UPDATE sessions SET project_id=?, data=? WHERE key=?').run(
        project.id,
        JSON.stringify({ ...session, projectId: project.id }),
        session.key,
      );
  }
}
