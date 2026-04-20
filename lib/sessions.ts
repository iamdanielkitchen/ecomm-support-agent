import type Anthropic from "@anthropic-ai/sdk";
import type { TurnConfidence } from "./confidence";

export type ToolInvocation = {
  turn_index: number;
  tool_name: string;
  input: unknown;
  output: unknown;
  latency_ms: number;
  timestamp: number;
};

export type TurnConfidenceRecord = {
  turn_index: number;
  timestamp: number;
  confidence: TurnConfidence;
};

export type SessionState = {
  session_id: string;
  created_at: number;
  last_activity: number;
  messages: Anthropic.MessageParam[];
  tool_trace: ToolInvocation[];
  confidence_per_turn: TurnConfidenceRecord[];
  escalated: boolean;
  handoff_id?: string;
};

// In-memory store. CLAUDE.md is explicit: no DB, no Redis. Process restart =
// clean slate. The postmortem line is "would swap to Redis at 10x volume".
//
// Hoisted to globalThis so /api/chat and /api/session/[id] share one Map in
// Next dev — each route compiles to its own module instance with a private
// top-level `const`, which in dev caused sessions to look empty when /debug
// queried them immediately after a chat turn. In prod the routes share a
// process; in dev the globalThis handle is what keeps them in sync.
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_EVERY_MS = 5 * 60 * 1000; // 5 minutes

declare global {
  // eslint-disable-next-line no-var
  var __fieldstoneSweeperStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __fieldstoneSessions: Map<string, SessionState> | undefined;
}

const sessions: Map<string, SessionState> =
  globalThis.__fieldstoneSessions ?? new Map<string, SessionState>();
if (!globalThis.__fieldstoneSessions) {
  globalThis.__fieldstoneSessions = sessions;
}

function startSweeper(): void {
  if (globalThis.__fieldstoneSweeperStarted) return;
  globalThis.__fieldstoneSweeperStarted = true;
  setInterval(() => {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, s] of sessions) {
      if (s.last_activity < cutoff) sessions.delete(id);
    }
  }, SWEEP_EVERY_MS).unref?.();
}

startSweeper();

export function getOrCreateSession(session_id: string): SessionState {
  let s = sessions.get(session_id);
  if (!s) {
    const now = Date.now();
    s = {
      session_id,
      created_at: now,
      last_activity: now,
      messages: [],
      tool_trace: [],
      confidence_per_turn: [],
      escalated: false,
    };
    sessions.set(session_id, s);
  }
  return s;
}

export function getSession(session_id: string): SessionState | undefined {
  return sessions.get(session_id);
}

export function touchSession(s: SessionState): void {
  s.last_activity = Date.now();
}

export function recordToolInvocation(
  s: SessionState,
  inv: ToolInvocation
): void {
  s.tool_trace.push(inv);
}

export function recordConfidence(
  s: SessionState,
  record: TurnConfidenceRecord
): void {
  s.confidence_per_turn.push(record);
}

export function markEscalated(s: SessionState, handoff_id: string): void {
  s.escalated = true;
  s.handoff_id = handoff_id;
}

// Exposed for tests / eval harness.
export function __clearAllSessions(): void {
  sessions.clear();
}
