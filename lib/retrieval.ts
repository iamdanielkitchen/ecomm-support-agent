/**
 * In-memory retrieval over the Fieldstone help-center corpus.
 *
 * Loads data/corpus/chunks.json + data/corpus/embeddings.json once at
 * module init, precomputes L2 norms per vector, and serves retrieve()
 * by embedding the query (input_type="query") and computing cosine
 * similarity against every chunk.
 *
 * Why no vector DB: CLAUDE.md pre-commits to "no RAG, no vector store"
 * for Weekend 1; Path 2 explicitly accepts a dependency-free in-memory
 * index. 265 chunks × 1024 dims × 4 bytes ≈ 1 MB of hot data. Cosine
 * over the whole set is ~5 ms; dwarfed by the query-embedding round
 * trip (~300 ms). Upgrade path is "swap to pg_vector at 10K chunks".
 *
 * Threshold gate: if the top-1 score is below threshold (default 0.65),
 * retrieve() returns chunks: [] — an explicit "I don't have that"
 * signal the agent can branch on, so it avoids grounding on weak hits.
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const VOYAGE_ENDPOINT = "https://ai.mongodb.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-4-lite";
const DEFAULT_K = 5;
const DEFAULT_THRESHOLD = 0.65;

// ── types ──────────────────────────────────────────────────────────────

export type Chunk = {
  chunk_id: string;
  slug: string;
  title: string;
  category: string;
  section_heading: string | null;
  text: string;
  tokens: number;
};

type StoredEmbedding = {
  chunk_id: string;
  vector: number[];
};

type CorpusEntry = {
  chunk: Chunk;
  vector: Float32Array;
  norm: number;
};

export type RetrieveOpts = {
  k?: number;
  threshold?: number;
  // Caller-supplied correlation id (e.g. session_id:turn_index). Falls back
  // to a random UUID so every call has a stable id in the log.
  request_id?: string;
};

export type RetrieveResult = {
  chunks: Chunk[];
  scores: number[];
  latency_ms: number;
  query_tokens: number;
  query_embedding_ms: number;
  cosine_ms: number;
};

// ── module-init corpus load ────────────────────────────────────────────

function loadCorpus(): CorpusEntry[] {
  const cwd = process.cwd();
  const chunks = JSON.parse(
    readFileSync(join(cwd, "data/corpus/chunks.json"), "utf-8"),
  ) as Chunk[];
  const embeddings = JSON.parse(
    readFileSync(join(cwd, "data/corpus/embeddings.json"), "utf-8"),
  ) as StoredEmbedding[];

  const byId = new Map<string, StoredEmbedding>();
  for (const e of embeddings) byId.set(e.chunk_id, e);

  const entries: CorpusEntry[] = [];
  for (const chunk of chunks) {
    const emb = byId.get(chunk.chunk_id);
    if (!emb) {
      throw new Error(
        `[retrieval] no embedding for chunk_id "${chunk.chunk_id}". Run \`pnpm corpus:embed\`.`,
      );
    }
    const vector = new Float32Array(emb.vector);
    let sum = 0;
    for (let i = 0; i < vector.length; i++) {
      const v = vector[i] ?? 0;
      sum += v * v;
    }
    entries.push({ chunk, vector, norm: Math.sqrt(sum) });
  }
  return entries;
}

const CORPUS: CorpusEntry[] = loadCorpus();
const VECTOR_DIM = CORPUS[0]?.vector.length ?? 0;

// ── query embedding ────────────────────────────────────────────────────

type VoyageEmbedResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
  usage?: { total_tokens?: number };
  detail?: string;
};

async function embedQuery(
  query: string,
): Promise<{ vector: Float32Array; tokens: number; latency_ms: number }> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("[retrieval] VOYAGE_API_KEY is not set");
  }

  const start = Date.now();
  const resp = await fetch(VOYAGE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [query],
      model: VOYAGE_MODEL,
      // input_type="query" is the critical retrieval-time switch — it tells
      // Voyage to asymmetrically embed queries vs documents. Mismatching
      // this with the document embeddings degrades recall.
      input_type: "query",
    }),
  });
  const latency_ms = Date.now() - start;

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `[retrieval] Voyage ${resp.status}: ${body.slice(0, 500)}`,
    );
  }

  const json = (await resp.json()) as VoyageEmbedResponse;
  const emb = json.data?.[0]?.embedding;
  if (!emb) {
    throw new Error(
      `[retrieval] Voyage returned no embedding${json.detail ? `: ${json.detail}` : ""}`,
    );
  }
  if (emb.length !== VECTOR_DIM) {
    throw new Error(
      `[retrieval] query dim ${emb.length} does not match corpus dim ${VECTOR_DIM}. Re-embed corpus.`,
    );
  }

  return {
    vector: new Float32Array(emb),
    tokens: json.usage?.total_tokens ?? 0,
    latency_ms,
  };
}

// ── cosine ─────────────────────────────────────────────────────────────

function cosineAll(q: Float32Array, qNorm: number): number[] {
  const n = CORPUS.length;
  const scores = new Array<number>(n);
  const qLen = q.length;
  for (let i = 0; i < n; i++) {
    const entry = CORPUS[i]!;
    const v = entry.vector;
    let dot = 0;
    for (let j = 0; j < qLen; j++) {
      dot += (q[j] ?? 0) * (v[j] ?? 0);
    }
    scores[i] = dot / (qNorm * entry.norm);
  }
  return scores;
}

// ── logging ────────────────────────────────────────────────────────────

function logCall(entry: Record<string, unknown>): void {
  // Observability must never crash retrieval. Swallow disk errors (Vercel's
  // runtime fs is read-only outside /tmp).
  try {
    const dir = join(process.cwd(), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "retrieval.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    process.stderr.write(
      `[retrieval] log write failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ── public API ─────────────────────────────────────────────────────────

export async function retrieve(
  query: string,
  opts: RetrieveOpts = {},
): Promise<RetrieveResult> {
  const start = Date.now();
  const k = opts.k ?? DEFAULT_K;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const request_id = opts.request_id ?? randomUUID();

  const { vector: qVec, tokens: query_tokens, latency_ms: query_embedding_ms } =
    await embedQuery(query);

  // Query norm (once per call).
  let qNormSq = 0;
  for (let i = 0; i < qVec.length; i++) {
    const v = qVec[i] ?? 0;
    qNormSq += v * v;
  }
  const qNorm = Math.sqrt(qNormSq);

  const cosineStart = Date.now();
  const scores = cosineAll(qVec, qNorm);
  const cosine_ms = Date.now() - cosineStart;

  // Sort by score desc, take top-k. indices-array approach avoids mutating
  // the parallel CORPUS array and lets us read chunks + scores in one pass.
  const indices = scores
    .map((_, i) => i)
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  const topIndices = indices.slice(0, k);
  const topChunks = topIndices.map((i) => CORPUS[i]!.chunk);
  const topScores = topIndices.map((i) => scores[i] ?? 0);

  // Threshold gate: empty chunks signals "no confident hit".
  const top1 = topScores[0] ?? 0;
  const aboveThreshold = top1 >= threshold;
  const outChunks = aboveThreshold ? topChunks : [];
  const outScores = aboveThreshold ? topScores : [];

  const latency_ms = Date.now() - start;

  logCall({
    ts: new Date().toISOString(),
    request_id,
    query,
    k,
    threshold,
    above_threshold: aboveThreshold,
    top_k_chunk_ids: topChunks.map((c) => c.chunk_id),
    top_k_scores: topScores,
    latency_ms,
    query_tokens,
    query_embedding_ms,
    cosine_ms,
  });

  return {
    chunks: outChunks,
    scores: outScores,
    latency_ms,
    query_tokens,
    query_embedding_ms,
    cosine_ms,
  };
}

// Exposed for the smoke test and for potential debug surfaces. Not intended
// for agent-loop consumption (which should stick to retrieve()).
export function corpusSize(): number {
  return CORPUS.length;
}
