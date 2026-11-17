import type { ClassificationRequest } from './interface';

export function validClassificationOutcomeRequest(
  request: unknown,
): request is { requestId: string } {
  return (
    !!request &&
    typeof request === 'object' &&
    !Array.isArray(request) &&
    'requestId' in request &&
    typeof request.requestId === 'string' &&
    /^[a-zA-Z0-9-]{1,128}$/.test(request.requestId)
  );
}
export function validClassificationRequest(request: unknown): request is ClassificationRequest {
  return (
    validClassificationOutcomeRequest(request) &&
    'key' in request &&
    typeof request.key === 'string' &&
    /^[a-f0-9]{64}$/.test(request.key) &&
    'classification' in request &&
    (request.classification === 'main' || request.classification === 'archive') &&
    'expectedRevision' in request &&
    Number.isSafeInteger(request.expectedRevision) &&
    (request.expectedRevision as number) >= 0
  );
}
