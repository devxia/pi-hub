import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { Transport } from '../../src/remote/transport';
import type { Server } from '../../src/remote/contract';

/** All keys, config, endpoints and agent sockets are fresh and owned by this fixture. */
export async function ownedRemoteSSH() {
  const evidence = resolve(process.env.PI_HUB_TEST_EVIDENCE!);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-owned-sftp-')));
  const env = { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', SSH_ASKPASS_REQUIRE: 'never' };
  const daemons: ChildProcess[] = [];
  let log = '';
  const assets = resolve('dist/remote');
  const manifest = JSON.parse(await readFile(join(assets, 'assets.json'), 'utf8'));
  const work = join(root, 'work');
  await mkdir(work, { mode: 0o700 });
  const transport = new Transport(work, assets, manifest);
  const inherited = {
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    SSH_ASKPASS: process.env.SSH_ASKPASS,
  };
  await mkdir(evidence, { recursive: true });
  const close = async () => {
    for (const [key, value] of Object.entries(inherited))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await transport.close();
    for (const daemon of daemons.reverse())
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const ended = new Promise<void>((r) => daemon.once('exit', () => r()));
        daemon.kill('SIGTERM');
        await ended;
      }
    await writeFile(join(evidence, `sftp-ssh-${daemons[0]?.pid}.log`), log);
    await writeFile(
      join(evidence, `sftp-cleanup-${daemons[0]?.pid}.json`),
      JSON.stringify(
        {
          root,
          processes: daemons.map((d) => ({
            pid: d.pid,
            exitCode: d.exitCode,
            signal: d.signalCode,
          })),
        },
        null,
        2,
      ),
    );
    await rm(root, { recursive: true, force: true });
  };
  try {
    for (const name of ['host', 'client', 'other'])
      execFileSync(
        '/usr/bin/ssh-keygen',
        ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)],
        { env },
      );
    await writeFile(join(root, 'authorized_keys'), await readFile(join(root, 'client.pub')), {
      mode: 0o600,
    });
    const port = await new Promise<number>((res, rej) => {
      const s = createServer();
      s.once('error', rej);
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => res(p));
      });
    });
    const config = join(root, 'sshd_config');
    await writeFile(
      config,
      `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(root, 'host')}\nPidFile ${join(root, 'pid')}\nAuthorizedKeysFile ${join(root, 'authorized_keys')}\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin no\nAllowUsers ${userInfo().username}\nUseDNS no\nPrintMotd no\nLogLevel VERBOSE\nAllowTcpForwarding yes\nPermitTunnel no\n`,
    );
    execFileSync('/usr/sbin/sshd', ['-t', '-f', config], { env });
    const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    daemons.push(daemon);
    daemon.stderr!.on('data', (b) => (log += String(b)));
    await until(
      () => log.includes('Server listening'),
      () => daemon.exitCode !== null,
    );
    const hostKey = (await readFile(join(root, 'host.pub'), 'utf8'))
      .trim()
      .split(' ')
      .slice(0, 2)
      .join(' ');
    const server: Server = {
      id: 'owned',
      revision: 1,
      name: '自有环回端点',
      backend: 'linux',
      root: join(root, 'remote'),
      hops: [
        {
          alias: 'owned',
          host: '127.0.0.1',
          user: userInfo().username,
          port,
          identityFile: join(root, 'client'),
          hostKey,
        },
      ],
    };
    process.env.SSH_AUTH_SOCK = join(root, 'forbidden-inherited-agent');
    process.env.SSH_ASKPASS = join(root, 'forbidden-askpass');
    const startAgent = async () => {
      const socket = join(root, 'owned-agent.sock');
      const agent = spawn('/usr/bin/ssh-agent', ['-D', '-a', socket], { env, stdio: 'ignore' });
      daemons.push(agent);
      await until(
        async () => {
          try {
            await access(socket);
            return true;
          } catch {
            return false;
          }
        },
        () => agent.exitCode !== null,
      );
      const agentEnv = { ...env, SSH_AUTH_SOCK: socket };
      execFileSync('/usr/bin/ssh-add', [join(root, 'client')], { env: agentEnv, stdio: 'pipe' });
      execFileSync('/usr/bin/ssh-add', [join(root, 'other')], { env: agentEnv, stdio: 'pipe' });
      process.env.SSH_AUTH_SOCK = socket;
      return {
        socket,
        publicKey: (await readFile(join(root, 'client.pub'), 'utf8'))
          .trim()
          .split(' ')
          .slice(0, 2)
          .join(' '),
        otherKey: (await readFile(join(root, 'other.pub'), 'utf8'))
          .trim()
          .split(' ')
          .slice(0, 2)
          .join(' '),
      };
    };
    return { root, work, transport, server, env, startAgent, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function until(
  test: () => boolean | Promise<boolean>,
  failed: () => boolean = () => false,
  seconds = 8,
) {
  const deadline = Date.now() + seconds * 1000;
  while (!(await test())) {
    if (failed() || Date.now() > deadline) throw Error('Owned boundary deadline exceeded');
    await new Promise((r) => setTimeout(r, 20));
  }
}
