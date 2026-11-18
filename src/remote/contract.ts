/** Remote authority is deliberately separate from native Pi sessions. */
export type Backend = 'linux' | 'slurm';
export type Phase =
  'unknown' | 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
export interface Hop {
  alias: string;
  host: string;
  user: string;
  port: number;
  identityFile?: string;
  certificateFile?: string;
  agent?: 'environment';
  agentIdentity?: string;
  hostKey?: string;
}
export interface Server {
  id: string;
  revision: number;
  name: string;
  backend: Backend;
  root: string;
  hops: Hop[];
  disabled?: boolean;
  defaults?: { environment?: Record<string, string>; resources?: Resources };
  capability?: Capability;
  lastError?: string;
}
export interface Capability {
  host: string;
  user: string;
  bootId: string;
  python: string;
  supervisorHash?: string;
  observedAt: number;
  retention: 'unverified' | 'forbidden' | 'verified';
  cancel: 'unverified' | 'sluid' | 'constraints';
  controller?: {
    version: string;
    cluster: string;
    configurationDigest: string;
  };
  reason: string;
}
export interface Resources {
  partition?: string;
  account?: string;
  qos?: string;
  minutes?: number;
  memoryMB?: number;
  cpus?: number;
  gpus?: number;
  nodes?: number;
}
export interface ProgressMapping {
  file: string;
  stage?: string;
  completed: string;
  total: string;
  metrics: Record<string, string>;
}
export interface Task {
  id: string;
  serverId: string;
  serverRevision: number;
  project: string;
  name: string;
  argv: string[];
  inputs: string[];
  artifacts: string[];
  progressMapping?: ProgressMapping;
  environment?: Record<string, string>;
  resources?: Resources;
  source?: {
    projectId?: string;
    sessionId?: string;
    kind?: 'native' | 'external';
    identity?: string;
  };
}
export interface LinuxRef {
  kind: 'linux';
  host: string;
  user: string;
  bootId: string;
  supervisor: { pid: number; start: string };
  helper: { pid: number; start: string };
  workload?: { pid: number; start: string };
  pgid: number;
  endpoint: string;
}
export interface SlurmRef {
  kind: 'slurm';
  jobId: string;
  owner: string;
  cluster: string;
  submittedAt: string;
  name: string;
  sluid?: string;
  databaseIndex?: string;
  restart?: number;
}
export interface ExternalLinuxRef {
  kind: 'linux-external';
  host: string;
  user: string;
  bootId: string;
  pid: number;
  start: string;
  pgid: number;
}
export type ExecutionRef = LinuxRef | SlurmRef | ExternalLinuxRef;
export interface Progress {
  schemaVersion: 1;
  attemptId: string;
  executionId: string;
  sequence: number;
  updatedAt: number;
  stage: string;
  completed: number;
  total: number;
  metrics: Record<string, number>;
}
export interface LogCursor {
  identity: string;
  offset: number;
  preceding: string;
}
export interface Attempt {
  id: string;
  executionId: string;
  taskId: string;
  server: Server;
  marker: string;
  createdAt: number;
  remoteCreatedAt?: number;
  phase: Phase;
  ref?: ExecutionRef;
  lastObservedAt?: number;
  detail: string;
  log?: string;
  inputDigest: string;
  taskSnapshot?: Task;
  owned: boolean;
  invalidated?: boolean;
  progress?: Progress;
  progressSample?: string;
  progressSequence?: number;
  scopeEnded?: boolean;
  mainExit?: { code: number; observedAt: number } | null;
  logCursors?: Record<string, LogCursor>;
  logs?: Record<string, string>;
  externalLogs?: string[];
}
export type Action =
  | { kind: 'submit'; taskId: string }
  | { kind: 'cancel'; attemptId: string; force: boolean }
  | { kind: 'fetch'; attemptId: string; paths: string[]; destination: string; overwrite?: boolean };
export interface TransferProgress {
  preparedBytes?: number;
  acknowledgedBytes?: number;
  totalBytes?: number;
  publishedBytes?: number;
}
export interface OperationSummary {
  requestId: string;
  digest: string;
  action: { kind: Action['kind'] };
  status: 'preparing' | 'review' | 'approved' | 'running' | 'done' | 'unknown' | 'denied' | 'blocked' | 'expired';
  createdAt: number;
  expiresAt: number;
  subject: string;
  detail: string;
  attemptId?: string;
  transfer?: TransferProgress;
}
export interface Operation extends OperationSummary {
  action: Action;
  review: unknown;
  binding?: string;
}
export interface ReviewPage {
  entries: ({ path: string; size: number; sha256: string } | { path: string })[];
  next: number | null;
}
export interface OperationPage {
  operations: OperationSummary[];
  next: number | null;
}
export interface AttemptPage {
  attempts: Attempt[];
  next: number | null;
}
export interface Grant {
  id: string;
  serverId: string;
  project: string;
  taskIds: string[];
  actions: ('observe' | 'submit' | 'cancel' | 'fetch' | 'adopt')[];
  expiresAt: number;
  revoked: boolean;
  tokenPath: string;
}
export interface QueueObservation {
  serverId: string;
  observedAt: number;
  rows: { name: string; phase: Phase; ref: ExecutionRef }[];
  detail: string;
}
export interface Snapshot {
  generation: string;
  sequence: number;
  servers: Server[];
  tasks: Task[];
  attempts: Attempt[];
  operations: OperationSummary[];
  nextOperationPage: number | null;
  watchingServer: string | null;
  nextAttemptPage: number | null;
  grants: Grant[];
  queues: QueueObservation[];
  cli: { ready: boolean; detail: string; launcher?: string; acceptanceLauncher?: string };
}
export type Request =
  | { command: 'snapshot' }
  | { command: 'discoverHost'; server: Server; hop: number }
  | { command: 'agentIdentities' }
  | { command: 'interrupt'; serverId: string }
  | { command: 'watch'; serverId: string | null; attemptId: string | null }
  | { command: 'importSSH'; text: string }
  | { command: 'saveServer'; server: Server }
  | { command: 'probe'; serverId: string }
  | { command: 'saveTask'; task: Task }
  | { command: 'refresh'; serverId: string }
  | { command: 'lookup'; serverId: string; identifier: string }
  | { command: 'adopt'; serverId: string; job: ExecutionRef; taskId?: string; logs?: string[] }
  | { command: 'propose'; requestId: string; action: Action }
  | { command: 'operation'; requestId: string }
  | { command: 'operations'; offset: number }
  | { command: 'attempts'; serverId: string; offset: number }
  | { command: 'reviewPage'; requestId: string; digest: string; offset: number }
  | { command: 'approve'; requestId: string; digest: string; allow: boolean }
  | { command: 'grant'; grant: Omit<Grant, 'id' | 'revoked' | 'tokenPath'> }
  | { command: 'revoke'; grantId: string }
  | { command: 'configureCLI'; nodePath: string };
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

/** Internal messages for an authenticated Pi Hub SDK host. */
export interface NativeTaskScope {
  id: string;
  project: string;
  serverId: string;
}
export type NativePiAction =
  | { command: 'snapshot' }
  | { command: 'status'; attemptId: string }
  | { command: 'logs'; attemptId: string; offset: number; length: number }
  | { command: 'operation'; requestId: string }
  | { command: 'propose'; requestId: string; action: Action };
export type NativePiRequest =
  | { command: 'choices'; offset: number }
  | { command: 'bind'; taskId: string }
  | { command: 'task'; subject: string; scope: NativeTaskScope; request: NativePiAction };
export type NativePiBridge = (request: NativePiRequest) => Promise<Reply>;
export type RemoteChoice =
  'config' | 'knownHosts' | 'project' | 'inputs' | 'destination' | 'identity';
export interface DefaultSSHPreview {
  aliases: Hop[][];
  skipped: { alias: string; reason: string }[];
  omitted: ('Include' | 'Match' | 'Host 通配模式')[];
}
export interface RemoteAPI {
  request<T = unknown>(request: Request): Promise<Reply<T>>;
  choose(kind: RemoteChoice, project?: string): Promise<Reply<{ paths: string[]; text?: string }>>;
  previewDefaultSSH(): Promise<Reply<DefaultSSHPreview>>;
}
export const text = (s: unknown, limit = 8192): string =>
  String(s ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .slice(0, limit);
