import Anthropic from "@anthropic-ai/sdk";

// TODO: decide AM — CLAUDE.md says "Claude Sonnet 4.6" but gives the literal
// id `claude-sonnet-4-5`. Keeping the literal string so this runs against a
// real model today; flip to `claude-sonnet-4-6` if 4.6 was the intent. One
// constant, one line to change.
export const MODEL_ID = "claude-sonnet-4-5";

// Reasonable default for a support turn: long enough for several tool calls +
// a paragraph of reply, short enough to keep latency bounded.
export const MAX_TOKENS = 1024;

// One process-wide client. The SDK handles keep-alive + retries.
let _client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and fill it in."
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}
