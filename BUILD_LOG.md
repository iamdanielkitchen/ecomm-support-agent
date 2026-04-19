# BUILD_LOG

## 2026-04-18 — Run start, plan summary

Overnight run started. Read `CLAUDE.md` (currently named `CLAUDE.md.txt` — I'll
fix the name as part of the scaffold). Authoritative plan as I understand it:

- **Product**: Fieldstone Goods support agent ("Ember"). Narrow scope (order
  lookup, return eligibility, initiate return, escalate to human). Portfolio piece,
  not production — the point is the architecture around the agent, not its surface
  area.
- **Stack**: Next.js App Router + TypeScript strict, Anthropic SDK direct (no
  LangChain / AI SDK wrappers), Vercel target, `pnpm`. In-memory `Map<session_id,
  SessionState>` — no DB, no Redis. Hardcoded `data/store.json` — no RAG.
- **Deliverables for tonight** (Sections 1, 3, 4, 5, 7 of CLAUDE.md): repo
  scaffold, system prompt, 4 tool schemas + implementations, 12-order
  `store.json`, session state + TTL sweeper, streaming tool_use agent loop,
  functional chat UI, `/debug` view, JSONL per-turn logger, 18-case golden set,
  eval harness run once with failures dumped.
- **Explicitly out of scope tonight**: Vercel deploy/login, any OAuth, any
  `git push`. Local commits only.
- **Commit discipline**: small commits after each block (~8–10 total). Messages
  written as if to a senior teammate — no `wip`.
- **Stopping condition**: all sections done, or 7h elapsed, or 3 consecutive
  unroutable blockers.

### Ambiguities flagged for AM

1. **Model ID mismatch in CLAUDE.md**. The spec says "Claude Sonnet 4.6 as the
   default model (`claude-sonnet-4-5`)". Those are inconsistent — `claude-sonnet-4-5`
   is a Sonnet 4.5 identifier, not 4.6. I'll centralize the model ID in
   `lib/anthropic.ts` as a single constant so it's a one-line change, default it
   to `claude-sonnet-4-5` (matching the literal parenthetical), and leave a
   `TODO: decide AM` comment pointing here. Easy to flip in the morning.
2. **CLAUDE.md filename**: committed as `CLAUDE.md.txt`. I'll rename to
   `CLAUDE.md` so the operator's "read CLAUDE.md first" instruction matches the
   file actually in the tree.
3. **Section numbering for the brief**. The brief says "Sections 1, 3, 4, 5, 7"
   but CLAUDE.md doesn't number sections. I'm mapping to the hour-by-hour plan
   blocks: (1) scaffold, (3) prompt+tools+data, (4) agent loop + session state,
   (5) chat UI, (7) debug view + logger. Section 2 = "deploy empty app" is
   skipped per the no-deploy rule; section 6 = break; later sections = eval
   harness + docs, which I'll attempt as time allows after the core path.

### Blocker hit on first action: Node / pnpm not installed

Neither `node` nor `pnpm` is on PATH, and no portable copy exists under the
user profile. I attempted `winget install OpenJS.NodeJS.LTS --scope user`; the
harness denied it as out-of-scope (system-wide install outside the project
directory). Per the brief's "three blocked attempts then document and move on"
rule, I'm not retrying. Consequences:

- I **can** write every source file, config, data file, and eval case.
- I **can** commit via git (git itself is available).
- I **cannot** run `pnpm install`, `pnpm build`, or `pnpm eval`. The "run
  `pnpm build` after each block" check in the brief is not achievable; ditto
  "run the eval harness at least once before stopping".

Plan: proceed by writing all source, committing incrementally, and leaving
`pnpm install && pnpm build && pnpm eval` as the first morning step. I'll be
extra-careful about TS types and schemas since I can't lean on the compiler
to catch mistakes — will hand-walk imports and types as I write.

Next: rename CLAUDE.md.txt → CLAUDE.md, `git init`, scaffold package.json +
tsconfig + next.config + the directory tree, first commit.

## 2026-04-18 — Status check (through Section 7a)

**Finished since start**: Scaffold (Next 14 App Router, strict TS, `.gitignore`,
`README.md`, CI-less layout). System prompt lifted verbatim from CLAUDE.md.
Four tool schemas + implementations in `lib/tools.ts` with a clean dispatcher
and injectable `now()` for the eval runner. Fake store hand-authored with all
12 enumerated scenarios anchored to today (2026-04-18) so the 30-day window
math hits the intended boundaries. Session state map with a 30-min TTL sweeper
guarded against hot-reload double-start. JSONL turn logger. Full streaming
agent loop with a 6-hop guardrail, emitting NDJSON events for text deltas,
tool-use starts/results, escalations, end-of-turn, and errors. Chat UI with
inline tool pills and an escalation banner that disables input. Debug view at
`/debug?session={id}` with summary strip, turn timeline, handoff payload card,
and 2s auto-refresh.

**Working on next**: Section 7b is already done (bundled with 3c). Next is the
18-case golden set + `evals/run.ts` replay harness. I'll generate the golden
set with `pass_criteria` using the rubric vocabulary (`correct_tool_called`,
`escalation_triggered`, etc.) and build a harness that hits the local
`/api/chat` endpoint, parses the NDJSON stream, and scores each case.

**TODOs left for the morning**:
- **Model ID**: `lib/anthropic.ts` currently uses `claude-sonnet-4-5` (literal
  from CLAUDE.md); CLAUDE.md prose says "Sonnet 4.6". One-line flip.
- **`pnpm install` + `pnpm build`**: I never ran either. The code typechecks
  in my head but nothing on this box can compile it. Run `pnpm install && pnpm
  build` as the first AM step; expect minor type fixes around Anthropic SDK
  imports (`ToolUseBlock` vs `Messages.ToolUseBlock`, etc.).
- **LLM-as-judge tone scoring**: the harness will score the structural
  criteria cleanly; I'll stub the `tone_appropriate` judge but leave it
  non-blocking since we can't actually call Claude from this box.

**Blockers**: Still the same one, not resolved — Node / pnpm not installed on
this machine, winget install denied as out-of-scope. I'm writing + committing;
compilation and eval execution are morning tasks. No new blockers.
