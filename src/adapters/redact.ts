const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|authorization|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const COMMON_TOKEN = /\b(?:sk|xai|ghp|github_pat|glpat)-?[A-Za-z0-9_-]{12,}\b/g;

export function redactAdapterDiagnostic(value: string): string {
  let redacted = value
    .replace(SECRET_ASSIGNMENT, "$1$2[REDACTED]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(COMMON_TOKEN, "[REDACTED]");
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 8 && /(TOKEN|KEY|SECRET|PASSWORD)/i.test(name)) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }
  return redacted.slice(0, 4_000).trim();
}
