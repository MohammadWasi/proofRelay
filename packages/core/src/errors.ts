export type RelayErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'DEPENDENCY_BLOCKED' | 'DEPENDENCY_CYCLE' | 'APPROVAL_REQUIRED' | 'CONFLICT' | 'STALE_LEASE' | 'RETRY_LIMIT' | 'BACKOFF' | 'READ_ONLY' | 'UNAUTHORIZED' | 'UNSUPPORTED_SCHEMA' | 'UNSAFE_PATH';

export class RelayError extends Error {
  override readonly name = 'RelayError';
  constructor(readonly code: RelayErrorCode, message: string, readonly details?: Record<string, unknown>) { super(message); }
}
