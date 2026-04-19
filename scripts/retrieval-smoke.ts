/**
 * Manual smoke test for lib/retrieval.
 *
 * Runs six queries covering happy paths, an escalation-path topic, a
 * below-threshold control, and a brittle identifier lookup. Prints the
 * top-3 chunks + scores per query and flags whether each query would
 * pass the default 0.65 threshold that retrieve() enforces in prod.
 *
 * We pass threshold=0 here so we always see the raw top-3 (retrieve()'s
 * default would return [] for query 5). Rate-limited to 21 seconds
 * between queries because the Atlas free tier caps at 3 RPM.
 *
 * Usage: pnpm retrieval:smoke
 */

import { setTimeout as sleep } from "node:timers/promises";
import {
  retrieve,
  corpusSize,
  DEFAULT_RETRIEVAL_THRESHOLD,
} from "../lib/retrieval.js";

const QUERIES: ReadonlyArray<{ q: string; expect: string }> = [
  {
    q: "how do I return something I opened",
    expect: "returns-exchanges hits, high scores",
  },
  {
    q: "what's your shipping time to california",
    expect: "orders-shipping hits",
  },
  {
    q: "how do I season a cast iron pan",
    expect: "product-care/cast-iron hits",
  },
  {
    q: "can I use my gift card with a promo code",
    expect: "gifting-promotions hits (escalation-path test)",
  },
  {
    q: "what's the weather in stonington",
    expect: "empty chunks array (below-threshold control)",
  },
  {
    q: "FG-123456",
    expect: "account-lookup/order-number-format hits",
  },
];

const PACE_MS = 21_000;

function fmtScore(n: number): string {
  return n.toFixed(3);
}

function fmtChunk(chunk_id: string, heading: string | null, title: string): string {
  const sec = heading ? ` — ${heading}` : " — (intro)";
  return `${chunk_id}  "${title}"${sec}`;
}

async function main() {
  process.stdout.write(`corpus size: ${corpusSize()} chunks\n`);
  process.stdout.write(`default threshold: ${DEFAULT_RETRIEVAL_THRESHOLD}\n\n`);

  for (let i = 0; i < QUERIES.length; i++) {
    const entry = QUERIES[i]!;
    const { q, expect } = entry;
    // threshold=0 so we always see the raw top-3, even for the weather query.
    // The "would filter" flag below tells you what default-threshold retrieve()
    // returns.
    const result = await retrieve(q, {
      k: 3,
      threshold: 0,
      request_id: `smoke#${i + 1}`,
    });

    const top1 = result.scores[0] ?? 0;
    const passes = top1 >= DEFAULT_RETRIEVAL_THRESHOLD;

    process.stdout.write(`Q${i + 1}: "${q}"\n`);
    process.stdout.write(`      expect: ${expect}\n`);
    for (let j = 0; j < result.chunks.length; j++) {
      const c = result.chunks[j]!;
      const s = result.scores[j] ?? 0;
      process.stdout.write(
        `  [${j + 1}] ${fmtScore(s)}  ${fmtChunk(c.chunk_id, c.section_heading, c.title)}\n`,
      );
    }
    const mark = passes ? "passes" : "FILTERED";
    process.stdout.write(
      `      ${mark} default threshold (top-1 ${fmtScore(top1)} ${passes ? ">=" : "<"} ${DEFAULT_RETRIEVAL_THRESHOLD})\n`,
    );
    process.stdout.write(
      `      embed ${result.query_embedding_ms}ms · cosine ${result.cosine_ms}ms · total ${result.latency_ms}ms · ${result.query_tokens} q-tok\n\n`,
    );

    if (i < QUERIES.length - 1) {
      await sleep(PACE_MS);
    }
  }

  process.stdout.write(`done. ${QUERIES.length} queries.\n`);
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + "\n");
  process.exit(1);
});
