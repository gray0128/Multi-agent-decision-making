const SENSITIVE_KEY = /(authorization|api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)/i;
const MAX_DEPTH = 8;
const MAX_ITEMS = 100;
const MAX_STRING_LENGTH = 4_000;

function redactString(value: string): string {
  let redacted = value
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|xai|ghp|github_pat|glpat)-?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 8 && /(TOKEN|KEY|SECRET|PASSWORD)/i.test(name)) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }
  return redacted.slice(0, MAX_STRING_LENGTH);
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return redactString(String(value));
  if (seen.has(value)) return "[CIRCULAR]";
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  seen.add(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((entry) => sanitize(entry, depth + 1, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_ITEMS)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(entry, depth + 1, seen);
  }
  return output;
}

export function redactDiagnostic(record: unknown): unknown {
  return sanitize(record, 0, new WeakSet<object>());
}
