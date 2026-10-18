const sensitiveKey = /(?:^|[_-])(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization|credential)(?:$|[_-])/iu;
const camelSensitiveKey = /^(?:password|passwd|secret|token|apiKey|privateKey|accessToken|refreshToken|authorization|credentials|clientSecret|completionToken)$/iu;

export function isSensitiveKey(key: string): boolean {
  return sensitiveKey.test(key) || camelSensitiveKey.test(key);
}

export function redactText(input: string): string {
  let value = input
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b/gu, '[REDACTED]')
    .replace(/\b(Bearer\s+)[^\s"',;]+/giu, '$1[REDACTED]')
    .replace(/((?:["']?)(?:password|passwd|secret|(?:[\w-]*[_-])?token|api[_-]?key|private[_-]?key|client[_-]?secret|authorization|credential)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/giu, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@');
  // Exact environment values supplement pattern redaction without reading secret files.
  for (const [key, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 4 && isSensitiveKey(key)) value = value.replaceAll(secret, '[REDACTED]');
  }
  return value;
}

/** Return a redacted copy; untrusted prose remains data and is never interpreted. */
export function sanitize<T>(value: T): T {
  const visited = new WeakSet<object>();
  const walk = (current: unknown): unknown => {
    if (typeof current === 'string') return redactText(current);
    if (current === null || typeof current !== 'object') return current;
    if (visited.has(current)) return '[CIRCULAR]';
    visited.add(current);
    if (Array.isArray(current)) return current.map(walk);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current)) {
      Object.defineProperty(result, key, { value: isSensitiveKey(key) ? '[REDACTED]' : walk(item), enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  return walk(value) as T;
}
