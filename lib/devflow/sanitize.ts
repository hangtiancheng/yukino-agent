const REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    "[REDACTED_JWT]",
  ],
  [/\b(authorization\s*:\s*bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]"],
  [/(::add-mask::)[^\r\n]+/gi, "$1[REDACTED]"],
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
