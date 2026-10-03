// Milvus Standalone client (official Node SDK, gRPC :19530), modelled on the
// proven yukino-agent2 implementation. Replaces the former Redis Stack
// (RediSearch) vector index.
//
// The collection carries BOTH vector paths — dense (COSINE) and a native BM25
// full-text path where the `content` field (analyzer-enabled) feeds a BM25
// Function that populates the `sparse` field. BM25 search and dense+BM25
// hybrid search (RRF fusion) therefore run inside Milvus, not in-process.
//
// Semantics preserved from the Redis implementation: the collection is created
// lazily with the dimension inferred from the first embedding (model-agnostic,
// never hardcoded), an existing collection with a mismatched dimension is
// dropped and recreated, a missing collection reads as empty, and every
// failure throws so callers surface a down Milvus instead of silently
// degrading.
import {
  DataType,
  ErrorCode,
  FunctionType,
  MilvusClient,
  RANKER_TYPE,
  type HybridSearchReq,
  type ResStatus,
  type SearchSimpleReq,
  type SearchResultData,
} from "@zilliz/milvus2-sdk-node";
import { config } from "@/lib/config";

const COLLECTION = config.milvus.collection;
const TIMEOUT_MS = 15_000;
// Milvus 3.x only returns the primary key when it is listed explicitly, so
// "id" rides along.
const OUTPUT_FIELDS = ["id", "content", "source", "metadata", "created_at"];
// RRF smoothing constant; matches the RRFRanker() default (k=60).
const RRF_K = 60;
// Storage cap carried over from the old Redis schema (VarChar max_length).
export const MAX_CONTENT_LENGTH = 8192;

// A chunk row upserted into Milvus. `vector` is supplied by the caller, while
// `sparse` is derived server-side by the BM25 Function from `content`, so
// upserts never set it.
export interface MilvusRow {
  id: string;
  vector: number[];
  content: string;
  source: string;
  metadata: string;
  created_at: string;
}

// A search hit. `score` is the Milvus distance: COSINE similarity for dense,
// BM25 relevance for sparse, fused RRF value for hybrid — higher is better.
export interface MilvusHit {
  id: string;
  score: number;
  content: string;
  source: string;
  metadata: string;
  created_at: string;
}

// --- connection (lazy singleton) ---
let cachedClient: MilvusClient | null = null;
// True once the collection has been loaded into memory in this process; reset by drop().
let ready = false;
// Dimension the in-process collection was verified/created with; a different
// incoming dim triggers the drop-and-recreate path.
let readyDim = 0;

function connect(): MilvusClient {
  if (cachedClient !== null) {
    return cachedClient;
  }
  const address = config.milvus.uri.replace(/^https?:\/\//, "");
  const clientConfig: ConstructorParameters<typeof MilvusClient>[0] = {
    address,
    timeout: TIMEOUT_MS,
    // Keep the SDK's own winston output out of the way.
    logLevel: "warn",
  };
  if (config.milvus.token !== "") {
    clientConfig.token = config.milvus.token;
  }
  cachedClient = new MilvusClient(clientConfig);
  // The SDK fires a background Connect RPC during construction; when Milvus is
  // down that promise rejects with no handler attached, which Node treats as
  // fatal. Awaited calls surface the same error through their own promises,
  // so swallowing the background copy is safe.
  cachedClient.connectPromise.catch(() => undefined);
  return cachedClient;
}

// Close the underlying gRPC connections (scripts use this to let the process exit).
export async function close(): Promise<void> {
  if (cachedClient !== null) {
    await cachedClient.closeConnection();
    cachedClient = null;
    ready = false;
    readyDim = 0;
  }
}

// The SDK reports logical failures in-band; anything not Success must throw so
// callers never mistake an error response for an empty result.
function isSuccess(res: ResStatus | { status: ResStatus }): boolean {
  const status = "status" in res ? res.status : res;
  const code = status.error_code;
  return code === ErrorCode.SUCCESS || code === 0 || code === "0";
}

function checkStatus(res: ResStatus | { status: ResStatus }, op: string): void {
  if (!isSuccess(res)) {
    const status = "status" in res ? res.status : res;
    throw new Error(
      `milvus ${op} failed: ${status.reason || String(status.error_code)}`,
    );
  }
}

// Milvus boolean-expr string literal; values come from user data but are
// escaped anyway so a quote can never break out of the filter.
export function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function toHits(results: SearchResultData[]): MilvusHit[] {
  return results.map((hit) => ({
    id: String(hit.id ?? ""),
    score: hit.score,
    content: String(hit.content ?? ""),
    source: String(hit.source ?? ""),
    metadata: String(hit.metadata ?? ""),
    created_at: String(hit.created_at ?? ""),
  }));
}

async function hasCollection(): Promise<boolean> {
  const res = await connect().hasCollection({
    collection_name: COLLECTION,
    timeout: TIMEOUT_MS,
  });
  checkStatus(res, "hasCollection");
  return Boolean(res.value);
}

// Read the stored dense dimension; 0 when the collection/field is missing.
async function storedDim(): Promise<number> {
  const res = await connect().describeCollection({
    collection_name: COLLECTION,
    timeout: TIMEOUT_MS,
  });
  checkStatus(res, "describeCollection");
  const vectorField = res.schema.fields.find((f) => f.name === "vector");
  const dim = Number(
    vectorField?.type_params?.find?.((p) => p.key === "dim")?.value ?? 0,
  );
  return Number.isFinite(dim) ? dim : 0;
}

// Load the collection into memory (idempotent server-side; the `ready` flag
// skips the redundant round-trip within this process).
async function loadCollection(): Promise<void> {
  if (ready) {
    return;
  }
  const loaded = await connect().loadCollection({
    collection_name: COLLECTION,
    timeout: TIMEOUT_MS,
  });
  checkStatus(loaded, "loadCollection");
  ready = true;
}

// Idempotent create with a model-agnostic dimension inferred from the first
// embedded vector. Strong consistency keeps post-write reads deterministic.
// An existing collection whose dense dim differs from the active embedding
// model is dropped and recreated — old vectors are useless after a dimension
// change and startup re-indexing repopulates the data (same policy as the
// former Redis index).
export async function ensureCollection(dim: number): Promise<void> {
  const client = connect();
  if (await hasCollection()) {
    const existing = await storedDim();
    if (existing && existing !== dim) {
      console.warn(
        `[milvus] Collection dimension mismatch: stored=${existing}, actual=${dim}. ` +
          "Dropping and recreating collection.",
      );
      await drop();
    } else {
      await loadCollection();
      readyDim = dim;
      return;
    }
  }
  const created = await client.createCollection({
    collection_name: COLLECTION,
    consistency_level: "Strong",
    fields: [
      {
        name: "id",
        data_type: DataType.VarChar,
        is_primary_key: true,
        max_length: 512,
      },
      { name: "vector", data_type: DataType.FloatVector, dim },
      // BM25 Function input. The analyzer matches the corpus language;
      // "standard" (default) also tokenizes CJK as unigrams, "chinese" uses
      // jieba for mixed CN/EN corpora.
      {
        name: "content",
        data_type: DataType.VarChar,
        max_length: MAX_CONTENT_LENGTH,
        enable_analyzer: true,
        analyzer_params: { type: config.milvus.analyzer },
      },
      // BM25 Function output: derived from `content` server-side, never
      // written by upserts.
      {
        name: "sparse",
        data_type: DataType.SparseFloatVector,
        is_function_output: true,
      },
      { name: "source", data_type: DataType.VarChar, max_length: 512 },
      { name: "metadata", data_type: DataType.VarChar, max_length: 16384 },
      { name: "created_at", data_type: DataType.VarChar, max_length: 40 },
    ],
    functions: [
      {
        name: "content_bm25",
        type: FunctionType.BM25,
        input_field_names: ["content"],
        output_field_names: ["sparse"],
        params: {},
      },
    ],
    timeout: TIMEOUT_MS,
  });
  if (!isSuccess(created) && !(await hasCollection())) {
    checkStatus(created, "createCollection");
  }
  const denseIndexed = await client.createIndex({
    collection_name: COLLECTION,
    field_name: "vector",
    index_type: "AUTOINDEX",
    metric_type: "COSINE",
    timeout: TIMEOUT_MS,
  });
  const sparseIndexed = await client.createIndex({
    collection_name: COLLECTION,
    field_name: "sparse",
    index_type: "SPARSE_INVERTED_INDEX",
    metric_type: "BM25",
    timeout: TIMEOUT_MS,
  });
  const loaded = await client.loadCollection({
    collection_name: COLLECTION,
    timeout: TIMEOUT_MS,
  });
  // Load needs both indexes: when it fails, report the first index that failed.
  if (!isSuccess(loaded)) {
    checkStatus(denseIndexed, "createIndex(vector)");
    checkStatus(sparseIndexed, "createIndex(sparse)");
  }
  checkStatus(loaded, "loadCollection");
  ready = true;
  readyDim = dim;
}

// Returns false when the collection does not exist (reads answer empty);
// otherwise makes sure it is loaded before search/query/delete/flush.
async function ensureLoaded(): Promise<boolean> {
  if (!(await hasCollection())) {
    ready = false;
    readyDim = 0;
    return false;
  }
  await loadCollection();
  return true;
}

// --- public API ---
export async function upsert(rows: MilvusRow[]): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  await ensureCollection(rows[0].vector.length);
  const res = await connect().upsert({
    collection_name: COLLECTION,
    data: rows.map((row) => ({ ...row })),
    timeout: TIMEOUT_MS,
  });
  checkStatus(res, "upsert");
  return rows.length;
}

// Dense-only COSINE search.
export async function search(
  vector: number[],
  topK: number,
  filter?: string,
): Promise<MilvusHit[]> {
  if (!(await ensureLoaded())) {
    return [];
  }
  const request: SearchSimpleReq = {
    collection_name: COLLECTION,
    data: vector,
    anns_field: "vector",
    limit: topK,
    output_fields: OUTPUT_FIELDS,
    metric_type: "COSINE",
    timeout: TIMEOUT_MS,
  };
  if (filter) {
    request.filter = filter;
  }
  const res = await connect().search(request);
  checkStatus(res, "search");
  return toHits(res.results);
}

// Native BM25 full-text search: the raw query text rides to the `sparse`
// field produced by the BM25 Function.
export async function bm25Search(
  text: string,
  topK: number,
  filter?: string,
): Promise<MilvusHit[]> {
  if (!(await ensureLoaded())) {
    return [];
  }
  const request: SearchSimpleReq = {
    collection_name: COLLECTION,
    data: text,
    anns_field: "sparse",
    limit: topK,
    output_fields: OUTPUT_FIELDS,
    metric_type: "BM25",
    timeout: TIMEOUT_MS,
  };
  if (filter) {
    request.filter = filter;
  }
  const res = await connect().search(request);
  checkStatus(res, "search");
  return toHits(res.results);
}

// Dense + BM25 hybrid search fused inside Milvus with RRF. Both legs recall
// up to max(recall, topK) rows and the fused list is sliced down to topK.
export async function hybridSearch(
  vector: number[],
  text: string,
  topK: number,
  recall = 50,
  filter?: string,
): Promise<MilvusHit[]> {
  if (!(await ensureLoaded())) {
    return [];
  }
  const request: HybridSearchReq = {
    collection_name: COLLECTION,
    data: [
      {
        data: vector,
        anns_field: "vector",
        params: { metric_type: "COSINE" },
        ...(filter ? { expr: filter } : {}),
      },
      {
        data: text,
        anns_field: "sparse",
        params: { metric_type: "BM25" },
        ...(filter ? { expr: filter } : {}),
      },
    ],
    rerank: { strategy: RANKER_TYPE.RRF, params: { k: RRF_K } },
    limit: Math.max(topK, recall),
    output_fields: OUTPUT_FIELDS,
    timeout: TIMEOUT_MS,
  };
  const res = await connect().hybridSearch(request);
  checkStatus(res, "hybridSearch");
  return toHits(res.results).slice(0, topK);
}

export async function count(filter?: string): Promise<number> {
  if (!(await ensureLoaded())) {
    return 0;
  }
  const res = await connect().count({
    collection_name: COLLECTION,
    timeout: TIMEOUT_MS,
  });
  checkStatus(res, "count");
  if (!filter) return res.data;
  // count() ignores filters — use a query for filtered counts.
  const queried = await connect().query({
    collection_name: COLLECTION,
    filter,
    output_fields: ["count(*)"],
    timeout: TIMEOUT_MS,
  });
  checkStatus(queried, "query(count)");
  const row = queried.data?.[0] as Record<string, unknown> | undefined;
  return Number(row?.["count(*)"] ?? 0);
}

export async function deleteByExpr(expr: string): Promise<void> {
  if (!(await ensureLoaded())) {
    return;
  }
  const res = await connect().delete({
    collection_name: COLLECTION,
    filter: expr,
    timeout: TIMEOUT_MS,
  });
  checkStatus(res, "delete");
}

export async function drop(): Promise<void> {
  if (await hasCollection()) {
    const res = await connect().dropCollection({
      collection_name: COLLECTION,
      timeout: TIMEOUT_MS,
    });
    checkStatus(res, "dropCollection");
  }
  ready = false;
  readyDim = 0;
}

export async function flush(): Promise<void> {
  if (!(await ensureLoaded())) {
    return;
  }
  const res = await connect().flush({
    collection_names: [COLLECTION],
    timeout: TIMEOUT_MS,
  });
  checkStatus(res, "flush");
}

export function collectionReadyDim(): number {
  return readyDim;
}
