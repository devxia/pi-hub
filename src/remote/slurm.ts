import type { Attempt, Phase, SlurmRef } from './contract';

/** Slurm 24/25 data_parser scalars explicitly distinguish unset/infinite values. */
export function slurmScalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (item.set === false || item.infinite === true) return;
  for (const key of ['number', 'current', 'name']) {
    if (key in item) return slurmScalar(item[key]);
  }
}

function stateValue(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return stateValue((value as Record<string, unknown>).current);
  if (Array.isArray(value)) {
    const states = value.map(slurmScalar).filter((s): s is string => Boolean(s && phaseByState[s]));
    return states.length === 1 ? states[0] : undefined;
  }
  return slurmScalar(value)?.replace(/\+$/, '').split(' ')[0];
}
const phaseByState: Record<string, Phase> = {
  PENDING: 'queued',
  CONFIGURING: 'queued',
  REQUEUED: 'unknown',
  REQUEUE_FED: 'unknown',
  REQUEUE_HOLD: 'unknown',
  RUNNING: 'running',
  COMPLETING: 'running',
  SUSPENDED: 'running',
  COMPLETED: 'succeeded',
  FAILED: 'failed',
  TIMEOUT: 'failed',
  OUT_OF_MEMORY: 'failed',
  NODE_FAIL: 'failed',
  BOOT_FAIL: 'failed',
  DEADLINE: 'failed',
  PREEMPTED: 'failed',
  CANCELLED: 'cancelled',
};
export interface SlurmObservation {
  ref: SlurmRef;
  phase: Phase;
  state: string;
  directory?: string;
  source: 'active' | 'accounting';
}

export function parseSlurmJob(raw: unknown): SlurmObservation | undefined {
  if (!raw || typeof raw !== 'object') return;
  const j = raw as Record<string, any>;
  let jobId = slurmScalar(j.job_id);
  if (!jobId || !/^\d+(?:_\d+)?(?:\+\d+)?$/.test(jobId)) return;
  const array = slurmScalar(j.array?.job_id ?? j.array_job_id);
  const index = slurmScalar(j.array?.task_id ?? j.array_task_id);
  const het = slurmScalar(j.het?.job_id ?? j.het_job_id ?? j.heterogeneous?.job_id);
  const offset = slurmScalar(j.het?.job_offset ?? j.het_job_offset ?? j.heterogeneous?.job_offset);
  // An array range describes multiple executions and cannot authorize one task.
  if (slurmScalar(j.array_task_string) || slurmScalar(j.array?.task_string)) return;
  for (const [base, component, separator] of [
    [array, index, '_'],
    [het, offset, '+'],
  ] as const) {
    if ([base, component].some((value) => value !== undefined && !/^\d+$/.test(value))) return;
    if (base === undefined || base === '0' || Number(base) >= 4294967294) continue;
    if (component === undefined || Number(component) >= 4294967294) return;
    const full = `${base}${separator}${component}`;
    if ((jobId.includes('_') || jobId.includes('+')) && jobId !== full) return;
    jobId = full;
  }
  const owner = slurmScalar(j.user_name ?? j.user),
    cluster = slurmScalar(j.cluster);
  const submittedAt = slurmScalar(j.time?.submission ?? j.submit_time),
    name = slurmScalar(j.name);
  const restartRaw = slurmScalar(j.restart_cnt ?? j.restart_count ?? j.restarts);
  const sluid = slurmScalar(j.sluid);
  const databaseIndex = slurmScalar(j.database_index ?? j.db_index);
  if (
    !owner ||
    !cluster ||
    !name ||
    !submittedAt ||
    !/^\d+$/.test(submittedAt) ||
    !Number.isSafeInteger(Number(submittedAt)) ||
    Number(submittedAt) <= 0
  )
    return;
  if (
    restartRaw !== undefined &&
    (!/^\d+$/.test(restartRaw) || !Number.isSafeInteger(Number(restartRaw)))
  )
    return;
  if (sluid && !/^[A-Za-z0-9_-]{8,128}$/.test(sluid)) return;
  if (databaseIndex && !/^[1-9]\d*$/.test(databaseIndex)) return;
  const state = stateValue(j.state ?? j.job_state) ?? 'UNKNOWN';
  const source = j._source === 'active' ? 'active' : 'accounting';
  const candidate = phaseByState[state] ?? 'unknown';
  const phase =
    source === 'active' && ['succeeded', 'failed', 'cancelled'].includes(candidate)
      ? 'unknown'
      : candidate;
  return {
    ref: {
      kind: 'slurm',
      jobId,
      owner,
      cluster,
      submittedAt,
      name,
      ...(sluid ? { sluid } : {}),
      ...(databaseIndex ? { databaseIndex } : {}),
      ...(restartRaw !== undefined ? { restart: Number(restartRaw) } : {}),
    },
    state,
    phase,
    source,
    directory: slurmScalar(j.working_directory ?? j.work_dir),
  };
}

export function sameSlurmIdentity(a: SlurmRef, b: SlurmRef) {
  return (
    a.jobId === b.jobId &&
    a.owner === b.owner &&
    a.name === b.name &&
    (!a.cluster || a.cluster === b.cluster) &&
    (!a.submittedAt || a.submittedAt === b.submittedAt)
  );
}

function sameGeneration(a: SlurmRef, b: SlurmRef) {
  return (
    (!a.sluid || !b.sluid || a.sluid === b.sluid) &&
    (!a.databaseIndex || !b.databaseIndex || a.databaseIndex === b.databaseIndex) &&
    (a.restart === undefined || b.restart === undefined || a.restart === b.restart)
  );
}

function requeued(job: SlurmObservation) {
  return job.state.startsWith('REQUEUE');
}

export function selectSlurmObservation(candidates: SlurmObservation[]) {
  const active = candidates.filter((j) => j.source === 'active');
  const accounting = candidates.filter((j) => j.source === 'accounting');
  const selected = active[0] ?? accounting[0];
  if (!selected || active.length > 1 || accounting.length > 1) return;
  if (
    candidates.some(
      ({ ref }) => !sameSlurmIdentity(selected.ref, ref) || !sameGeneration(selected.ref, ref),
    )
  )
    return;
  const other = active.length ? accounting[0]?.ref : undefined;
  return { ...selected, ref: { ...other, ...selected.ref } };
}

export function listSlurmObservations(records: unknown[], activeUnavailable: boolean) {
  const groups = new Map<string, SlurmObservation[]>();
  for (const raw of records) {
    const job = parseSlurmJob(raw);
    if (!job) continue;
    const { jobId, cluster, owner, name, submittedAt } = job.ref;
    const key = JSON.stringify([jobId, cluster, owner, name, submittedAt]);
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const selected = selectSlurmObservation(group);
    if (!selected || (activeUnavailable && selected.source === 'accounting')) return [];
    return [{ ...selected, phase: group.some(requeued) ? ('unknown' as const) : selected.phase }];
  });
}

export function observeExternalSlurm(ref: SlurmRef, records: unknown[], activeUnavailable = false) {
  const candidates = records.flatMap((record) => {
    const job = parseSlurmJob(record);
    return job && sameSlurmIdentity(ref, job.ref) ? [job] : [];
  });
  const selected = selectSlurmObservation(candidates);
  if (!selected || (activeUnavailable && selected.source === 'accounting')) return;
  if (sameGeneration(ref, selected.ref) && !candidates.some(requeued)) return selected;
}

/** Active queue evidence wins while a job is present; absence never proves completion. */
export function reconcileSlurm(
  attempt: Attempt,
  records: unknown[],
  activeUnavailable = false,
): { phase: Phase; ref?: SlurmRef; detail: string; invalidated?: boolean } {
  const parsed = records.map(parseSlurmJob).filter((j): j is SlurmObservation => Boolean(j));
  const candidates = parsed.filter(
    (j) =>
      j.ref.name === attempt.marker &&
      j.ref.owner === attempt.server.capability?.user &&
      j.directory === `${attempt.server.root}/attempts/${attempt.id}/input` &&
      Number(j.ref.submittedAt) * 1000 >= (attempt.remoteCreatedAt ?? attempt.createdAt) - 60000 &&
      Number(j.ref.submittedAt) * 1000 <= (attempt.remoteCreatedAt ?? attempt.createdAt) + 300000,
  );
  const previous = attempt.ref?.kind === 'slurm' ? attempt.ref : undefined;
  const cluster = previous?.cluster || attempt.server.capability?.controller?.cluster;
  if (
    attempt.invalidated ||
    candidates.some(
      (job) =>
        requeued(job) ||
        (previous && (!sameSlurmIdentity(previous, job.ref) || !sameGeneration(previous, job.ref))),
    ) ||
    candidates.some((job) =>
      candidates.some(
        (other) => sameSlurmIdentity(job.ref, other.ref) && !sameGeneration(job.ref, other.ref),
      ),
    )
  )
    return {
      phase: 'unknown',
      invalidated: true,
      detail: '控制器报告执行身份或重排代次改变；原执行凭据失效。',
    };
  const selected = selectSlurmObservation(
    candidates.filter((job) => !cluster || job.ref.cluster === cluster),
  );
  if (!selected || (activeUnavailable && selected.source === 'accounting'))
    return {
      phase: 'unknown',
      detail: '当前无法确认唯一的调度器执行身份；不会重复提交。',
    };
  const ref = { ...previous, ...selected.ref };
  return { phase: selected.phase, ref, detail: '调度器观测：' + selected.state };
}
