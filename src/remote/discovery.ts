import { execFile } from 'node:child_process';
import { realpath, lstat } from 'node:fs/promises';
import { assert, fingerprint, validateServer } from './security';
import type { Server } from './contract';
import type { Transport } from './transport';

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function publicKeys(source: string) {
  const keys = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const match =
      /(?:^|\s)((?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,3})(?:\s|$)/.exec(
        line,
      );
    if (match) keys.add(match[1]);
  }
  return [...keys].map((key) => ({ key, fingerprint: fingerprint(key) }));
}

export async function discover(server: Server, hop: number, transport: Transport) {
  validateServer(server);
  assert(Number.isInteger(hop) && hop >= 0 && hop < server.hops.length, '请选择有效的 SSH 跳点。');
  const h = server.hops[hop];
  const args = ['-T', '5', '-t', 'ed25519,ecdsa,rsa', '-p', String(h.port), h.host];
  const output =
    hop === 0
      ? await fixedProcess('/usr/bin/ssh-keyscan', args)
      : await transport.trustedCommand(
          { ...server, hops: server.hops.slice(0, hop) },
          ['ssh-keyscan', ...args].map(quote).join(' '),
        );
  const candidates = publicKeys(output);
  assert(
    candidates.length > 0,
    '未获取到候选公钥。请核对地址或显式导入 known_hosts；不会尝试认证此跳。',
  );
  return candidates;
}

export async function agentIdentities() {
  const socket = process.env.SSH_AUTH_SOCK;
  assert(socket, '没有明确可用的 SSH_AUTH_SOCK。');
  const actual = await realpath(socket),
    st = await lstat(actual);
  assert(st.isSocket() && st.uid === process.getuid?.(), 'SSH Agent 不属于当前用户。');
  return publicKeys(await fixedProcess('/usr/bin/ssh-add', ['-L'], { SSH_AUTH_SOCK: actual }));
}

function fixedProcess(file: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      file,
      args,
      {
        timeout: 10000,
        maxBuffer: 65536,
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          HOME: '/nonexistent',
          SSH_ASKPASS_REQUIRE: 'never',
          ...env,
        },
      },
      (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout)),
    ),
  );
}
