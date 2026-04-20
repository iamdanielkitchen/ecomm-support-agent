/**
 * Manual smoke test for the agent loop with the search_help_center tool
 * wired in. Hits the running dev server over HTTP, parses the streamed
 * NDJSON, and prints a compact trace per query.
 *
 * Runs two queries back-to-back on two fresh sessions:
 *   1. "how do I season a cast iron pan"
 *   2. "what are your aprons made of"
 *
 * Expected: both turns fire search_help_center; query 1 retrieves
 * cast-iron hits and the reply quotes them; query 2 likely returns
 * below-threshold since Fieldstone does not sell aprons, and the
 * reply says so without fabricating.
 *
 * Usage: start the dev server separately (`pnpm dev`) then:
 *   pnpm tsx scripts/agent-smoke.ts
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.FIELDSTONE_BASE_URL ?? "http://localhost:3000";

const DEFAULT_QUERIES = [
  "how do I season a cast iron pan",
  "what are your aprons made of",
];

// Positional CLI args override the default set; `pnpm agent:smoke -- "q1" "q2"`.
const cliQueries = process.argv.slice(2).filter((a) => a !== "--");
const QUERIES = cliQueries.length > 0 ? cliQueries : DEFAULT_QUERIES;

type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_started"; name: string; input: unknown; id: string }
  | {
      type: "tool_use_result";
      name: string;
      id: string;
      output: unknown;
      ok: boolean;
      latency_ms: number;
    }
  | { type: "escalated"; handoff_id: string }
  | { type: "end_turn"; stop_reason: string }
  | { type: "error"; message: string };

async function runQuery(session_id: string, message: string): Promise<StreamEvent[]> {
  const resp = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id, message }),
  });
  if (!resp.ok || !resp.body) {
    const body = await resp.text();
    throw new Error(`chat ${resp.status}: ${body.slice(0, 300)}`);
  }

  const events: StreamEvent[] = [];
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      events.push(JSON.parse(line) as StreamEvent);
    }
  }
  if (buffer.trim()) events.push(JSON.parse(buffer) as StreamEvent);
  return events;
}

function printTrace(query: string, events: StreamEvent[]): void {
  process.stdout.write(`── "${query}" ────────────────────────────────\n`);
  let finalText = "";
  for (const e of events) {
    switch (e.type) {
      case "tool_use_started":
        process.stdout.write(
          `  → ${e.name}(${JSON.stringify(e.input)})\n`,
        );
        break;
      case "tool_use_result": {
        const out = e.output as Record<string, unknown>;
        if (e.name === "search_help_center" && out) {
          const refs = (out.chunks as Array<{ chunk_id: string; score: number }>) ?? [];
          const above = out.above_threshold;
          process.stdout.write(
            `  ← ${e.name} (${e.latency_ms}ms, above_threshold=${above})\n`,
          );
          for (const r of refs) {
            process.stdout.write(`      ${r.score.toFixed(3)}  ${r.chunk_id}\n`);
          }
          if (!refs.length) {
            process.stdout.write(`      (no chunks — NO_RELEVANT_CONTENT_FOUND)\n`);
          }
        } else {
          const preview = JSON.stringify(out).slice(0, 140);
          process.stdout.write(`  ← ${e.name} (${e.latency_ms}ms) ${preview}\n`);
        }
        break;
      }
      case "text_delta":
        finalText += e.text;
        break;
      case "end_turn":
        process.stdout.write(`  stop: ${e.stop_reason}\n`);
        break;
      case "escalated":
        process.stdout.write(`  ESCALATED ${e.handoff_id}\n`);
        break;
      case "error":
        process.stdout.write(`  ERROR: ${e.message}\n`);
        break;
    }
  }
  process.stdout.write(`\n  reply:\n`);
  for (const line of finalText.split("\n")) {
    process.stdout.write(`    ${line}\n`);
  }
  process.stdout.write(`\n`);
}

async function main() {
  process.stdout.write(`base: ${BASE}\n\n`);
  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i]!;
    const session_id = `smoke-${randomUUID()}`;
    const events = await runQuery(session_id, q);
    printTrace(q, events);
    if (i < QUERIES.length - 1) {
      // Stagger — free-tier Voyage is 3 RPM and each query runs one embed.
      await sleep(21_000);
    }
  }
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + "\n");
  process.exit(1);
});
