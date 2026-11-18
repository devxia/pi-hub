export interface Project {
  id: string;
  name: string;
  path: string;
  includeDescendants: boolean;
  enabled?: boolean;
}
export interface ProjectSnapshot {
  projects: Project[];
  revision: number;
}
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_HISTORY'
  | 'DIRECTORY_UNAVAILABLE'
  | 'DATABASE_UNAVAILABLE'
  | 'DATABASE_BUSY'
  | 'DATABASE_VERSION'
  | 'BACKGROUND_UNAVAILABLE'
  | 'IMPORT_UNAVAILABLE'
  | 'SCOPE_CHANGED'
  | 'RECORD_CHANGED'
  | 'TERMINAL_MISSING'
  | 'TERMINAL_PROTOCOL'
  | 'PI_MISSING'
  | 'AUTOMATION_DENIED'
  | 'TERMINAL_TIMEOUT'
  | 'RECOVERY_REQUIRED'
  | 'STARTUP_IO';
export interface ManagementError {
  terminal?: ExternalTerminal;
  code: ErrorCode;
  message: string;
  detail?: string;
  existingProjectId?: string;
  field?: 'piPath' | 'nodePath' | 'settings';
}
export type Result<T> =
  { status: 'completed'; value: T } | { status: 'failed'; error: ManagementError };
export interface AddProjectRequest {
  requestId: string;
  path: string | null;
}
export interface AddProjectResult {
  project: Project | null;
  outcome: 'added' | 'existing' | 'cancelled';
}
export interface ProjectScopeRequest {
  requestId: string;
  projectId: string;
  expectedScopeRevision: number;
  includeDescendants: boolean;
}
export interface RemoveProjectRequest {
  requestId: string;
  projectId: string;
  expectedScopeRevision: number;
}
export interface StorageLocation {
  id: string;
  path: string;
  kind: 'standard' | 'custom';
  enumeration: 'encoded' | 'flat';
  enabled: boolean;
}
export interface StorageSnapshot {
  locations: StorageLocation[];
  revision: number;
}
export interface StorageLocationRequest {
  requestId: string;
  path: string | null;
  enumeration: StorageLocation['enumeration'];
}
export interface RemoveStorageRequest {
  requestId: string;
  locationId: string;
  expectedScopeRevision: number;
}
export interface RecordSource {
  locationId: string;
  sourcePath: string;
  rootIdentity?: string;
}
export interface ClassificationRequest {
  requestId: string;
  key: string;
  classification: 'main' | 'archive';
  expectedRevision: number;
}
export interface ClassificationReceipt {
  key: string;
  classification: 'main' | 'archive';
  revision: number;
}
export interface ExternalPiSdk {
  packagePath: string;
  entryPath: string;
  version: '1.5.2' | string;
  packageIdentity: string;
  manifestHash: string;
  entryHash: string;
}
export interface LaunchConfiguration {
  cliPath?: string;
  cliHash?: string;
  launcherArgs?: string[];
  externalSdk?: ExternalPiSdk;
  mode?: 'launcher' | 'node';
  piPath: string;
  nodePath: string;
}
export interface PiStatus {
  configured: boolean;
  compatibility: 'unchecked' | 'supported' | 'incompatible';
  supportedVersions: string[];
  settingsPath: string;
  legacyExtension: string;
  legacyExtensionConfigured: boolean;
  version?: string;
  launch?: LaunchConfiguration;
  reviewId?: string;
  instances: RuntimeInstance[];
  error?: string;
}
export type RuntimeState = 'unknown' | 'connected' | 'busy';
export interface RuntimeInstance {
  pid: number;
  generation: string;
  sessionId: string;
  cwd: string;
  persisted: boolean;
  tty: string | null;
  state: RuntimeState;
  reason?: string;
  hostId?: string;
  mode?: string;
}
export interface RuntimeDiagnostic {
  at: string;
  event: 'rejected' | 'bound' | 'verified' | 'exit';
  category: string;
  pid?: number;
  generation?: string;
  sequence?: number;
  claimedStartIdentity?: string;
  observedStartIdentity?: string;
  claimedSessionId?: string;
  sourceIdentity?: string;
}
export interface OpenSessionRequest {
  requestId: string;
  intent: 'resume' | 'new';
  projectId?: string;
  remoteTaskId?: string;
  key?: string;
  identity?: string;
  runtimeProjectId?: string;
  terminal?: ExternalTerminal;
  rememberTerminal?: boolean;
}
export interface DeleteRequest {
  requestId: string;
  key: string;
  identity: string;
  expectedRevision: string;
  confirmed: true;
}
export interface DeleteOutcome {
  requestId: string;
  state: 'pending' | 'uncertain' | 'completed' | 'rejected';
  method?: 'trash' | 'permanent' | 'observed-absent';
  error?: string;
}
export interface DeletePreparation {
  key: string;
  identity: string;
  expectedRevision: string;
  sourcePath: string;
  pending?: DeleteOutcome;
  request?: DeleteRequest;
}
export interface RenameRequest {
  requestId: string;
  key: string;
  identity: string;
  expectedRevision: string;
  name: string;
}
export interface RenameOutcome {
  requestId: string;
  state: 'pending' | 'uncertain' | 'completed' | 'rejected' | 'superseded';
  canonicalName?: string;
  revision?: string;
  error?: string;
}
export interface RenamePreparation {
  key: string;
  identity: string;
  expectedRevision: string;
  name: string;
  pending?: RenameOutcome;
  request?: RenameRequest;
}
export interface CloneRequest {
  requestId: string;
  key: string;
}
export interface ClonePreparation {
  key: string;
  identity: string;
  defaultName: string;
  pending?: CloneOutcome;
  request?: CloneRequest;
}
export interface CloneOutcome {
  requestId: string;
  state: 'pending' | 'uncertain' | 'completed' | 'rejected';
  targetId: string;
  targetPath: string;
  key?: string;
  error?: string;
  errorCode?: 'UNSUPPORTED_HISTORY';
}
export type ExternalTerminal = 'Terminal' | 'Ghostty';
export interface TerminalTarget {
  windowId: number | string;
  tty: string;
  tabId?: string;
  terminalId?: string;
  terminal?: ExternalTerminal;
}
export interface TerminalOutcome {
  terminal?: ExternalTerminal;
  manualNotice?: string;
  canRetry?: boolean;
  command?: string;
  requestId: string;
  state: 'uncertain' | 'bound' | 'not-started' | 'located' | 'ended' | 'awaiting-paste';
  target?: TerminalTarget;
  message: string;
  errorCode?: ErrorCode;
}
export interface TerminalIdentity {
  bundleId: 'com.apple.Terminal' | 'com.mitchellh.ghostty';
  path: string;
  version: string;
  capability?: 'stable-terminal-ids';
}
export interface SessionTerminal {
  hostId: string;
  terminal: ExternalTerminal;
  pid: number;
  tty: string;
  busy: boolean;
}
export interface ExitSessionRequest {
  requestId: string;
  key: string;
  identity: string;
  hostId: string;
  stopBusy: boolean;
}
export interface ExitSessionOutcome {
  requestId: string;
  state: 'completed' | 'uncertain';
  message: string;
}
export type SessionMenuAction =
  'open' | 'locate' | 'rename' | 'clone' | 'classify' | 'copy-id' | 'reveal' | 'exit' | 'delete';
export interface SessionMenuSelection {
  key: string;
  identity: string;
  action: SessionMenuAction;
  hostId?: string;
  classification?: 'main' | 'archive';
  classificationRevision?: number;
}
export interface TerminalSettings {
  defaultTerminal: ExternalTerminal | null;
  installed?: TerminalIdentity;
  available: { terminal: ExternalTerminal; installed: TerminalIdentity }[];
}
export interface SessionManagement {
  prepareDelete(request: { key: string }): Promise<Result<DeletePreparation>>;
  deleteSession(request: DeleteRequest): Promise<Result<DeleteOutcome>>;
  getDeleteOutcome(request: { requestId: string }): Promise<Result<DeleteOutcome | null>>;
  prepareRename(request: { key: string }): Promise<Result<RenamePreparation>>;
  renameSession(request: RenameRequest): Promise<Result<RenameOutcome>>;
  getRenameOutcome(request: { requestId: string }): Promise<Result<RenameOutcome | null>>;
  prepareTerminalCommand(request: { requestId: string }): Promise<Result<TerminalOutcome>>;
  cancelTerminalCommand(request: { requestId: string }): Promise<Result<TerminalOutcome>>;
  retryTerminal(request: { requestId: string }): Promise<Result<TerminalOutcome>>;
  openTerminal(request: OpenSessionRequest): Promise<Result<TerminalOutcome>>;
  locateSession(request: { key: string }): Promise<Result<TerminalOutcome>>;
  sessionTerminals(request: { key: string; identity: string }): Promise<Result<SessionTerminal[]>>;
  exitSession(request: ExitSessionRequest): Promise<Result<ExitSessionOutcome>>;
  getTerminalOutcome(request: { requestId: string }): Promise<Result<TerminalOutcome | null>>;
  getTerminalSettings(): Promise<Result<TerminalSettings>>;
  setDefaultTerminal(request: {
    terminal: ExternalTerminal | null;
  }): Promise<Result<TerminalSettings>>;
  prepareClone(request: { key: string }): Promise<Result<ClonePreparation>>;
  cloneSession(request: CloneRequest): Promise<Result<CloneOutcome>>;
  getCloneOutcome(request: { requestId: string }): Promise<Result<CloneOutcome | null>>;
  /** Trusted terminal adapter only. Association is never exposed through renderer IPC. */
  getPiStatus(): Promise<Result<PiStatus>>;
  inspectPi(request: LaunchConfiguration): Promise<Result<PiStatus>>;
  savePiConfiguration(request: { reviewId: string }): Promise<Result<PiStatus>>;
  setSessionClassification(request: ClassificationRequest): Promise<Result<ClassificationReceipt>>;
  getClassificationOutcome(request: {
    requestId: string;
  }): Promise<Result<Result<ClassificationReceipt> | null>>;
  listStorageLocations(): Promise<Result<StorageSnapshot>>;
  prepareStorageLocation(request: StorageLocationRequest): Promise<Result<ImportBatch | null>>;
  removeStorageLocation(request: RemoveStorageRequest): Promise<Result<null>>;
  changeProjectScope(request: ProjectScopeRequest): Promise<Result<ImportBatch | null>>;
  removeProject(request: RemoveProjectRequest): Promise<Result<null>>;
  listProjects(): Promise<Result<ProjectSnapshot>>;
  addProject(request: AddProjectRequest): Promise<Result<AddProjectResult>>;
  matchProject(cwd: string): Promise<Result<Project | null>>;
  prepareImport(request: AddProjectRequest): Promise<Result<ImportBatch | null>>;
  getImport(request: ImportRequest): Promise<Result<ImportBatch>>;
  listImports(): Promise<Result<ImportBatch[]>>;
  selectImport(request: ImportSelectionRequest): Promise<Result<ImportBatch>>;
  commitImport(request: ImportRequest): Promise<Result<ImportBatch>>;
  cancelImport(request: ImportRequest): Promise<Result<ImportBatch>>;
  retryImport(request: ImportRequest): Promise<Result<ImportBatch>>;
  listSessions(request: SessionListRequest): Promise<Result<ManagedSession[]>>;
  getPreview(request: PreviewRequest): Promise<Result<SessionPreview>>;
  cancelPreview(request: { requestId: string }): Promise<Result<null>>;
  /** Trusted runtime adapter only; never exposed to renderer. Disconnect revokes leaf authority. */
  updatePreviewRuntime(request: PreviewRuntime): Promise<Result<null>>;
  listQueuedRecords(): Promise<Result<SessionRecord[]>>;
  getSnapshot(): Promise<Result<WorkspaceSnapshot>>;
  reconcile(): Promise<Result<DiscoveryState>>;
  cancelReconciliation(): Promise<Result<DiscoveryState>>;
  subscribe(afterRevision: number, listener: (snapshot: WorkspaceSnapshot) => void): () => void;
  close(): Promise<void>;
}
export function completed<T>(value: T): Result<T> {
  return { status: 'completed', value };
}
export function failed(code: ErrorCode, message: string, detail?: string): Result<never> {
  return { status: 'failed', error: { code, message, detail } };
}
/** Explicit renderer commands; launch paths are accepted only by the reviewed onboarding flow. */
export type SettingsCategory = 'terminal' | 'storage' | 'pi';
export interface SettingsWindowState {
  category: SettingsCategory;
  dirty: boolean;
  busy: boolean;
}
export interface DesktopSessionManagement {
  showSettings(): Promise<Result<null>>;
  updateSettingsWindow(state: SettingsWindowState): Promise<Result<null>>;
  closeSettings(): Promise<Result<null>>;
  onSettingsChanged(listener: () => void): () => void;
  prepareDelete: SessionManagement['prepareDelete'];
  deleteSession: SessionManagement['deleteSession'];
  getDeleteOutcome: SessionManagement['getDeleteOutcome'];
  prepareRename: SessionManagement['prepareRename'];
  renameSession: SessionManagement['renameSession'];
  getRenameOutcome: SessionManagement['getRenameOutcome'];
  cancelTerminalCommand: SessionManagement['cancelTerminalCommand'];
  copyTerminalCommand(request: { requestId: string }): Promise<Result<null>>;
  getTerminalSettings: SessionManagement['getTerminalSettings'];
  setDefaultTerminal: SessionManagement['setDefaultTerminal'];
  openTerminal: SessionManagement['openTerminal'];
  getTerminalOutcome: SessionManagement['getTerminalOutcome'];
  locateSession: SessionManagement['locateSession'];
  sessionTerminals: SessionManagement['sessionTerminals'];
  exitSession: SessionManagement['exitSession'];
  showSessionMenu(request: {
    key: string;
    x?: number;
    y?: number;
  }): Promise<Result<SessionMenuSelection | null>>;
  getPiStatus: SessionManagement['getPiStatus'];
  inspectPi: SessionManagement['inspectPi'];
  savePiConfiguration: SessionManagement['savePiConfiguration'];
  retryTerminal: SessionManagement['retryTerminal'];
  prepareClone: SessionManagement['prepareClone'];
  cloneSession: SessionManagement['cloneSession'];
  getCloneOutcome: SessionManagement['getCloneOutcome'];
  setSessionClassification: SessionManagement['setSessionClassification'];
  getClassificationOutcome: SessionManagement['getClassificationOutcome'];
  listStorageLocations: SessionManagement['listStorageLocations'];
  chooseStorageLocation(request: {
    requestId: string;
    enumeration: StorageLocation['enumeration'];
  }): Promise<Result<ImportBatch | null>>;
  removeStorageLocation: SessionManagement['removeStorageLocation'];
  changeProjectScope: SessionManagement['changeProjectScope'];
  removeProject: SessionManagement['removeProject'];
  listProjects(): Promise<Result<ProjectSnapshot>>;
  chooseProject(request: { requestId: string }): Promise<Result<ImportBatch | null>>;
  listImports: SessionManagement['listImports'];
  getImport: SessionManagement['getImport'];
  selectImport: SessionManagement['selectImport'];
  commitImport: SessionManagement['commitImport'];
  cancelImport: SessionManagement['cancelImport'];
  retryImport: SessionManagement['retryImport'];
  listSessions: SessionManagement['listSessions'];
  getPreview: SessionManagement['getPreview'];
  cancelPreview: SessionManagement['cancelPreview'];
  getSnapshot: SessionManagement['getSnapshot'];
  reconcile: SessionManagement['reconcile'];
  cancelReconciliation: SessionManagement['cancelReconciliation'];
  subscribe: SessionManagement['subscribe'];
}

export interface RecordIdentity {
  sources?: RecordSource[];
  physicalIdentity?: string;
  key: string;
  headerId: string;
  sourcePath: string;
  cwd: string;
  identity: string;
}
export interface SessionRecord extends RecordIdentity {
  /** Root device/inode verified while this specific source was successfully read. */
  sourceRootIdentity?: string;
  createdAt?: string | null;
  name?: string;
  automaticTitle?: string;
  projectionVersion?: number;
  cloneUnsupportedReason?: string;
  hasMessages?: boolean;
  sourceModifiedAt?: number;
  sourceFingerprint?: string;
  title: string;
  lastMessageAt: string | null;
  messageWatermark: string[];
}
export interface ImportIssue {
  path: string;
  message: string;
}
export interface ImportBatch {
  id: string;
  project: Project;
  scopeRevision: number;
  purpose?: 'add' | 'expand' | 'return' | 'storage';
  location?: StorageLocation;
  projects?: Project[];
  candidateProjectIds?: Record<string, string>;
  state: 'scanning' | 'ready' | 'validating' | 'completed' | 'cancelled' | 'error';
  candidates: SessionRecord[];
  selectedKeys: string[];
  progress: {
    phase: 'discovering' | 'reading' | 'validating';
    inspected: number;
    total: number;
    parsed: number;
  };
  issues: ImportIssue[];
  error?: ManagementError;
  validationNotice?: string;
  scopeOutcomes?: { projectId: string; main: number; archived: number }[];
  outcome?: { main: number; archived: number; removed: number; queued: number };
}
export interface ImportRequest {
  batchId: string;
}
export interface ImportSelectionRequest extends ImportRequest {
  selectedKeys: string[];
}

export interface ManagedSession extends SessionRecord {
  classificationRevision?: number;
  classificationChange?: { revision: number; cause: 'manual' | 'message' };
  archiveBaselineUncertain?: boolean;
  identityConflict?: boolean;
  uniqueIdentity?: Capability;
  projectId: string;
  classification: 'main' | 'archive';
  archiveWatermark: string[] | null;
}
export interface SessionListRequest {
  classification: 'main' | 'archive' | 'all';
  projectId?: string;
  search?: string;
  sort?: 'recent' | 'name' | 'created';
  offset?: number;
  limit?: number;
}

export interface Capability {
  allowed: boolean;
  reason?: string;
  code?: string;
}
export interface RuntimeCapabilities {
  read: Capability;
  classify: Capability;
  rename: Capability;
  clone: Capability;
  delete: Capability;
  launch: Capability;
  locate: Capability;
}
export interface SourceAvailability {
  state: 'available' | 'unavailable';
  reason?: string;
}
export type StorageAvailability =
  SourceAvailability | { state: 'pending' | 'checking'; reason: string };
export interface DiscoveryState {
  state: 'idle' | 'scanning' | 'completed' | 'cancelled' | 'error';
  inspected: number;
  parsed: number;
  issues: ImportIssue[];
  error?: ManagementError;
  /** Work observed at this publication; pending reconciliation requests coalesce to one. */
  work?: {
    concurrencyLimit: number;
    activeReads: number;
    queuedReconciliations: number;
    pendingPaths?: number;
    pendingPathLimit?: number;
  };
}
/** Every notification is an authoritative replacement snapshot, including after reconnect. */
export interface WorkspaceSnapshot {
  revision: number;
  projects: (Project & { availability: SourceAvailability; newSession: Capability })[];
  sessions: (ManagedSession & {
    runtimeCwd?: string;
    previewRevision: string;
    availability: SourceAvailability;
    openSession: Capability;
    runtimeCapabilities: RuntimeCapabilities;
    runtimeState: RuntimeState;
  })[];
  discovery: DiscoveryState;
  locations?: (StorageLocation & { availability: StorageAvailability })[];
}

export interface PreviewRequest {
  key: string;
  requestId: string;
  expectedPreviewRevision?: string;
}
export interface PreviewRuntime {
  key: string;
  identity: string;
  generation: number | string;
  runtimeIdentity?: string;
  sequence?: number;
  state?: RuntimeState;
  connected: boolean;
  leafId: string | null;
  runtimeCwd?: string;
}
export interface PreviewMessage {
  sourceId: string;
  role: 'user' | 'assistant';
  text: string;
  kind: 'original' | 'recent' | 'original-and-recent';
}
export interface SessionPreview {
  previewRevision: string;
  key: string;
  requestId: string;
  leafId: string | null;
  generation: number | string | null;
  messages: PreviewMessage[];
}
