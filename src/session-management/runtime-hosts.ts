import net from 'node:net';
import type Database from 'better-sqlite3';
import { mkdir, lstat, readFile, unlink, chmod } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomBytes, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { atomicWrite, type RuntimeOptions } from './pi-configuration';
import { observeProcess } from './runtime-process';
import {
  completed,
  failed,
  type Result,
  type RuntimeInstance,
  type PreviewRuntime,
} from './interface';
import { readIdentity } from './history-reader';

export interface HostReport {
  hostId: string;
  pid: number;
  startIdentity: string;
  tty: string | null;
  generation: string;
  sequence: number;
  sessionId: string;
  file: string | null;
  cwd: string;
  leafId: string | null;
  persisted: boolean;
  busy: boolean;
}
interface HostRecord {
  hostId: string;
  requestId: string;
  statusPath: string;
  report?: HostReport;
}
interface Pending {
  hostId: string;
  resolve: (value: Result<any>) => void;
  timer: NodeJS.Timeout;
}
const MAX_FRAME = 32768;
const absolute = (value: unknown): value is string =>
  typeof value === 'string' && isAbsolute(value) && value.length < 4096 && !value.includes('\0');
function validReport(r: any): r is HostReport {
  return (
    !!r &&
    typeof r === 'object' &&
    !Array.isArray(r) &&
    Object.keys(r).every((k) =>
      [
        'hostId',
        'pid',
        'startIdentity',
        'tty',
        'generation',
        'sequence',
        'sessionId',
        'file',
        'cwd',
        'leafId',
        'persisted',
        'busy',
      ].includes(k),
    ) &&
    typeof r.hostId === 'string' &&
    Number.isSafeInteger(r.pid) &&
    r.pid > 0 &&
    typeof r.startIdentity === 'string' &&
    r.startIdentity.length < 512 &&
    typeof r.generation === 'string' &&
    r.generation.length < 128 &&
    Number.isSafeInteger(r.sequence) &&
    r.sequence > 0 &&
    typeof r.sessionId === 'string' &&
    r.sessionId.length > 0 &&
    r.sessionId.length < 256 &&
    absolute(r.cwd) &&
    (r.file === null || absolute(r.file)) &&
    (r.tty === null || (typeof r.tty === 'string' && /^\/dev\/ttys\d+$/.test(r.tty))) &&
    (r.leafId === null || (typeof r.leafId === 'string' && r.leafId.length < 256)) &&
    typeof r.persisted === 'boolean' &&
    typeof r.busy === 'boolean'
  );
}
const sameState = (a: HostReport | undefined, b: HostReport) =>
  !!a &&
  [
    'pid',
    'startIdentity',
    'generation',
    'sessionId',
    'file',
    'cwd',
    'leafId',
    'persisted',
    'busy',
  ].every((k) => a[k as keyof HostReport] === b[k as keyof HostReport]);

/** Controls only explicitly launched SDK hosts. It never scans for, admits, or excludes session writers. */
export async function runtimeHosts(
  options: RuntimeOptions,
  db: Database.Database,
  apply: (r: PreviewRuntime[]) => Result<null>,
  changed: () => void,
  reconcile: (file: string) => Promise<unknown>,
) {
  const directory = `/tmp/pi-hub-${process.getuid!()}-${createHash('sha256').update(options.appData).digest('hex').slice(0, 16)}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    directoryInfo.uid !== process.getuid!() ||
    (directoryInfo.mode & 0o777) !== 0o700
  )
    throw Error('Private runtime directory unavailable');
  const socketPath = join(directory, 'sdk.sock'),
    credentialPath = join(options.appData, 'runtime', 'credential.json');
  let token = randomBytes(32).toString('hex');
  try {
    const info = await lstat(credentialPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 4096
    )
      throw Error('Private credential changed');
    const old = JSON.parse(await readFile(credentialPath, 'utf8'));
    if (old.protocol !== 2 || !/^[a-f0-9]{64}$/.test(old.token))
      throw Error('Invalid runtime credential');
    token = old.token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const records = () =>
    (db.prepare('SELECT data FROM sdk_hosts').all() as { data: string }[]).map(
      (r) => JSON.parse(r.data) as HostRecord,
    );
  const read = (id: string) => {
    const r = db.prepare('SELECT data FROM sdk_hosts WHERE id=?').get(id) as
      { data: string } | undefined;
    return r ? (JSON.parse(r.data) as HostRecord) : undefined;
  };
  const save = (h: HostRecord) =>
    db
      .prepare('INSERT OR REPLACE INTO sdk_hosts(id,data) VALUES(?,?)')
      .run(h.hostId, JSON.stringify(h));
  const clients = new Map<string, net.Socket>(),
    connections = new Set<net.Socket>(),
    pending = new Map<string, Pending>(),
    jobs = new Set<Promise<unknown>>();
  let closing = false,
    publicationSequence = 0;
  function track(job: Promise<unknown>) {
    jobs.add(job);
    void job.catch(() => {}).finally(() => jobs.delete(job));
  }
  async function publish(h: HostRecord, connected: boolean) {
    const r = h.report;
    if (closing || !r?.file || !r.persisted) return;
    try {
      const identity = await readIdentity(r.file, AbortSignal.timeout(3000));
      if (closing) return;
      const result = apply([
        {
          key: identity.key,
          identity: identity.identity,
          generation: r.generation,
          runtimeIdentity: h.hostId,
          sequence: ++publicationSequence,
          connected,
          leafId: r.leafId,
          state: connected ? (r.busy ? 'busy' : 'connected') : 'unknown',
          runtimeCwd: r.cwd,
        },
      ]);
      if (result.status === 'failed') changed();
    } catch {
      /* A newly saved or switched native record can be indexed on the next report. */
    }
  }
  async function refreshFile(h: HostRecord, connected: boolean) {
    const other = records()
      .filter(
        (r) => r.hostId !== h.hostId && r.report?.file === h.report?.file && clients.has(r.hostId),
      )
      .at(-1);
    await publish(other ?? h, other ? true : connected);
  }
  try {
    const info = await lstat(socketPath);
    if (!info.isSocket() || info.uid !== process.getuid!()) throw Error('Foreign runtime socket');
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath);
      probe.setTimeout(500);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
      probe.once('timeout', () => {
        probe.destroy();
        resolve(true);
      });
    });
    if (alive) throw Error('This Hub profile already has a runtime server');
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const server = net.createServer((socket) => {
    connections.add(socket);
    let input = '',
      hostId: string | undefined,
      queue = Promise.resolve();
    const handshake = setTimeout(() => {
      if (!hostId) socket.destroy();
    }, 5000);
    handshake.unref();
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (bytes) => {
      input += bytes;
      if (Buffer.byteLength(input) > MAX_FRAME * 4) {
        socket.destroy();
        return;
      }
      let end;
      while ((end = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        if (Buffer.byteLength(line + '\n') > MAX_FRAME) {
          socket.destroy();
          return;
        }
        queue = queue.then(async () => {
          if (closing || socket.destroyed) return;
          try {
            const message = JSON.parse(line);
            if (message.kind === 'report') {
              if (
                Object.keys(message).some(
                  (k) => !['kind', 'protocol', 'token', 'hostId', 'report'].includes(k),
                ) ||
                message.protocol !== 2 ||
                typeof message.token !== 'string' ||
                message.token.length !== token.length ||
                !timingSafeEqual(Buffer.from(message.token), Buffer.from(token))
              )
                throw Error('Untrusted SDK report');
              const h = read(message.hostId),
                r = message.report;
              if (!h || !validReport(r) || r.hostId !== h.hostId || (hostId && hostId !== h.hostId))
                throw Error('Invalid SDK report');
              if (
                h.report &&
                (h.report.pid !== r.pid ||
                  h.report.startIdentity !== r.startIdentity ||
                  h.report.tty !== r.tty)
              )
                throw Error('SDK host OS identity changed');
              if (!hostId) {
                const os = await observeProcess(r.pid);
                if (os.startIdentity !== r.startIdentity || os.tty !== r.tty)
                  throw Error('SDK host OS identity mismatch');
              }
              if (h.report?.generation === r.generation && h.report.sequence >= r.sequence) {
                socket.write(JSON.stringify({ kind: 'ack', hostId: h.hostId }) + '\n');
                return;
              }
              const oldReport = h.report,
                wasConnected = clients.has(h.hostId),
                dirty = !wasConnected || !sameState(oldReport, r);
              hostId = h.hostId;
              clearTimeout(handshake);
              const previous = clients.get(hostId);
              if (previous && previous !== socket) previous.destroy();
              clients.set(hostId, socket);
              h.report = r;
              save(h);
              if (oldReport?.file !== r.file && oldReport?.persisted)
                await refreshFile({ ...h, report: oldReport }, false);
              if (dirty && r.file && r.persisted) await reconcile(r.file).catch(() => {});
              if (dirty) await publish(h, true);
              if (!closing && !socket.destroyed) {
                socket.write(JSON.stringify({ kind: 'ack', hostId }) + '\n');
                if (dirty) changed();
              }
            } else if (message.kind === 'result') {
              if (
                !hostId ||
                clients.get(hostId) !== socket ||
                typeof message.id !== 'string' ||
                typeof message.ok !== 'boolean' ||
                Object.keys(message).some(
                  (k) => !['kind', 'id', 'ok', 'value', 'error'].includes(k),
                )
              )
                throw Error('Untrusted SDK result');
              const p = pending.get(message.id);
              if (p?.hostId === hostId) {
                clearTimeout(p.timer);
                pending.delete(message.id);
                p.resolve(
                  message.ok
                    ? completed(message.value)
                    : failed('RECORD_CHANGED', String(message.error ?? 'Pi命令未完成。')),
                );
              }
            } else throw Error('Unsupported SDK frame');
          } catch {
            socket.destroy();
          }
        });
        track(queue);
      }
      if (Buffer.byteLength(input) > MAX_FRAME) socket.destroy();
    });
    socket.on('close', () => {
      clearTimeout(handshake);
      connections.delete(socket);
      if (hostId && clients.get(hostId) === socket) {
        clients.delete(hostId);
        if (!closing) {
          const h = read(hostId);
          if (h) track(refreshFile(h, false));
          changed();
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  await atomicWrite(credentialPath, JSON.stringify({ protocol: 2, socketPath, token }));
  function request(hostId: string, id: string, message: unknown, timeout: number) {
    const socket = clients.get(hostId);
    if (!socket) return Promise.resolve(failed('BACKGROUND_UNAVAILABLE', '原Hub宿主尚未连接。'));
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME)
      return Promise.resolve(failed('INVALID_REQUEST', '命令超过单次传输容量，请缩短名称。'));
    if (pending.has(id))
      return Promise.resolve(failed('INVALID_REQUEST', '当前图形请求正在等待回执。'));
    return new Promise<Result<any>>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(failed('BACKGROUND_UNAVAILABLE', '宿主回执尚未确认，请核对原操作。'));
      }, timeout);
      pending.set(id, { hostId, timer, resolve });
      socket.write(frame);
    });
  }
  return {
    credentialPath,
    register(requestId: string, statusPath: string) {
      const h = { hostId: randomUUID(), requestId, statusPath };
      save(h);
      return h.hostId;
    },
    instances(): RuntimeInstance[] {
      return records()
        .filter((h) => h.report)
        .map((h) => {
          const r = h.report!;
          return {
            pid: r.pid,
            generation: r.generation,
            sessionId: r.sessionId,
            cwd: r.cwd,
            persisted: r.persisted,
            tty: r.tty,
            state: clients.has(h.hostId) ? (r.busy ? 'busy' : 'connected') : 'unknown',
            mode: 'sdk',
            hostId: h.hostId,
          };
        });
    },
    reportFor(requestId: string) {
      const h = records()
        .reverse()
        .find((h) => h.requestId === requestId);
      return h?.report ? { ...h.report, connected: clients.has(h.hostId) } : undefined;
    },
    command(
      file: string,
      command: { id: string; type: 'rename' | 'clone'; name?: string; expectedRevision?: string },
    ) {
      const h = records()
        .filter((h) => h.report?.file === file && clients.has(h.hostId))
        .at(-1);
      return h
        ? request(
            h.hostId,
            command.id,
            { kind: 'command', ...command, sessionId: h.report!.sessionId, file },
            10000,
          )
        : Promise.resolve(
            failed(
              'BACKGROUND_UNAVAILABLE',
              '此会话没有已连接的Hub宿主，可在原生Pi中执行或从Hub打开。',
            ),
          );
    },
    connectedFor(file: string) {
      return records()
        .filter((h) => h.report?.file === file && clients.has(h.hostId))
        .map((h) => ({ ...h.report!, requestId: h.requestId }));
    },
    hostFor(file: string) {
      return records()
        .filter((h) => h.report?.file === file && clients.has(h.hostId))
        .at(-1)?.hostId;
    },
    queryCommand(hostId: string, requestId: string) {
      const id = randomUUID();
      return request(hostId, id, { kind: 'query', id, requestId }, 5000);
    },
    hasConnected(file: string) {
      return records().some((h) => h.report?.file === file && clients.has(h.hostId));
    },
    async close() {
      closing = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.resolve(failed('BACKGROUND_UNAVAILABLE', 'Hub正在退出，终端中的Pi继续运行。'));
      }
      pending.clear();
      for (const s of connections) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await Promise.allSettled([...jobs]);
      await unlink(socketPath).catch(() => {});
    },
  };
}
