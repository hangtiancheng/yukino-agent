// CI log secret sanitization. Port of the Python sanitize_ci_log
// (DevFlow-AI services/rag/indexing.py): failed-job logs are persisted to
// PostgreSQL, rendered in the UI, and handed to LLMs, so credentials that
// leaked into a CI run must be scrubbed BEFORE storage — the migration
// initially kept the raw log text, which this restores.

const REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private key blocks.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
    "[REDACTED_PRIVATE_KEY]",
  ],
  // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_).
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  // AWS access key ids.
  [/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
  // JWTs.
  [
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    "[REDACTED_JWT]",
  ],
  // Authorization: bearer <token>.
  [/\b(authorization\s*:\s*bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]"],
  // GitHub Actions masked-secret markers (the rest of the line is the secret).
  [/(::add-mask::)[^\r\n]+/gi, "$1[REDACTED]"],
  // key=value / key: value assignments whose key looks credential-shaped.
  [
    /\b([a-z0-9_]*(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|private[_-]?key|client[_-]?secret|account[_-]?key)[a-z0-9_]*)(\s*[:=]\s*)([^\s,;]+)/gi,
    "$1$2[REDACTED]",
  ],
];

export function sanitizeCiLog(text: string): string {
  let sanitized = text;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}
