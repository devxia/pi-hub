import { inspectExternalSdk } from './external-sdk';
import { lock } from 'proper-lockfile';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
  lstat,
  realpath,
  access,
} from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import {
  completed,
  failed,
  type PiStatus,
  type LaunchConfiguration,
  type Result,
} from './interface';
const exec = promisify(execFile);
export interface RuntimeOptions {
  appData: string;
  agentDir: string;
  hostAssetPath: string;
}
export async function atomicWrite(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
const absolute = (p: unknown): p is string =>
  typeof p === 'string' && isAbsolute(p) && p.length < 4096 && !p.includes('\0');
const supportedNode = (s: string) => /^v(2[4-9]|[3-9]\d)\./.test(s.trim());
const invalid = (field: 'piPath' | 'nodePath' | 'settings', message: string): Result<never> => ({
  status: 'failed',
  error: { code: 'INVALID_REQUEST', field, message },
});
export function piConfiguration(options: RuntimeOptions) {
  const savedPath = join(options.appData, 'pi-launch.json'),
    settingsPath = join(options.agentDir, 'settings.json'),
    legacyExtension = join(options.appData, 'companion', 'extension.ts');
  let review:
      | { id: string; launch: LaunchConfiguration; version: string; settingsBytes: string }
      | undefined,
    busy = false;
  const settingsBytes = async () => {
    try {
      const s = await lstat(settingsPath);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 1024 * 1024) throw Error();
      return await readFile(settingsPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
      throw e;
    }
  };
  async function getPiStatus(): Promise<Result<PiStatus>> {
    let saved: Partial<PiStatus> = {};
    try {
      saved = JSON.parse(await readFile(savedPath, 'utf8'));
    } catch {}
    let legacyExtensionConfigured = false;
    try {
      legacyExtensionConfigured =
        JSON.parse(await settingsBytes()).extensions?.includes(legacyExtension) === true;
    } catch {}
    return completed({
      ...saved,
      configured: !!saved.launch,
      compatibility:
        saved.version === '1.5.2' ? 'supported' : saved.launch ? 'incompatible' : 'unchecked',
      supportedVersions: ['1.5.2'],
      settingsPath,
      legacyExtension,
      legacyExtensionConfigured,
      instances: [],
    });
  }
  async function inspectPi(request: LaunchConfiguration): Promise<Result<PiStatus>> {
    if (busy) return failed('INVALID_REQUEST', '正在核对启动配置，请稍后重试。');
    busy = true;
    review = undefined;
    try {
      if (
        !request ||
        Object.keys(request).some((k) => !['mode', 'piPath', 'nodePath'].includes(k)) ||
        (request.mode !== undefined && !['launcher', 'node'].includes(request.mode))
      )
        return failed('INVALID_REQUEST', '无效启动配置。');
      const mode = request.mode ?? 'launcher';
      let piPath = request.piPath,
        nodePath = request.nodePath;
      if (!piPath) {
        const candidates = [
          ...(process.env.PATH ?? '')
            .split(':')
            .filter(isAbsolute)
            .map((dir) => join(dir, 'pi')),
          join(homedir(), '.pi', 'agent', 'bin', 'pi'),
          '/usr/local/bin/pi',
          '/opt/homebrew/bin/pi',
        ];
        for (const p of [...new Set(candidates)])
          try {
            await access(p, constants.X_OK);
            piPath = p;
            break;
          } catch {}
      }
      if (!absolute(piPath)) return invalid('piPath', '请选择 Pi 启动文件的绝对路径。');
      try {
        piPath = await realpath(piPath);
        if (!(await lstat(piPath)).isFile()) throw Error();
      } catch {
        return invalid('piPath', 'Pi 文件不存在或不可访问。');
      }
      if (!nodePath) {
        const dirs = [
          ...(process.env.PATH ?? '').split(':'),
          join(homedir(), '.local', 'share', 'pi-node', 'current', 'bin'),
          '/usr/local/bin',
          '/opt/homebrew/bin',
        ];
        for (const dir of [...new Set(dirs)].filter((d) => isAbsolute(d)))
          try {
            const p = await realpath(join(dir, 'node'));
            const v = await exec(p, ['--version'], { timeout: 3000, maxBuffer: 4096 });
            if (supportedNode(v.stdout)) {
              nodePath = p;
              break;
            }
          } catch {}
      }
      if (!absolute(nodePath))
        return invalid('nodePath', '未找到 Node 24+，请填写 Node 可执行文件路径。');
      try {
        nodePath = await realpath(nodePath);
        if (
          !supportedNode(
            (await exec(nodePath, ['--version'], { timeout: 3000, maxBuffer: 4096 })).stdout,
          )
        )
          throw Error();
      } catch {
        return invalid('nodePath', 'Node 需要可执行且为24或更新版本。');
      }
      await mkdir(options.appData, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(options.appData, 'inspection-'));
      let version: string,
        cliPath: string,
        cliHash: string,
        launcherArgs: string[] = [];
      try {
        if (mode === 'node') {
          version = (
            await exec(nodePath, [piPath, '--version'], {
              timeout: 10000,
              maxBuffer: 4096,
              env: {
                HOME: process.env.HOME ?? homedir(),
                PATH: dirname(nodePath) + ':/usr/bin:/bin:/usr/sbin:/sbin',
                PI_CODING_AGENT_DIR: options.agentDir,
                PI_OFFLINE: '1',
              },
            })
          ).stdout.trim();
          cliPath = piPath;
        } else {
          const output = join(directory, 'observations.jsonl'),
            preload = join(directory, 'observe.cjs');
          await writeFile(
            preload,
            `require('node:fs').appendFileSync(${JSON.stringify(output)},JSON.stringify({node:process.execPath,cli:process.argv[1],args:process.argv.slice(2)})+'\\n')`,
            { mode: 0o600 },
          );
          version = (
            await exec(piPath, ['--version'], {
              timeout: 10000,
              maxBuffer: 4096,
              env: {
                HOME: process.env.HOME ?? homedir(),
                PATH: dirname(nodePath) + ':/usr/bin:/bin:/usr/sbin:/sbin',
                PI_CODING_AGENT_DIR: options.agentDir,
                PI_OFFLINE: '1',
                NODE_OPTIONS: '--require ' + JSON.stringify(preload),
              },
            })
          ).stdout.trim();
          const s = await lstat(output);
          if (s.size > 16384) throw Error('启动器输出过大');
          const rows = (await readFile(output, 'utf8'))
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l));
          const nodes = await Promise.all(rows.map((r) => realpath(r.node))),
            entries = [...new Set(rows.map((r) => r.cli).filter(Boolean))] as string[];
          if (new Set(nodes).size !== 1 || entries.length !== 1) throw Error('不能确认实际运行时');
          nodePath = nodes[0];
          cliPath = await realpath(entries[0]);
          launcherArgs = rows[0].args.filter((a: string) => a !== '--version');
        }
        cliHash = createHash('sha256')
          .update(await readFile(cliPath))
          .digest('hex');
      } catch {
        return invalid('piPath', '无法检测 Pi 版本和运行入口，请核对 Pi/Node 路径。');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      const externalSdk = await inspectExternalSdk(cliPath!, version!);
      if (!externalSdk || version !== '1.5.2')
        return completed({
          ...((await getPiStatus()) as { status: 'completed'; value: PiStatus }).value,
          configured: false,
          compatibility: 'incompatible',
          version: version!,
          error: '此SDK宿主入口目前验证Pi1.5.2，请选择该版本；不会降级或改动你的安装。',
        });
      if (launcherArgs.length)
        return invalid(
          'piPath',
          '此启动器附带了额外CLI参数，SDK入口不能静默丢弃，请使用无附加参数的Pi入口。',
        );
      let bytes: string;
      try {
        bytes = await settingsBytes();
        const p = JSON.parse(bytes);
        if (
          !p ||
          Array.isArray(p) ||
          typeof p !== 'object' ||
          (p.extensions !== undefined &&
            (!Array.isArray(p.extensions) ||
              p.extensions.some((x: unknown) => typeof x !== 'string')))
        )
          throw Error();
      } catch {
        return invalid('settings', 'Pi设置无法读取或格式无效，请先修复设置文件。');
      }
      const launch = { mode, piPath, nodePath, cliPath: cliPath!, cliHash: cliHash!, externalSdk };
      review = { id: randomUUID(), launch, version: version!, settingsBytes: bytes };
      const current = await getPiStatus();
      return current.status === 'failed'
        ? current
        : completed({
            ...current.value,
            launch,
            version: version!,
            compatibility: 'supported',
            reviewId: review.id,
          });
    } finally {
      busy = false;
    }
  }
  async function savePiConfiguration(request: { reviewId: string }): Promise<Result<PiStatus>> {
    if (busy || !review || request?.reviewId !== review.id)
      return failed('INVALID_REQUEST', '请先检测并审阅当前配置。');
    busy = true;
    let release: (() => Promise<void>) | undefined;
    try {
      const bytes = await settingsBytes();
      if (bytes !== review.settingsBytes)
        return failed('RECORD_CHANGED', 'Pi设置已变化，请重新检测。');
      const settings = JSON.parse(bytes);
      if (settings.extensions?.includes(legacyExtension)) {
        let compromised = false;
        release = await lock(settingsPath, {
          realpath: false,
          onCompromised: () => {
            compromised = true;
          },
        });
        if (compromised || (await settingsBytes()) !== bytes)
          return failed('RECORD_CHANGED', 'Pi设置已变化。');
        settings.extensions = settings.extensions.filter((p: string) => p !== legacyExtension);
        await atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      }
      await atomicWrite(
        savedPath,
        JSON.stringify({ launch: review.launch, version: review.version }, null, 2),
      );
      review = undefined;
      return getPiStatus();
    } catch {
      return failed('IMPORT_UNAVAILABLE', '启动配置未能保存，请检查目录权限后重试。');
    } finally {
      await release?.();
      busy = false;
    }
  }
  let automatic: Promise<Result<PiStatus>> | undefined;
  async function detectAndSave(): Promise<Result<PiStatus>> {
    const current = await getPiStatus();
    if (current.status === 'failed') return current;
    if (
      current.value.configured &&
      current.value.compatibility === 'supported' &&
      current.value.launch?.externalSdk
    )
      return current;
    const detected = await inspectPi({ mode: 'launcher', piPath: '', nodePath: '' });
    if (detected.status === 'failed')
      return {
        ...detected,
        error: {
          ...detected.error,
          code: 'PI_MISSING',
          message: '自动检测Pi或Node未完成：' + detected.error.message,
        },
      };
    if (!detected.value.reviewId)
      return failed('PI_MISSING', detected.value.error ?? '未找到受支持的Pi1.5.2运行入口。');
    return savePiConfiguration({ reviewId: detected.value.reviewId });
  }
  return {
    getPiStatus,
    inspectPi,
    savePiConfiguration,
    ensureConfiguration() {
      if (automatic) return automatic;
      automatic = detectAndSave().finally(() => {
        automatic = undefined;
      });
      return automatic;
    },
  };
}
