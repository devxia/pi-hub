import { sessionDeletes, type DeleteAdapter } from './session-deletes';
import { sessionNames } from './session-names';
import { nativeClones } from './native-clones';
import { terminalSettings, type TerminalOptions } from './terminal';
import { piConfiguration, type RuntimeOptions } from './pi-configuration';
import { runtimeHosts } from './runtime-hosts';
import { readProjects, owner } from './project-scope';
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { classifications } from './classifications';
import { previews } from './preview';
import { discovery } from './discovery';
import { imports } from './imports';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { completed, failed, type Project, type SessionManagement, type Result } from './interface';

function databaseFailure(error: unknown): Result<never> {
  const code = (error as { code?: string }).code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
    return failed('DATABASE_BUSY', '项目数据库正被占用，请稍后重试。');
  return failed(
    'DATABASE_UNAVAILABLE',
    '无法读写项目数据库；请核对原操作结果，并检查存储位置与权限后重试。',
    String(error),
  );
}

export async function openSessionManagement(
  databasePath: string,
  options: {
    sessionsRoot?: string;
    reconciliationIntervalMs?: number;
    runtime?: RuntimeOptions;
    terminal?: TerminalOptions;
    deletion?: DeleteAdapter;
  } = {},
): Promise<Result<SessionManagement>> {
  let db: Database.Database;
  try {
    const existingFile = existsSync(databasePath);
    db = new Database(databasePath, { timeout: 500 });
    try {
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version > 15) {
        db.close();
        return failed(
          'DATABASE_VERSION',
          '数据库来自更新版本的应用，请使用更新版本打开；原文件已保留。',
        );
      }
      db.pragma('foreign_keys = ON');
      if (version < 15) {
        // SQLite backup includes committed journal state; a raw file copy would not.
        if (existingFile)
          await db.backup(`${databasePath}.backup-v${version}-${randomUUID()}.sqlite`);
        db.transaction(() => {
          if (version === 0)
            db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE)');
          if (version < 2)
            db.exec(`CREATE TABLE import_batches (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE sessions (key TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
            CREATE TABLE import_queue (key TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id), data TEXT NOT NULL);
            CREATE TABLE scope_state (revision INTEGER NOT NULL);
            INSERT INTO scope_state SELECT count(*) FROM projects;`);
          db.prepare('SELECT id, path FROM projects LIMIT 0').all();
          if (version < 3)
            db.exec(`CREATE TABLE discovery_state (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL);
            INSERT INTO discovery_state VALUES (1, 0, '{}');`);
          // v4 requires header creation and separate automatic title; discovery reparses
          // unchanged sources whose projectionVersion is absent, preserving classification.
          if (version < 5)
            db.exec(
              'ALTER TABLE projects ADD COLUMN include_descendants INTEGER NOT NULL DEFAULT 0; ALTER TABLE projects ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;',
            );
          if (version < 6)
            db.exec('CREATE TABLE storage_locations (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
          if (version < 7)
            db.exec(
              'CREATE TABLE classification_requests (id TEXT PRIMARY KEY, request TEXT NOT NULL, outcome TEXT NOT NULL); CREATE TABLE classification_state (revision INTEGER NOT NULL); INSERT INTO classification_state VALUES(0)',
            );
          if (version < 11)
            db.exec(
              'CREATE TABLE terminal_settings (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL); CREATE TABLE terminal_requests (id TEXT PRIMARY KEY,data TEXT NOT NULL)',
            );
          if (version < 13)
            db.exec('CREATE TABLE rename_requests (id TEXT PRIMARY KEY,data TEXT NOT NULL)');
          if (version < 14)
            db.exec('CREATE TABLE delete_requests (id TEXT PRIMARY KEY,data TEXT NOT NULL)');
          db.exec(
            'DELETE FROM terminal_requests; DELETE FROM rename_requests; DELETE FROM delete_requests; CREATE TABLE sdk_hosts (id TEXT PRIMARY KEY,data TEXT NOT NULL); DROP TABLE IF EXISTS runtime_leases; DROP TABLE IF EXISTS launch_reservations; DROP TABLE IF EXISTS clone_requests; DROP TABLE IF EXISTS recovery_requests; DROP TABLE IF EXISTS directory_recoveries; CREATE TABLE native_clone_requests (id TEXT PRIMARY KEY,data TEXT NOT NULL)',
          );
          db.pragma('user_version = 15');
        })();
      }
      db.prepare('SELECT id, path FROM projects LIMIT 0').all();
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    return databaseFailure(error);
  }
  const projects = () => readProjects(db);
  function query<T>(read: () => T): Result<T> {
    try {
      return completed(read());
    } catch (error) {
      return databaseFailure(error);
    }
  }
  const sessionsRoot =
    options.sessionsRoot ??
    process.env.PI_HUB_SESSIONS_ROOT ??
    join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions');
  try {
    db.prepare('INSERT OR REPLACE INTO storage_locations(id,data) VALUES(?,?)').run(
      'standard',
      JSON.stringify({
        id: 'standard',
        path: resolve(sessionsRoot),
        kind: 'standard',
        enumeration: 'encoded',
        enabled: true,
      }),
    );
  } catch (error) {
    db.close();
    return databaseFailure(error);
  }
  let onImported = () => {};
  let history: ReturnType<typeof imports>;
  try {
    history = imports(db, sessionsRoot, databaseFailure, () => onImported());
  } catch (error) {
    db.close();
    return databaseFailure(error);
  }
  let live: ReturnType<typeof discovery>;
  const preview = previews(db, () => live.invalidatePreview());
  const configuration = options.runtime ? piConfiguration(options.runtime) : undefined;
  try {
    live = discovery(
      db,
      sessionsRoot,
      projects,
      databaseFailure,
      options.reconciliationIntervalMs,
      preview.getRevision,
      preview.getRuntimeState,
      preview.getRuntimeCwd,
    );
  } catch (error) {
    await history.close();
    db.close();
    return databaseFailure(error);
  }
  onImported = () => live.scopeChanged();
  let hosts: Awaited<ReturnType<typeof runtimeHosts>> | undefined;
  try {
    if (options.runtime)
      hosts = await runtimeHosts(
        options.runtime,
        db,
        preview.applyRuntime,
        live.invalidatePreview,
        live.reconcileSource,
      );
  } catch (error) {
    await live.close();
    await history.close();
    db.close();
    return databaseFailure(error);
  }
  const { applyRuntime: _internalRuntime, ...publicPreview } = preview;
  const runtimeSnapshot = () => live.getSnapshot();
  const terminal = terminalSettings(
    db,
    options.terminal,
    configuration,
    hosts,
    runtimeSnapshot,
    options.runtime,
    sessionsRoot,
    live.invalidatePreview,
  );
  return completed({
    ...terminal,
    async getPiStatus() {
      const s = configuration
        ? await configuration.getPiStatus()
        : completed({
            configured: false,
            compatibility: 'unchecked' as const,
            supportedVersions: ['1.5.2'],
            settingsPath: '',
            legacyExtension: '',
            legacyExtensionConfigured: false,
            instances: [],
          });
      return s.status === 'failed'
        ? s
        : completed({ ...s.value, instances: hosts?.instances() ?? [] });
    },
    async inspectPi(request) {
      return configuration
        ? configuration.inspectPi(request)
        : failed('PI_MISSING', '启动服务未配置。');
    },
    async savePiConfiguration(request) {
      return configuration
        ? configuration.savePiConfiguration(request)
        : failed('PI_MISSING', '启动服务未配置。');
    },
    ...sessionDeletes(
      db,
      runtimeSnapshot,
      databaseFailure,
      live.classificationChanged,
      live.invalidatePreview,
      options.deletion,
    ),
    ...sessionNames(
      db,
      runtimeSnapshot,
      live.reconcileSource,
      databaseFailure,
      hosts,
      live.invalidatePreview,
    ),
    ...nativeClones(db, runtimeSnapshot, live.reconcileSettled, hosts),
    ...history,
    ...live,
    getSnapshot: runtimeSnapshot,
    ...publicPreview,
    ...classifications(db, databaseFailure, live.classificationChanged),
    async listProjects() {
      return query(() => {
        const rows = projects();
        return {
          projects: rows,
          revision: (db.prepare('SELECT revision FROM scope_state').get() as { revision: number })
            .revision,
        };
      });
    },
    async addProject(request) {
      if (
        !request ||
        typeof request.requestId !== 'string' ||
        !request.requestId ||
        request.requestId.length > 128
      )
        return failed('INVALID_REQUEST', '无效的项目请求。');
      if (request.path === null) return completed({ project: null, outcome: 'cancelled' });
      if (
        typeof request.path !== 'string' ||
        !isAbsolute(request.path) ||
        request.path.includes('\0')
      )
        return failed('INVALID_REQUEST', '请选择绝对目录路径。');
      const path = resolve(request.path);
      try {
        if (!(await stat(path)).isDirectory())
          return failed('DIRECTORY_UNAVAILABLE', '所选路径不是目录。');
      } catch {
        return failed('DIRECTORY_UNAVAILABLE', '目录不可用，请检查位置与访问权限。');
      }
      const inactive = query(() =>
        readProjects(db, true).some((project) => project.path === path && !project.enabled),
      );
      if (inactive.status === 'failed') return inactive;
      if (inactive.value)
        return failed('IMPORT_UNAVAILABLE', '重新添加项目需要先选择新增历史，请使用项目导入。');
      const result = query(() =>
        db.transaction(() => {
          const existing = projects().find((project) => project.path === path);
          if (existing) return { project: existing, outcome: 'existing' as const };
          const project: Project = {
            id: randomUUID(),
            path,
            name: basename(path) || path,
            includeDescendants: false,
            enabled: true,
          };
          db.prepare('INSERT INTO projects (id, path) VALUES (?, ?)').run(project.id, project.path);
          db.prepare('UPDATE scope_state SET revision = revision + 1').run();
          return { project, outcome: 'added' as const };
        })(),
      );
      if (result.status === 'completed') void live.reconcile();
      return result;
    },
    async matchProject(cwd) {
      if (!isAbsolute(cwd)) return failed('INVALID_REQUEST', '需要绝对目录路径。');
      return query(() => owner(projects(), cwd) ?? null);
    },
    async close() {
      await hosts?.close();
      await preview.close();
      await live.close();
      await history.close();
      if (db.open) db.close();
    },
  });
}
