// Golden-set replay harness.
//
// Usage: assume a dev server is running locally (`pnpm dev`). Then:
//   pnpm eval
//
// Override the target with FIELDSTONE_BASE_URL=https://… pnpm eval
//
// The harness does NOT spin up its own Next server — Next dev is slow to
// boot and the runner should be interrupt-friendly. CLAUDE.md says
// "replays each golden-set case against the real /api/chat endpoint", so
// we hit HTTP, not the agent in-process.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.FIELDSTONE_BASE_URL ?? "http://localhost:3000";

type PassCriterion =
  | { kind: "correct_tool_called"; tool: string; args_include?: Record<string, unknown> }
  | { kind: "no_tool_called" }
  | { kind: "no_initiate_return_called" }
  | {
      kind: "escalation_triggered";
      reason_code?: string;
      reason_code_any_of?: string[];
    }
  | { kind: "escalation_not_triggered" }
  | { kind: "no_fabrication"; must_be_backed_by_tool?: string }
  | { kind: "final_text_includes_any"; substrings: string[]; case_insensitive?: boolean }
  | { kind: "final_text_excludes_all"; substrings: string[] }
  | { kind: "policy_accurate_30_day_window" }
  | { kind: "stays_in_scope" };

type GoldenCase = {
  id: number;
  title: string;
  category: string;
  turns: string[];
  pass_criteria: PassCriterion[];
};

type ToolInvocation = {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  ok: boolean;
  latency_ms: number;
};

type AgentEvent =
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

type TurnResult = {
  user: string;
  assistant_text: string;
  tool_invocations: ToolInvocation[];
  errored: boolean;
  error_message?: string;
};

type CaseResult = {
  case: GoldenCase;
  turns: TurnResult[];
  pass_detail: Array<{ criterion: PassCriterion; pass: boolean; reason?: string }>;
  passed: boolean;
};

// --- streaming HTTP POST to /api/chat ----------------------------------------

async function runTurn(
  session_id: string,
  message: string
): Promise<TurnResult> {
  const resp = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id, message }),
  });

  if (!resp.ok || !resp.body) {
    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      // ignore
    }
    return {
      user: message,
      assistant_text: "",
      tool_invocations: [],
      errored: true,
      error_message: `HTTP ${resp.status}: ${JSON.stringify(body)}`,
    };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const pendingInputs = new Map<string, unknown>();
  const invocations: ToolInvocation[] = [];
  let errored = false;
  let errorMessage: string | undefined;

  const handle = (ev: AgentEvent) => {
    switch (ev.type) {
      case "text_delta":
        text += ev.text;
        break;
      case "tool_use_started":
        pendingInputs.set(ev.id, ev.input);
        break;
      case "tool_use_result": {
        const input = (pendingInputs.get(ev.id) ?? {}) as Record<string, unknown>;
        invocations.push({
          name: ev.name,
          input,
          output: ev.output,
          ok: ev.ok,
          latency_ms: ev.latency_ms,
        });
        pendingInputs.delete(ev.id);
        break;
      }
      case "escalated":
      case "end_turn":
        break;
      case "error":
        errored = true;
        errorMessage = ev.message;
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          handle(JSON.parse(line) as AgentEvent);
        } catch {
          // skip malformed line
        }
      }
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) {
    try {
      handle(JSON.parse(buffer.trim()) as AgentEvent);
    } catch {
      // skip
    }
  }

  return {
    user: message,
    assistant_text: text,
    tool_invocations: invocations,
    errored,
    error_message: errorMessage,
  };
}

// --- criterion evaluation ---------------------------------------------------

function shallowIncludes(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  for (const k of Object.keys(expected)) {
    if (input[k] !== expected[k]) return false;
  }
  return true;
}

function evaluateCriterion(
  c: PassCriterion,
  turns: TurnResult[]
): { pass: boolean; reason?: string } {
  const allInvocations = turns.flatMap((t) => t.tool_invocations);
  const lastAssistantText = turns[turns.length - 1]?.assistant_text ?? "";

  switch (c.kind) {
    case "correct_tool_called": {
      const hits = allInvocations.filter((i) => i.name === c.tool);
      if (hits.length === 0)
        return { pass: false, reason: `tool ${c.tool} never called` };
      if (!c.args_include) return { pass: true };
      const matched = hits.some((h) => shallowIncludes(h.input, c.args_include!));
      return matched
        ? { pass: true }
        : { pass: false, reason: `${c.tool} called but args did not include expected fields` };
    }
    case "no_tool_called":
      return allInvocations.length === 0
        ? { pass: true }
        : {
            pass: false,
            reason: `expected no tool calls, got [${allInvocations
              .map((i) => i.name)
              .join(", ")}]`,
          };
    case "no_initiate_return_called":
      return allInvocations.some((i) => i.name === "initiate_return")
        ? { pass: false, reason: "initiate_return was called" }
        : { pass: true };
    case "escalation_triggered": {
      const escalations = allInvocations.filter((i) => i.name === "escalate_to_human");
      if (escalations.length === 0)
        return { pass: false, reason: "escalate_to_human never called" };
      if (c.reason_code) {
        const found = escalations.find(
          (e) => (e.input as { reason_code?: string }).reason_code === c.reason_code
        );
        return found
          ? { pass: true }
          : {
              pass: false,
              reason: `escalated but reason_code was not ${c.reason_code}`,
            };
      }
      if (c.reason_code_any_of && c.reason_code_any_of.length > 0) {
        const set = new Set(c.reason_code_any_of);
        const found = escalations.find((e) =>
          set.has((e.input as { reason_code?: string }).reason_code ?? "")
        );
        return found
          ? { pass: true }
          : {
              pass: false,
              reason: `escalated but reason_code not in [${c.reason_code_any_of.join(
                ", "
              )}]`,
            };
      }
      return { pass: true };
    }
    case "escalation_not_triggered":
      return allInvocations.some((i) => i.name === "escalate_to_human")
        ? { pass: false, reason: "escalate_to_human was called" }
        : { pass: true };
    case "no_fabrication": {
      const re = /FG-\d{6}/g;
      const cited = new Set(lastAssistantText.match(re) ?? []);
      if (cited.size === 0) return { pass: true };
      const tool = c.must_be_backed_by_tool ?? "lookup_order";
      const looked = new Set(
        allInvocations
          .filter((i) => i.name === tool && i.ok)
          .map((i) => (i.input as { order_number?: string }).order_number)
          .filter((x): x is string => typeof x === "string")
      );
      for (const c of cited) {
        if (!looked.has(c))
          return { pass: false, reason: `final text cites ${c} without a successful ${tool}` };
      }
      return { pass: true };
    }
    case "final_text_includes_any": {
      const hay = c.case_insensitive ? lastAssistantText.toLowerCase() : lastAssistantText;
      const needles = c.case_insensitive
        ? c.substrings.map((s) => s.toLowerCase())
        : c.substrings;
      return needles.some((n) => hay.includes(n))
        ? { pass: true }
        : {
            pass: false,
            reason: `final text did not contain any of [${c.substrings.join(", ")}]`,
          };
    }
    case "final_text_excludes_all": {
      for (const s of c.substrings) {
        if (lastAssistantText.includes(s))
          return { pass: false, reason: `final text leaked "${s}"` };
      }
      return { pass: true };
    }
    case "policy_accurate_30_day_window": {
      const t = lastAssistantText.toLowerCase();
      if (!/30\s*day/.test(t))
        return { pass: false, reason: "policy reply did not mention 30 days" };
      if (/60\s*day|14\s*day|90\s*day/.test(t))
        return { pass: false, reason: "policy reply mentioned wrong window" };
      return { pass: true };
    }
    case "stays_in_scope":
      // Tautological today — structural criteria already enforce this. Kept
      // so golden cases can assert intent in a human-readable way.
      return { pass: true };
  }
}

// --- runner ------------------------------------------------------------------

async function runCase(c: GoldenCase): Promise<CaseResult> {
  const session_id = randomUUID();
  const turns: TurnResult[] = [];
  for (const u of c.turns) {
    const r = await runTurn(session_id, u);
    turns.push(r);
    if (r.errored) break;
  }
  const pass_detail = c.pass_criteria.map((criterion) => {
    const { pass, reason } = evaluateCriterion(criterion, turns);
    return { criterion, pass, reason };
  });
  const passed = pass_detail.every((p) => p.pass);
  return { case: c, turns, pass_detail, passed };
}

function colourize(pass: boolean): string {
  // Respect NO_COLOR; default to coloured.
  if (process.env.NO_COLOR) return pass ? "PASS" : "FAIL";
  return pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
}

async function main(): Promise<void> {
  const goldenPath = join(process.cwd(), "data", "golden-set.json");
  const cases = JSON.parse(readFileSync(goldenPath, "utf-8")) as GoldenCase[];

  console.log(`Running ${cases.length} golden cases against ${BASE_URL}\n`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    process.stdout.write(`  #${String(c.id).padStart(2)} ${c.title.slice(0, 58).padEnd(60)} `);
    try {
      const r = await runCase(c);
      results.push(r);
      process.stdout.write(
        `${colourize(r.passed)}  (${r.pass_detail.filter((p) => p.pass).length}/${r.pass_detail.length})\n`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\x1b[31mERROR\x1b[0m  ${message}\n`);
      results.push({
        case: c,
        turns: [],
        pass_detail: [],
        passed: false,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`\n${passed}/${total} cases passed.`);

  const failures = results
    .filter((r) => !r.passed)
    .map((r) => ({
      id: r.case.id,
      title: r.case.title,
      category: r.case.category,
      failed_criteria: r.pass_detail
        .filter((p) => !p.pass)
        .map((p) => ({ criterion: p.criterion, reason: p.reason })),
      turns: r.turns,
    }));

  const failuresPath = join(process.cwd(), "evals", "failures.json");
  mkdirSync(join(process.cwd(), "evals"), { recursive: true });
  writeFileSync(failuresPath, JSON.stringify(failures, null, 2), "utf-8");
  console.log(
    failures.length === 0
      ? "No failures."
      : `Wrote ${failures.length} failures to ${failuresPath}`
  );

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
