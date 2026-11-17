import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TerminalCloseTarget } from '../session-management/terminal';
import { observeProcess } from '../session-management/runtime-process';
const exec = promisify(execFile);
/** Only after graceful Pi exit; never close a live or reused terminal surface. */
export async function closeSessionTerminal(
  terminal: 'Terminal' | 'Ghostty',
  instance: TerminalCloseTarget,
) {
  if (
    !Number.isSafeInteger(instance.pid) ||
    !/^\/dev\/ttys\d+$/.test(instance.tty) ||
    instance.target.tty !== instance.tty
  )
    throw Error('Invalid exact terminal target');
  let observed;
  try {
    observed = await observeProcess(instance.pid);
  } catch {}
  if (observed?.startIdentity === instance.startIdentity)
    throw Error('Original Pi is still running');
  try {
    const r = await exec('/bin/ps', ['-t', instance.tty.slice(5), '-o', 'pid=', '-o', 'comm='], {
      timeout: 3000,
      maxBuffer: 4096,
    });
    if (r.stdout.trim()) throw Error('Terminal TTY has other processes');
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
  }
  const target = instance.target;
  let source: string, args: string[];
  if (terminal === 'Terminal') {
    if (!Number.isSafeInteger(Number(target.windowId))) throw Error('Invalid Terminal window');
    source = `on run argv
 tell application id "com.apple.Terminal"
  if not (exists window id (item 1 of argv as integer)) then return "already-closed"
  set w to window id (item 1 of argv as integer)
  set matching to missing value
  repeat with t in tabs of w
   if tty of t is (item 2 of argv) then
    if matching is not missing value then error "Ambiguous tab"
    set matching to contents of t
   end if
  end repeat
  if matching is missing value then return "already-closed"
  if busy of matching then error "Terminal reused by another process"
  if (count tabs of w) is 1 then
   close w
  else
   close matching
  end if
  return "closed-exact-terminal"
 end tell
end run`;
    args = [String(target.windowId), instance.tty];
  } else {
    if (!target.tabId || !target.terminalId) throw Error('Missing Ghostty surface identity');
    source = `on run argv
 tell application id "com.mitchellh.ghostty"
  if not (exists window id (item 1 of argv)) then return "already-closed"
  set w to window id (item 1 of argv)
  if not (exists tab id (item 2 of argv) of w) then return "already-closed"
  set t to tab id (item 2 of argv) of w
  if not (exists terminal id (item 3 of argv) of t) then return "already-closed"
  set term to terminal id (item 3 of argv) of t
  if tty of term is not (item 4 of argv) then error "Ghostty TTY changed"
  if (pid of term) is not 0 and (pid of term) is not (item 5 of argv as integer) then error "Ghostty surface reused"
  close term
  return "closed-exact-terminal"
 end tell
end run`;
    args = [
      String(target.windowId),
      target.tabId,
      target.terminalId,
      instance.tty,
      String(instance.pid),
    ];
  }
  const result = await exec('/usr/bin/osascript', ['-e', source, ...args], {
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (!['already-closed', 'closed-exact-terminal'].includes(result.stdout.trim()))
    throw Error('Terminal close result unknown');
}
