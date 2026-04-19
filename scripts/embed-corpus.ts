/**
 * Embed the chunked corpus with Voyage AI via MongoDB Atlas.
 *
 * Our VOYAGE_API_KEY is issued by MongoDB Atlas, which hosts Voyage
 * models behind its own endpoint (ai.mongodb.com) and only authorizes
 * requests to that host — calls to Voyage's direct endpoint return 403
 * with this key. Script posts JSON directly to the Atlas host.
 *
 * Pipeline: reads data/corpus/chunks.json, batches texts (up to 128
 * strings per call), posts each batch to /v1/embeddings, and writes
 * data/corpus/embeddings.json as an array of {chunk_id, vector}.
 * Per-batch token usage and estimated cost are appended to
 * logs/embedding-build.jsonl.
 *
 * Fails fast: before the batch loop, a single-input probe call
 * verifies auth and endpoint reachability. 403/401 surfaces with the
 * full response body.
 *
 * Usage:  pnpm corpus:embed
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), "..");

const MODEL = "voyage-4-lite";
// Free-tier Atlas keys are throttled to 3 RPM and 10K TPM. A batch of 20
// chunks is ~3.2K tokens (our chunks are ~160 tokens each), so 3 batches
// per minute stays under both caps. Bumping these requires a payment
// method on the Voyage org, not a code change.
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 21_000; // 3 RPM = 1 call every 20s; buffer to 21s
const INPUT_TYPE = "document"; // per Voyage: improves retrieval precision
const FREE_TIER_TOKENS = 200_000_000;
// voyage-4-lite public document-embedding rate as of this build.
const PRICE_PER_MTOK = 0.02;
const ENDPOINT = "https://ai.mongodb.com/v1/embeddings";

// ── types ──────────────────────────────────────────────────────────────

type Chunk = {
  chunk_id: string;
  slug: string;
  title: string;
  category: string;
  section_heading: string | null;
  text: string;
  tokens: number;
};

type Embedding = {
  chunk_id: string;
  vector: number[];
};

type VoyageEmbedResponse = {
  object?: string;
  data?: Array<{
    object?: string;
    embedding?: number[];
    index?: number;
  }>;
  model?: string;
  usage?: { total_tokens?: number };
  detail?: string; // error shape
};

// ── helpers ────────────────────────────────────────────────────────────

function batchify<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(6)}`;
}

async function embedBatch(
  apiKey: string,
  texts: string[],
): Promise<{ vectors: number[][]; totalTokens: number; dim: number }> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: MODEL,
      input_type: INPUT_TYPE,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Voyage ${response.status}: ${body.slice(0, 500)}`);
  }

  const json = (await response.json()) as VoyageEmbedResponse;
  if (!json.data || json.data.length !== texts.length) {
    throw new Error(
      `expected ${texts.length} embeddings, got ${json.data?.length ?? 0}` +
        (json.detail ? ` (${json.detail})` : ""),
    );
  }

  // Voyage returns items with an explicit `index` field — pair by index
  // rather than assuming list order, to be safe.
  const vectors: number[][] = new Array(texts.length);
  let dim = 0;
  for (const item of json.data) {
    if (item.index === undefined || !item.embedding) {
      throw new Error("embedding item missing index or vector");
    }
    vectors[item.index] = item.embedding;
    if (dim === 0) dim = item.embedding.length;
  }
  for (let i = 0; i < vectors.length; i++) {
    if (!vectors[i]) throw new Error(`missing embedding for index ${i}`);
  }

  return {
    vectors,
    totalTokens: json.usage?.total_tokens ?? 0,
    dim,
  };
}

// ── main ───────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Run with `tsx --env-file=.env.local scripts/embed-corpus.ts` or export the var.",
    );
  }

  const chunksPath = join(ROOT, "data/corpus/chunks.json");
  const outPath = join(ROOT, "data/corpus/embeddings.json");
  const logPath = join(ROOT, "logs/embedding-build.jsonl");

  const chunks = JSON.parse(readFileSync(chunksPath, "utf8")) as Chunk[];
  mkdirSync(dirname(logPath), { recursive: true });

  // Auth probe: fail fast on bad key / endpoint mismatch / IP ACL, before
  // burning API budget on real batches. Surfaces the full response body —
  // Voyage 403s give no detail otherwise.
  process.stdout.write(`probing ${ENDPOINT} ... `);
  const probeResp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: ["probe"], model: MODEL, input_type: INPUT_TYPE }),
  });
  if (!probeResp.ok) {
    const body = await probeResp.text();
    throw new Error(
      `auth probe failed: ${probeResp.status} ${probeResp.statusText}\n${body}`,
    );
  }
  await probeResp.json(); // drain body
  process.stdout.write(`ok\n\n`);
  // The probe just used a 3-RPM slot; wait before the first real batch so
  // we don't get 4 calls in the opening 60s window.
  await sleep(BATCH_DELAY_MS);

  const batches = batchify(chunks, BATCH_SIZE);

  process.stdout.write(
    `Embedding ${chunks.length} chunk(s) with ${MODEL} across ${batches.length} batch(es)...\n\n`,
  );

  const embeddings: Embedding[] = [];
  const failed: string[] = [];
  let totalTokens = 0;
  let vectorDim = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    const texts = batch.map((c) => c.text);
    const start = Date.now();

    try {
      const { vectors, totalTokens: batchTokens, dim } = await embedBatch(
        apiKey,
        texts,
      );
      const latency_ms = Date.now() - start;
      if (vectorDim === 0) vectorDim = dim;

      for (let i = 0; i < batch.length; i++) {
        embeddings.push({
          chunk_id: batch[i]!.chunk_id,
          vector: vectors[i]!,
        });
      }

      totalTokens += batchTokens;
      const costUsd = (batchTokens / 1_000_000) * PRICE_PER_MTOK;

      appendFileSync(
        logPath,
        JSON.stringify({
          ts: new Date().toISOString(),
          model: MODEL,
          input_type: INPUT_TYPE,
          batch_index: b,
          batch_size: batch.length,
          tokens: batchTokens,
          est_cost_usd: costUsd,
          latency_ms,
          vector_dim: dim,
        }) + "\n",
      );
      process.stdout.write(
        `  [ok]   batch ${b + 1}/${batches.length} — ${batch.length} chunks, ${batchTokens} tokens, ${latency_ms}ms (${formatUsd(costUsd)} @ paid rate, free-tier absorbs)\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendFileSync(
        logPath,
        JSON.stringify({
          ts: new Date().toISOString(),
          model: MODEL,
          batch_index: b,
          batch_size: batch.length,
          error: message,
        }) + "\n",
      );
      process.stdout.write(
        `  [fail] batch ${b + 1}/${batches.length} — ${message}\n`,
      );
      for (const c of batch) failed.push(c.chunk_id);
    }

    // Pace next batch to respect 3 RPM / 10K TPM. Skip on last batch.
    if (b < batches.length - 1) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  writeFileSync(outPath, JSON.stringify(embeddings, null, 2) + "\n");
  const fileBytes = statSync(outPath).size;
  const fileMb = (fileBytes / (1024 * 1024)).toFixed(2);
  const totalCostUsd = (totalTokens / 1_000_000) * PRICE_PER_MTOK;
  const freeTierRemaining = FREE_TIER_TOKENS - totalTokens;
  const freeTierPct = ((freeTierRemaining / FREE_TIER_TOKENS) * 100).toFixed(4);

  process.stdout.write(`\n`);
  process.stdout.write(`── summary ────────────────────────────────────\n`);
  process.stdout.write(`  chunks embedded      ${embeddings.length} / ${chunks.length}\n`);
  process.stdout.write(`  vector dimension     ${vectorDim}\n`);
  process.stdout.write(`  total tokens         ${totalTokens.toLocaleString()}\n`);
  process.stdout.write(`  estimated cost       ${formatUsd(totalCostUsd)} (free tier absorbs all)\n`);
  process.stdout.write(`  free-tier remaining  ${freeTierRemaining.toLocaleString()} / ${FREE_TIER_TOKENS.toLocaleString()} (${freeTierPct}%)\n`);
  process.stdout.write(`  output file          ${outPath}\n`);
  process.stdout.write(`  output file size     ${fileMb} MB (${fileBytes.toLocaleString()} bytes)\n`);

  if (failed.length > 0) {
    process.stdout.write(`\n  FAILED chunk_ids (${failed.length}):\n`);
    for (const id of failed) process.stdout.write(`    - ${id}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + "\n");
  process.exit(1);
});
