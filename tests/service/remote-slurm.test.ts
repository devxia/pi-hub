import { it, expect } from 'vitest';
import {
  listSlurmObservations,
  observeExternalSlurm,
  parseSlurmJob,
  reconcileSlurm,
} from '../../src/remote/slurm';
import type { Attempt } from '../../src/remote/contract';
const job = {
  job_id: { set: true, number: 123 },
  user_name: 'owned',
  cluster: 'cluster',
  name: 'marker',
  time: { submission: { set: true, number: 1700000000 } },
  state: { current: ['RUNNING'] },
  working_directory: '/owned/attempts/attempt/input',
  restart_cnt: { set: true, number: 0 },
};
const attempt = {
  id: 'attempt',
  marker: 'marker',
  createdAt: 1700000000000,
  server: { root: '/owned', capability: { user: 'owned' } },
} as Attempt;
it('parses typed documented scalar/state forms without object stringification', () => {
  expect(parseSlurmJob({ ...job, _source: 'active' })).toMatchObject({
    phase: 'running',
    ref: { jobId: '123', submittedAt: '1700000000', restart: 0 },
  });
  expect(parseSlurmJob({ ...job, job_id: { set: false, number: 123 } })).toBeUndefined();
  expect(
    parseSlurmJob({ ...job, time: { submission: { set: false, number: 0 } } }),
  ).toBeUndefined();
  expect(parseSlurmJob({ ...job, job_id: '123.batch' })).toBeUndefined();
  expect(parseSlurmJob({ ...job, state: ['RUNNING', 'COMPLETING'] })).toMatchObject({
    phase: 'unknown',
  });
  expect(
    parseSlurmJob({
      ...job,
      array_job_id: { set: true, number: 123 },
      array_task_id: { set: true, number: 7 },
    })?.ref.jobId,
  ).toBe('123_7');
  expect(
    parseSlurmJob({ ...job, het_job_id: 123, het_job_offset: { set: true, number: 2 } })?.ref.jobId,
  ).toBe('123+2');
  expect(parseSlurmJob({ ...job, array_task_string: '1-9' })).toBeUndefined();
  expect(
    parseSlurmJob({ ...job, job_id: '123_8', array_job_id: 123, array_task_id: 7 }),
  ).toBeUndefined();
});
it('withholds accounting-only results when active lookup failed and reconciles the same queue identity', () => {
  const active = { ...job, _source: 'active' };
  const terminal = { ...job, state: { current: 'COMPLETED' }, _source: 'accounting' };
  const ref = parseSlurmJob(active)!.ref;
  expect(listSlurmObservations([active, terminal], false)).toMatchObject([
    { phase: 'running', ref },
  ]);
  expect(listSlurmObservations([terminal], true)).toEqual([]);
  expect(observeExternalSlurm(ref, [terminal], true)).toBeUndefined();
  expect(observeExternalSlurm(ref, [terminal], false)?.phase).toBe('succeeded');
  expect(reconcileSlurm({ ...attempt, ref }, [terminal], true).phase).toBe('unknown');
  expect(listSlurmObservations([active, { ...terminal, restart_cnt: 1 }], false)).toEqual([]);
  expect(observeExternalSlurm(ref, [{ ...active, state: ['REQUEUED'] }])).toBeUndefined();
});
it('prefers active evidence with unavailable accounting and requires terminal accounting with exact identity', () => {
  expect(reconcileSlurm(attempt, [{ ...job, _source: 'active' }])).toMatchObject({
    phase: 'running',
  });
  expect(
    reconcileSlurm(attempt, [
      { ...job, _source: 'active' },
      { ...job, state: { current: 'COMPLETED' }, _source: 'accounting' },
    ]),
  ).toMatchObject({ phase: 'running' });
  expect(
    reconcileSlurm(attempt, [{ ...job, state: { current: 'COMPLETED' }, _source: 'accounting' }]),
  ).toMatchObject({ phase: 'succeeded' });
  expect(reconcileSlurm(attempt, [])).toMatchObject({ phase: 'unknown' });
  for (const changed of [
    { user_name: 'other' },
    { time: { submission: { set: true, number: 1700000999 } } },
    { working_directory: '/different' },
  ])
    expect(reconcileSlurm(attempt, [{ ...job, ...changed, _source: 'active' }]).phase).toBe(
      'unknown',
    );
  const bound = { ...attempt, ref: parseSlurmJob(job)!.ref };
  expect(reconcileSlurm(bound, [{ ...job, cluster: 'another', _source: 'active' }])).toMatchObject({
    phase: 'unknown',
    invalidated: true,
  });
  expect(reconcileSlurm(bound, [{ ...job, restart_cnt: 1, _source: 'active' }])).toMatchObject({
    phase: 'unknown',
    invalidated: true,
  });
  expect(
    reconcileSlurm(attempt, [
      { ...job, _source: 'active' },
      { ...job, _source: 'active' },
    ]).phase,
  ).toBe('unknown');
  expect(
    reconcileSlurm(attempt, [
      { ...job, _source: 'active' },
      { ...job, job_id: 124, _source: 'active' },
    ]).phase,
  ).toBe('unknown');
});
