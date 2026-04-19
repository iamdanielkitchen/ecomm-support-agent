import type Anthropic from "@anthropic-ai/sdk";
import { getClient, MAX_TOKENS, MODEL_ID } from "./anthropic.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import {
  markEscalated,
  recordToolInvocation,
  touchSession,
  type SessionState,
} from "./sessions.js";
import { logTurn, snippet, type ToolLogEntry } from "./logger.js";
import { runTool, TOOL_SCHEMAS, type ToolContext } from "./tools.js";

// Events streamed to the client over the chunked response body as newline-
// delimited JSON. The UI reads them one line at a time.
export type AgentEvent =
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

// Hard guardrail. If the model's thrashing in a tool_use loop we cut the
// turn short rather than burn tokens indefinitely. 6 hops is generous —
// lookup → eligibility → confirm → initiate → reply is 4.
const MAX_LOOP_ITERATIONS = 6;

export function createAgentStream(
  session: SessionState,
  userMessage: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AgentEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      // If the session is already escalated we never hand control back to the
      // model. Defensive — the UI disables input in this state, but an API
      // caller could still reach here.
      if (session.escalated) {
        emit({
          type: "error",
          message:
            "Session has been handed off to a human agent. Start a new chat to continue.",
        });
        controller.close();
        return;
      }

      session.messages.push({ role: "user", content: userMessage });
      touchSession(session);

      const turnIndex = session.tool_trace.length;
      const turnStart = Date.now();
      const toolsCalled: ToolLogEntry[] = [];
      let tokensIn = 0;
      let tokensOut = 0;
      let stopReason = "";
      let assistantTextBuffer = "";

      const client = getClient();

      try {
        loop: for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
          const stream = client.messages.stream({
            model: MODEL_ID,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: session.messages,
            tools: TOOL_SCHEMAS,
          });

          stream.on("text", (textDelta: string) => {
            assistantTextBuffer += textDelta;
            emit({ type: "text_delta", text: textDelta });
          });

          // finalMessage() resolves when the stream ends and returns the
          // assembled Message — including tool_use blocks with their inputs
          // fully parsed.
          const message = await stream.finalMessage();

          tokensIn += message.usage.input_tokens ?? 0;
          tokensOut += message.usage.output_tokens ?? 0;
          stopReason = message.stop_reason ?? "";

          // Append the assistant turn to the transcript regardless of stop
          // reason. The next iteration, or the next user turn, needs it.
          session.messages.push({
            role: "assistant",
            content: message.content,
          });

          if (message.stop_reason !== "tool_use") {
            emit({ type: "end_turn", stop_reason: message.stop_reason ?? "" });
            break loop;
          }

          // Collect tool_use blocks. There can be more than one per turn
          // (the model may parallelize). Run them in order; build one
          // user-role message with all tool_result blocks.
          const toolUses = message.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
          );

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          const toolCtx: ToolContext = {
            session_id: session.session_id,
            transcript: session.messages,
            now: () => new Date(),
            onEscalate: (handoff_id) => {
              markEscalated(session, handoff_id);
              emit({ type: "escalated", handoff_id });
            },
          };

          for (const tu of toolUses) {
            emit({
              type: "tool_use_started",
              id: tu.id,
              name: tu.name,
              input: tu.input,
            });

            const t0 = Date.now();
            const result = await runTool(tu.name, tu.input, toolCtx);
            const latency_ms = Date.now() - t0;

            const outputValue = result.ok
              ? result.value
              : { error: result.error };

            recordToolInvocation(session, {
              turn_index: turnIndex,
              tool_name: tu.name,
              input: tu.input,
              output: outputValue,
              latency_ms,
              timestamp: Date.now(),
            });
            toolsCalled.push({
              name: tu.name,
              latency_ms,
              ok: result.ok,
            });

            emit({
              type: "tool_use_result",
              id: tu.id,
              name: tu.name,
              output: outputValue,
              ok: result.ok,
              latency_ms,
            });

            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify(outputValue),
              is_error: !result.ok,
            });
          }

          session.messages.push({ role: "user", content: toolResults });

          // If escalation fired we let the model take one more turn to
          // produce a closing sentence (the "connecting you now…" line).
          // The session is already flagged escalated; the next user message
          // will bounce. No special handling needed here.
        }

        if (stopReason === "" || stopReason === "tool_use") {
          // We bailed out of the loop via MAX_LOOP_ITERATIONS. The model
          // is stuck. Tell the client, log it, and don't pretend otherwise.
          emit({
            type: "error",
            message:
              "The assistant took too many tool-use steps on this turn. I'm ending the turn here; please try rephrasing.",
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agent] ${message}\n`);
        emit({ type: "error", message });
      } finally {
        logTurn(session.session_id, {
          ts: turnStart,
          turn: turnIndex,
          user_snippet: snippet(userMessage),
          model_snippet: snippet(assistantTextBuffer),
          tools_called: toolsCalled,
          total_latency_ms: Date.now() - turnStart,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          stop_reason: stopReason,
        });
        touchSession(session);
        controller.close();
      }
    },
  });
}
