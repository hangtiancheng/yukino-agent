// Redis Stack (RediSearch) client singleton + auto-create vector index.
// Replaces lib/milvus/client.ts. Stores embeddings as native Float32 vectors
// with HNSW + COSINE (vs. Milvus BinaryVector + HAMMING).
import { createClient, type RedisClientType } from "redis";
import { embedText } from "@/lib/ai/embedder";
import { config } from "@/lib/config";

let clientPromise: Promise<RedisClientType> | null = null;

export function getRedisClient(): Promise<RedisClientType> {
  if (!clientPromise) {
    // P1-8 fix: reset clientPromise on failure so the next call can retry
    // instead of permanently caching a rejected promise.
    clientPromise = initClient().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function initClient(): Promise<RedisClientType> {
  // P1-8 fix: configure automatic reconnection with exponential backoff.
  // The redis client (v4+) supports reconnectStrategy on the socket — it
  // retries with increasing delays up to a 5s cap, so transient network
  // blips or Redis restarts don't permanently break the singleton.
  const client = createClient({
    url: config.redis.url,
    socket: {
      reconnectStrategy: (retries: number) => Math.min(retries * 100, 5000),
    },
  });
  client.on("error", (err) => console.error("Redis Client Error:", err));
  await client.connect();

  await ensureIndex(client);
  return client;
}

// Probe the embedding provider for the real vector dimension and make the
// index match it. The dimension is NOT taken from static config: the actual
// model output is authoritative (e.g. a model returning 1024 floats while
// config assumed 2048 made every HSET silently fail RediSearch indexing —
// num_docs stayed 0 with hash_indexing_failures climbing). Also covers
async function ensureIndex(client: RedisClientType): Promise<void> {
  const dim = (await embedText("dimension probe")).length;

  let indexExists = false;
  try {
    const info = await client.ft.info(config.redis.indexName);
    indexExists = true;

    const attrs =
      (info as { attributes?: Array<Record<string, unknown>> }).attributes ??
      [];
    const vectorAttr = attrs.find(
      (a) => a.attribute === "vector" || a.identifier === "vector",
    );
    if (vectorAttr) {
      const storedDim = Number(vectorAttr.DIM ?? vectorAttr.dim ?? 0);
      if (storedDim && storedDim !== dim) {
        console.warn(
          `[redis] Index dimension mismatch: stored=${storedDim}, actual=${dim}. ` +
            "Dropping and recreating index.",
        );
        await client.ft.dropIndex(config.redis.indexName);
        indexExists = false;
      }
    }
  } catch {
    // Index doesn't exist yet.
  }

  // If the index exists and dimension matches, nothing to do.
  if (indexExists) return;

  // Clean slate: wipe all hashes under the prefix before (re)creating the
  // index. Old vectors are useless after a dimension change, and RediSearch's
  // background rescan would otherwise resurrect them as duplicates that
  // source-based dedup can't see yet. Startup indexing repopulates the data.
  for await (const keys of client.scanIterator({
    MATCH: `${config.redis.keyPrefix}*`,
    COUNT: 500,
  })) {
    if (keys.length > 0) {
      await client.del(keys);
    }
  }

  // Create the RediSearch vector index.
  await client.ft.create(
    config.redis.indexName,
    {
      vector: {
        type: "VECTOR",
        ALGORITHM: "HNSW",
        TYPE: "FLOAT32",
        DIM: dim,
        DISTANCE_METRIC: "COSINE",
      },
      content: { type: "TEXT" },
      _source: { type: "TAG" },
    },
    { ON: "HASH", PREFIX: config.redis.keyPrefix },
  );
}
