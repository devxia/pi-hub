import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { NativePiBridge, NativePiRequest, Reply, Request, Snapshot } from '../remote/contract';
import { cleanupAbandonedTransports } from '../remote/owned-transports';

/** Main alone creates a writer, after the previous writer and its transports exit. */
export class RemoteBackground {
  private worker?: UtilityProcess;
  private generation = '';
  private sequence = 0;
  private serial = 0;
  private pending = new Map<number, (reply: Reply) => void>();
  private closing = false;
  private exiting?: Promise<void>;
  private ready?: Promise<void>;
  private starting?: Promise<UtilityProcess>;

  constructor(
    private profile: string,
    private changed: (snapshot: Snapshot) => void,
  ) {}

  private ensure(): Promise<UtilityProcess> {
    if (this.starting) return this.starting;
    if (this.worker) return Promise.resolve(this.worker);
    this.starting = (async () => {
      await this.exiting;
      this.profile = await realpath(this.profile);
      await cleanupAbandonedTransports(join(this.profile, 'remote'));
      const generation = randomUUID();
      this.generation = generation;
      this.sequence = 0;
      const worker = utilityProcess.fork(
        join(__dirname, 'remote-utility.cjs'),
        [this.profile, join(__dirname, '../remote'), generation],
        { serviceName: 'Pi Hub remote workspace' },
      );
      this.worker = worker;
      this.exiting = new Promise<void>((resolve, reject) =>
        worker.once('exit', () => {
          if (this.worker === worker) {
            this.worker = undefined;
            for (const done of this.pending.values())
              done({
                ok: false,
                error: 'Remote worker stopped. Existing operations are reconciled, never replayed.',
              });
            this.pending.clear();
          }
          void cleanupAbandonedTransports(join(this.profile, 'remote')).then(resolve, reject);
        }),
      );
      void this.exiting.catch(() => {});
      this.ready = new Promise((resolve, reject) => {
        worker.on('message', (message: any) => {
          if (message.generation === generation && message.type === 'ready') resolve();
        });
        worker.once('exit', () => reject(Error('Remote worker could not start.')));
      });
      void this.ready.catch(() => {});
      worker.on('message', (message: any) => {
        if (this.worker !== worker || message.generation !== generation) return;
        if (message.type === 'snapshot') {
          const snapshot = message.snapshot as Snapshot;
          if (snapshot.sequence <= this.sequence) return;
          this.sequence = snapshot.sequence;
          this.changed(snapshot);
        } else if (message.id) {
          this.pending.get(message.id)?.(message.reply);
          this.pending.delete(message.id);
        }
      });
      return worker;
    })();
    void this.starting
      .finally(() => {
        this.starting = undefined;
      })
      .catch(() => {});
    return this.starting;
  }

  call(request: Request | 'pending'): Promise<Reply> {
    return this.send(request === 'pending' ? { command: 'pending' } : { request });
  }

  callNative: NativePiBridge = (nativePi) => this.send({ nativePi });

  private async send(message: { request: Request } | { command: 'pending' } | { nativePi: NativePiRequest }): Promise<Reply> {
    if (this.closing) return { ok: false, error: 'Remote workspace is closing.' };
    if (
      'command' in message &&
      !this.worker &&
      !this.starting &&
      !existsSync(join(this.profile, 'remote', 'remote.sqlite'))
    )
      return { ok: true, value: 0 };
    let worker: UtilityProcess;
    try {
      worker = await this.ensure();
      await this.ready;
    } catch (error) {
      return { ok: false, error: 'Remote worker unavailable: ' + String(error) };
    }
    if (this.closing || this.worker !== worker)
      return { ok: false, error: 'Remote worker generation changed.' };
    const id = ++this.serial;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: 'Worker response timed out. The request must not be automatically repeated.',
        });
      }, 15000);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      worker.postMessage({
        generation: this.generation,
        id,
        ...message,
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.starting?.catch(() => {});
    const worker = this.worker;
    if (worker) {
      worker.postMessage({ generation: this.generation, id: ++this.serial, command: 'close' });
      const timer = setTimeout(() => worker.kill(), 15000);
      await this.exiting;
      clearTimeout(timer);
    }
    await cleanupAbandonedTransports(join(this.profile, 'remote'));
  }
}
