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

## 2026-04-18 — STOPPED

All of Sections 1, 3, 4, 5, 7 from CLAUDE.md are written and committed. Seven
clean commits on `main`:

```
1fd3b3b test(eval): 18-case golden set + replay harness + rubric doc
eb3eb0b chore(log): 45-min status append through Section 7a
fa873e2 feat(debug): per-session trace viewer at /debug?session={id}
08028c7 feat(ui): functional streaming chat UI with collapsible tool trace
85404fd feat(agent): wire streaming tool_use loop + /api/chat + /api/session/[id]
eeef1be feat(agent): system prompt, 4 tool schemas, store fixture, session + logger
0b36538 chore(scaffold): initialize Next.js + TypeScript project layout
```

### Why stopping now
Not time-triggered (nowhere near the 7h cap). The work scoped for tonight is
written; the next steps (compile, run the dev server, run the eval harness,
iterate on failures) all require Node, which I couldn't install on this box.
Rather than keep layering unverified code on an un-runnable codebase, I'm
handing it off. Every file has been hand-walked for types before commit, but I
expect small fixups on first compile — that is exactly the work that benefits
from you being in the loop.

### State of the codebase
- `package.json` pinned to Next 14.2.15, React 18.3.1, `@anthropic-ai/sdk`
  ^0.30.1, `tsx` ^4 for the eval runner. Node 20+ required.
- Strict TypeScript, `noUncheckedIndexedAccess` on. ESM throughout (`"type":
  "module"`). Path alias `@/*` → project root.
- No lockfile — `pnpm install` will generate one on first run.
- `.env.local` not created (per "do not modify .env.local"). You'll need to
  `cp .env.example .env.local` and add your key before `pnpm dev`.

### What I should tackle first in the morning, in order

1. **Install Node 20 + pnpm, then `pnpm install && pnpm typecheck && pnpm
   build`.** The typecheck is the single highest-value thing to run — it'll
   surface any Anthropic SDK type drift I couldn't see. Likely suspects:
   - `Anthropic.ToolUseBlock` vs `Anthropic.Messages.ToolUseBlock` depending
     on SDK version.
   - `Anthropic.ToolResultBlockParam` shape (newer SDKs may nest it).
   - `stream.on("text", ...)` signature — second arg is `textSnapshot` which
     I'm ignoring; should be fine.
2. **Resolve the model ID ambiguity.** `lib/anthropic.ts` has a `TODO: decide
   AM` on the MODEL_ID constant. CLAUDE.md is internally inconsistent — it
   says "Sonnet 4.6" in prose and `claude-sonnet-4-5` in the parenthetical.
   I defaulted to the literal string. One-line flip either way.
3. **Smoke test end-to-end once it compiles.** `pnpm dev`, load `/`, send one
   clean happy-path turn ("status of FG-100001 maya.ortiz@example.com"), watch
   the tool pill render, open `/debug?session={id}` in another tab.
4. **Run the eval harness.** `pnpm dev` in one terminal, `pnpm eval` in
   another. Check `evals/failures.json`. Expect 2–4 failures on the first
   run — the criteria for case 6 ("wrong format") and case 8 ("missing
   info") are the most brittle since they depend on the model asking the
   right follow-up rather than guessing.
5. **Only after steps 1–4 are green**: Vercel deploy, README polish, demo
   video. Those are what the overnight run was *not* authorized to do.

### What I deliberately did *not* write (cut list deferred)

- Per CLAUDE.md's cut list, `initiate_return` is fully implemented rather than
  stubbed. The code is short enough that cutting it would have saved maybe 10
  minutes — not worth the loss of surface area.
- No screenshots, no demo video, no Vercel deploy — out of scope for tonight.
- No LLM-as-judge for `tone_appropriate` — rubric documents it, harness reserves
  the slot, implementation is not there. Easy follow-up.

### Blockers encountered

1. **Node / pnpm not installed.** One attempt to `winget install
   OpenJS.NodeJS.LTS --scope user` denied as out-of-scope. Per brief's
   three-attempt rule, did not retry — documented and routed around.
   Single unresolved blocker. Sum total impact: I couldn't execute any of the
   code I wrote. Code + commits are the deliverable.

No second or third blocker. The run is stopping on the "work scoped for
tonight is written" condition, with the caveat above.

