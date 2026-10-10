import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildRelations,
  computeImpact,
  extractCallSites,
  extractImportTargets,
  extractSymbols,
  impactForFiles,
  normalizeFilePath,
  planScan,
  rankSymbolMatches,
  rebuildCodeGraph,
  searchSymbols,
  type ScannedFile,
} from "@/lib/devflow/code-graph";

const PYTHON_FIXTURE = `import os
import re

from app.core.config import settings


def _read_text(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def _is_text_candidate(path):
    return path.endswith(settings.text_suffix)


def _symbol_matches(name, query):
    return query.lower() in name.lower()


def _list_files(repo_id):
    return os.listdir(repo_id)


def _index_symbols(text):
    return re.findall(r"def (\\w+)", text)


def _sync_code_graph(repo_id):
    for path in _list_files(repo_id):
        if not _is_text_candidate(path):
            continue
        text = _read_text(path)
        _index_symbols(text)


def _delete_stale(repo_id):
    return None


def purge_legacy_code_documents(repo_id):
    _delete_stale(repo_id)


def sync_repository_code_analysis(repo_id):
    purge_legacy_code_documents(repo_id)
    _sync_code_graph(repo_id)
`;
import {
  analysisStreamFrames,
  encodeSse,
  type AnalyzeStreamHooks,
  type SseFrame,
} from "@/lib/devflow/analyze-stream";

let checks = 0;
function check(label: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`ok - ${label}`);
}

const TS_FIXTURE = [
  'import path from "node:path";',
  'import { prisma } from "@/lib/db";',
  'const { readFile } = require("node:fs/promises");',
  "",
  "export interface SymbolRow {",
  "  name: string;",
  "}",
  "",
  "export class GraphBuilder {",
  "  build() {",
  "    return computeRegions();",
  "  }",
  "}",
  "",
  "export function computeRegions(text: string): number {",
  '  if (text === "") return computeRegions("x");',
  "  return helperFn(text.length);",
  "}",
  "",
  "const helperFn = (x) => x * 2;",
  "",
  'export type Mode = "a" | "b";',
  "",
].join("\n");

const PY_FIXTURE = [
  "from app.core.config import settings",
  "import os",
  "",
  "class Repo:",
  "    def save(self):",
  "        helper(os.getcwd())",
  "",
  "def helper(value):",
  "    return value",
  "",
].join("\n");

const GO_FIXTURE = [
  "package main",
  "",
  'import "fmt"',
  "",
  "type Server struct{}",
  "",
  "func (s *Server) Start() {",
  "    fmt.Println(NewServer())",
  "}",
  "",
  "func NewServer() *Server { return &Server{} }",
  "",
].join("\n");

check(
  "ts: symbol names, legacy-derived kinds and genericRegions line spans",
  () => {
    const symbols = extractSymbols(TS_FIXTURE, "src/graph.ts");
    const rows = symbols.map((s) => [s.name, s.kind, s.startLine, s.endLine]);
    assert.deepEqual(rows, [
      ["SymbolRow", "interface", 5, 8],
      ["GraphBuilder", "class", 9, 14],
      ["computeRegions", "function", 15, 19],
      ["helperFn", "function", 20, 21],
      ["Mode", "type", 22, 23],
    ]);
    assert.ok(symbols.every((s) => s.language === "ts"));
  },
);

check(
  "ts: imports cover import-from / require; calls attribute to enclosing region",
  () => {
    assert.deepEqual(extractImportTargets(TS_FIXTURE), [
      { target: "node:path", line: 1 },
      { target: "@/lib/db", line: 2 },
      { target: "node:fs/promises", line: 3 },
    ]);
    const symbols = extractSymbols(TS_FIXTURE, "src/graph.ts");
    const calls = extractCallSites(TS_FIXTURE, symbols);
    const edges = calls.map((c) => [c.name, c.line, c.enclosing] as const);
    assert.ok(
      edges.some(
        ([n, l, e]) =>
          n === "computeRegions" && l === 11 && e === "GraphBuilder",
      ),
    );
    assert.ok(
      edges.some(
        ([n, l, e]) =>
          n === "computeRegions" && l === 15 && e === "computeRegions",
      ),
    );
    assert.ok(
      edges.some(
        ([n, l, e]) => n === "helperFn" && l === 17 && e === "computeRegions",
      ),
    );
    assert.ok(edges.some(([n]) => n === "require"));
    assert.ok(!edges.some(([n]) => n === "if"));
  },
);

check("python: def/class symbols + from-import and bare import targets", () => {
  const symbols = extractSymbols(PY_FIXTURE, "app/repo.py");
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.startLine, s.endLine]),
    [
      ["Repo", "class", 4, 4],
      ["save", "function", 5, 7],
      ["helper", "function", 8, 10],
    ],
  );
  assert.ok(symbols.every((s) => s.language === "py"));
  assert.deepEqual(extractImportTargets(PY_FIXTURE), [
    { target: "app.core.config", line: 1 },
    { target: "os", line: 2 },
  ]);
});

check("go: func (with receiver) / type symbols + bare quoted import", () => {
  const symbols = extractSymbols(GO_FIXTURE, "cmd/main.go");
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.startLine]),
    [
      ["Server", "type", 5],
      ["Start", "function", 7],
      ["NewServer", "function", 11],
    ],
  );
  assert.deepEqual(extractImportTargets(GO_FIXTURE), [
    { target: "fmt", line: 3 },
  ]);
});

check("non-code and symbol-less files yield no symbols", () => {
  assert.deepEqual(extractSymbols(TS_FIXTURE, "notes.md"), []);
  assert.deepEqual(extractSymbols("just text\n", "src/plain.ts"), []);
});

check("buildRelations: defines + imports + known-symbol calls, deduped", () => {
  const tsSymbols = extractSymbols(TS_FIXTURE, "src/graph.ts");
  const file: ScannedFile = {
    path: "src/graph.ts",
    symbols: tsSymbols,
    imports: [
      ...extractImportTargets(TS_FIXTURE),
      { target: "node:path", line: 99 },
    ],
    calls: extractCallSites(TS_FIXTURE, tsSymbols),
  };
  const known = new Set(tsSymbols.map((s) => s.name));
  const relations = buildRelations([file], known);

  const defines = relations.filter((r) => r.type === "defines");
  assert.equal(defines.length, 5);
  assert.ok(defines.every((r) => r.sourceName === "src/graph.ts"));

  const imports = relations.filter((r) => r.type === "imports");
  assert.equal(imports.length, 3);
  assert.ok(imports.every((r) => r.sourceName === "src/graph.ts"));

  const calls = relations.filter((r) => r.type === "calls");
  const callKeys = calls.map((r) => `${r.sourceName}->${r.targetName}`);
  assert.deepEqual([...new Set(callKeys)].sort(), [
    "GraphBuilder->computeRegions",
    "computeRegions->computeRegions",
    "computeRegions->helperFn",
  ]);
  assert.equal(calls.length, 3);
  assert.ok(
    !calls.some((r) => r.targetName === "build" || r.targetName === "require"),
  );
});

check(
  "buildRelations: calls before the first symbol fall back to the file path (legacy source_name)",
  () => {
    const text = "main();\nexport function main() {}\n";
    const symbols = extractSymbols(text, "src/boot.ts");
    const calls = extractCallSites(text, symbols);
    const relations = buildRelations(
      [{ path: "src/boot.ts", symbols, imports: [], calls }],
      new Set(symbols.map((s) => s.name)),
    );
    const mainCalls = relations.filter(
      (r) => r.type === "calls" && r.targetName === "main",
    );
    assert.ok(mainCalls.some((r) => r.sourceName === "src/boot.ts"));
    assert.ok(mainCalls.some((r) => r.sourceName === "main"));
  },
);

check(
  "computeImpact: one-hop dependents, self/defines excluded, sameFile flagged",
  () => {
    const symbols = [
      { path: "a.ts", name: "Foo" },
      { path: "a.ts", name: "Bar" },
      { path: "b.ts", name: "useFoo" },
    ];
    const relations = [
      {
        sourceName: "useFoo",
        targetName: "Foo",
        type: "calls",
        path: "b.ts",
        meta: { line: 2 },
      },
      {
        sourceName: "Bar",
        targetName: "Foo",
        type: "calls",
        path: "a.ts",
        meta: { line: 5 },
      },
      { sourceName: "a.ts", targetName: "Foo", type: "defines", path: "a.ts" },
      { sourceName: "Foo", targetName: "Foo", type: "calls", path: "a.ts" },
      { sourceName: "c.ts", targetName: "./x", type: "imports", path: "c.ts" },
      {
        sourceName: "useFoo",
        targetName: "Foo",
        type: "calls",
        path: "b.ts",
        meta: { line: 9 },
      },
    ];
    const impact = computeImpact(["./a.ts"], symbols, relations);
    assert.deepEqual(
      impact.symbols.map((s) => s.name),
      ["Foo", "Bar"],
    );
    assert.deepEqual(
      impact.dependents.map((d) => [
        d.sourceName,
        d.targetName,
        d.type,
        d.sameFile,
        d.line,
      ]),
      [
        ["useFoo", "Foo", "calls", false, 2],
        ["Bar", "Foo", "calls", true, 5],
      ],
    );
  },
);

check("computeImpact: unknown files produce an empty closure", () => {
  const impact = computeImpact(["zzz.ts"], [{ path: "a.ts", name: "Foo" }], []);
  assert.deepEqual(impact.symbols, []);
  assert.deepEqual(impact.dependents, []);
});

check("planScan: truncates at the file cap", () => {
  const candidates = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
  const capped = planScan(candidates, 4);
  assert.deepEqual(capped.files, ["f0.ts", "f1.ts", "f2.ts", "f3.ts"]);
  assert.equal(capped.truncated, true);
  const uncapped = planScan(candidates, 50);
  assert.equal(uncapped.files.length, 10);
  assert.equal(uncapped.truncated, false);
});

check("normalizeFilePath: separators, leading ./ and /, trim", () => {
  assert.equal(normalizeFilePath("./lib/a.ts"), "lib/a.ts");
  assert.equal(normalizeFilePath("/lib/a.ts"), "lib/a.ts");
  assert.equal(normalizeFilePath("lib\\a.ts"), "lib/a.ts");
  assert.equal(normalizeFilePath("  lib/a.ts  "), "lib/a.ts");
});

check("rankSymbolMatches: prefix > name-contains > path-only", () => {
  const rows = [
    { name: "workspace", path: "lib/searchCode.ts" },
    { name: "mySearch", path: "lib/b.ts" },
    { name: "searchCode", path: "lib/a.ts" },
  ];
  const ranked = rankSymbolMatches(rows, "search");
  assert.deepEqual(
    ranked.map((r) => r.name),
    ["searchCode", "mySearch", "workspace"],
  );
  assert.deepEqual(
    rankSymbolMatches(rows, "").map((r) => r.name),
    ["workspace", "mySearch", "searchCode"],
  );
});

const realFileChecks = async (): Promise<void> => {
  const workspaceSrc = await readFile(
    path.join(process.cwd(), "lib/devflow/workspace.ts"),
    "utf8",
  );
  const symbols = extractSymbols(workspaceSrc, "lib/devflow/workspace.ts");
  const byName = new Map(symbols.map((s) => [s.name, s]));
  for (const expected of [
    "parseGitRemoteUrl",
    "repoCheckoutPath",
    "syncCheckout",
    "workspaceStatus",
    "removeRepoCheckout",
    "listFiles",
    "readCodeFile",
    "searchCode",
    "requireCheckout",
    "getRepoOrThrow",
  ]) {
    const found = byName.get(expected);
    assert.ok(found, `workspace.ts symbol ${expected} extracted`);
    assert.equal(found.kind, "function");
  }
  const errorClass = byName.get("WorkspaceError");
  assert.ok(errorClass);
  assert.equal(errorClass.kind, "class");
  const iface = byName.get("SyncResult");
  assert.ok(iface);
  assert.equal(iface.kind, "interface");
  const totalLines = workspaceSrc.split("\n").length;
  for (let i = 0; i < symbols.length; i += 1) {
    const symbol = symbols[i];
    assert.ok(symbol.startLine >= 1 && symbol.startLine <= symbol.endLine);
    assert.ok(symbol.endLine <= totalLines);
    if (i > 0) assert.ok(symbol.startLine > (symbols[i - 1]?.startLine ?? 0));
  }
  checks += 1;
  console.log(
    `ok - real file: lib/devflow/workspace.ts (${symbols.length} symbols)`,
  );

  const pySrc = PYTHON_FIXTURE;
  const pySymbols = extractSymbols(pySrc, "code_analysis.py");
  const pyNames = new Set(pySymbols.map((s) => s.name));
  for (const expected of [
    "_symbol_matches",
    "_sync_code_graph",
    "purge_legacy_code_documents",
    "sync_repository_code_analysis",
  ]) {
    assert.ok(
      pyNames.has(expected),
      `code_analysis.py symbol ${expected} extracted`,
    );
  }
  const pyCalls = extractCallSites(pySrc, pySymbols);
  const pyRelations = buildRelations(
    [
      {
        path: "code_analysis.py",
        symbols: pySymbols,
        imports: extractImportTargets(pySrc),
        calls: pyCalls,
      },
    ],
    pyNames,
  );
  const callEdges = new Set(
    pyRelations
      .filter((r) => r.type === "calls")
      .map((r) => `${r.sourceName}->${r.targetName}`),
  );
  assert.ok(callEdges.has("_sync_code_graph->_read_text"));
  assert.ok(callEdges.has("_sync_code_graph->_is_text_candidate"));
  const pyImports = pyRelations
    .filter((r) => r.type === "imports")
    .map((r) => r.targetName);
  assert.ok(pyImports.includes("os"));
  assert.ok(pyImports.includes("app.core.config"));
  checks += 1;
  console.log(
    `ok - python fixture: code_analysis shape (${pySymbols.length} symbols, ${pyRelations.length} relations)`,
  );
};

async function collect(
  hooks: AnalyzeStreamHooks<{ generationMode?: string }>,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of analysisStreamFrames(hooks)) frames.push(frame);
  return frames;
}

const baseHooks = {
  contextDetail: "ctx-detail",
  rulesDetail: "rules-detail",
  llmDetail: (mode: string) => `llm:${mode}`,
  mergeDetail: (record: { id: string }) => `merge:${record.id}`,
};

const sseChecks = async (): Promise<void> => {
  check(
    "encodeSse: id/event/data framing, one data: line per text line",
    () => {
      const single = encodeSse("trace", '{"stage":"context"}');
      assert.match(
        single,
        /^id: \d+\nevent: trace\ndata: \{"stage":"context"\}\n\n$/,
      );
      const multi = encodeSse("message", "line1\nline2");
      assert.match(
        multi,
        /^id: \d+\nevent: message\ndata: line1\ndata: line2\n\n$/,
      );
    },
  );

  const okFrames = await collect({
    ...baseHooks,
    run: async () => ({
      id: "a1",
      result: { generationMode: "llm" as const },
      createdAt: new Date(0),
    }),
  });
  check(
    "stream: trace(context) → trace(rules) → trace(llm) → trace(merge) → result → done",
    () => {
      assert.deepEqual(
        okFrames.map((f) => f.event),
        ["trace", "trace", "trace", "trace", "result", "done"],
      );
      const traces = okFrames
        .slice(0, 4)
        .map((f) => JSON.parse(f.data) as { stage: string; detail: string });
      assert.deepEqual(
        traces.map((t) => t.stage),
        ["context", "rules", "llm", "merge"],
      );
      assert.equal(traces[0]?.detail, "ctx-detail");
      assert.equal(traces[1]?.detail, "rules-detail");
      assert.equal(traces[2]?.detail, "llm:llm");
      assert.equal(traces[3]?.detail, "merge:a1");
      const result = JSON.parse(okFrames[4]?.data ?? "") as {
        id: string;
        createdAt: string;
      };
      assert.equal(result.id, "a1");
      assert.equal(result.createdAt, "1970-01-01T00:00:00.000Z");
      assert.deepEqual(JSON.parse(okFrames[5]?.data ?? ""), { id: "a1" });
    },
  );

  const deterministicFrames = await collect({
    ...baseHooks,
    run: async () => ({ id: "a2", result: {}, createdAt: new Date(0) }),
  });
  check(
    "stream: missing generationMode defaults to deterministic in the llm trace",
    () => {
      const llmTrace = JSON.parse(deterministicFrames[2]?.data ?? "") as {
        detail: string;
      };
      assert.equal(llmTrace.detail, "llm:deterministic");
    },
  );

  const errorFrames = await collect({
    ...baseHooks,
    run: async () => {
      throw new Error("boom");
    },
  });
  check("stream: run failure emits error and no result/done", () => {
    assert.deepEqual(
      errorFrames.map((f) => f.event),
      ["trace", "trace", "error"],
    );
    assert.deepEqual(JSON.parse(errorFrames[2]?.data ?? ""), {
      message: "boom",
    });
  });
};

async function live(): Promise<void> {
  const { prisma } = await import("@/lib/db");
  const stamp = Date.now();
  const libDir = path.join(process.cwd(), "lib");
  const repo = await prisma.repository.create({
    data: {
      owner: "smoke-code-graph",
      name: `live-${stamp}`,
      fullName: `smoke-code-graph/live-${stamp}`,
      checkoutMode: "local",
      localPath: libDir,
      defaultBranch: "main",
    },
  });
  try {
    const summary = await rebuildCodeGraph(repo.id);
    assert.ok(summary.filesScanned > 0, "live: files scanned");
    assert.ok(summary.symbolCount > 0, "live: symbols written");
    assert.ok(
      summary.relationCount >= summary.symbolCount,
      "live: relations >= symbols",
    );
    assert.ok(summary.branch.length > 0, "live: branch resolved");

    const rows = await prisma.codeSymbol.findMany({
      where: { repoId: repo.id },
      take: 5,
      orderBy: { createdAt: "asc" },
    });
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.prNumber, null);
      assert.equal(row.branch, summary.branch);
      assert.ok(row.path.length > 0 && row.name.length > 0);
    }
    const relationCount = await prisma.codeRelation.count({
      where: { repoId: repo.id },
    });
    assert.equal(relationCount, summary.relationCount);

    const found = await searchSymbols(repo.id, { query: "rebuildCodeGraph" });
    assert.ok(
      found.some(
        (s) =>
          s.name === "rebuildCodeGraph" && s.path === "devflow/code-graph.ts",
      ),
      "live: searchSymbols finds rebuildCodeGraph (prefix-ranked)",
    );
    assert.equal(found[0]?.name, "rebuildCodeGraph");

    const impact = await impactForFiles(repo.id, ["devflow/code-graph.ts"]);
    assert.ok(
      impact.symbols.some((s) => s.name === "rebuildCodeGraph"),
      "live: impact lists symbols of the changed file",
    );

    const summary2 = await rebuildCodeGraph(repo.id);
    assert.equal(summary2.symbolCount, summary.symbolCount);
    const countAfter = await prisma.codeSymbol.count({
      where: { repoId: repo.id },
    });
    assert.equal(countAfter, summary.symbolCount);
    checks += 1;
    console.log(
      `ok - live: rebuild wrote ${summary.symbolCount} symbols / ${summary.relationCount} relations across ${summary.filesScanned} files (branch ${summary.branch})`,
    );
  } finally {
    await prisma.codeRelation.deleteMany({ where: { repoId: repo.id } });
    await prisma.codeSymbol.deleteMany({ where: { repoId: repo.id } });
    await prisma.repository.delete({ where: { id: repo.id } });
  }
}

async function main(): Promise<void> {
  await realFileChecks();
  await sseChecks();
  if (process.env.CODE_GRAPH_SMOKE_LIVE === "1") {
    console.log("code-graph smoke: LIVE section (PostgreSQL)");
    await live();
  } else {
    console.log("  LIVE section skipped (set CODE_GRAPH_SMOKE_LIVE=1)");
  }
  console.log(`DEVFLOW-CODE-GRAPH SMOKE OK (${checks} checks)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("SMOKE FAILED:", e);
    process.exit(1);
  });
