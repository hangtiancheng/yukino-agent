// Automatic persistence of finished AI Ops diagnostic reports into the ops
// knowledge base. Port of the Python DiagnosisCasePersistor (agent_py
// aiops/cases.py): every completed report becomes a markdown case document
// under FILE_DIR and is indexed into Milvus immediately, so later chats and
// AI Ops runs retrieve past incidents ("query_internal_docs" by alert name
// finds both the runbook and prior cases). Content-hash dedup keeps re-runs
// with an identical report idempotent; startup indexDataDir() re-indexes the
// case files after a restart.
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { buildKnowledgeIndex } from "./knowledge-index";

const CASE_PREFIX = "aiops-case-";

// Below this length a "report" carries no case value (e.g. the exhausted-run
// "Max iterations reached" result).
const MIN_REPORT_CHARS = 200;

// Per-evidence summary cap, matching the Python case document (500 chars).
const EVIDENCE_SUMMARY_CHARS = 500;
const MAX_EVIDENCE_ITEMS = 20;

// The OnCall surface is public and unauthenticated, so cap the case corpus to
// keep anonymous repeated runs from growing FILE_DIR without bound (the
// Python original was authenticated and needed no cap).
const MAX_CASE_FILES = 200;

// Persist one finished diagnostic report. Returns the case file name, or null
// when nothing was written (report too short, duplicate, or cap reached).
export async function persistDiagnosticCase(
  report: string,
  detail: string[],
  alertName?: string | null,
): Promise<string | null> {
  const trimmed = report.trim();
  if (trimmed.length < MIN_REPORT_CHARS) return null;

  const dir = path.resolve(config.fileDir);
  await mkdir(dir, { recursive: true });

  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  const name = `${CASE_PREFIX}${hash}.md`;
  const existing = (await readdir(dir).catch(() => [] as string[])).filter(
    (entry) => entry.startsWith(CASE_PREFIX),
  );
  // Identical report already persisted — idempotent no-op.
  if (existing.includes(name)) return null;
  if (existing.length >= MAX_CASE_FILES) {
    console.warn(
      `[diagnostic-cases] case cap (${MAX_CASE_FILES}) reached; skipping persistence`,
    );
    return null;
  }

  const evidence = detail
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((item, i) => {
      const normalized = item.split(/\s+/).join(" ").trim();
      const summary =
        normalized.length <= EVIDENCE_SUMMARY_CHARS
          ? normalized
          : `${normalized.slice(0, EVIDENCE_SUMMARY_CHARS - 3)}...`;
      return `${i + 1}. ${summary}`;
    })
    .join("\n");

  const content = [
    "# AI Ops Diagnostic Case",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Evidence Summaries",
    "",
    evidence === "" ? "(none)" : evidence,
    "",
    "## Report",
    "",
    trimmed,
    "",
  ].join("\n");

  await writeFile(path.join(dir, name), content, "utf8");
  // Fixed classification (legacy source "aiops-diagnostic" → diagnostic-case):
  // the override pins it even if the hash-named file stops matching the
  // aiops-case- prefix heuristic.
  await buildKnowledgeIndex(path.join(dir, name), "diagnostic-case");
  // Structured case registry (legacy aiops_diagnostic_cases) backing the
  // case-library API; fire-and-forget — a registry failure must not discard
  // the case document itself.
  void upsertCaseRecord({
    hash,
    title: caseTitle(trimmed),
    alertName: alertName ?? "",
    summary: caseSummary(trimmed),
    fileName: name,
  }).catch((e) =>
    console.error("[diagnostic-cases] case record upsert failed:", e),
  );
  return name;
}

// First markdown heading, else the first non-empty line (legacy title rules).
export function caseTitle(report: string): string {
  for (const line of report.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
    if (heading) return (heading[1] ?? trimmed).slice(0, 200);
    return trimmed.slice(0, 200);
  }
  return "AI Ops case";
}

// 结论 section when present, else the first 300 chars (legacy summary field).
export function caseSummary(report: string): string {
  const lines = report.split("\n");
  const start = lines.findIndex((line) => /^##\s*结论/.test(line.trim()));
  const body = (start >= 0 ? lines.slice(start + 1).join("\n") : report).split(
    /^##\s/m,
  )[0] as string;
  const normalized = body.split(/\s+/).join(" ").trim();
  return normalized.length <= 300
    ? normalized
    : `${normalized.slice(0, 297)}...`;
}

async function upsertCaseRecord(row: {
  hash: string;
  title: string;
  alertName: string;
  summary: string;
  fileName: string;
}): Promise<void> {
  const { prisma } = await import("@/lib/db");
  await prisma.diagnosticCaseRecord.upsert({
    where: { hash: row.hash },
    create: row,
    update: {
      title: row.title,
      alertName: row.alertName,
      summary: row.summary,
      fileName: row.fileName,
    },
  });
}
