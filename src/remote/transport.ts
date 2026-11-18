import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server, TransferProgress } from './contract';
import type { DiskSnapshot, ManifestFile } from './snapshots';
import { cleanupTransportDirectory } from './owned-transports';
import { assert, hash, relativePath, validateServer } from './security';

type ReportTransfer = (progress: TransferProgress, flush?: boolean) => void;

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const batchQuote = (s: string) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';

/** Every process, including SFTP and jump hops, uses one explicit, private configuration. */
export class Transport {
  private children = new Set<ReturnType<typeof spawn>>();
  private closed = false;
  private interrupted = new Map<string, number>();
  private sessions = new Map<string, string>();
  private processes = new Map<ReturnType<typeof spawn>, string>();
  constructor(
    private directory: string,
    private assets: string,
    private expected: Record<string, string>,
  ) {}

  private async asset(name: string) {
    const manifest = JSON.parse(await readFile(join(this.assets, 'assets.json'), 'utf8'));
    assert(
      JSON.stringify(manifest) === JSON.stringify(this.expected),
      '远程组件清单与工作进程不一致。',
    );
    const content = await readFile(join(this.assets, name), 'utf8');
    assert(hash(content) === manifest[name], '远程组件完整性检查失败：' + name);
    return content;
  }

  private async session<T>(
    server: Server,
    work: (directory: string, config: string) => Promise<T>,
  ) {
    assert(!this.closed, '传输进程已关闭。');
    validateServer(server);
    assert(
      server.hops.every((h) => h.hostKey),
      'Approve the public host key for every SSH hop before connecting.',
    );
    const dir = await mkdtemp(join(this.directory, 'ssh-'));
    this.sessions.set(dir, server.id);
    const config = join(dir, 'config'),
      known = join(dir, 'known_hosts');
    let clean = false;
    try {
      for (let i = 1; i < server.hops.length; i++) {
        await writeFile(
          join(dir, `hop-${i}.sh`),
          '#!/bin/sh\nset -eu\n/bin/ps -p $$ -o pid=,lstart= > ' +
            quote(join(dir, `hop-${i}.pid`)) +
            '\nexec /usr/bin/ssh -F ' +
            quote(config) +
            ' -W ' +
            quote('[' + server.hops[i].host + ']:' + server.hops[i].port) +
            ' hub-' +
            (i - 1) +
            '\n',
          { mode: 0o600 },
        );
      }
      const entries = await Promise.all(
        server.hops.map(async (h, i) => {
          let identity = h.identityFile;
          if (h.agent === 'environment') {
            assert(h.agentIdentity, '请明确选择本次允许使用的 SSH Agent 公钥。');
            identity = join(dir, `identity-${i}.pub`);
            await writeFile(identity, h.agentIdentity + '\n', { mode: 0o600 });
          }
          return [
            `Host hub-${i}`,
            ` HostName ${h.host}`,
            ` User ${h.user}`,
            ` Port ${h.port}`,
            ` HostKeyAlias hub-${i}`,
            ` IdentityFile ${identity ? quote(identity) : 'none'}`,
            ` CertificateFile ${h.certificateFile ? quote(h.certificateFile) : 'none'}`,
            ` IdentityAgent ${h.agent === 'environment' ? quote(await agentSocket()) : 'none'}`,
            ...(i ? [` ProxyCommand /bin/sh ${quote(join(dir, `hop-${i}.sh`))}`] : []),
          ].join('\n');
        }),
      );
      await writeFile(known, server.hops.map((h, i) => `hub-${i} ${h.hostKey}`).join('\n') + '\n', {
        mode: 0o600,
      });
      await writeFile(
        config,
        entries.join('\n') +
          `\nHost *\n BatchMode yes\n IdentitiesOnly yes\n IdentityAgent none\n PreferredAuthentications publickey\n PasswordAuthentication no\n KbdInteractiveAuthentication no\n StrictHostKeyChecking yes\n UserKnownHostsFile ${quote(known)}\n GlobalKnownHostsFile /dev/null\n KnownHostsCommand none\n UpdateHostKeys no\n VerifyHostKeyDNS no\n CheckHostIP no\n ControlMaster no\n ControlPath none\n ControlPersist no\n ClearAllForwardings yes\n ForwardAgent no\n ForwardX11 no\n RequestTTY no\n PermitLocalCommand no\n AddKeysToAgent no\n IgnoreUnknown UseKeychain\n UseKeychain no\n ConnectTimeout 10\n ConnectionAttempts 1\n ServerAliveInterval 10\n ServerAliveCountMax 2\n LogLevel ERROR\n`,
        { mode: 0o600 },
      );
      return await work(dir, config);
    } finally {
      await cleanupTransportDirectory(dir);
      clean = true;
      this.sessions.delete(dir);
      if (clean) await rm(dir, { recursive: true, force: true });
    }
  }

  private async process(
    dir: string,
    executable: string,
    args: string[],
    input: string,
    deadline: number,
    generation?: number,
  ) {
    const script = join(dir, 'root.sh');
    await writeFile(
      script,
      '#!/bin/sh\nset -eu\n/bin/ps -p $$ -o pid=,lstart= > ' +
        quote(join(dir, 'root.pid')) +
        '\nexec ' +
        [executable, ...args].map(quote).join(' ') +
        '\n',
      { mode: 0o600 },
    );
    const serverId = this.sessions.get(dir)!;
    assert(!this.closed, '传输进程已关闭。');
    if (generation !== undefined) this.requireGeneration(serverId, generation);
    return new Promise<string>((resolve, reject) => {
      const child = spawn('/bin/sh', [script], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: dir, SSH_ASKPASS_REQUIRE: 'never' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.children.add(child);
      this.processes.set(child, serverId);
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let size = 0,
        errorSize = 0,
        failure: Error | undefined;
      const fail = (error: Error) => {
        if (failure) return;
        failure = error;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 500).unref();
      };
      const timer = setTimeout(
        () => fail(Error('SSH 传输超时；请核对已有操作，勿重复提交。')),
        deadline,
      );
      child.stdout.on('data', (b: Buffer) => {
        size += b.length;
        if (size > 8 * 1024 * 1024) fail(Error('控制响应超过限制。'));
        else stdout.push(b);
      });
      child.stderr.on('data', (b: Buffer) => {
        errorSize += b.length;
        if (errorSize <= 8192) stderr.push(b);
      });
      child.on('error', fail);
      child.stdin.on('error', () => {});
      child.on('close', async (code) => {
        clearTimeout(timer);
        try {
          await cleanupTransportDirectory(dir);
        } catch (e) {
          failure = e instanceof Error ? e : Error(String(e));
        }
        this.children.delete(child);
        this.processes.delete(child);
        if (failure) return reject(failure);
        if (code !== 0)
          return reject(
            Error(
              'SSH stopped (' +
                code +
                '): ' +
                Buffer.concat(stderr)
                  .toString('utf8')
                  .replace(/[\x00-\x1f\x7f]/g, ' ')
                  .slice(0, 2048),
            ),
          );
        resolve(Buffer.concat(stdout).toString('utf8'));
      });
      child.stdin.end(input);
    });
  }

  async trustedCommand(server: Server, command: string) {
    return this.session(server, async (dir, config) =>
      this.process(
        dir,
        '/usr/bin/ssh',
        ['-F', config, '-T', 'hub-' + (server.hops.length - 1), command],
        '',
        15000,
      ),
    );
  }
  generation(serverId: string) {
    return this.interrupted.get(serverId) ?? 0;
  }

  requireGeneration(serverId: string, generation: number) {
    assert(!this.closed && this.generation(serverId) === generation, '传输已中断。');
  }

  interrupt(serverId: string) {
    this.interrupted.set(serverId, this.generation(serverId) + 1);
    for (const [child, id] of this.processes)
      if (id === serverId) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 500).unref();
      }
  }
  async run(
    server: Server,
    request: unknown,
    generation = this.generation(server.id),
  ): Promise<any> {
    const acceptance = await this.asset('acceptance.py');
    const runner =
      (await this.asset('transfer.py')) +
      '\n' +
      acceptance +
      '\n' +
      (await this.asset('runner.py'));
    const supervisor = await this.asset('supervisor.py');
    const bytes = JSON.stringify({
      root: server.root,
      supervisor,
      acceptance,
      toolHash: hash(runner),
      request,
    });
    assert(Buffer.byteLength(bytes) <= 8 * 1024 * 1024, '控制请求超过限制。');
    return this.session(server, async (dir, config) => {
      const output = await this.process(
        dir,
        '/usr/bin/ssh',
        ['-F', config, '-T', 'hub-' + (server.hops.length - 1), 'python3 -c ' + quote(runner)],
        bytes,
        (request as { kind?: string })?.kind === 'acceptanceStart' ? 15 * 60 * 1000 : 45000,
        generation,
      );
      const result = JSON.parse(output);
      assert(result.ok, String(result.error));
      return result.value;
    });
  }

  private async sftp(
    server: Server,
    token: string,
    files: ManifestFile[],
    local: string,
    upload: boolean,
    generation: number,
  ) {
    assert(/^[a-f0-9]{32}$/.test(token), '无效传输票据。');
    const script = (await this.asset('transfer.py')) + '\n' + (await this.asset('sftp.py'));
    await this.session(server, async (dir, config) => {
      const ssh = join(dir, 'sftp-ssh.sh');
      await writeFile(
        ssh,
        '#!/bin/sh\nset -eu\n/bin/ps -p $$ -o pid=,lstart= > ' +
          quote(join(dir, 'sftp.pid')) +
          '\nexec /usr/bin/ssh "$@"\n',
        { mode: 0o700 },
      );
      const batch = join(dir, 'batch');
      await writeFile(
        batch,
        files
          .map((f) => {
            assert(/^\d{8}$/.test(f.object), '无效快照对象。');
            return upload
              ? `put ${batchQuote(join(local, f.object))} /${f.object}`
              : `get /${f.object} ${batchQuote(join(local, f.object))}`;
          })
          .join('\n') + '\n',
        { mode: 0o600 },
      );
      await this.process(
        dir,
        '/usr/bin/sftp',
        [
          '-q',
          '-S',
          ssh,
          '-b',
          batch,
          '-F',
          config,
          '-s',
          'python3 -c ' + quote(script) + ' ' + quote(server.root) + ' ' + quote(token),
          'hub-' + (server.hops.length - 1),
        ],
        '',
        30 * 60 * 1000,
        generation,
      );
    });
  }

  private async transferObjects(
    server: Server,
    token: string,
    snapshot: DiskSnapshot,
    upload: boolean,
    generation: number,
    report?: ReportTransfer,
  ) {
    report?.({ totalBytes: snapshot.totalBytes, acknowledgedBytes: 0 });
    let acknowledgedBytes = 0;
    let batch: ManifestFile[] = [];
    let bytes = 0;
    const confirm = async () => {
      this.requireGeneration(server.id, generation);
      await this.sftp(server, token, batch, snapshot.directory, upload, generation);
      if (!upload) {
        for (const file of batch) {
          const local = await lstat(join(snapshot.directory, file.object));
          assert(local.isFile() && local.nlink === 1 && local.size === file.size,
            '下载大小与确认清单不一致。');
        }
      }
      acknowledgedBytes += bytes;
      report?.({ acknowledgedBytes }, true);
      batch = [];
      bytes = 0;
    };
    for (const file of snapshot.files) {
      if (batch.length && (batch.length === 16 || bytes + file.size > 64 * 1024 ** 2))
        await confirm();
      batch.push(file);
      bytes += file.size;
    }
    if (batch.length) await confirm();
  }

  async upload(
    server: Server,
    snapshot: DiskSnapshot,
    request: Record<string, unknown>,
    generation = this.generation(server.id),
    report?: ReportTransfer,
  ) {
    const ticket = await this.run(
      server,
      {
        ...request,
        kind: 'uploadPrepare',
        manifest: snapshot.files,
        directories: snapshot.directories,
      },
      generation,
    );
    try {
      this.requireGeneration(server.id, generation);
      await this.transferObjects(server, ticket.token, snapshot, true, generation, report);
      this.requireGeneration(server.id, generation);
      return await this.run(server, { kind: 'uploadCommit', token: ticket.token }, generation);
    } finally {
      await this.run(server, { kind: 'transferRelease', token: ticket.token }).catch(() => {});
    }
  }

  async download(
    server: Server,
    request: Record<string, unknown>,
    directory: string,
    generation = this.generation(server.id),
    report?: ReportTransfer,
  ): Promise<DiskSnapshot> {
    const ticket = await this.run(server, { ...request, kind: 'downloadPrepare' }, generation);
    const snapshot: DiskSnapshot = {
      directory, files: ticket.files, directories: ticket.directories, totalBytes: ticket.totalBytes,
    };
    try {
      this.requireGeneration(server.id, generation);
      assert(
        Array.isArray(ticket.files) &&
          ticket.files.length <= 10000 &&
          Array.isArray(ticket.directories) &&
          ticket.files.length + ticket.directories.length <= 10000 &&
          Number.isSafeInteger(ticket.totalBytes) && ticket.totalBytes >= 0 &&
          ticket.totalBytes <= 1024 ** 4,
        '无效结果清单。',
      );
      let bytes = 0;
      for (const file of snapshot.files) {
        relativePath(file.path);
        assert(Number.isSafeInteger(file.size) && file.size >= 0 &&
          /^[0-9a-f]{64}$/.test(file.sha256), '无效结果文件清单。');
        bytes += file.size;
      }
      snapshot.directories.forEach(relativePath);
      assert(bytes === snapshot.totalBytes, '无效结果清单总大小。');
      await this.transferObjects(server, ticket.token, snapshot, false, generation, report);
    } finally {
      await this.run(server, { kind: 'transferRelease', token: ticket.token }).catch(() => {});
    }
    this.requireGeneration(server.id, generation);
    return snapshot;
  }

  async close() {
    this.closed = true;
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once('close', () => {
              const finish = () => {
                if (!this.children.has(child)) resolve();
                else setTimeout(finish, 10);
              };
              finish();
            });
            child.kill('SIGTERM');
            setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }, 500).unref();
          }),
      ),
    );
  }
}

async function agentSocket() {
  const path = process.env.SSH_AUTH_SOCK;
  assert(path, '明确授权的 SSH Agent 不可用。');
  const actual = await realpath(path),
    st = await lstat(actual);
  assert(
    st.isSocket() && st.uid === process.getuid?.(),
    'SSH Agent 套接字不可用或不属于当前用户。',
  );
  return actual;
}
