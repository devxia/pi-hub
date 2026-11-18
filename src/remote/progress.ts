import type { Progress, ProgressMapping } from './contract';
import { text } from './contract';
import { assert, relativePath } from './security';

const field = (path: string) => {
  assert(
    typeof path === 'string' &&
      path.length <= 128 &&
      /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(path) &&
      path.split('.').every((key) => !['__proto__', 'prototype', 'constructor'].includes(key)),
    'Use an explicit JSON property path.',
  );
  return path;
};
export function validateProgressMapping(
  mapping: ProgressMapping,
  artifacts: string[],
): ProgressMapping {
  assert(
    mapping &&
      typeof mapping === 'object' &&
      Object.keys(mapping).every((key) =>
        ['file', 'stage', 'completed', 'total', 'metrics'].includes(key),
      ),
    'Invalid progress mapping.',
  );
  relativePath(mapping.file);
  assert(
    mapping.file.endsWith('.json') && artifacts.includes(mapping.file),
    'Declare the mapped JSON file in the artifact allowlist.',
  );
  assert(
    mapping.metrics &&
      typeof mapping.metrics === 'object' &&
      !Array.isArray(mapping.metrics) &&
      Object.keys(mapping.metrics).length <= 16,
    'At most sixteen metric mappings are allowed.',
  );
  for (const [name, path] of Object.entries(mapping.metrics)) {
    assert(/^[a-zA-Z0-9_ .%-]{1,40}$/.test(name), 'Invalid metric label.');
    field(path);
  }
  return {
    file: mapping.file,
    ...(mapping.stage ? { stage: field(mapping.stage) } : {}),
    completed: field(mapping.completed),
    total: field(mapping.total),
    metrics: { ...mapping.metrics },
  };
}
export function mapProgress(
  mapping: ProgressMapping,
  raw: unknown,
  identity: { attemptId: string; executionId: string; sequence: number; updatedAt: number },
): Progress | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const document = raw as Record<string, unknown>;
  // A plain metrics document may carry its own attemptId metadata.
  if (['schemaVersion', 'executionId', 'sequence'].some((key) => Object.hasOwn(document, key))) {
    if (
      document.schemaVersion !== 1 ||
      document.attemptId !== identity.attemptId ||
      document.executionId !== identity.executionId ||
      typeof document.sequence !== 'number' ||
      !Number.isSafeInteger(document.sequence) ||
      document.sequence < 0 ||
      typeof document.updatedAt !== 'number'
    )
      return;
    identity = { ...identity, sequence: document.sequence, updatedAt: document.updatedAt };
  }
  const read = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (node, key) =>
          node && typeof node === 'object' && Object.hasOwn(node, key)
            ? (node as Record<string, unknown>)[key]
            : undefined,
        raw,
      );
  const completed = read(mapping.completed),
    total = read(mapping.total);
  const metrics = Object.fromEntries(
    Object.entries(mapping.metrics).map(([name, path]) => [name, read(path)]),
  );
  if (
    typeof completed !== 'number' ||
    !Number.isFinite(completed) ||
    typeof total !== 'number' ||
    !Number.isFinite(total) ||
    completed < 0 ||
    total <= 0 ||
    completed > total ||
    Object.values(metrics).some((value) => typeof value !== 'number' || !Number.isFinite(value))
  )
    return;
  return {
    schemaVersion: 1,
    ...identity,
    stage: mapping.stage ? text(read(mapping.stage), 120) : '应用进度',
    completed,
    total,
    metrics: metrics as Record<string, number>,
  };
}
