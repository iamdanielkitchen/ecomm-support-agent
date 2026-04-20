/**
 * Dual-signal per-turn confidence scoring.
 *
 * Two independent signals, deliberately not combined into a single scalar —
 * keeping them separate lets evals study calibration of each and lets later
 * policy choose how to gate on one, both, or neither.
 *
 * 1. Self-scored (subjective). A side call to Claude Haiku that grades the
 *    assistant reply against the user question: is it grounded, specific,
 *    and actionable, or does it hedge / fabricate / bail? Haiku chosen for
 *    cost — this call runs every turn and is off the critical path for
 *    the streamed user-visible response.
 *
 * 2. Retrieval-derived (objective). If search_help_center was called this
 *    turn, normalize the best top-1 cosine score to [0, 1] over the
 *    operational band [0.40, 0.70]. Exposes raw top-1 and gap-to-top-2
 *    separately so evals can distinguish "confident winner" from
 *    "barely above threshold".
 *
 * We measure before we gate. Nothing here affects agent behavior yet.
 */

import { getClient } from "./anthropic";
import type { ToolInvocation } from "./sessions";

// Haiku 4.5 id per Anthropic model cards; flip here if we tune up or down.
// The main agent still runs on claude-sonnet-4-5; Haiku is scoped to this
// scorer only so any Opus-upgrade path lands independently.
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_MAX_TOKENS = 200;

// Retrieval normalization band. 0.40 matches the retrieval threshold gate —
// anything above is at-or-better than the "weakest acceptable" retrieval.
// 0.70 is the top of the "solid on-topic" band observed in smoke tests.
const RETRIEVAL_LOW = 0.40;
const RETRIEVAL_HIGH = 0.70;
const RETRIEVAL_LOW_OUTPUT = 0.3;

// ── types ──────────────────────────────────────────────────────────────

export type TurnSnapshot = {
  user_message: string;
  assistant_reply: string;
  tool_invocations: ToolInvocation[];
};

export type TurnConfidence = {
  self_score: number | null;
  self_reason: string | null;
  retrieval_score: number | null;
  retrieval_top1: number | null;
  retrieval_gap: number | null;
  used_retrieval: boolean;
};

// ── retrieval signal ───────────────────────────────────────────────────

type SearchChunkRef = { chunk_id: string; score: number };
type SearchOutput = {
  chunks?: SearchChunkRef[];
  above_threshold?: boolean;
};

function normalizeRetrieval(top1: number): number {
  if (top1 < RETRIEVAL_LOW) return 0.0;
  if (top1 >= RETRIEVAL_HIGH) return 1.0;
  const span = RETRIEVAL_HIGH - RETRIEVAL_LOW;
  const frac = (top1 - RETRIEVAL_LOW) / span;
  return RETRIEVAL_LOW_OUTPUT + frac * (1.0 - RETRIEVAL_LOW_OUTPUT);
}

function retrievalSignal(tools: ToolInvocation[]): {
  used_retrieval: boolean;
  retrieval_score: number | null;
  retrieval_top1: number | null;
  retrieval_gap: number | null;
} {
  const searches = tools.filter((t) => t.tool_name === "search_help_center");
  if (searches.length === 0) {
    return {
      used_retrieval: false,
      retrieval_score: null,
      retrieval_top1: null,
      retrieval_gap: null,
    };
  }

  // Multiple searches per turn possible (the agent can re-query). Use the
  // best top-1 across calls — that reflects the strongest evidence the
  // agent had access to when composing the reply.
  let bestTop1 = Number.NEGATIVE_INFINITY;
  let bestGap: number | null = null;

  for (const s of searches) {
    const out = s.output as SearchOutput | undefined;
    const chunks = out?.chunks;
    if (!chunks || chunks.length === 0) continue;
    const top1 = chunks[0]?.score ?? Number.NEGATIVE_INFINITY;
    const top2 = chunks[1]?.score ?? 0;
    if (top1 > bestTop1) {
      bestTop1 = top1;
      bestGap = top1 - top2;
    }
  }

  if (bestTop1 === Number.NEGATIVE_INFINITY) {
    // Every search returned NO_RELEVANT_CONTENT (below threshold). Retrieval
    // ran but produced nothing — score 0, keep top1/gap null to distinguish
    // from the "didn't run" case.
    return {
      used_retrieval: true,
      retrieval_score: 0,
      retrieval_top1: null,
      retrieval_gap: null,
    };
  }

  return {
    used_retrieval: true,
    retrieval_score: normalizeRetrieval(bestTop1),
    retrieval_top1: bestTop1,
    retrieval_gap: bestGap,
  };
}

// ── self-score signal ──────────────────────────────────────────────────

const SELF_SCORE_SYSTEM = `You evaluate the quality of a Fieldstone Goods customer-support assistant's reply.

Return a single JSON object with two fields, nothing else:
  "confidence": a number between 0.0 and 1.0
  "reason":     a short string, under 25 words, explaining the score

High confidence (0.8–1.0): reply is grounded in specific facts, directly answers the question, and is actionable.
Mid confidence (0.4–0.7): reply is partially grounded but hedges, generalizes, or leaves obvious follow-up unaddressed.
Low confidence (0.0–0.3): reply fabricates details, contradicts stated policy, or says "I don't know" without offering a path forward (escalation, a clarifying question, or a pointer).

Do not reward length; reward accuracy and usefulness. An honest "we don't carry that, here's who can help" scores higher than a padded answer full of guesses.

Return only the JSON object. No preamble, no code fences, no prose.`;

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return fenceMatch && fenceMatch[1] !== undefined ? fenceMatch[1].trim() : trimmed;
}

async function selfScore(
  user_message: string,
  assistant_reply: string,
): Promise<{ score: number | null; reason: string | null }> {
  // Edge case: agent produced no text at all (pure tool-use turn that ended
  // without a closing message). Skip the call; there is nothing to score.
  if (!assistant_reply.trim()) {
    return { score: null, reason: null };
  }

  const client = getClient();
  try {
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: HAIKU_MAX_TOKENS,
      system: SELF_SCORE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Customer question:\n${user_message}\n\nAssistant reply:\n${assistant_reply}\n\nScore the reply.`,
        },
      ],
    });

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    const cleaned = stripJsonFence(text);
    const parsed = JSON.parse(cleaned) as {
      confidence?: number;
      reason?: string;
    };

    if (typeof parsed.confidence !== "number" || Number.isNaN(parsed.confidence)) {
      return { score: null, reason: null };
    }
    const clamped = Math.max(0, Math.min(1, parsed.confidence));
    const reason = typeof parsed.reason === "string" ? parsed.reason : null;
    return { score: clamped, reason };
  } catch (err) {
    process.stderr.write(
      `[confidence] self-score failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { score: null, reason: null };
  }
}

// ── public API ─────────────────────────────────────────────────────────

export async function computeTurnConfidence(
  snap: TurnSnapshot,
): Promise<TurnConfidence> {
  // Retrieval signal is synchronous and cheap; wrap in Promise.resolve so
  // the two land concurrently regardless of future changes to either.
  const [self, retrieval] = await Promise.all([
    selfScore(snap.user_message, snap.assistant_reply),
    Promise.resolve(retrievalSignal(snap.tool_invocations)),
  ]);

  return {
    self_score: self.score,
    self_reason: self.reason,
    retrieval_score: retrieval.retrieval_score,
    retrieval_top1: retrieval.retrieval_top1,
    retrieval_gap: retrieval.retrieval_gap,
    used_retrieval: retrieval.used_retrieval,
  };
}
