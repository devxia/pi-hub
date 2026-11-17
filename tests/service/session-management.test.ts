import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSessionManagement as openManager } from '../../src/session-management/service';
const openSessionManagement = (databasePath: string) => openManager(databasePath, { sessionsRoot: join(dirname(databasePath), 'isolated-agent', 'sessions') });

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-service-'));
  roots.push(root);
  const projectPath = join(root, '项目 空格');
  await mkdir(projectPath);
  return { root, projectPath, databasePath: join(root, 'hub.sqlite') };
}
function value<T>(result: { status: 'completed'; value: T } | { status: 'failed'; error: unknown }): T {
  expect(result.status).toBe('completed');
  if (result.status !== 'completed') throw new Error(JSON.stringify(result.error));
  return result.value;
}

test('adding a project persists its identity and exact scope across manager restart', async () => {
  const { projectPath, databasePath } = await fixture();
  const manager = value(await openSessionManagement(databasePath));
  expect(value(await manager.listProjects()).projects).toEqual([]);
  const added = value(await manager.addProject({ requestId: randomUUID(), path: projectPath }));
  expect(added.project).toMatchObject({ path: projectPath, includeDescendants: false });
  await manager.close();
  const restarted = value(await openSessionManagement(databasePath));
  expect(value(await restarted.listProjects()).projects).toEqual([added.project]);
  await restarted.close();
});

test('cancel creates nothing; lexical duplicates reuse identity while symlinks stay distinct', async () => {
  const { root, projectPath, databasePath } = await fixture();
  const { symlink } = await import('node:fs/promises');
  const link = join(root, '项目链接');
  await symlink(projectPath, link);
  const manager = value(await openSessionManagement(databasePath));
  expect(value(await manager.addProject({ requestId: randomUUID(), path: null }))).toEqual({ project: null, outcome: 'cancelled' });
  expect(value(await manager.listProjects()).projects).toEqual([]);
  const original = value(await manager.addProject({ requestId: randomUUID(), path: projectPath })).project;
  const duplicate = value(await manager.addProject({ requestId: randomUUID(), path: `${projectPath}//child/../.` }));
  expect(duplicate).toEqual({ outcome: 'existing', project: original });
  const linked = value(await manager.addProject({ requestId: randomUUID(), path: link })).project;
  expect(linked?.path).toBe(link);
  expect(linked?.id).not.toBe(original?.id);
  expect(value(await manager.listProjects()).projects).toHaveLength(2);
  await manager.close();
});

test('project scope matches only the normalized root, never a child or similar prefix', async () => {
  const { projectPath, databasePath } = await fixture();
  const manager = value(await openSessionManagement(databasePath));
  const project = value(await manager.addProject({ requestId: randomUUID(), path: projectPath })).project;
  expect(value(await manager.matchProject(`${projectPath}/.`))).toEqual(project);
  expect(value(await manager.matchProject(`${projectPath}/child`))).toBeNull();
  expect(value(await manager.matchProject(`${projectPath}-other`))).toBeNull();
  expect((await manager.addProject({ requestId: randomUUID(), path: 'relative' })).status).toBe('failed');
  expect((await manager.addProject({ requestId: randomUUID(), path: `${projectPath}/missing` })).status).toBe('failed');
  expect(value(await manager.listProjects()).projects).toHaveLength(1);
  await manager.close();
});

test('database corruption and inaccessible storage fail explicitly without replacing originals', async () => {
  const { root, databasePath } = await fixture();
  const { writeFile, readFile } = await import('node:fs/promises');
  const original = Buffer.from('not a database: preserve this file');
  await writeFile(databasePath, original);
  expect(await openSessionManagement(databasePath)).toMatchObject({ status: 'failed', error: { code: 'DATABASE_UNAVAILABLE' } });
  expect(await readFile(databasePath)).toEqual(original);
  expect(await openSessionManagement(join(root, 'missing', 'hub.sqlite'))).toMatchObject({ status: 'failed', error: { code: 'DATABASE_UNAVAILABLE' } });
});

test('a failed write reports failure, preserves existing projects, and can be retried after restart', async () => {
  const { root, projectPath, databasePath } = await fixture();
  const Database = (await import('better-sqlite3')).default;
  const manager = value(await openSessionManagement(databasePath));
  const original = value(await manager.addProject({ requestId: randomUUID(), path: projectPath })).project;
  const next = join(root, 'second');
  await mkdir(next);
  // A competing OS-level SQLite writer is a failure fixture, never a query/assertion seam.
  const lock = new Database(databasePath);
  lock.exec('BEGIN IMMEDIATE');
  try {
    expect(await manager.addProject({ requestId: randomUUID(), path: next })).toMatchObject({ status: 'failed', error: { code: 'DATABASE_BUSY' } });
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  expect(value(await manager.listProjects()).projects).toEqual([original]);
  await manager.close();
  const restarted = value(await openSessionManagement(databasePath));
  expect(value(await restarted.listProjects()).projects).toEqual([original]);
  expect(value(await restarted.addProject({ requestId: randomUUID(), path: next })).outcome).toBe('added');
  await restarted.close();
}, 15000);

test('versioned migration preserves a recoverable copy and rejects newer or incompatible databases', async () => {
  const { root, databasePath } = await fixture();
  const { readFile, readdir, copyFile } = await import('node:fs/promises');
  const Database = (await import('better-sqlite3')).default;
  // Version-zero SQLite is the supported pre-schema input. Fixtures are not production queries.
  const empty = new Database(databasePath);
  empty.exec('VACUUM');
  empty.close();
  const original = await readFile(databasePath);
  const manager = value(await openSessionManagement(databasePath));
  expect(value(await manager.listProjects()).projects).toEqual([]);
  await manager.close();
  const backups = (await readdir(root)).filter(name => name.includes('backup'));
  expect(backups).toHaveLength(1);
  const restoredPath = join(root, 'restored.sqlite');
  await copyFile(join(root, backups[0]), restoredPath);
  const backup = value(await openSessionManagement(restoredPath));
  expect(value(await backup.listProjects()).projects).toEqual([]);
  await backup.close();
  expect(original.length).toBeGreaterThan(0);

  const newerPath = join(root, 'newer.sqlite');
  const newer = new Database(newerPath);
  newer.pragma('user_version = 99');
  newer.close();
  const newerBytes = await readFile(newerPath);
  expect(await openSessionManagement(newerPath)).toMatchObject({ status: 'failed', error: { code: 'DATABASE_VERSION' } });
  expect(await readFile(newerPath)).toEqual(newerBytes);

  const incompatiblePath = join(root, 'incompatible.sqlite');
  const incompatible = new Database(incompatiblePath);
  incompatible.exec('CREATE TABLE projects (unrecognized TEXT)');
  incompatible.close();
  const incompatibleBytes = await readFile(incompatiblePath);
  expect(await openSessionManagement(incompatiblePath)).toMatchObject({ status: 'failed', error: { code: 'DATABASE_UNAVAILABLE' } });
  expect(await readFile(incompatiblePath)).toEqual(incompatibleBytes);
});
