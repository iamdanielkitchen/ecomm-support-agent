// Golden-set replay harness.
//
// Two modes:
//   Path 1 (default):   structural pass/fail against data/golden-set.json
//   Path 2 (--rag):     LLM-as-judge with Opus 4.7 against
//                       data/golden-set-rag.json, two runs per case for
//                       stability, writes evals/results/{ts}.json and
//                       evals/results/{ts}-failures.md
//
// Usage (assume dev server is running locally via `pnpm dev`):
//   pnpm eval                              # Path 1 structural
//   pnpm eval:rag                          # RAG set, LLM judge, 2 runs
//   pnpm eval:rag -- --limit 3             # first 3 RAG cases only
//   pnpm eval:rag -- --runs 1              # skip stability double-run
//   FIELDSTONE_BASE_URL=https://... pnpm eval  # point at a remote deploy

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

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

// --- Path 2 additions: RAG golden set + LLM-as-judge ----------------------

type GoldenRagCase = {
  id: string;
  description: string;
  turns: Array<{ role: string; content: string }>;
  expectations: {
    tool_sequence: string[];
    escalation_expected: boolean;
    grounding_required: boolean;
    pass_criteria: string;
  };
};

type JudgeDim = "pass" | "fail" | "n/a";

type JudgeVerdict = {
  tool_routing: Exclude<JudgeDim, "n/a">;
  tool_routing_reason: string;
  grounding: JudgeDim;
  grounding_reason: string;
  escalation: JudgeDim;
  escalation_reason: string;
  response_quality: Exclude<JudgeDim, "n/a">;
  response_quality_reason: string;
  overall_pass: boolean;
  notes?: string;
};

type RagRunResult = {
  run_index: number;
  turns: TurnResult[];
  judge_verdict: JudgeVerdict | null;
  judge_tokens: { in: number; out: number };
  judge_latency_ms: number;
  judge_error?: string;
};

type RagCaseResult = {
  case: GoldenRagCase;
  runs: RagRunResult[];
  stable: boolean;
  divergence_note: string | null;
};

type RagArgs = {
  limit: number | null;
  runs: number;
};

// Opus 4.7 is the interview-surface judge: slower and pricier than Sonnet
// but catches nuance on grounding and escalation the structural harness
// misses. Judge cost is the gating concern — we pace runs and cap limits.
const JUDGE_MODEL = "claude-opus-4-7";
const JUDGE_MAX_TOKENS = 1200;
// Public Opus rates at build time. These are used only for the cost
// estimate line in the aggregate output; Anthropic billing is authoritative.
const OPUS_IN_PRICE_PER_MTOK = 15;
const OPUS_OUT_PRICE_PER_MTOK = 75;

const JUDGE_SYSTEM = `You are evaluating a customer-support assistant's performance on a test case
for Fieldstone Goods, an e-commerce store of home and kitchen goods.

You receive the case (description, expectations, pass criteria) and the
actual transcript (customer turns, agent tool trace, final reply). Return a
single JSON object with these fields, nothing else, no code fences:

{
  "tool_routing":           "pass" | "fail",
  "tool_routing_reason":    string (under 30 words),
  "grounding":              "pass" | "fail" | "n/a",
  "grounding_reason":       string (under 30 words),
  "escalation":             "pass" | "fail" | "n/a",
  "escalation_reason":      string (under 30 words),
  "response_quality":       "pass" | "fail",
  "response_quality_reason": string (under 30 words),
  "overall_pass":           boolean,
  "notes":                  string (optional, under 40 words)
}

Rubric:
- tool_routing: the agent called the tools expected by tool_sequence. Extra
  calls are OK if they did not distract from the answer. Missing a required
  call is a fail.
- grounding: if grounding_required is true, the reply's factual claims must
  be supported by a tool output, a retrieved chunk, or the system policy
  block (30-day window, $7.95 opened-item fee, 5–7 business-day refund,
  standard 3–5 day / expedited 1–2 day shipping). Fabricated SKUs, prices,
  timelines, or certifications are a fail. Use "n/a" only if the reply made
  no factual claims (pure clarifying question or boundary-setting refusal).
- escalation: if escalation_expected is true, escalate_to_human must have
  been called with a reasonable reason_code. If false, escalate_to_human
  must NOT have been called (verbal refusal is fine). "n/a" only if the
  case is irrelevant to escalation (rare).
- response_quality: the reply is specific, warm, in Fieldstone voice, and
  moves the customer forward. Empty, evasive, over-apologetic, or
  contradicting-itself replies fail.

overall_pass = true iff every applicable dimension passes (ignoring "n/a").`;

function previewOutput(output: unknown): string {
  // Truncate large tool outputs so the judge prompt stays under a few
  // thousand tokens per case. search_help_center's \`content\` field can
  // balloon; trim it to the first ~1500 chars and keep metadata intact.
  if (!output || typeof output !== "object") return JSON.stringify(output);
  const shallow: Record<string, unknown> = { ...(output as Record<string, unknown>) };
  if (typeof shallow["content"] === "string") {
    const s = shallow["content"] as string;
    if (s.length > 1500) shallow["content"] = s.slice(0, 1500) + "…[truncated]";
  }
  return JSON.stringify(shallow);
}

function buildJudgeUserPrompt(c: GoldenRagCase, turns: TurnResult[]): string {
  const toolLines: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    toolLines.push(`  — user turn ${i + 1}: ${t.user}`);
    for (const inv of t.tool_invocations) {
      toolLines.push(`    TOOL ${inv.name}(${JSON.stringify(inv.input)})`);
      toolLines.push(`      → output: ${previewOutput(inv.output)}`);
    }
  }
  const lastReply = turns[turns.length - 1]?.assistant_text ?? "";

  return `CASE
id: ${c.id}
description: ${c.description}
expected tool_sequence: ${JSON.stringify(c.expectations.tool_sequence)}
escalation_expected: ${c.expectations.escalation_expected}
grounding_required: ${c.expectations.grounding_required}
pass_criteria: ${c.expectations.pass_criteria}

TRANSCRIPT
${toolLines.join("\n")}

FINAL ASSISTANT REPLY
${lastReply}

Evaluate per the rubric. Return JSON only.`;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return m && m[1] !== undefined ? m[1].trim() : trimmed;
}

let _judgeClient: Anthropic | null = null;
function getJudgeClient(): Anthropic {
  if (_judgeClient) return _judgeClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — judge cannot run");
  }
  _judgeClient = new Anthropic({ apiKey });
  return _judgeClient;
}

async function judgeRun(
  c: GoldenRagCase,
  turns: TurnResult[],
): Promise<{
  verdict: JudgeVerdict | null;
  tokens: { in: number; out: number };
  latency_ms: number;
  error?: string;
}> {
  const client = getJudgeClient();
  const user = buildJudgeUserPrompt(c, turns);
  const start = Date.now();
  try {
    const response = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: JUDGE_MAX_TOKENS,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    const latency_ms = Date.now() - start;
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    const verdict = JSON.parse(stripJsonFence(text)) as JudgeVerdict;
    return {
      verdict,
      tokens: {
        in: response.usage.input_tokens,
        out: response.usage.output_tokens,
      },
      latency_ms,
    };
  } catch (err) {
    return {
      verdict: null,
      tokens: { in: 0, out: 0 },
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runRagCase(
  c: GoldenRagCase,
  runs: number,
): Promise<RagCaseResult> {
  const runResults: RagRunResult[] = [];
  for (let r = 0; r < runs; r++) {
    const session_id = randomUUID();
    const turns: TurnResult[] = [];
    for (const turn of c.turns) {
      if (turn.role !== "user") continue;
      const tr = await runTurn(session_id, turn.content);
      turns.push(tr);
      if (tr.errored) break;
    }
    const judged = await judgeRun(c, turns);
    runResults.push({
      run_index: r,
      turns,
      judge_verdict: judged.verdict,
      judge_tokens: judged.tokens,
      judge_latency_ms: judged.latency_ms,
      judge_error: judged.error,
    });
  }
  const overalls = runResults.map((r) => r.judge_verdict?.overall_pass ?? null);
  const first = overalls[0];
  const stable =
    overalls.length <= 1 || overalls.every((v) => v === first);
  const divergence_note = stable
    ? null
    : `overall_pass diverged across runs: [${overalls.join(", ")}]`;
  return { case: c, runs: runResults, stable, divergence_note };
}

function parseRagArgs(argv: string[]): RagArgs {
  const args: RagArgs = { limit: null, runs: 2 };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i++];
    if (a === undefined) continue;
    if (a === "--" || a === "--rag") continue;
    if (a === "--limit") {
      const v = argv[i++];
      if (!v) throw new Error("--limit requires a number");
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit must be positive, got "${v}"`);
      }
      args.limit = n;
    } else if (a === "--runs") {
      const v = argv[i++];
      if (!v) throw new Error("--runs requires a number");
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--runs must be a positive integer, got "${v}"`);
      }
      args.runs = n;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

function emitRagResults(
  cases: RagCaseResult[],
  args: RagArgs,
): { resultsPath: string; failuresPath: string | null; cost: number } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = join(process.cwd(), "evals", "results");
  mkdirSync(resultsDir, { recursive: true });

  const allRuns = cases.flatMap((c) => c.runs);
  const judgedRuns = allRuns.filter((r) => r.judge_verdict !== null);
  const passedRuns = judgedRuns.filter((r) => r.judge_verdict!.overall_pass).length;
  const totalIn = allRuns.reduce((s, r) => s + r.judge_tokens.in, 0);
  const totalOut = allRuns.reduce((s, r) => s + r.judge_tokens.out, 0);
  const cost =
    (totalIn / 1_000_000) * OPUS_IN_PRICE_PER_MTOK +
    (totalOut / 1_000_000) * OPUS_OUT_PRICE_PER_MTOK;

  const jsonBody = {
    timestamp: new Date().toISOString(),
    judge_model: JUDGE_MODEL,
    runs_per_case: args.runs,
    cases: cases.map((c) => ({
      id: c.case.id,
      description: c.case.description,
      expectations: c.case.expectations,
      runs: c.runs.map((r) => ({
        run_index: r.run_index,
        judge_verdict: r.judge_verdict,
        judge_tokens: r.judge_tokens,
        judge_latency_ms: r.judge_latency_ms,
        judge_error: r.judge_error,
        turns: r.turns,
      })),
      stable: c.stable,
      divergence_note: c.divergence_note,
    })),
    aggregate: {
      total_cases: cases.length,
      total_runs: allRuns.length,
      judged_runs: judgedRuns.length,
      passed_runs: passedRuns,
      pass_rate: judgedRuns.length > 0 ? passedRuns / judgedRuns.length : 0,
      stable_cases: cases.filter((c) => c.stable).length,
      unstable_cases: cases.filter((c) => !c.stable).length,
      total_tokens_in: totalIn,
      total_tokens_out: totalOut,
      estimated_cost_usd: cost,
    },
  };

  const resultsPath = join(resultsDir, `${timestamp}.json`);
  writeFileSync(resultsPath, JSON.stringify(jsonBody, null, 2), "utf-8");

  const failing = cases.filter(
    (c) =>
      c.runs.some(
        (r) => r.judge_verdict === null || !r.judge_verdict.overall_pass,
      ) || !c.stable,
  );
  let failuresPath: string | null = null;
  if (failing.length > 0) {
    failuresPath = join(resultsDir, `${timestamp}-failures.md`);
    writeFileSync(failuresPath, buildFailuresMarkdown(failing), "utf-8");
  }

  return { resultsPath, failuresPath, cost };
}

function buildFailuresMarkdown(failing: RagCaseResult[]): string {
  const lines: string[] = [];
  lines.push(`# RAG eval failures — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`${failing.length} failing/unstable case(s).`);
  lines.push("");
  for (const c of failing) {
    lines.push(`## ${c.case.id}: ${c.case.description}`);
    lines.push("");
    lines.push(`**stable:** ${c.stable}${c.divergence_note ? ` — ${c.divergence_note}` : ""}`);
    lines.push("");
    for (const r of c.runs) {
      lines.push(`### run ${r.run_index}`);
      lines.push("");
      if (r.judge_error) {
        lines.push(`**judge error:** ${r.judge_error}`);
      } else if (r.judge_verdict) {
        const v = r.judge_verdict;
        lines.push(`**overall_pass:** ${v.overall_pass}`);
        lines.push(`- tool_routing: \`${v.tool_routing}\` — ${v.tool_routing_reason}`);
        lines.push(`- grounding: \`${v.grounding}\` — ${v.grounding_reason}`);
        lines.push(`- escalation: \`${v.escalation}\` — ${v.escalation_reason}`);
        lines.push(`- response_quality: \`${v.response_quality}\` — ${v.response_quality_reason}`);
        if (v.notes) lines.push(`- notes: ${v.notes}`);
      }
      lines.push("");
      lines.push("**turns:**");
      for (const t of r.turns) {
        lines.push(`- user: ${t.user}`);
        for (const inv of t.tool_invocations) {
          lines.push(`  - \`${inv.name}\`(${JSON.stringify(inv.input)}) → ${previewOutput(inv.output).slice(0, 200)}…`);
        }
        lines.push(`  - reply: ${t.assistant_text.slice(0, 500)}${t.assistant_text.length > 500 ? "…" : ""}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function runRagMode(cliArgs: string[]): Promise<void> {
  const args = parseRagArgs(cliArgs);
  const goldenPath = join(process.cwd(), "data", "golden-set-rag.json");
  let cases = JSON.parse(readFileSync(goldenPath, "utf-8")) as GoldenRagCase[];
  if (args.limit !== null) cases = cases.slice(0, args.limit);

  console.log(
    `Running ${cases.length} RAG case(s) × ${args.runs} run(s) against ${BASE_URL} (judge: ${JUDGE_MODEL})\n`,
  );

  const results: RagCaseResult[] = [];
  for (const c of cases) {
    process.stdout.write(
      `  ${c.id.padEnd(8)} ${c.description.slice(0, 54).padEnd(56)} `,
    );
    try {
      const r = await runRagCase(c, args.runs);
      results.push(r);
      const verdicts = r.runs.map((run) =>
        run.judge_verdict === null
          ? "ERR"
          : run.judge_verdict.overall_pass
            ? "P"
            : "F",
      );
      const stableMark = r.stable ? "=" : "≠";
      process.stdout.write(`[${verdicts.join(" ")}] ${stableMark}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`ERROR  ${message}\n`);
    }
  }

  const { resultsPath, failuresPath, cost } = emitRagResults(results, args);

  const allRuns = results.flatMap((c) => c.runs);
  const judgedRuns = allRuns.filter((r) => r.judge_verdict !== null);
  const passedRuns = judgedRuns.filter((r) => r.judge_verdict!.overall_pass).length;
  const totalIn = allRuns.reduce((s, r) => s + r.judge_tokens.in, 0);
  const totalOut = allRuns.reduce((s, r) => s + r.judge_tokens.out, 0);

  console.log("");
  console.log(`judged runs:    ${passedRuns}/${judgedRuns.length} passed`);
  console.log(
    `stable cases:   ${results.filter((r) => r.stable).length}/${results.length}`,
  );
  console.log(
    `tokens:         ${totalIn.toLocaleString()} in · ${totalOut.toLocaleString()} out`,
  );
  console.log(`estimated cost: $${cost.toFixed(4)} (Opus 4.7 public rates)`);
  console.log(`results:        ${resultsPath}`);
  if (failuresPath) console.log(`failures:       ${failuresPath}`);
}

// --- entry point ----------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--rag")) {
    await runRagMode(argv);
    return;
  }

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
