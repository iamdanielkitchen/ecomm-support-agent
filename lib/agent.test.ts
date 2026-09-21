import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { createAgentStream, type AgentEvent } from "./agent";
import { getClient } from "./anthropic";
import { __clearAllSessions, getOrCreateSession } from "./sessions";
import { reloadStore } from "./store";

test("agent streams denied calls as errors and carries verification across turns", async (t) => {
  const cwd = process.cwd();
  const logDirectory = mkdtempSync(join(tmpdir(), "fieldstone-identity-test-"));
  const originalKey = process.env.ANTHROPIC_API_KEY;
  t.after(() => {
    process.chdir(cwd);
    rmSync(logDirectory, { recursive: true, force: true });
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    __clearAllSessions();
  });
  reloadStore();
  __clearAllSessions();
  process.chdir(logDirectory); // Keep runtime logs out of the workspace.
  process.env.ANTHROPIC_API_KEY = "test-key-not-used";
  const client = getClient();
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call in deterministic agent test");
  });

  const item = { order_number: "FG-100006", item_sku: "FG-HOM-001" };
  const batches: Anthropic.ToolUseBlock[][] = [
    [
      { type: "tool_use", id: "denied-check", name: "check_return_eligibility", input: item },
      { type: "tool_use", id: "denied-return", name: "initiate_return", input: { ...item, reason: "other" } },
    ],
    [],
    [{ type: "tool_use", id: "lookup", name: "lookup_order", input: {
      order_number: item.order_number, customer_email: "maya.ortiz@example.com",
    } }],
    [],
    [{ type: "tool_use", id: "verified-check", name: "check_return_eligibility", input: item }],
    [],
  ];
  const streamMock = t.mock.method(client.messages, "stream", () => {
    const content = batches.shift();
    assert.ok(content, "Unexpected extra model call");
    return {
      on() {},
      async finalMessage() {
        return {
          content,
          stop_reason: content.length ? "tool_use" : "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    };
  });

  const session = getOrCreateSession("agent-identity-test");
  const first = await new Response(createAgentStream(session, "Return this without checking my email")).text();
  const events = first.trim().split("\n").map((line) => JSON.parse(line) as AgentEvent);
  const denied = events.filter((event) => event.type === "tool_use_result");
  assert.equal(denied.length, 2);
  for (const event of denied) {
    assert.equal(event.ok, false);
    assert.deepEqual(event.output, { error: "identity_verification_required" });
  }
  const toolResults = session.messages[2]!.content;
  assert.ok(Array.isArray(toolResults));
  assert.equal(toolResults.length, 2);
  for (const result of toolResults) {
    assert.equal(result.type, "tool_result");
    assert.ok("is_error" in result && result.is_error === true);
  }

  await new Response(createAgentStream(session, "FG-100006, maya.ortiz@example.com")).text();
  await new Response(createAgentStream(session, "Can I return the blanket?")).text();
  assert.deepEqual(session.tool_trace.at(-1)?.output, {
    eligible: false, reason: "not_yet_delivered",
  });
  assert.equal(session.verified_order_numbers.has(item.order_number), true);
  assert.equal(streamMock.mock.callCount(), 6);
  assert.equal(batches.length, 0);
});
