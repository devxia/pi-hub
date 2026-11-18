import { dialog, type BrowserWindow } from 'electron';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, isAbsolute, join } from 'node:path';
import type { DefaultSSHPreview, RemoteChoice, Reply } from '../remote/contract';
import { previewDefaultSSH } from '../remote/security';

const configLimit = 64 * 1024;

async function readConfiguration(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > configLimit)
      throw Error('请选择不超过 64 KiB 的普通配置文件。');
    const bytes = Buffer.alloc(configLimit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (
      bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error('文件在读取时改变，请重试。');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

export async function readDefaultSSHPreview(): Promise<Reply<DefaultSSHPreview>> {
  const home = homedir();
  try {
    const source = await readConfiguration(join(home, '.ssh', 'config'));
    return { ok: true, value: previewDefaultSSH(source, home) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = code === 'ENOENT' ? '未找到默认 SSH 配置 ~/.ssh/config。可选择其他配置文件或粘贴片段。'
      : code === 'ELOOP' ? '默认 SSH 配置是符号链接。请手动选择它指向的配置文件。'
      : code ? '无法读取默认 SSH 配置 ~/.ssh/config。请检查文件权限或选择其他文件。'
      : (error as Error).message;
    return { ok: false, error: message };
  }
}

/** Native chooser for a user-specified file, directory, or publication target. */
export async function chooseRemote(
  owner: BrowserWindow,
  kind: RemoteChoice,
  project?: string,
): Promise<Reply<{ paths: string[]; text?: string }>> {
  try {
    if (kind === 'destination') {
      const result = await dialog.showSaveDialog(owner, {
        title: '选择结果目录名称',
        buttonLabel: '选择结果目录',
        properties: ['createDirectory'],
      });
      return {
        ok: true,
        value: { paths: result.canceled || !result.filePath ? [] : [result.filePath] },
      };
    }
    const result = await dialog.showOpenDialog(owner, {
      title: {
        config: '选择 SSH 配置文件',
        knownHosts: '选择 known_hosts 文件',
        project: '选择项目目录',
        inputs: '选择输入文件或目录',
        identity: '选择 SSH 身份文件',
      }[kind],
      properties:
        kind === 'inputs'
          ? ['openFile', 'openDirectory', 'multiSelections', 'noResolveAliases']
          : kind === 'project'
            ? ['openDirectory', 'noResolveAliases']
            : ['openFile', 'noResolveAliases'],
      ...(kind === 'inputs' && project ? { defaultPath: project } : {}),
    });
    if (result.canceled) return { ok: true, value: { paths: [] } };
    if (kind === 'inputs') {
      if (!project || !isAbsolute(project)) throw Error('请先选择绝对项目目录。');
      const paths = result.filePaths.map((path) => relative(project, path));
      if (
        paths.some((path) => !path || path === '..' || path.startsWith('../') || isAbsolute(path))
      )
        throw Error('输入必须位于所选项目目录内；请选择具体子目录或文件。');
      return { ok: true, value: { paths } };
    }
    if (kind === 'config' || kind === 'knownHosts') {
      return {
        ok: true,
        value: { paths: result.filePaths, text: await readConfiguration(result.filePaths[0]) },
      };
    }
    return { ok: true, value: { paths: result.filePaths } };
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) };
  }
}
