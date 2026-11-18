import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { SecureFiles } from './security';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  lstat,
  chmod,
  rm,
  mkdtemp,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import type {
  Action,
  Attempt,
  Grant,
  Operation,
  Request,
  Server,
  Snapshot,
  Task,
  Reply,
  Capability,
  QueueObservation,
  ExecutionRef,
  OperationSummary,
  OperationPage,
  ReviewPage,
  TransferProgress,
  AttemptPage,
  NativePiRequest,
  NativeTaskScope,
} from './contract';
import { text } from './contract';
import {
  assert,
  absolutePath,
  canonical,
  checkedDirectory,
  digest,
  equal,
  hash,
  id,
  importSSH,
  executionOptions,
  relativePath,
  validateServer,
} from './security';
import { snapshotInputs, verifySnapshot, publishDisk, type DiskSnapshot } from './snapshots';
import { discover, agentIdentities } from './discovery';
import { Store } from './store';
import { Transport } from './transport';
import { mapProgress, validateProgressMapping } from './progress';
import { reconcileSlurm, listSlurmObservations, observeExternalSlurm } from './slurm';
type AgentScope = Pick<Grant, 'id' | 'serverId' | 'project' | 'taskIds' | 'actions'>;
interface Review {
  server: Server;
  task?: Task;
  attempt?: Attempt;
  manifest?: Omit<DiskSnapshot, 'directory'>;
  snapshotId?: string;
  serverRevision?: number;
  files?: DiskSnapshot;
  argv?: string[];
  destinationParent?: string;
  destinationRevision?: string;
  nativeScope?: NativeTaskScope;
}
const REVIEW_TTL = 20 * 60 * 1000;
const OPERATION_PAGE_SIZE = 30;
const MANIFEST_PAGE_SIZE = 24;
const ATTEMPT_PAGE_SIZE = 30;
const terminal = (a: Attempt) => ['succeeded', 'failed', 'cancelled'].includes(a.phase);

export class RemoteService {
  readonly generation = randomUUID();
  private sequence = 0;
  private store: Store;
  private transport: Transport;
  private active = new Set<Promise<unknown>>();
  private busy = new Set<string>();
  private closed = false;
  private native: SecureFiles;
  private timer?: ReturnType<typeof setTimeout>;
  private preparation?: Promise<void>;
  private preparingId?: string;
  private readonly reviews: string;
  private watching: { serverId: string | null; attemptId: string | null } = {
    serverId: null,
    attemptId: null,
  };
  private due = new Map<string, number>();
  private failures = new Map<string, number>();
  private authStopped = new Set<string>();
  private cli: Snapshot['cli'] = {
    ready: false,
    detail: 'Choose an absolute Node 24+ executable to create a profile-bound launcher.',
  };
  constructor(
    readonly profile: string,
    readonly assets: string,
    readonly expectedAssets: Record<string, string>,
    private changed: (s: Snapshot) => void = () => {},
  ) {
    assert(
      hash(readFileSync(join(assets, 'secure-fs.node'))) === expectedAssets['secure-fs.node'],
      'Secure filesystem asset integrity check failed.',
    );
    this.native = createRequire(join(assets, 'loader.cjs'))(
      join(assets, 'secure-fs.node'),
    ) as SecureFiles;
    this.store = new Store(join(profile, 'remote', 'remote.sqlite'));
    this.transport = new Transport(join(profile, 'remote'), assets, expectedAssets);
    this.reviews = join(profile, 'remote', 'reviews');
    mkdirSync(this.reviews, { recursive: true, mode: 0o700 });
    for (const op of this.store.operationsWhere(['approved', 'running', 'preparing'])) {
      const preparing = op.status === 'preparing';
      op.status = preparing ? 'blocked' : 'unknown';
      op.detail = preparing
        ? 'Worker interrupted during snapshot preparation. Create a new review to prepare again.'
        : 'Worker interrupted. Reconcile the existing attempt; write actions are never automatically replayed.';
      this.store.put('operation', op.requestId, op);
    }
    this.expireReviews();
    for (const row of this.store.releasedSnapshotCandidates()) {
      this.releaseReview(this.get<Operation>('operation', row.id));
    }
    this.schedule();
  }
  private schedule() {
    this.timer = setTimeout(() => {
      if (!this.closed) {
        if (this.expireReviews()) this.emit();
        this.poll();
        this.schedule();
      }
    }, 5000);
    this.timer.unref();
  }
  private poll() {
    const now = Date.now();
    for (const s of this.store.all<Server>('server')) {
      if (this.busy.size >= 2) break;
      if (
        s.disabled ||
        this.authStopped.has(s.id) ||
        !s.capability ||
        this.busy.has(s.id) ||
        (this.due.get(s.id) ?? 0) > now
      )
        continue;
      const selected = this.watching.serverId === s.id;
      const attempts = this.store.observedAttempts(s.id, this.watching.attemptId);
      if (!selected && !attempts.length) continue;
      this.due.set(s.id, now + (selected ? 15000 : 45000) * (0.9 + Math.random() * 0.2));
      this.enqueue(s.id, async () => {
        const ok = await this.queue(s);
        for (const attempt of attempts) {
          if (this.authStopped.has(s.id)) break;
          await this.observe(attempt);
        }
        const failures = ok ? 0 : Math.min(5, (this.failures.get(s.id) ?? 0) + 1);
        this.failures.set(s.id, failures);
        if (failures) this.due.set(s.id, Date.now() + Math.min(300000, 15000 * 2 ** failures));
      });
    }
    const aid = this.watching.attemptId;
    if (aid) {
      const a = this.store.get<Attempt>('attempt', aid);
      if (
        a &&
        !this.authStopped.has(a.server.id) &&
        !this.busy.has(a.server.id) &&
        this.busy.size < 2
      )
        this.enqueue(a.server.id, () => this.observe(a));
    }
  }
  state(): Snapshot {
    const recent = this.operationPage(0);
    const pending = this.store.operationHistory(0, OPERATION_PAGE_SIZE, undefined, true);
    const operations = [...pending, ...recent.operations.filter((op) =>
      !pending.some((item) => item.requestId === op.requestId),
    )];
    const serverId = this.watching.serverId;
    const recentAttempts = this.attemptPage(serverId, 0);
    const watched = this.watching.attemptId && this.store.get<Attempt>('attempt', this.watching.attemptId);
    const attempts = recentAttempts.attempts.filter((a) => a.id !== this.watching.attemptId);
    if (watched) {
      const { logs, logCursors, ...summary } = watched;
      attempts.unshift(summary);
    }
    return {
      generation: this.generation,
      sequence: ++this.sequence,
      servers: this.store.all('server'),
      tasks: this.store.all('task'),
      attempts,
      watchingServer: serverId,
      nextAttemptPage: recentAttempts.next,
      operations,
      nextOperationPage: recent.next,
      queues: this.store.all('queue'),
      grants: this.store
        .all<Grant & { tokenHash: string }>('grant')
        .map(({ tokenHash, ...grant }) => grant),
      cli: this.cli,
    };
  }
  private attemptPage(serverId: string | null, offset: number): AttemptPage {
    assert(Number.isSafeInteger(offset) && offset >= 0, 'Invalid attempt page.');
    const attempts = this.store.attemptHistory(serverId, offset, ATTEMPT_PAGE_SIZE + 1);
    return {
      attempts: attempts.slice(0, ATTEMPT_PAGE_SIZE),
      next: attempts.length > ATTEMPT_PAGE_SIZE ? offset + ATTEMPT_PAGE_SIZE : null,
    };
  }
  private operationPage(offset: number, subject?: string): OperationPage {
    assert(Number.isSafeInteger(offset) && offset >= 0, 'Invalid operation page.');
    const rows = this.store.operationHistory(offset, OPERATION_PAGE_SIZE + 1, subject);
    return {
      operations: rows.slice(0, OPERATION_PAGE_SIZE),
      next: rows.length > OPERATION_PAGE_SIZE ? offset + OPERATION_PAGE_SIZE : null,
    };
  }
  private operationSummary(op: Operation): OperationSummary {
    return {
      requestId: op.requestId,
      digest: op.digest,
      action: { kind: op.action.kind },
      status: op.status,
      createdAt: op.createdAt,
      expiresAt: op.expiresAt,
      subject: op.subject,
      detail: op.detail,
      attemptId: op.attemptId ?? ('attemptId' in op.action ? op.action.attemptId : undefined),
      transfer: op.transfer,
    };
  }
  private operationView(op: Operation) {
    const r = this.publicReview(op.review as Review);
    return {
      ...this.operationSummary(op),
      action: op.action,
      review: {
        ...r,
        manifest: r.manifest && {
          fileCount: r.manifest.files.length,
          directoryCount: r.manifest.directories.length,
          totalBytes: r.manifest.totalBytes,
        },
      },
    };
  }
  private publicReview(r: Review) {
    return {
      server: r.server,
      task: r.task,
      attempt: r.attempt
        ? {
            id: r.attempt.id,
            executionId: r.attempt.executionId,
            taskId: r.attempt.taskId,
            server: r.attempt.server,
            ref: r.attempt.ref,
            owned: r.attempt.owned,
            marker: r.attempt.marker,
            createdAt: r.attempt.createdAt,
            inputDigest: r.attempt.inputDigest,
          }
        : undefined,
      manifest: r.manifest,
      destinationParent: r.destinationParent,
      destinationRevision: r.destinationRevision,
    };
  }
  private emit() {
    if (!this.closed) this.changed(this.state());
  }
  private get<T>(kind: string, key: string) {
    assert(id(key), 'Invalid object identity.');
    const v = this.store.get<T>(kind, key);
    assert(v, kind + ' unavailable.');
    return v;
  }
  private server(key: string) {
    return this.get<Server>('server', key);
  }
  private put(kind: string, key: string, value: unknown) {
    this.store.put(kind, key, value);
    this.emit();
  }
  private enqueue(serverId: string, fn: () => Promise<void>) {
    assert(!this.busy.has(serverId), 'A server operation is already active.');
    this.busy.add(serverId);
    const p = fn().finally(() => {
      this.active.delete(p);
      this.busy.delete(serverId);
      this.emit();
    });
    this.active.add(p);
    void p.catch(() => {});
  }
  async request(request: Request): Promise<Reply> {
    try {
      assert(
        !this.closed &&
          request &&
          typeof request === 'object' &&
          !Array.isArray(request) &&
          Buffer.byteLength(canonical(request)) <= 128 * 1024,
        'Invalid or oversized remote request.',
      );
      let value: unknown = null;
      switch (request.command) {
        case 'snapshot':
          this.expireReviews();
          value = this.state();
          break;
        case 'operation':
          this.expireReviews();
          value = this.operationView(this.get<Operation>('operation', request.requestId));
          break;
        case 'operations':
          this.expireReviews();
          value = this.operationPage(request.offset);
          break;
        case 'attempts':
          this.server(request.serverId);
          value = this.attemptPage(request.serverId, request.offset);
          break;
        case 'reviewPage': {
          const op = this.get<Operation>('operation', request.requestId);
          const m = (op.review as Review).manifest;
          assert(op.digest && equal(op.digest, request.digest) && m, 'Review digest changed.');
          assert(Number.isSafeInteger(request.offset) && request.offset >= 0, 'Invalid review page.');
          const entries: ReviewPage['entries'] = [];
          const end = Math.min(request.offset + MANIFEST_PAGE_SIZE, m.files.length + m.directories.length);
          for (let i = request.offset; i < end; i++) {
            if (i < m.files.length) {
              const { path, size, sha256 } = m.files[i];
              entries.push({ path, size, sha256 });
            } else entries.push({ path: m.directories[i - m.files.length] });
          }
          value = { entries, next: end < m.files.length + m.directories.length ? end : null } satisfies ReviewPage;
          break;
        }
        case 'discoverHost':
          value = await discover(request.server, request.hop, this.transport);
          break;
        case 'agentIdentities':
          value = await agentIdentities();
          break;
        case 'interrupt':
          this.server(request.serverId);
          this.transport.interrupt(request.serverId);
          break;
        case 'watch':
          assert(
            (request.serverId === null || id(request.serverId)) &&
              (request.attemptId === null || id(request.attemptId)),
            'Invalid selection.',
          );
          this.watching = { serverId: request.serverId, attemptId: request.attemptId };
          break;
        case 'importSSH':
          value = importSSH(request.text);
          break;
        case 'saveServer': {
          const s = request.server;
          validateServer(s);
          const old = this.store.get<Server>('server', s.id);
          assert(s.revision === (old?.revision ?? 0), 'Server revision changed. Review it again.');
          const clean: Server = {
            id: s.id,
            revision: s.revision + 1,
            name: text(s.name, 120),
            backend: s.backend,
            root: s.root,
            disabled: s.disabled === true,
            defaults: executionOptions(s.defaults ?? {}),
            hops: s.hops.map((h) => ({
              alias: h.alias,
              host: h.host,
              user: h.user,
              port: h.port,
              ...(h.identityFile ? { identityFile: h.identityFile } : {}),
              ...(h.certificateFile ? { certificateFile: h.certificateFile } : {}),
              ...(h.agent ? { agent: h.agent, agentIdentity: h.agentIdentity } : {}),
              ...(h.hostKey ? { hostKey: h.hostKey } : {}),
            })),
          };
          this.put('server', s.id, clean);
          value = clean;
          break;
        }
        case 'saveTask': {
          const t = request.task,
            s = this.server(t.serverId);
          assert(
            id(t.id) &&
              t.serverRevision === s.revision &&
              typeof t.name === 'string' &&
              t.name.length > 0 &&
              t.name.length <= 120,
            'Invalid task or stale server.',
          );
          await checkedDirectory(t.project);
          assert(
            Array.isArray(t.argv) &&
              t.argv.length > 0 &&
              t.argv.length <= 64 &&
              t.argv.every((a) => typeof a === 'string' && a.length < 4096 && !a.includes('\0')),
            'Use an explicit foreground argv.',
          );
          assert(
            Array.isArray(t.inputs) &&
              t.inputs.length <= 256 &&
              Array.isArray(t.artifacts) &&
              t.artifacts.length <= 256,
            'Too many files.',
          );
          t.inputs.forEach(relativePath);
          t.artifacts.forEach(relativePath);
          const options = executionOptions({
            environment: { ...s.defaults?.environment, ...t.environment },
            resources: { ...s.defaults?.resources, ...t.resources },
          });
          if (t.source) {
            assert(
              Object.keys(t.source).every((k) =>
                ['projectId', 'sessionId', 'kind', 'identity'].includes(k),
              ) &&
                Object.values(t.source).every(
                  (v) =>
                    typeof v === 'string' &&
                    v.length > 0 &&
                    v.length <= 256 &&
                    !/[\x00-\x1f]/.test(v),
                ),
              'Invalid source association.',
            );
            assert(
              t.source.kind === undefined || ['native', 'external'].includes(t.source.kind),
              'Invalid source kind.',
            );
          }
          assert(
            s.backend === 'slurm' || !Object.keys(options.resources).length,
            'Scheduler resources require Slurm.',
          );
          const clean: Task = {
            ...options,
            id: t.id,
            serverId: t.serverId,
            serverRevision: t.serverRevision,
            project: t.project,
            name: text(t.name, 120),
            ...(t.source ? { source: t.source } : {}),
            argv: t.argv,
            inputs: t.inputs,
            artifacts: t.artifacts,
            ...(t.progressMapping
              ? { progressMapping: validateProgressMapping(t.progressMapping, t.artifacts) }
              : {}),
          };
          this.put('task', t.id, clean);
          value = clean;
          break;
        }
        case 'probe': {
          const s = this.server(request.serverId);
          assert(!s.disabled, 'Server is disabled.');
          this.authStopped.delete(s.id);
          this.enqueue(s.id, async () => {
            try {
              const cap = (await this.transport.run(s, {
                kind: 'probe',
                backend: s.backend,
              })) as Capability;
              assert(
                cap &&
                  typeof cap.bootId === 'string' &&
                  typeof cap.host === 'string' &&
                  typeof cap.user === 'string',
                'Invalid capability receipt.',
              );
              assert(this.server(s.id).revision === s.revision, 'Server changed during probe.');
              assert(
                ['unverified', 'verified', 'forbidden'].includes(cap.retention) &&
                  ['unverified', 'sluid', 'constraints'].includes(cap.cancel) &&
                  (s.backend !== 'slurm' ||
                    (typeof cap.controller?.cluster === 'string' &&
                      typeof cap.controller.version === 'string' &&
                      /^[a-f0-9]{64}$/.test(cap.controller.configurationDigest))),
                'Invalid capability decision.',
              );
              s.capability = cap;
              s.lastError = undefined;
              this.put('server', s.id, s);
            } catch (e) {
              if (/Permission denied|Authentication failed|No more authentication/i.test(String(e)))
                this.authStopped.add(s.id);
              if (this.server(s.id).revision === s.revision) {
                s.lastError = text(e);
                this.put('server', s.id, s);
              }
            }
          });
          value = { queued: true };
          break;
        }
        case 'refresh': {
          const s = this.server(request.serverId);
          assert(!s.disabled, 'Server is disabled.');
          this.enqueue(s.id, async () => {
            await this.queue(s);
            for (const attempt of this.store.observedAttempts(s.id, this.watching.attemptId)) {
              if (this.authStopped.has(s.id)) break;
              await this.observe(attempt);
            }
          });
          value = { queued: true };
          break;
        }
        case 'lookup': {
          const s = this.server(request.serverId);
          assert(
            !s.disabled &&
              typeof request.identifier === 'string' &&
              /^[0-9]+(?:_[0-9]+)?(?:\+[0-9]+)?$/.test(request.identifier),
            'Use a numeric PID or full Slurm JobID.',
          );
          this.enqueue(s.id, async () => {
            await this.queue(s, request.identifier);
          });
          value = { queued: true };
          break;
        }
        case 'adopt': {
          const s = this.server(request.serverId);
          const job = request.job;
          const queue = this.store.get<QueueObservation>('queue', s.id);
          assert(
            queue &&
              Date.now() - queue.observedAt < 60000 &&
              queue.rows.some((row) => digest(row.ref) === digest(job)),
            'Choose an execution from a recent server observation.',
          );
          const logs = request.logs ?? [];
          assert(Array.isArray(logs) && logs.length <= 2, 'Choose at most two log files.');
          logs.forEach(absolutePath);
          const task = request.taskId ? this.get<Task>('task', request.taskId) : undefined;
          assert(!task || task.serverId === s.id, 'Task belongs to another server.');
          const aid = randomUUID(),
            a: Attempt = {
              id: aid,
              taskId: task?.id ?? 'external',
              taskSnapshot: task,
              externalLogs: logs,
              executionId: randomUUID(),
              server: s,
              marker: job.kind === 'slurm' ? job.name : 'external-linux',
              createdAt: Date.now(),
              phase: 'unknown',
              ref: job,
              inputDigest: '',
              owned: false,
              detail: 'External job: read only. No cancellation or fetch authority.',
            };
          this.put('attempt', aid, a);
          value = a;
          break;
        }
        case 'propose':
          value = this.operationView(this.propose(request.requestId, request.action, 'gui'));
          break;
        case 'approve': {
          this.expireReviews();
          const op = this.get<Operation>('operation', request.requestId);
          assert(typeof request.allow === 'boolean', 'Approval decision is required.');
          assert(
            op.status === 'review' && op.expiresAt > Date.now() &&
              /^[0-9a-f]{64}$/.test(request.digest) && equal(op.digest, request.digest),
            'Review is expired, already consumed, or its digest changed.',
          );
          if (!request.allow) {
            op.status = 'denied';
            op.detail = 'Declined in Pi Hub.';
            this.settleOperation(op);
            value = { requestId: op.requestId };
            break;
          }
          const r = op.review as Review;
          if (r.nativeScope) {
            this.nativeTask(r.nativeScope);
            if (r.attempt) {
              assert(this.inGrant(this.nativeAgent(op.subject, r.nativeScope), r.attempt),
                'Attempt outside selected Pi task.');
            }
          } else if (op.subject !== 'gui') {
            const grant = this.get<Grant>('grant', op.subject);
            assert(
              !grant.revoked && grant.expiresAt > Date.now(),
              'Agent grant expired or was revoked before approval.',
            );
            const task = op.action.kind === 'submit' ? r.task! : this.get<Task>('task', r.attempt!.taskId);
            assert(!r.attempt || this.inGrant(grant, r.attempt), 'Attempt outside grant scope.');
            assert(grant.actions.includes(op.action.kind) && grant.taskIds.includes(task.id) &&
              task.project === grant.project && task.serverId === grant.serverId,
              'Agent grant scope changed before approval.');
          }
          assert(!this.server(r.server.id).disabled, 'Server is disabled.');
          assert(this.server(r.server.id).revision === (r.serverRevision ?? r.server.revision),
            'Server changed since review.');
          if (op.action.kind === 'submit') {
            assert(digest(this.get<Task>('task', op.action.taskId)) === digest(r.task),
              'Task changed since review.');
          }
          assert(!this.busy.has(r.server.id), 'Wait for the current server operation.');
          op.status = 'approved';
          op.detail = 'Approved in the trusted main window.';
          this.put('operation', op.requestId, op);
          this.enqueue(r.server.id, () => this.execute(op));
          value = { requestId: op.requestId };
          break;
        }
        case 'grant':
          value = await this.issueGrant(request.grant);
          break;
        case 'revoke': {
          const g = this.get<Grant>('grant', request.grantId);
          g.revoked = true;
          this.put('grant', g.id, g);
          break;
        }
        case 'configureCLI':
          value = await this.configureCLI(request.nodePath);
          break;
        default:
          throw Error('Unknown remote method.');
      }
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: text(e instanceof Error ? e.message : e, 2048) };
    }
  }
  private releaseReview(op: Operation) {
    const r = op.review as Review;
    const name = r.snapshotId ?? (r.files?.directory.startsWith(this.reviews + '/')
      ? r.files.directory.slice(this.reviews.length + 1) : undefined);
    if (!name || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name)) return;
    try {
      this.native.releaseSnapshot(this.reviews, name);
      delete r.files;
      delete r.snapshotId;
      this.store.put('operation', op.requestId, op);
    } catch (e) {
      const detail = ' Snapshot cleanup pending: ' + text(e, 256);
      if (!op.detail.includes(' Snapshot cleanup pending: ')) {
        op.detail += detail;
        this.store.put('operation', op.requestId, op);
      }
    }
  }
  private settleOperation(op: Operation) {
    this.store.put('operation', op.requestId, op);
    this.releaseReview(op);
    this.emit();
  }
  private expireReviews() {
    const now = Date.now();
    let changed = false;
    for (const op of this.store.expiredReviews(now, this.preparingId)) {
      op.status = 'expired';
      op.detail = 'Review expired. Prepare a new operation to continue.';
      this.store.put('operation', op.requestId, op);
      this.releaseReview(op);
      changed = true;
    }
    return changed;
  }
  private reviewBinding(action: Action, subject: string, r: Review) {
    return digest({
      action,
      subject,
      serverId: r.server.id,
      serverRevision: r.serverRevision ?? r.server.revision,
      task: r.task,
      executionId: r.attempt?.executionId,
      ref: r.attempt?.ref,
      nativeScope: r.nativeScope,
    });
  }
  private propose(requestId: string, action: Action, subject: string, nativeScope?: NativeTaskScope) {
    assert(
      id(requestId) && action && ['submit', 'cancel', 'fetch'].includes(action.kind),
      'Invalid action identity.',
    );
    this.expireReviews();
    let review: Review;
    if (action.kind === 'submit') {
      const task = this.get<Task>('task', action.taskId);
      const server = this.server(task.serverId);
      assert(task.serverRevision === server.revision,
        'Task server revision changed. Save the task after reviewing the server.');
      action = { kind: 'submit', taskId: task.id };
      review = { server, task, argv: task.argv };
    } else {
      const attempt = this.get<Attempt>('attempt', action.attemptId);
      review = { server: attempt.server, attempt };
      if (action.kind === 'cancel') {
        assert(typeof action.force === 'boolean' && attempt.ref,
          'Cancellation needs an observed execution identity.');
        action = { kind: 'cancel', attemptId: attempt.id, force: action.force };
      } else {
        const task = attempt.taskSnapshot;
        assert(task, 'This legacy attempt has no immutable artifact declaration; fetching is disabled.');
        assert(Array.isArray(action.paths) && action.paths.length > 0 && action.paths.length <= 256 &&
          new Set(action.paths).size === action.paths.length &&
          action.paths.every((p) => task.artifacts.includes(p)), 'Choose explicitly allowed artifacts.');
        action.paths.forEach(relativePath);
        absolutePath(action.destination);
        assert(action.overwrite === undefined || typeof action.overwrite === 'boolean',
          'Invalid replacement selection.');
        action = { kind: 'fetch', attemptId: attempt.id, paths: action.paths,
          destination: action.destination, ...(action.overwrite === undefined ? {} : { overwrite: action.overwrite }) };
      }
    }
    if (nativeScope) review.nativeScope = nativeScope;
    const configured = this.server(review.server.id);
    review.serverRevision = configured.revision;
    const binding = this.reviewBinding(action, subject, review);
    const old = this.store.get<Operation>('operation', requestId);
    if (old) {
      assert(equal(old.binding ?? this.reviewBinding(old.action, old.subject, old.review as Review), binding),
        'The same requestId cannot be used with a different digest, command binding or grant.');
      return old;
    }
    assert(!review.server.disabled && !configured.disabled, 'Server is disabled.');
    if (review.attempt) {
      assert(review.attempt.owned && !review.attempt.invalidated,
        'External or invalidated executions are read only.');
      const { log, logs, logCursors, ...attempt } = review.attempt;
      review.attempt = attempt;
    }
    const now = Date.now();
    if (action.kind === 'submit') review.snapshotId = randomUUID();
    const op: Operation = {
      requestId,
      binding,
      digest: '',
      action,
      status: 'preparing',
      createdAt: now,
      expiresAt: now + REVIEW_TTL,
      subject,
      detail: 'Preparing the immutable operation review.',
      review,
    };
    this.put('operation', requestId, op);
    this.prepareReviews();
    return op;
  }
  private prepareReviews() {
    if (this.preparation) return;
    const job = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      while (!this.closed) {
        const op = this.store.nextPreparation();
        if (!op) return;
        this.preparingId = op.requestId;
        try {
          await this.prepareReview(op);
        } finally {
          this.preparingId = undefined;
        }
      }
    }).finally(() => {
      this.active.delete(job);
      this.preparation = undefined;
    });
    this.preparation = job;
    this.active.add(job);
    void job.catch(() => {});
  }
  private progressWriter(op: Operation) {
    let sampledAt = 0;
    return (progress: TransferProgress, flush = false) => {
      op.transfer = { ...op.transfer, ...progress };
      if (flush || Date.now() - sampledAt >= 200) {
        sampledAt = Date.now();
        this.put('operation', op.requestId, op);
      }
    };
  }
  private async prepareReview(op: Operation) {
    const r = op.review as Review;
    const action = op.action;
    try {
      assert(op.expiresAt > Date.now(), 'Preparation expired.');
      if (action.kind === 'submit') {
        const update = this.progressWriter(op);
        const files = await snapshotInputs(r.task!.project, r.task!.inputs, this.reviews, this.native,
          r.snapshotId, (preparedBytes) => {
            assert(!this.closed && op.expiresAt > Date.now(), 'Preparation interrupted or expired.');
            update({ preparedBytes });
          });
        r.files = files;
        r.manifest = { files: files.files, directories: files.directories, totalBytes: files.totalBytes };
        op.transfer = { preparedBytes: files.totalBytes, totalBytes: files.totalBytes };
      } else if (action.kind === 'fetch') {
        r.destinationParent = await checkedDirectory(dirname(action.destination));
        if (action.overwrite === true) r.destinationRevision = this.native.inspect(action.destination);
        else {
          try {
            await lstat(action.destination);
            throw Error('Choose a new result destination, or explicitly review replacement.');
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        }
      }
      assert(!this.closed && op.expiresAt > Date.now(), 'Preparation interrupted or expired.');
      op.digest = digest({ action, review: this.publicReview(r) });
      op.status = 'review';
      op.expiresAt = Date.now() + REVIEW_TTL;
      op.detail = 'Review the exact server, command, paths and content digests in Pi Hub.';
      this.put('operation', op.requestId, op);
    } catch (e) {
      op.status = op.expiresAt <= Date.now() ? 'expired' : 'blocked';
      op.detail = text(e instanceof Error ? e.message : e);
      this.settleOperation(op);
    }
  }
  private applyResult(a: Attempt, result: any) {
    assert(
      result &&
        ['unknown', 'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(
          result.phase,
        ),
      'Invalid execution response.',
    );
    a.phase = result.phase;
    if (result.ref) {
      assert(result.ref.kind === a.server.backend, 'Execution reference backend mismatch.');
      a.ref = result.ref;
    }
    a.detail = text(result.detail);
  }
  private async execute(op: Operation) {
    op.status = 'running';
    this.put('operation', op.requestId, op);
    const r = op.review as Review;
    const generation = this.transport.generation(r.server.id);
    const updateTransfer = this.progressWriter(op);
    let a = r.attempt,
      remoteStarted = false;
    try {
      if (op.action.kind === 'submit') {
        const task = r.task!,
          server = r.server;
        assert(!server.disabled, 'Server is disabled.');
        assert(server.capability, 'Probe the approved server first.');
        if (server.backend === 'linux')
          assert(
            server.capability.retention === 'verified',
            'Managed Linux launch is blocked: logout retention has not been verified for this host boot.',
          );
        const aid = randomUUID();
        a = {
          id: aid,
          executionId: randomUUID(),
          taskId: task.id,
          server,
          marker: 'pihub-' + randomUUID(),
          createdAt: Date.now(),
          phase: 'unknown',
          detail: 'Intent persisted locally; awaiting remote staging.',
          inputDigest: digest(r.manifest),
          taskSnapshot: task,
          owned: true,
        };
        op.attemptId = aid;
        this.store.transaction(() => {
          this.store.put('attempt', aid, a);
          this.store.put('operation', op.requestId, op);
        });
        this.emit();
        const files = r.files!;
        await verifySnapshot(files, this.native);
        assert(
          digest({
            files: files.files,
            directories: files.directories,
            totalBytes: files.totalBytes,
          }) === digest(r.manifest),
          '审核快照清单改变。',
        );
        this.transport.requireGeneration(server.id, generation);
        this.requireCurrentAttempt(a);
        remoteStarted = true;
        const staged = await this.transport.upload(
          server,
          files,
          {
            attemptId: aid,
            executionId: a.executionId,
            identity: {
              attemptId: aid,
              executionId: a.executionId,
              marker: a.marker,
              createdAt: a.createdAt,
              inputDigest: a.inputDigest,
            },
            supervisorHash: this.expectedAssets['supervisor.py'],
          },
          generation,
          updateTransfer,
        );
        a = this.requireCurrentAttempt(a);
        if (Number.isFinite(staged.remoteCreatedAt)) {
          a.remoteCreatedAt = staged.remoteCreatedAt;
          this.put('attempt', aid, a);
        }
        const result = await this.transport.run(
          server,
          {
            kind: server.backend === 'linux' ? 'linuxLaunch' : 'slurmSubmit',
            attemptId: aid,
            executionId: a.executionId,
            argv: task.argv,
            environment: task.environment ?? {},
            resources: task.resources ?? {},
            operation: { requestId: op.requestId, digest: op.digest },
          },
          generation,
        );
        this.applyExecutionResponse(a, result);
      } else if (op.action.kind === 'cancel') {
        assert(a?.ref && a.ref.kind !== 'linux-external', 'Missing managed execution reference.');
        const current = this.requireCurrentAttempt(a, true);
        if (terminal(current)) {
          op.status = 'done';
          op.detail =
            'Execution already has an authoritative terminal state; no cancellation was sent.';
          this.settleOperation(op);
          return;
        }
        if (a.ref.kind === 'slurm')
          assert(
            !op.action.force &&
              a.ref.cluster === a.server.capability?.controller?.cluster &&
              a.ref.submittedAt &&
              ((a.server.capability?.cancel === 'sluid' && a.ref.sluid) ||
                (a.server.capability?.cancel === 'constraints' &&
                  a.ref.cluster &&
                  a.ref.submittedAt)),
            'Stable controller cancellation has not been verified.',
          );
        remoteStarted = true;
        const result = await this.transport.run(
          a.server,
          {
            kind: a.ref.kind === 'linux' ? 'linuxCancel' : 'slurmCancel',
            attemptId: a.id,
            executionId: a.executionId,
            ref: a.ref,
            force: op.action.force,
            operation: { requestId: op.requestId, digest: op.digest },
          },
          generation,
        );
        this.applyExecutionResponse(current, result);
      } else {
        assert(a, 'Missing attempt.');
        assert(
          (await checkedDirectory(dirname(op.action.destination))) === r.destinationParent,
          '结果目录的父目录在审核后发生变化。',
        );
        const directory = await mkdtemp(join(this.profile, 'remote', 'fetch-'));
        try {
          this.requireCurrentAttempt(a, true);
          remoteStarted = true;
          const result = await this.transport.download(
            a.server,
            { attemptId: a.id, executionId: a.executionId, paths: op.action.paths },
            directory,
            generation,
            updateTransfer,
          );
          assert(
            result.files.every(
              (f) =>
                op.action.kind === 'fetch' &&
                op.action.paths.some((p) => f.path === p || f.path.startsWith(p + '/')),
            ) &&
              result.directories.every(
                (p) =>
                  op.action.kind === 'fetch' &&
                  op.action.paths.some(
                    (selected) => p === selected || p.startsWith(selected + '/'),
                  ),
              ),
            '结果不在审核的路径内。',
          );
          const backup = await publishDisk(
            op.action.destination,
            directory,
            result.files,
            this.native,
            r.destinationParent!,
            r.destinationRevision,
            result.directories,
            () => {
              this.transport.requireGeneration(r.server.id, generation);
              this.requireCurrentAttempt(a!, true);
            },
          );
          updateTransfer({ publishedBytes: result.totalBytes }, true);
          if (backup) op.detail = 'Result published. Previous directory retained at ' + backup;
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
      op.status = 'done';
      if (!op.detail.startsWith('Result published.'))
        op.detail =
          op.action.kind === 'cancel'
            ? 'Cancellation request processed; task completion is determined by observations.'
            : 'Operation completed. Execution state is shown separately.';
    } catch (e) {
      op.status = remoteStarted ? 'unknown' : 'blocked';
      op.detail = text(e instanceof Error ? e.message : e);
      if (a && op.action.kind === 'submit') {
        const current = this.currentAttempt(a);
        if (current && !current.invalidated && current.phase === 'unknown' &&
            current.lastObservedAt === a.lastObservedAt) {
          current.detail = op.detail;
          this.put('attempt', current.id, current);
        }
      }
    }
    this.settleOperation(op);
  }
  private currentAttempt(expected: Attempt) {
    const current = this.store.get<Attempt>('attempt', expected.id);
    return current?.executionId === expected.executionId &&
      current.server.id === expected.server.id && current.server.revision === expected.server.revision &&
      digest(current.ref ?? null) === digest(expected.ref ?? null)
      ? current : undefined;
  }
  private requireCurrentAttempt(expected: Attempt, allowTerminal = false) {
    const current = this.currentAttempt(expected);
    assert(current && !current.invalidated && (allowTerminal || !terminal(current)),
      'Execution changed since approval.');
    return current;
  }
  private applyExecutionResponse(expected: Attempt, result: unknown) {
    const current = this.requireCurrentAttempt(expected, true);
    if (terminal(current) || current.lastObservedAt !== expected.lastObservedAt ||
        current.phase !== expected.phase) return;
    this.applyResult(current, result);
    this.put('attempt', current.id, current);
  }
  private async queue(s: Server, identifier?: string) {
    try {
      const raw = await this.transport.run(s, {
        kind: s.backend === 'linux' ? 'linuxQueue' : 'slurmQueue',
        ...(identifier ? { identifier } : {}),
      });
      let rows: QueueObservation['rows'];
      if (s.backend === 'linux') rows = raw.rows;
      else
        rows = listSlurmObservations(
          raw.jobs,
          raw.observationErrors?.some((error: string) => error.startsWith('active:')) === true,
        ).map(({ ref, phase }) => ({ name: ref.name, phase, ref }));
      this.put('queue', s.id, {
        serverId: s.id,
        observedAt: Date.now(),
        rows: rows.slice(0, 500),
        detail: 'Latest bounded user queue observation. Absence does not imply completion.',
      });
      return true;
    } catch (e) {
      if (/Permission denied|Authentication failed|No more authentication/i.test(String(e)))
        this.authStopped.add(s.id);
      const old = this.store.get<QueueObservation>('queue', s.id);
      this.put('queue', s.id, {
        serverId: s.id,
        observedAt: old?.observedAt ?? 0,
        rows: old?.rows ?? [],
        detail: 'Observation unavailable. ' + text(e),
      });
      return false;
    }
  }
  private async observe(expected: Attempt) {
    const started = this.currentAttempt(expected);
    if (!started || started.invalidated) return;
    let a = started;
    const latest = () => {
      const current = this.currentAttempt(started);
      return current && !current.invalidated && current.phase === started.phase &&
        digest(current.logCursors ?? {}) === digest(started.logCursors ?? {}) &&
        current.lastObservedAt === started.lastObservedAt ? current : undefined;
    };
    try {
      if (!a.owned) {
        const result = await this.transport.run(a.server, {
          kind: 'externalObserve',
          ref: a.ref,
          logs: a.externalLogs ?? [],
        });
        const current = latest();
        if (!current) return;
        a = current;
        if (a.ref?.kind === 'slurm') {
          const selected = observeExternalSlurm(
            a.ref,
            result.records,
            result.activeUnavailable === true,
          );
          result.phase = selected?.phase ?? 'unknown';
          result.detail = selected
            ? '只读调度器观测：' + selected.state
            : '无匹配的调度器身份，完成情况未知。';
        }
        if (result.log) a.log = text(result.log, 65536);
        if (result.phase && !['succeeded', 'failed', 'cancelled'].includes(a.phase))
          a.phase = result.phase;
        a.lastObservedAt = Date.now();
        a.detail = text(result.detail);
        this.put('attempt', a.id, a);
        return;
      }

      const result = await this.transport.run(a.server, {
        kind: a.server.backend === 'slurm' ? 'slurmObserve' : 'observe',
        attemptId: a.id,
        executionId: a.executionId,
        logCursors: a.logCursors ?? {},
        progressFile: a.taskSnapshot?.progressMapping?.file ?? 'progress.json',
      });
      const current = latest();
      if (!current) return;
      a = current;
      if (a.server.backend === 'slurm') {
        if (Number.isFinite(result.remoteCreatedAt)) a.remoteCreatedAt = result.remoteCreatedAt;
        const reconciled = reconcileSlurm(a, result.records, result.activeUnavailable === true);
        if (!['succeeded', 'failed', 'cancelled'].includes(a.phase) || reconciled.invalidated)
          Object.assign(a, reconciled);
        if (reconciled.phase === 'unknown' && a.phase === 'unknown') {
          a.progressSequence ??= a.progress?.sequence;
          a.progress = undefined;
        }
        if (reconciled.invalidated) {
          a.logs = undefined;
          a.logCursors = undefined;
        }
        result.phase = reconciled.phase;
      } else {
        assert(
          [
            'unknown',
            'queued',
            'running',
            'cancelling',
            'succeeded',
            'failed',
            'cancelled',
          ].includes(result.phase),
          'Invalid observation state.',
        );
        if (!terminal(a)) {
          a.phase = result.phase;
          a.ref = result.ref ?? a.ref;
          a.detail = text(result.detail);
        }
        if (result.scopeEnded === true && !a.scopeEnded) {
          a.scopeEnded = true;
          a.mainExit = result.mainExit ?? null;
        }
      }
      if (!a.invalidated && result.logs && typeof result.logs === 'object')
        for (const name of ['stdout.log', 'stderr.log']) {
          const delta = result.logs[name];
          if (
            delta &&
            typeof delta.text === 'string' &&
            delta.text.length <= 65536 &&
            typeof delta.cursor?.identity === 'string' &&
            Number.isSafeInteger(delta.cursor.offset) &&
            delta.cursor.offset >= 0
          ) {
            a.logs ??= {};
            a.logCursors ??= {};
            a.logs[name] = text(
              (delta.reset ? '' : (a.logs[name] ?? '')) + delta.text,
              131072,
            ).slice(-65536);
            a.logCursors[name] = delta.cursor;
          }
        }
      a.log = Object.entries(a.logs ?? {})
        .map(([name, value]) => name + '\n' + value)
        .join('\n');
      const mapping = a.taskSnapshot?.progressMapping;
      const generationObserved =
        !a.invalidated && result.phase !== 'unknown' && a.phase !== 'unknown';
      const sample = mapping && result.progress ? digest(result.progress) : undefined;
      const lastSequence = a.progressSequence ?? a.progress?.sequence ?? -1;
      const p = !generationObserved
        ? undefined
        : mapping
          ? sample && sample !== a.progressSample
            ? mapProgress(mapping, result.progress, {
                attemptId: a.id,
                executionId: a.executionId,
                sequence: lastSequence + 1,
                updatedAt: Number(result.progressObservedAt),
              })
            : undefined
          : result.progress;
      if (
        p &&
        p.schemaVersion === 1 &&
        p.attemptId === a.id &&
        p.executionId === a.executionId &&
        Number.isSafeInteger(p.sequence) &&
        p.sequence >= 0 &&
        p.sequence > lastSequence &&
        Number.isFinite(p.updatedAt) &&
        p.updatedAt <= Date.now() + 300000 &&
        typeof p.stage === 'string' &&
        p.stage.length <= 256 &&
        Number.isFinite(p.completed) &&
        Number.isFinite(p.total) &&
        p.total > 0 &&
        p.completed >= 0 &&
        p.completed <= p.total &&
        p.metrics &&
        typeof p.metrics === 'object' &&
        !Array.isArray(p.metrics) &&
        Object.keys(p.metrics).length <= 32 &&
        Object.entries(p.metrics).every(
          ([key, n]) => key.length <= 64 && typeof n === 'number' && Number.isFinite(n),
        )
      ) {
        a.progress = { ...p, stage: text(p.stage, 256) };
        a.progressSample = sample;
        a.progressSequence = p.sequence;
      }
      a.lastObservedAt = Date.now();
    } catch (e) {
      if (/Permission denied|Authentication failed|No more authentication/i.test(String(e)))
        this.authStopped.add(a.server.id);
      const current = latest();
      if (!current || terminal(current)) return;
      a = current;
      a.detail = 'Offline / observation unavailable. Last known state retained. ' + text(e);
    }
    this.put('attempt', a.id, a);
    if (a.invalidated) return;
    for (const op of this.store.operationsWhere(['unknown'], a.id)) {
      if (
        (op.action.kind === 'submit' && a.ref && a.phase !== 'unknown') ||
        (['cancel', 'submit'].includes(op.action.kind) &&
          (['succeeded', 'failed', 'cancelled'].includes(a.phase) || a.scopeEnded))
      ) {
        op.status = 'done';
        op.detail =
          'Reconciled from the existing execution observation; no write action was repeated. ' +
          a.detail;
        this.settleOperation(op);
      }
    }
  }
  private async issueGrant(g: Omit<Grant, 'id' | 'revoked' | 'tokenPath'>) {
    this.server(g.serverId);
    await checkedDirectory(g.project);
    assert(
      Array.isArray(g.taskIds) &&
        g.taskIds.length > 0 &&
        g.taskIds.every((t) => {
          const task = this.get<Task>('task', t);
          return task.serverId === g.serverId && task.project === g.project;
        }),
      'Grant tasks must belong to its server and project.',
    );
    assert(
      g.expiresAt > Date.now() &&
        g.expiresAt <= Date.now() + 24 * 3600000 &&
        Array.isArray(g.actions) &&
        g.actions.length > 0 &&
        g.actions.every((a) => ['observe', 'submit', 'cancel', 'fetch', 'adopt'].includes(a)),
      'Choose grant actions and expiry within 24 hours.',
    );
    const gid = randomUUID(),
      token = randomBytes(32).toString('hex'),
      dir = join(this.profile, 'remote', 'grants');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tokenPath = join(dir, gid + '.json');
    await writeFile(tokenPath, JSON.stringify({ grantId: gid, token }), {
      flag: 'wx',
      mode: 0o600,
    });
    const grant = { ...g, id: gid, revoked: false, tokenPath, tokenHash: hash(token) };
    this.put('grant', gid, grant);
    const { tokenHash, ...publicGrant } = grant;
    return publicGrant;
  }
  private cliServer(s: Server) {
    const cap = s.capability;
    return {
      id: s.id,
      name: s.name,
      revision: s.revision,
      backend: s.backend,
      disabled: s.disabled === true,
      capability: cap && {
        observedAt: cap.observedAt,
        python: cap.python,
        retention: cap.retention,
        cancel: cap.cancel,
        controller: cap.controller && {
          cluster: cap.controller.cluster,
          version: cap.controller.version,
        },
      },
    };
  }
  private cliAttempt(a: Attempt) {
    return {
      id: a.id,
      executionId: a.executionId,
      taskId: a.taskId,
      serverId: a.server.id,
      serverRevision: a.server.revision,
      phase: a.phase,
      owned: a.owned,
      createdAt: a.createdAt,
      lastObservedAt: a.lastObservedAt,
      invalidated: a.invalidated,
      scopeEnded: a.scopeEnded,
      mainExit: a.mainExit && { code: a.mainExit.code, observedAt: a.mainExit.observedAt },
      progress: a.progress && {
        schemaVersion: a.progress.schemaVersion,
        attemptId: a.progress.attemptId,
        executionId: a.progress.executionId,
        sequence: a.progress.sequence,
        updatedAt: a.progress.updatedAt,
        stage: a.progress.stage,
        completed: a.progress.completed,
        total: a.progress.total,
        metrics: a.progress.metrics,
      },
    };
  }
  private cliOperation(op: OperationSummary) {
    const progress = op.transfer;
    return {
      requestId: op.requestId,
      digest: op.digest,
      action: { kind: op.action.kind },
      status: op.status,
      createdAt: op.createdAt,
      expiresAt: op.expiresAt,
      attemptId: op.attemptId ?? undefined,
      transfer: progress && {
        preparedBytes: progress.preparedBytes,
        acknowledgedBytes: progress.acknowledgedBytes,
        totalBytes: progress.totalBytes,
        publishedBytes: progress.publishedBytes,
      },
    };
  }
  private inGrant(g: AgentScope, a: Attempt) {
    return g.taskIds.includes(a.taskId) && a.server.id === g.serverId &&
      a.taskSnapshot?.project === g.project;
  }
  async cliRequest(input: any): Promise<Reply> {
    try {
      assert(
        !this.closed && input && id(input.grantId) && typeof input.token === 'string' &&
          /^[a-f0-9]{64}$/.test(input.token),
        'Grant credential required.',
      );
      const g = this.get<Grant & { tokenHash: string }>('grant', input.grantId);
      assert(
        !g.revoked && g.expiresAt > Date.now() && equal(hash(input.token), g.tokenHash),
        'Grant denied, expired or revoked.',
      );
      assert(
        g.taskIds.every((tid) => {
          const task = this.store.get<Task>('task', tid);
          return task?.serverId === g.serverId && task.project === g.project;
        }),
        'Grant scope changed; grant access again in Pi Hub.',
      );
      return await this.agentRequest(g, input.request);
    } catch (e) {
      return { ok: false, error: text(e instanceof Error ? e.message : e) };
    }
  }
  private nativeTask(scope: NativeTaskScope) {
    const task = this.get<Task>('task', scope.id);
    assert(task.serverId === scope.serverId && task.project === scope.project,
      '关联任务的项目或服务器已变化，请重新打开 Pi。');
    return task;
  }
  private nativeAgent(subject: string, scope: NativeTaskScope): AgentScope {
    return { id: subject, taskIds: [scope.id], serverId: scope.serverId, project: scope.project,
      actions: ['observe', 'submit', 'cancel', 'fetch'] };
  }
  async nativePiRequest(input: NativePiRequest): Promise<Reply> {
    try {
      assert(!this.closed, '远端任务服务正在关闭。');
      if (input.command === 'choices') {
        assert(Number.isSafeInteger(input.offset) && input.offset >= 0, '无效的任务页。');
        const tasks = this.store.taskChoices(input.offset, 11);
        return { ok: true, value: {
          tasks: tasks.slice(0, 10).map((task) => ({ id: task.id, name: task.name.slice(0, 100),
            server: this.server(task.serverId).name.slice(0, 80) })),
          next: tasks.length > 10 ? input.offset + 10 : null,
        } };
      }
      if (input.command === 'bind') {
        assert(id(input.taskId), '无效的任务标识。');
        const task = this.get<Task>('task', input.taskId);
        return { ok: true, value: { id: task.id, project: task.project, serverId: task.serverId } };
      }
      assert(input.command === 'task' && /^pi:[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(input.subject),
        '无效的 Pi 会话。');
      this.nativeTask(input.scope);
      assert(['snapshot', 'status', 'logs', 'operation', 'propose'].includes(input.request?.command),
        'Pi 只能查看关联任务或发起待审操作。');
      return await this.agentRequest(this.nativeAgent(input.subject, input.scope), input.request, input.scope);
    } catch (e) {
      return { ok: false, error: text(e instanceof Error ? e.message : e) };
    }
  }
  private agentOperation(op: OperationSummary, nativeScope?: NativeTaskScope) {
    const {digest, ...summary} = this.cliOperation(op);
    return nativeScope ? summary : { ...summary, digest };
  }
  private async agentRequest(g: AgentScope, request: any, nativeScope?: NativeTaskScope): Promise<Reply> {
    assert(
      request &&
        ['snapshot', 'propose', 'adopt', 'servers', 'status', 'logs', 'operation'].includes(
          request.command,
        ),
      'CLI cannot approve, create grants or change configuration.',
    );
    if (request.command === 'adopt') {
      assert(
        g.actions.includes('adopt') && g.taskIds.includes(request.taskId),
        'Adoption not granted for this task.',
      );
      const task = this.get<Task>('task', request.taskId);
      assert(
        task.serverId === g.serverId && task.project === g.project,
        'Adoption outside grant scope.',
      );
      const reply = await this.request({
        command: 'adopt',
        serverId: g.serverId,
        taskId: task.id,
        job: request.job,
      });
      if (!reply.ok) return reply;
      const a = reply.value as Attempt;
      return { ok: true, value: { id: a.id, executionId: a.executionId, taskId: a.taskId,
        phase: a.phase, owned: a.owned } };
    }
    if (request.command === 'servers') {
      assert(g.actions.includes('observe'), 'Observation not granted.');
      return { ok: true, value: [this.cliServer(this.server(g.serverId))] };
    }
    if (['status', 'logs'].includes(request.command)) {
      assert(g.actions.includes('observe'), 'Observation not granted.');
      const a = this.get<Attempt>('attempt', request.attemptId);
      assert(this.inGrant(g, a), 'Attempt outside grant scope.');
      if (request.command === 'status') return { ok: true, value: {
        ...this.cliAttempt(a),
        ...(nativeScope ? { artifacts: a.taskSnapshot?.artifacts.slice(0, 100) } : {}),
      } };
      assert(
        Number.isSafeInteger(request.offset) &&
          request.offset >= 0 &&
          Number.isSafeInteger(request.length) &&
          request.length > 0 &&
          request.length <= (nativeScope ? 4096 : 32768),
        nativeScope ? '单次日志最多读取 4096 个字符。' : 'Use a bounded log offset and length up to 32768.',
      );
      const log = a.log ?? '';
      return {
        ok: true,
        value: {
          attemptId: a.id,
          offset: request.offset,
          nextOffset: Math.min(log.length, request.offset + request.length),
          total: log.length,
          text: log.slice(request.offset, request.offset + request.length),
          lastObservedAt: a.lastObservedAt,
        },
      };
    }
    this.expireReviews();
    if (request.command === 'operation') {
      const op = this.get<Operation>('operation', request.requestId);
      assert(op.subject === g.id, 'Operation outside grant scope.');
      return { ok: true, value: this.agentOperation(this.operationSummary(op), nativeScope) };
    }
    if (request.command === 'snapshot') {
      assert(g.actions.includes('observe'), 'Observation not granted.');
      const page = this.operationPage(0, g.id);
      return { ok: true, value: {
        generation: this.generation,
        sequence: ++this.sequence,
        servers: [this.cliServer(this.server(g.serverId))],
        tasks: g.taskIds.map((id) => {
          const t = this.get<Task>('task', id);
          return { id, name: t.name, serverId: t.serverId, serverRevision: t.serverRevision };
        }),
        attempts: this.store.grantedAttempts(g.serverId, g.taskIds, g.project, nativeScope ? 6 : 100)
          .map((a) => this.cliAttempt(a)),
        operations: page.operations.slice(0, nativeScope ? 6 : OPERATION_PAGE_SIZE)
          .map((o) => this.agentOperation(o, nativeScope)),
      } };
    }
    const a = request.action as Action;
    assert(a && ['submit', 'cancel', 'fetch'].includes(a.kind) && g.actions.includes(a.kind),
      'Action not granted.');
    const attempt = a.kind !== 'submit' ? this.get<Attempt>('attempt', a.attemptId) : undefined;
    if (attempt) assert(this.inGrant(g, attempt), 'Attempt outside grant scope.');
    const task = this.get<Task>('task', a.kind === 'submit' ? a.taskId : attempt!.taskId);
    assert(g.taskIds.includes(task.id) && task.project === g.project && task.serverId === g.serverId,
      'Action is outside grant scope.');
    return { ok: true, value: this.agentOperation(this.operationSummary(
      this.propose(request.requestId, a, g.id, nativeScope),
    ), nativeScope) };
  }
  private async configureCLI(nodePath: string) {
    assert(
      Buffer.byteLength(join(this.profile, 'remote', 'control.sock')) < 104,
      'Profile path is too long for a private CLI socket; GUI remote workspace remains available.',
    );
    absolutePath(nodePath);
    const node = await realpath(nodePath),
      st = await lstat(node);
    assert(st.isFile(), 'Choose a Node executable.');
    const version = await new Promise<string>((resolve, reject) =>
      execFile(
        node,
        ['--version'],
        { timeout: 5000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      ),
    );
    assert(/^v(?:2[4-9]|[3-9][0-9])\./.test(version), 'Node 24+ is required.');
    let cli = join(this.assets, 'cli.mjs');
    if (cli.includes('/app.asar/')) cli = cli.replace('/app.asar/', '/app.asar.unpacked/');
    cli = await realpath(cli);
    const sha256 = hash(await readFile(cli));
    assert(sha256 === this.expectedAssets['cli.mjs'], 'CLI package integrity check failed.');
    const binding = {
      schema: 1,
      profile: await realpath(this.profile),
      nodePath: node,
      cliPath: cli,
      cliHash: sha256,
      nodeHash: hash(await readFile(node)),
    };
    const config = join(this.profile, 'remote', 'cli-binding.json');
    await writeFile(config, JSON.stringify(binding, null, 2), { mode: 0o600 });
    await chmod(config, 0o600);
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const launcher = join(this.profile, 'remote', 'pi-hub-remote');
    await writeFile(
      launcher,
      '#!/bin/sh\nexec ' +
        quote(node) +
        ' ' +
        quote(cli) +
        ' --profile ' +
        quote(binding.profile) +
        ' "$@"\n',
      { mode: 0o700 },
    );
    await chmod(launcher, 0o700);
    let acceptance = join(this.assets, 'acceptance-cli.mjs').replace(
      '/app.asar/',
      '/app.asar.unpacked/',
    );
    acceptance = await realpath(acceptance);
    assert(
      hash(await readFile(acceptance)) === this.expectedAssets['acceptance-cli.mjs'],
      'Acceptance CLI integrity changed.',
    );
    const acceptanceBinding = join(this.profile, 'remote', 'acceptance-binding.json');
    await writeFile(
      acceptanceBinding,
      JSON.stringify({
        schema: 1,
        nodePath: node,
        nodeHash: binding.nodeHash,
        toolPath: acceptance,
        toolHash: this.expectedAssets['acceptance-cli.mjs'],
      }),
      { mode: 0o600 },
    );
    const acceptanceLauncher = join(this.profile, 'remote', 'pi-hub-remote-acceptance');
    await writeFile(
      acceptanceLauncher,
      '#!/bin/sh\nexec ' +
        quote(node) +
        ' ' +
        quote(acceptance) +
        ' --binding ' +
        quote(acceptanceBinding) +
        ' "$@"\n',
      { mode: 0o700 },
    );
    await chmod(acceptanceLauncher, 0o700);
    this.cli = { ready: true, detail: `${version} · ${cli}`, launcher, acceptanceLauncher };
    this.emit();
    return this.cli;
  }
  pending() {
    return this.store.pendingCount();
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.transport.close();
    await Promise.allSettled(this.active);
    for (const op of this.store.operationsWhere(['preparing'])) {
      op.status = 'blocked';
      op.detail = 'Worker stopped during snapshot preparation. Create a new review to prepare again.';
      this.settleOperation(op);
    }
    this.store.close();
  }
}
