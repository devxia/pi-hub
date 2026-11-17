import { isAbsolute } from 'node:path';
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** Resolve exported variables inside the user's terminal, never serialize its shell environment. */
export function terminalHostCommand(
  d: { runtimeNodePath: string; env: Record<string, string> },
  entry: string,
  descriptor: string,
) {
  const shell = d.env.SHELL ?? '/bin/zsh';
  if (!isAbsolute(shell) || shell.includes('\0')) throw Error('Invalid user shell');
  const pinned = ['HOME', 'PATH', 'SHELL', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE']
    .filter((key) => d.env[key] !== undefined)
    .map((key) => `${key}=${d.env[key]}`);
  const host = 'exec ' + [d.runtimeNodePath, entry, descriptor].map(shellQuote).join(' ');
  return ['/usr/bin/env', ...pinned, shell, '-ilc', host].map(shellQuote).join(' ');
}
