import { closeSessionTerminal } from './close-session-terminal';
import { terminalHostCommand } from '../session-management/terminal-shell';
import {
  prepareManualHandoff,
  inspectManualHandoff,
  revokeManualHandoff,
} from '../session-management/manual-handoff';
import { observeProcess } from '../session-management/runtime-process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, lstat, readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TerminalAdapterFailure,
  type TerminalAdapter,
  type TerminalLaunchDescriptor,
} from '../session-management/terminal';
const exec = promisify(execFile);
const terminalPath = '/System/Applications/Utilities/Terminal.app';
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function prepareLaunch(descriptor: TerminalLaunchDescriptor) {
  const directory = join(descriptor.appData, 'terminal-launches');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o777) !== 0o700
  )
    throw Error('private launch directory');
  const script = join(directory, randomUUID() + '.sh');
  let command = [
    '/usr/bin/env',
    ...Object.entries(descriptor.env).map(([key, value]) => `${key}=${value}`),
    descriptor.executable,
    ...descriptor.argv,
  ]
    .map(shellQuote)
    .join(' ');
  if (descriptor.startupAssetPath) {
    const entry = join(directory, randomUUID() + '.mjs'),
      data = join(directory, randomUUID() + '.json');
    await copyFile(descriptor.startupAssetPath, entry);
    await writeFile(data, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
    const node = descriptor.runtimeNodePath;
    if (!node) throw new TerminalAdapterFailure('PI_MISSING', true);
    command = terminalHostCommand(descriptor, entry, data);
  }
  await writeFile(
    script,
    `#!/bin/sh\n${descriptor.startupAssetPath ? '' : `cd ${shellQuote(descriptor.cwd)} || exit 1\n`}exec ${command}\n`,
    { mode: 0o700, flag: 'wx' },
  );
  return script;
}
/** This boundary receives only service-generated descriptors, never renderer argv or environment. */
export const terminalAdapter: TerminalAdapter = {
  closeExited: (instance) => closeSessionTerminal('Terminal', instance),
  prepareManual: prepareManualHandoff,
  inspectManual: inspectManualHandoff,
  revokeManual: revokeManualHandoff,
  async inspect() {
    const plist = join(terminalPath, 'Contents/Info.plist');
    const identity = await exec(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', plist],
      { timeout: 3000 },
    );
    const version = await exec(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', plist],
      { timeout: 3000 },
    );
    if (identity.stdout.trim() !== 'com.apple.Terminal') throw Error('Terminal identity');
    return { bundleId: 'com.apple.Terminal', path: terminalPath, version: version.stdout.trim() };
  },
  async reconcile(request) {
    return reconcileTerminalProcess(request, async (instance, target) => {
      const script = `on run argv
 tell application id "com.apple.Terminal"
  repeat with w in windows
   repeat with t in tabs of w
    if tty of t is (item 1 of argv) then
     if (item 2 of argv) is "" or (id of w as text) is (item 2 of argv) then return (id of w as text) & (ASCII character 9) & (tty of t)
    end if
   end repeat
  end repeat
  return ""
 end tell
end run`;
      try {
        const { stdout } = await exec(
          '/usr/bin/osascript',
          ['-e', script, instance.tty, target ? String(target.windowId) : ''],
          { timeout: 3000, maxBuffer: 4096 },
        );
        const match = stdout.trim().match(/^(\d+)\t(\/dev\/[^\s]+)$/);
        if (match) return { windowId: Number(match[1]), tty: match[2] };
      } catch {}
      return undefined;
    });
  },
  async focus(instance) {
    const before = await observeProcess(instance.pid);
    if (before.startIdentity !== instance.startIdentity || before.tty !== instance.tty)
      throw Error('process identity');
    const source = `on run argv
 tell application id "com.apple.Terminal"
  repeat with w in windows
   repeat with t in tabs of w
    if tty of t is (item 1 of argv) then
     set selected of t to true
     set miniaturized of w to false
     set index of w to 1
     activate
     return (id of w as text) & (ASCII character 9) & (tty of t)
    end if
   end repeat
  end repeat
  error "Original Terminal object unavailable"
 end tell
end run`;
    const { stdout } = await exec('/usr/bin/osascript', ['-e', source, instance.tty], {
      timeout: 5000,
      maxBuffer: 4096,
    });
    const after = await observeProcess(instance.pid);
    if (after.startIdentity !== instance.startIdentity || after.tty !== instance.tty)
      throw Error('changed process identity');
    const match = stdout.trim().match(/^(\d+)\t(\/dev\/[^\s]+)$/);
    if (!match || match[2] !== instance.tty) throw Error('Terminal object');
    return { windowId: Number(match[1]), tty: match[2] };
  },
  async launch(descriptor: TerminalLaunchDescriptor) {
    let script: string;
    try {
      script = await prepareLaunch(descriptor);
    } catch (error) {
      if (error instanceof TerminalAdapterFailure) throw error;
      throw new TerminalAdapterFailure('STARTUP_IO', true);
    }
    const source = `on run argv
 tell application id "com.apple.Terminal"
  set launched to do script (item 1 of argv)
  set device to tty of launched
  repeat with w in windows
   repeat with t in tabs of w
    if tty of t is device then
     activate
     return (id of w as text) & (ASCII character 9) & device
    end if
   end repeat
  end repeat
  error "No matching Terminal object"
 end tell
end run`;
    let stdout: string;
    try {
      ({ stdout } = await exec(
        '/usr/bin/osascript',
        ['-e', source, `exec /bin/sh ${shellQuote(script)}`],
        { timeout: 10000, maxBuffer: 4096 },
      ));
    } catch (error) {
      const e = error as { stderr?: string; killed?: boolean };
      if (e.stderr?.includes('-1743')) throw new TerminalAdapterFailure('AUTOMATION_DENIED', true);
      if (e.stderr?.includes('-1708')) throw new TerminalAdapterFailure('TERMINAL_PROTOCOL', true);
      if (e.killed) throw new TerminalAdapterFailure('TERMINAL_TIMEOUT', false);
      throw new TerminalAdapterFailure('TERMINAL_PROTOCOL', false);
    }
    const match = stdout.trim().match(/^(\d+)\t(\/dev\/[^\s]+)$/);
    if (!match) throw Error('Terminal protocol');
    return { windowId: Number(match[1]), tty: match[2] };
  },
};

export async function reconcileTerminalProcess(
  request: Parameters<NonNullable<TerminalAdapter['reconcile']>>[0],
  locate: (
    instance: { pid: number; startIdentity: string; tty: string },
    target?: import('../session-management/interface').TerminalTarget,
  ) => Promise<import('../session-management/interface').TerminalTarget | undefined>,
): Promise<import('../session-management/terminal').TerminalReconciliation> {
  let receipt: any;
  if (request.statusPath && request.attemptId) {
    try {
      const parent = await lstat(join(request.statusPath, '..'));
      const before = await lstat(request.statusPath);
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        parent.uid !== process.getuid!() ||
        (parent.mode & 0o777) !== 0o700 ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.uid !== process.getuid!() ||
        (before.mode & 0o777) !== 0o600 ||
        before.size > 8192
      )
        throw Error('startup status identity');
      receipt = JSON.parse(await readFile(request.statusPath, 'utf8'));
      const after = await lstat(request.statusPath);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        receipt.requestId !== request.requestId ||
        receipt.attemptId !== request.attemptId
      )
        throw Error('startup status changed');
    } catch {
      receipt = undefined;
    }
  }
  let nodeProof: any;
  if (receipt?.nodeProbePath === request.statusPath + '.node.json') {
    try {
      const file = await lstat(receipt.nodeProbePath);
      if (
        file.isFile() &&
        !file.isSymbolicLink() &&
        file.uid === process.getuid!() &&
        (file.mode & 0o777) === 0o600 &&
        file.size <= 4096
      ) {
        const proof = JSON.parse(await readFile(receipt.nodeProbePath, 'utf8'));
        if (proof.requestId === request.requestId && proof.attemptId === request.attemptId)
          nodeProof = proof;
      }
    } catch {}
  }
  const writer = nodeProof ?? receipt?.runtime;
  const instance = request.instance ?? writer ?? receipt?.helper;
  const observed = instance ? await observeProcess(instance.pid).catch(() => null) : null;
  const live =
    observed &&
    observed.startIdentity === instance.startIdentity &&
    observed.tty === instance.tty &&
    instance.tty;
  let target: import('../session-management/interface').TerminalTarget | undefined;
  if (live) {
    target = await locate(instance, request.target).catch(() => undefined);
    const checked = await observeProcess(instance.pid).catch(() => null);
    if (
      !checked ||
      checked.startIdentity !== instance.startIdentity ||
      checked.tty !== instance.tty
    )
      return { state: 'unknown' };
    if (receipt?.phase === 'not-started')
      return {
        state: 'not-started',
        target,
        errorCode: receipt.errorCode,
        message: receipt.message,
      };
    return { state: 'running', target };
  }
  if (receipt?.phase === 'not-started')
    return { state: 'not-started', errorCode: receipt.errorCode, message: receipt.message };
  if (writer && receipt?.phase !== 'preparing') {
    let exited = !!observed && observed.startIdentity !== instance.startIdentity;
    try {
      process.kill(writer.pid, 0);
    } catch (error) {
      exited = (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    if (exited) return { state: 'exited', errorCode: receipt.errorCode, message: receipt.message };
  }
  return { state: 'unknown' };
}
