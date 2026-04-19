import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// One JSONL line per turn. Schema matches CLAUDE.md §Observability.

export type ToolLogEntry = {
  name: string;
  latency_ms: number;
  ok: boolean;
};

export type TurnLog = {
  ts: number;
  turn: number;
  user_snippet: string;
  model_snippet: string;
  tools_called: ToolLogEntry[];
  total_latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  stop_reason: string;
};

function logPath(session_id: string): string {
  return join(process.cwd(), "logs", "sessions", `${session_id}.jsonl`);
}

export function logTurn(session_id: string, entry: TurnLog): void {
  try {
    const dir = join(process.cwd(), "logs", "sessions");
    mkdirSync(dir, { recursive: true });
    appendFileSync(logPath(session_id), JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    // Observability must never crash the request. Drop the line but keep
    // serving the user.
    process.stderr.write(
      `[logger] failed to write turn log for ${session_id}: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }
}

export function readTurns(session_id: string): TurnLog[] {
  const path = logPath(session_id);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TurnLog);
}

export function snippet(s: string, max = 140): string {
  const normalized = s.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : normalized.slice(0, max) + "…";
}
