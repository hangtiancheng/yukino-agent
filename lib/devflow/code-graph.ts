// DevFlow code graph: regex symbol extraction + imports/calls/defines
// relations computed from a repository's checkout, persisted into
// CodeSymbol / CodeRelation (prNumber=null = the default checkout scan),
// plus symbol search and one-hop change-impact queries for PR/CI analysis
// context.
//
// Legacy ports (DevFlow-AI/backend):
//  - app/services/code_analysis.py — _symbol_matches (PY_SYMBOL_RE /
//    TS_SYMBOL_RE), _sync_code_graph (IMPORT_RE / CALL_RE relation
//    extraction, delete-then-insert rebuild keyed by repo+branch+pr scope).
//  - app/api/routes/code_graph.py:18-72 — rebuild_code_graph +
//    search_code_graph endpoints.
//  - app/api/routes/pull_requests.py:269-308 (_pr_code_graph_impact) and
//    app/api/routes/ci.py:231-270 (_ci_code_graph_impact) — changed-files →
//    symbols + surrounding relations; this port narrows to one-hop
//    dependents (task spec).
//  - Symbol regions follow the genericRegions approach of
//    lib/devflow/chunking.ts (line scan for declaration starts, region end =
//    next start - 1) with that file's per-language pattern set, refined with
//    legacy code_analysis.py kind derivation for TS-family declarations.
//
// Documented divergences from legacy (each annotated at the site):
//  - single scan pass instead of legacy's two passes (symbols first, then a
//    full re-scan for relations); the scan budget applies to files read.
//  - calls keep only KNOWN symbol targets (task spec; legacy persisted every
//    callee with an unresolved target_symbol_id).
//  - call attribution uses the enclosing region instead of legacy's "first
//    symbol of the file"; import alternation order fixed so
//    `import a from "mod"` records "mod" (legacy recorded the binding "a").
//  - defines relations (file → symbol) are new (task spec).
import path from "node:path";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import type { CodeSymbol } from "@/generated/prisma/client";
import {
  getRepoOrThrow,
  listFiles,
  readCodeFile,
  requireCheckout,
  workspaceStatus,
} from "./workspace";

// ---------------------------------------------------------------------------
// Symbol extraction (chunking.ts genericRegions approach + legacy kinds)
// ---------------------------------------------------------------------------

interface SymbolPattern {
  // Must capture the symbol name in group 1; never carry the /g flag
  // (executed once per line).
  pattern: RegExp;
  kind?: string;
  // Legacy code_analysis.py _symbol_matches derived TS-family kinds from the
  // matched declaration text; patterns that need it supply this instead of a
  // static kind.
  kindOf?: (match: RegExpExecArray) => string;
}

// chunking.ts genericRegions only records start lines; the code graph also
// needs the region end, computed the same way (next start - 1 / EOF).
export interface ExtractedSymbol {
  name: string;
  kind: string;
  language: string;
  startLine: number;
  endLine: number;
}

function kindFromDeclaration(declaration: string): string {
  // legacy code_analysis.py:259-261 kind derivation; "enum" added alongside
  // the chunking.ts pattern coverage.
  if (/\bclass\b/.test(declaration)) return "class";
  if (/\binterface\b/.test(declaration)) return "interface";
  if (/\btype\b/.test(declaration)) return "type";
  if (/\benum\b/.test(declaration)) return "enum";
  return "function";
}

// Port of chunking.ts patternsForSuffix (private there) with kinds refined
// per legacy code_analysis.py: TS declarations get class/interface/type/enum/
// function, Go func/type split, Rust fn vs struct/enum/trait vs impl.
function patternsForSuffix(suffix: string): SymbolPattern[] {
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(suffix)) {
    return [
      {
        pattern:
          /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
        kindOf: (match) => kindFromDeclaration(match[0]),
      },
      {
        pattern:
          /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
        kind: "function",
      },
    ];
  }
  if (suffix === ".go") {
    return [
      {
        pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
        kind: "function",
      },
      { pattern: /^\s*type\s+([A-Za-z_]\w*)/, kind: "type" },
    ];
  }
  if (suffix === ".rs") {
    return [
      {
        pattern:
          /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
        kind: "function",
      },
      {
        pattern:
          /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
        kind: "type",
      },
      {
        pattern:
          /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([\w:]+)/,
        kind: "impl",
      },
    ];
  }
  if (
    [
      ".java",
      ".kt",
      ".kts",
      ".cs",
      ".cpp",
      ".c",
      ".h",
      ".hpp",
      ".php",
      ".rb",
      ".swift",
      ".scala",
    ].includes(suffix)
  ) {
    return [
      {
        pattern:
          /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open)\s+)*(?:class|interface|enum|struct|trait|record)\s+([A-Za-z_]\w*)/,
        kind: "type",
      },
    ];
  }
  if (suffix === ".sql") {
    return [
      {
        pattern:
          /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|TABLE|VIEW)\s+([\w.]+)/i,
        kind: "sql_object",
      },
    ];
  }
  if ([".sh", ".bash", ".zsh", ".ps1"].includes(suffix)) {
    return [
      {
        pattern: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*(?:\(\))?\s*\{/,
        kind: "function",
      },
    ];
  }
  if (suffix === ".py") {
    // Regex stand-in for the legacy CPython `ast` scan, mirroring
    // chunking.ts: top-level-ish def/class lines.
    return [
      { pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
      { pattern: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
    ];
  }
  return [];
}

function suffixOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

// chunking.ts languageForPath / legacy code_analysis.py _language_for.
function languageForPath(filePath: string): string {
  const suffix = suffixOf(filePath).replace(/^\./, "");
  if (suffix) return suffix;
  return (filePath.split(/[\\/]/).pop() ?? filePath).toLowerCase();
}

const CODE_SUFFIXES = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".php",
  ".rb",
  ".swift",
  ".scala",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
]);

export function isCodeFile(filePath: string): boolean {
  return CODE_SUFFIXES.has(suffixOf(filePath));
}

// genericRegions approach: collect declaration starts line by line, each
// region ends one line before the next start (EOF for the last). Files
// without symbols yield no rows — legacy _sync_code_graph skipped them too.
export function extractSymbols(
  text: string,
  filePath: string,
): ExtractedSymbol[] {
  const patterns = patternsForSuffix(suffixOf(filePath));
  if (patterns.length === 0) return [];
  const lines = text.split("\n");
  const starts: Array<{ line: number; name: string; kind: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const { pattern, kind, kindOf } of patterns) {
      const match = pattern.exec(line);
      if (!match || !match[1]) continue;
      starts.push({
        line: i + 1,
        name: match[1],
        kind: kindOf ? kindOf(match) : (kind ?? "symbol"),
      });
      break;
    }
  }
  if (starts.length === 0) return [];
  const language = languageForPath(filePath);
  return starts.map((start, index) => {
    const next = starts[index + 1];
    return {
      name: start.name,
      kind: start.kind,
      language,
      startLine: start.line,
      endLine: next ? next.line - 1 : lines.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Relation extraction (legacy code_analysis.py IMPORT_RE / CALL_RE)
// ---------------------------------------------------------------------------

// legacy code_analysis.py IMPORT_RE (`from X import` / `import X` /
// `import ... from "X"`), extended per task spec with bare side-effect / Go
// imports (`import "X"`) and CommonJS `require("X")`. Divergence: the
// alternation order is fixed so `import a from "mod"` records "mod" —
// legacy tried the bare `import X` branch first and recorded the local
// binding name.
const IMPORT_RE =
  /^\s*(?:import\s+[^\n;]*?\sfrom\s+["']([^"']+)["']|import\s+["']([^"']+)["']|from\s+([\w./@-]+)\s+import\b|import\s+([\w./@-]+)\b|(?:const|let|var)\s+[^\n=]+=\s*require\(\s*["']([^"']+)["']\s*\))/;

// legacy code_analysis.py CALL_RE.
const CALL_RE = /\b([A-Za-z_][$A-Za-z0-9_]*)\s*\(/g;

// legacy skip set {if,for,while,return,print,len,str,int} extended with
// JS/TS/Go keywords that syntactically precede "(".
const CALL_NOISE = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "typeof",
  "await",
  "yield",
  "throw",
  "else",
  "do",
  "case",
  "new",
  "print",
  "len",
  "str",
  "int",
]);

export interface ExtractedImport {
  target: string;
  line: number;
}

export interface ExtractedCallSite {
  name: string;
  line: number;
  // Enclosing region's symbol name; null when the call sits before the first
  // declaration (legacy used the file path as the source there).
  enclosing: string | null;
}

export function extractImportTargets(text: string): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = IMPORT_RE.exec(lines[i] ?? "");
    if (!match) continue;
    const target = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
    if (target) out.push({ target, line: i + 1 });
  }
  return out;
}

function enclosingSymbol(
  symbols: ExtractedSymbol[],
  line: number,
): string | null {
  for (const symbol of symbols) {
    if (symbol.startLine > line) break;
    if (symbol.startLine <= line && line <= symbol.endLine) return symbol.name;
  }
  return null;
}

// Divergence from legacy: the call regex is applied line by line (so the
// enclosing region can be attributed); legacy ran it over the whole text,
// which additionally matched `name\n(` across a newline — a rare form this
// port does not capture.
export function extractCallSites(
  text: string,
  symbols: ExtractedSymbol[],
): ExtractedCallSite[] {
  const out: ExtractedCallSite[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const match of line.matchAll(CALL_RE)) {
      const name = match[1];
      if (!name || CALL_NOISE.has(name)) continue;
      out.push({
        name,
        line: i + 1,
        enclosing: enclosingSymbol(symbols, i + 1),
      });
    }
  }
  return out;
}

export interface ScannedFile {
  path: string;
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCallSite[];
}

export interface ExtractedRelation {
  sourceName: string;
  targetName: string;
  type: "imports" | "calls" | "defines";
  path: string;
  line: number;
}

export function buildRelations(
  files: ScannedFile[],
  knownSymbolNames: ReadonlySet<string>,
): ExtractedRelation[] {
  const out: ExtractedRelation[] = [];
  const seen = new Set<string>();
  const push = (relation: ExtractedRelation): void => {
    // legacy deduped calls per (file, callee) via seen_calls; this dedupe is
    // keyed by (type, path, source, target) so repeated imports collapse too.
    const key = `${relation.type}\u001f${relation.path}\u001f${relation.sourceName}\u001f${relation.targetName}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(relation);
  };
  for (const file of files) {
    // defines: file → symbol (task spec; legacy had no defines edges).
    for (const symbol of file.symbols) {
      push({
        sourceName: file.path,
        targetName: symbol.name,
        type: "defines",
        path: file.path,
        line: symbol.startLine,
      });
    }
    for (const imp of file.imports) {
      push({
        sourceName: file.path,
        targetName: imp.target,
        type: "imports",
        path: file.path,
        line: imp.line,
      });
    }
    // calls: a KNOWN symbol name appearing inside a symbol body (task spec;
    // legacy wrote every callee, leaving unresolved targets with
    // target_symbol_id=None). Enclosing-region attribution replaces legacy's
    // "first local symbol is the source" shortcut.
    for (const call of file.calls) {
      if (!knownSymbolNames.has(call.name)) continue;
      push({
        sourceName: call.enclosing ?? file.path,
        targetName: call.name,
        type: "calls",
        path: file.path,
        line: call.line,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rebuild orchestration (legacy code_analysis.py _sync_code_graph)
// ---------------------------------------------------------------------------

// workspace.ts listFiles() clamps its limit at 1000 entries; rebuild passes
// the cap explicitly so both bounds are visible here.
const LIST_ENTRIES_CAP = 1000;

// Pure scan-budget decision (legacy counted symbol-bearing files; this port
// counts code files read, matching how workspace.ts searchCode budgets
// maxScanFiles).
export function planScan(
  candidates: string[],
  maxFiles: number,
): { files: string[]; truncated: boolean } {
  return {
    files: candidates.slice(0, maxFiles),
    truncated: candidates.length > maxFiles,
  };
}

export interface RebuildSummary {
  branch: string;
  commitSha: string | null;
  filesScanned: number;
  symbolCount: number;
  relationCount: number;
  truncated: boolean;
}

// legacy code_analysis.py _sync_code_graph + sync_repository_code_analysis:
// delete the repo+branch snapshot rows, re-extract from the checkout, insert.
// prNumber=null marks the default checkout scan (legacy used pr_id/pr_number
// for PR worktree snapshots, intentionally not migrated).
export async function rebuildCodeGraph(
  repoId: string,
): Promise<RebuildSummary> {
  const repo = await getRepoOrThrow(repoId);
  const checkout = await requireCheckout(repo);
  const status = await workspaceStatus(repo);
  // branch comes from workspaceStatus; fall back like legacy
  // (default_branch, then "main") when HEAD is detached.
  const branch = status.branch ?? repo.defaultBranch ?? "main";

  const entries = await listFiles(checkout, ".", LIST_ENTRIES_CAP);
  const listingTruncated = entries.length >= LIST_ENTRIES_CAP;
  const candidates = entries
    .filter((entry) => entry.type === "file" && isCodeFile(entry.path))
    .map((entry) => entry.path);
  const plan = planScan(candidates, config.devflow.workspace.maxScanFiles);

  const scanned: ScannedFile[] = [];
  for (const relPath of plan.files) {
    let text: string;
    try {
      text = (await readCodeFile(checkout, relPath)).content;
    } catch {
      // unreadable (binary/too large/secret) — legacy _read_text returned
      // None and skipped.
      continue;
    }
    const symbols = extractSymbols(text, relPath);
    scanned.push({
      path: relPath,
      symbols,
      imports: extractImportTargets(text),
      calls: extractCallSites(text, symbols),
    });
  }

  const knownSymbolNames = new Set(
    scanned.flatMap((file) => file.symbols.map((s) => s.name)),
  );
  const relations = buildRelations(scanned, knownSymbolNames);

  const symbolRows = scanned.flatMap((file) =>
    file.symbols.map((symbol) => ({
      repoId,
      path: file.path,
      name: symbol.name,
      kind: symbol.kind,
      language: symbol.language,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      branch,
      commitSha: status.commitSha,
      prNumber: null,
    })),
  );
  const relationRows = relations.map((relation) => ({
    repoId,
    sourceName: relation.sourceName,
    targetName: relation.targetName,
    type: relation.type,
    path: relation.path,
    branch,
    prNumber: null,
    meta: { line: relation.line },
  }));

  await prisma.$transaction(async (tx) => {
    await tx.codeSymbol.deleteMany({
      where: { repoId, branch, prNumber: null },
    });
    await tx.codeRelation.deleteMany({
      where: { repoId, branch, prNumber: null },
    });
    if (symbolRows.length > 0)
      await tx.codeSymbol.createMany({ data: symbolRows });
    if (relationRows.length > 0) {
      await tx.codeRelation.createMany({ data: relationRows });
    }
  });

  return {
    branch,
    commitSha: status.commitSha,
    filesScanned: scanned.length,
    symbolCount: symbolRows.length,
    relationCount: relationRows.length,
    truncated: plan.truncated || listingTruncated,
  };
}

// ---------------------------------------------------------------------------
// Symbol search (legacy code_graph.py search_code_graph)
// ---------------------------------------------------------------------------

export interface SymbolSearchFilters {
  query?: string;
  kind?: string;
  language?: string;
  path?: string;
  limit?: number;
}

// Pure ranking: prefix matches first, then name containment, then path-only
// hits (task spec "前缀/包含").
export function rankSymbolMatches<T extends { name: string; path: string }>(
  rows: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const score = (row: T): number => {
    const name = row.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return 2;
  };
  return [...rows].sort(
    (a, b) => score(a) - score(b) || a.path.localeCompare(b.path),
  );
}

export async function searchSymbols(
  repoId: string,
  filters: SymbolSearchFilters = {},
): Promise<CodeSymbol[]> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const query = filters.query?.trim() ?? "";
  // Over-fetch so prefix matches can be ranked to the front after the
  // DB-level contains filter.
  const rows = await prisma.codeSymbol.findMany({
    where: {
      repoId,
      prNumber: null,
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.language ? { language: filters.language } : {}),
      ...(filters.path ? { path: { contains: filters.path } } : {}),
      ...(query
        ? { OR: [{ name: { contains: query } }, { path: { contains: query } }] }
        : {}),
    },
    orderBy: [{ path: "asc" }, { startLine: "asc" }],
    take: limit * 2,
  });
  return rankSymbolMatches(rows, query).slice(0, limit);
}

// ---------------------------------------------------------------------------
// One-hop change impact (legacy _pr_code_graph_impact / _ci_code_graph_impact,
// narrowed to dependents per task spec)
// ---------------------------------------------------------------------------

export function normalizeFilePath(filePath: string): string {
  return filePath
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

const MetaLineSchema = z.object({ line: z.number() });

function metaLine(meta: unknown): number | null {
  const parsed = MetaLineSchema.safeParse(meta);
  return parsed.success ? parsed.data.line : null;
}

export interface ImpactDependent {
  path: string | null;
  sourceName: string | null;
  targetName: string;
  type: string;
  line: number | null;
  sameFile: boolean;
}

// Pure one-hop closure: symbols defined in the changed files, plus the
// relations that depend on those symbols (calls/imports/references with the
// changed symbol as target — legacy additionally surfaced the changed
// symbols' own outgoing edges and intra-file rows; this port keeps only
// dependents and flags same-file rows).
export function computeImpact<TSymbol extends { path: string; name: string }>(
  files: string[],
  symbols: TSymbol[],
  relations: Array<{
    sourceName: string | null;
    targetName: string;
    type: string;
    path: string | null;
    meta?: unknown;
  }>,
): { symbols: TSymbol[]; dependents: ImpactDependent[] } {
  const changed = new Set(files.map(normalizeFilePath));
  const changedSymbols = symbols.filter((symbol) =>
    changed.has(normalizeFilePath(symbol.path)),
  );
  const names = new Set(changedSymbols.map((symbol) => symbol.name));
  const dependents: ImpactDependent[] = [];
  const seen = new Set<string>();
  for (const relation of relations) {
    if (relation.type === "defines") continue;
    if (!names.has(relation.targetName)) continue;
    if (relation.sourceName === relation.targetName) continue;
    const key = `${relation.type}\u001f${relation.path ?? ""}\u001f${relation.sourceName ?? ""}\u001f${relation.targetName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dependents.push({
      path: relation.path,
      sourceName: relation.sourceName,
      targetName: relation.targetName,
      type: relation.type,
      line: metaLine(relation.meta),
      sameFile:
        relation.path !== null && changed.has(normalizeFilePath(relation.path)),
    });
  }
  dependents.sort(
    (a, b) =>
      Number(a.sameFile) - Number(b.sameFile) ||
      (a.path ?? "").localeCompare(b.path ?? "") ||
      (a.sourceName ?? "").localeCompare(b.sourceName ?? ""),
  );
  return { symbols: changedSymbols, dependents };
}

export interface ImpactReport {
  files: string[];
  symbols: CodeSymbol[];
  dependents: ImpactDependent[];
}

const IMPACT_MAX_FILES = 50;
const IMPACT_RELATION_CAP = 1000;

export async function impactForFiles(
  repoId: string,
  files: string[],
): Promise<ImpactReport> {
  const normalized = [
    ...new Set(files.map(normalizeFilePath).filter(Boolean)),
  ].slice(0, IMPACT_MAX_FILES);
  if (normalized.length === 0)
    return { files: [], symbols: [], dependents: [] };
  const symbols = await prisma.codeSymbol.findMany({
    where: { repoId, prNumber: null, path: { in: normalized } },
    orderBy: [{ path: "asc" }, { startLine: "asc" }],
  });
  if (symbols.length === 0) {
    return { files: normalized, symbols: [], dependents: [] };
  }
  const names = [...new Set(symbols.map((symbol) => symbol.name))];
  const relations = await prisma.codeRelation.findMany({
    where: {
      repoId,
      prNumber: null,
      type: { in: ["calls", "imports", "references"] },
      targetName: { in: names },
    },
    take: IMPACT_RELATION_CAP,
  });
  return {
    files: normalized,
    ...computeImpact(normalized, symbols, relations),
  };
}
