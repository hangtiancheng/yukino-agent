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
const OUTPUT_FIELDS = ["id", "content", "source", "metadata", "created_at"];
const RRF_K = 60;
export const MAX_CONTENT_LENGTH = 8192;

export interface MilvusRow {
  id: string;
  vector: number[];
  content: string;
  source: string;
  metadata: string;
  created_at: string;
}

export interface MilvusHit {
  id: string;
  score: number;
  content: string;
  source: string;
  metadata: string;
  created_at: string;
}

let cachedClient: MilvusClient | null = null;
let ready = false;
let readyDim = 0;

function connect(): MilvusClient {
  if (cachedClient !== null) {
    return cachedClient;
  }
  const address = config.milvus.uri.replace(/^https?:\/\//, "");
  const clientConfig: ConstructorParameters<typeof MilvusClient>[0] = {
    address,
    timeout: TIMEOUT_MS,
    logLevel: "warn",
  };
  if (config.milvus.token !== "") {
    clientConfig.token = config.milvus.token;
  }
  cachedClient = new MilvusClient(clientConfig);
  cachedClient.connectPromise.catch(() => undefined);
  return cachedClient;
}

export async function close(): Promise<void> {
  if (cachedClient !== null) {
    await cachedClient.closeConnection();
    cachedClient = null;
    ready = false;
    readyDim = 0;
  }
}

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
      {
        name: "content",
        data_type: DataType.VarChar,
        max_length: MAX_CONTENT_LENGTH,
        enable_analyzer: true,
        analyzer_params: { type: config.milvus.analyzer },
      },
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
  if (!isSuccess(loaded)) {
    checkStatus(denseIndexed, "createIndex(vector)");
    checkStatus(sparseIndexed, "createIndex(sparse)");
  }
  checkStatus(loaded, "loadCollection");
  ready = true;
  readyDim = dim;
}

async function ensureLoaded(): Promise<boolean> {
  if (!(await hasCollection())) {
    ready = false;
    readyDim = 0;
    return false;
  }
  await loadCollection();
  return true;
}

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

export async function getByIds(ids: string[]): Promise<MilvusHit[]> {
  if (ids.length === 0) return [];
  if (!(await ensureLoaded())) {
    return [];
  }
  const res = await connect().get({
    collection_name: COLLECTION,
    ids,
    output_fields: OUTPUT_FIELDS,
    timeout: TIMEOUT_MS,
  });
  checkStatus(res, "get");
  const rows = (res.data ?? []) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    score: 0,
    content: String(row.content ?? ""),
    source: String(row.source ?? ""),
    metadata: String(row.metadata ?? ""),
    created_at: String(row.created_at ?? ""),
  }));
}

export async function queryByFilter(
  filter: string,
  limit: number,
): Promise<MilvusHit[]> {
  if (!(await ensureLoaded())) {
    return [];
  }
  const res = await connect().query({
    collection_name: COLLECTION,
    filter,
    limit,
    output_fields: OUTPUT_FIELDS,
    timeout: TIMEOUT_MS,
  });
  checkStatus(res, "query");
  const rows = (res.data ?? []) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    score: 0,
    content: String(row.content ?? ""),
    source: String(row.source ?? ""),
    metadata: String(row.metadata ?? ""),
    created_at: String(row.created_at ?? ""),
  }));
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
