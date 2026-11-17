import { closeSessionTerminal } from './close-session-terminal';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TerminalIdentity, TerminalTarget } from '../session-management/interface';
import { TerminalAdapterFailure, type TerminalAdapter } from '../session-management/terminal';
import { observeProcess } from '../session-management/runtime-process';
import {
  prepareManualHandoff,
  inspectManualHandoff,
  revokeManualHandoff,
} from '../session-management/manual-handoff';
import { prepareLaunch, reconcileTerminalProcess, shellQuote } from './terminal-adapter';
const exec = promisify(execFile),
  appPath = '/Applications/Ghostty.app',
  bundleId = 'com.mitchellh.ghostty';
async function script(source: string, args: string[] = []) {
  try {
    return (
      await exec('/usr/bin/osascript', ['-e', source, ...args], { timeout: 10000, maxBuffer: 4096 })
    ).stdout.trim();
  } catch (error) {
    const e = error as { stderr?: string; killed?: boolean };
    if (e.stderr?.includes('-1743')) throw new TerminalAdapterFailure('AUTOMATION_DENIED', true);
    if (e.killed) throw new TerminalAdapterFailure('TERMINAL_TIMEOUT', false);
    throw new TerminalAdapterFailure('TERMINAL_PROTOCOL', false);
  }
}
function targetFrom(text: string): TerminalTarget {
  const parts = text.split('\t');
  if (
    parts.length !== 4 ||
    parts.slice(0, 3).some((p) => !p || !/^[-a-zA-Z0-9]+$/.test(p)) ||
    !/^\/dev\/[^\s]+$/.test(parts[3]!)
  )
    throw new TerminalAdapterFailure('TERMINAL_PROTOCOL', false);
  return {
    terminal: 'Ghostty',
    windowId: parts[0]!,
    tabId: parts[1]!,
    terminalId: parts[2]!,
    tty: parts[3]!,
  };
}
async function locate(
  instance: { pid: number; startIdentity: string; tty: string },
  target: TerminalTarget | undefined,
  focus: boolean,
) {
  if (
    !target ||
    target.terminal !== 'Ghostty' ||
    !target.tabId ||
    !target.terminalId ||
    target.tty !== instance.tty
  )
    throw Error('Original Ghostty binding unavailable');
  const before = await observeProcess(instance.pid);
  if (before.startIdentity !== instance.startIdentity || before.tty !== instance.tty)
    throw Error('Process identity changed');
  const text = await script(
    `on run argv
 tell application id "com.mitchellh.ghostty"
  repeat with w in windows
   if (id of w as text) is (item 1 of argv) then
    repeat with t in tabs of w
     if (id of t as text) is (item 2 of argv) then
      repeat with term in terminals of t
       if (id of term as text) is (item 3 of argv) and tty of term is (item 4 of argv) then
        if (item 5 of argv) is "focus" then
         select tab t
         focus term
         activate
        end if
        return (id of w as text) & (ASCII character 9) & (id of t as text) & (ASCII character 9) & (id of term as text) & (ASCII character 9) & (tty of term)
       end if
      end repeat
     end if
    end repeat
   end if
  end repeat
  error "Original Ghostty object unavailable"
 end tell
end run`,
    [
      String(target.windowId),
      target.tabId,
      target.terminalId,
      instance.tty,
      focus ? 'focus' : 'inspect',
    ],
  );
  const after = await observeProcess(instance.pid);
  if (after.startIdentity !== instance.startIdentity || after.tty !== instance.tty)
    throw Error('Process identity changed');
  return targetFrom(text);
}
async function bindTarget(instance: { pid: number; startIdentity: string; tty: string }) {
  const before = await observeProcess(instance.pid);
  if (before.startIdentity !== instance.startIdentity || before.tty !== instance.tty)
    throw Error('Process identity changed');
  const text = await script(
    `on run argv
 tell application id "com.mitchellh.ghostty"
  set matches to ""
  repeat with w in windows
   repeat with t in tabs of w
    repeat with term in terminals of t
     if tty of term is (item 1 of argv) then
      if matches is not "" then error "Ambiguous terminal binding"
      set matches to (id of w as text) & (ASCII character 9) & (id of t as text) & (ASCII character 9) & (id of term as text) & (ASCII character 9) & (tty of term)
     end if
    end repeat
   end repeat
  end repeat
  return matches
 end tell
end run`,
    [instance.tty],
  );
  const after = await observeProcess(instance.pid);
  if (after.startIdentity !== instance.startIdentity || after.tty !== instance.tty)
    throw Error('Process identity changed');
  return targetFrom(text);
}
/** Native scripting reads only stable object metadata, never terminal contents or titles. */
export const ghosttyAdapter: TerminalAdapter = {
  closeExited: (instance) => closeSessionTerminal('Ghostty', instance),
  prepareManual: prepareManualHandoff,
  inspectManual: inspectManualHandoff,
  revokeManual: revokeManualHandoff,
  async inspect(): Promise<TerminalIdentity> {
    const plist = join(appPath, 'Contents/Info.plist');
    const identity = (
      await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], {
        timeout: 3000,
      })
    ).stdout.trim();
    const version = (
      await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], {
        timeout: 3000,
      })
    ).stdout.trim();
    if (identity !== bundleId) throw new TerminalAdapterFailure('TERMINAL_MISSING', true);
    const dictionary = await readFile(join(appPath, 'Contents/Resources/Ghostty.sdef'), 'utf8');
    if (
      version !== '1.4.0' ||
      !['new tab', 'new window', 'surface configuration', 'select tab', 'focus', 'tty'].every(
        (name) => dictionary.includes(`name="${name}"`),
      )
    )
      throw new TerminalAdapterFailure('TERMINAL_PROTOCOL', true);
    return { bundleId, path: appPath, version, capability: 'stable-terminal-ids' };
  },
  async launch(descriptor) {
    await this.inspect();
    let path: string;
    try {
      path = await prepareLaunch(descriptor);
    } catch (error) {
      if (error instanceof TerminalAdapterFailure) throw error;
      throw new TerminalAdapterFailure('STARTUP_IO', true);
    }
    return targetFrom(
      await script(
        `on run argv
 tell application id "com.mitchellh.ghostty"
  set config to new surface configuration
  set command of config to item 1 of argv
  set initial working directory of config to item 2 of argv
  set wait after command of config to true
  if (count of windows) is 0 then
   set w to new window with configuration config
   set t to selected tab of w
  else
   set w to front window
   set t to new tab in w with configuration config
  end if
  set term to focused terminal of t
  repeat 100 times
   if tty of term is not "" then exit repeat
   delay 0.02
  end repeat
  activate
  return (id of w as text) & (ASCII character 9) & (id of t as text) & (ASCII character 9) & (id of term as text) & (ASCII character 9) & (tty of term)
 end tell
end run`,
        [`/bin/sh ${shellQuote(path)}`, descriptor.cwd],
      ),
    );
  },
  async focus(instance) {
    return locate(instance, instance.target, true);
  },
  async reconcile(request) {
    return reconcileTerminalProcess(request, (instance, target) =>
      target ? locate(instance, target, false) : bindTarget(instance),
    );
  },
};
