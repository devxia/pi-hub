import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { launchOwnedElectron } from '../fixtures/owned-electron';

const evidence = process.env.PI_HUB_TEST_EVIDENCE!;
for (const compatible of [true, false]) {
  test(`standalone app ${compatible ? 'migrates the original project schema' : 'preserves an incompatible original database'}`, {tag:'@foreground'}, async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub18-schema-'));
    const profile = join(root, 'profile'), project = join(root, 'legacy project'), sessions = join(root, 'sessions');
    for (const path of [profile, project, sessions, evidence]) await mkdir(path, { recursive: true });
    const databasePath = join(profile, 'projects.sqlite');
    const db = new Database(databasePath);
    db.exec(compatible ? 'CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE); PRAGMA user_version=1' : 'CREATE TABLE projects (unrecognized TEXT); PRAGMA user_version=1');
    if (compatible) db.prepare('INSERT INTO projects VALUES (?, ?)').run('legacy-project', project);
    db.close();
    const original = await readFile(databasePath);
    let app = await launchOwnedElectron(root, profile, join(root, 'agent'), sessions, evidence);
    try {
      const page = await app.firstWindow();
      const runtime = await app.evaluate(({ app }) => ({ appPath: app.getAppPath(), versions: process.versions, pid: process.pid }));
      const rel = relative(resolve('.'), runtime.appPath);
      expect(rel.startsWith('..') || isAbsolute(rel)).toBe(true);
      expect(await page.url()).toMatch(/^file:/);
      if (compatible) {
        await expect(page.getByRole('button', { name: /legacy project/ }).first()).toBeVisible();
        const projects = await page.evaluate(() => window.sessionManagement.listProjects());
        expect(projects).toMatchObject({ status: 'completed', value: { projects: [{ id: 'legacy-project', path: project }] } });
        const backup = (await readdir(profile)).find(name => name.startsWith('projects.sqlite.backup-v1-'));
        expect(backup).toBeTruthy();
        await app.close();
        const restoreProfile = join(root, 'restored-profile');
        await mkdir(restoreProfile);
        await copyFile(join(profile, backup!), join(restoreProfile, 'projects.sqlite'));
        app = await launchOwnedElectron(root, restoreProfile, join(root, 'agent'), sessions, evidence);
        const restoredPage = await app.firstWindow();
        await expect(restoredPage.getByRole('button', { name: /legacy project/ }).first()).toBeVisible();
        expect(await restoredPage.evaluate(() => window.sessionManagement.listProjects())).toMatchObject({ status: 'completed', value: { projects: [{ id: 'legacy-project', path: project }] } });
      } else {
        await expect(page.getByRole('alert')).toContainText('未能读取项目');
        await page.getByRole('button', { name: '重新读取项目' }).click();
        await expect(page.getByRole('alert')).toContainText('已保存的项目未被更改');
        expect(await readFile(databasePath)).toEqual(original);
      }
      await writeFile(join(evidence, compatible ? 'migration.json' : 'migration-failed-preserved.json'), JSON.stringify({ root, runtime, backupOrOriginalPreserved: true }, null, 2));
    } finally { await app.close(); }
  });
}
