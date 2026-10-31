const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /(?:api[_-]?key|token|secret|password|passwd|private[_-]?key)\s*[:=]\s*["']?[^"',\s}]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecretText(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value);
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretText(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (/api[_-]?key|token|secret|password|passwd|private[_-]?key/i.test(key)) {
        return [key, '[REDACTED]'];
      }
      return [key, redactUnknown(item)];
    });
    return Object.fromEntries(entries);
  }
  return value;
}

