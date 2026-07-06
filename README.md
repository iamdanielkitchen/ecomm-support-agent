# Fieldstone Support Agent

A support agent you can actually trust with a real customer — it takes any
query and reliably gives a useful answer, and the word "reliably" is earned:
what it knows and doesn't know is measured, and it hands off the moment it
isn't sure. Escalating isn't the system failing; it's the system working
exactly as designed.

Every support agent claims it's reliable. Fieldstone is built around the
opposite discipline: an agent whose most valuable move is recognizing the
edge of its own knowledge and handing off there, every time, without
exception. Nothing runs on inference the model was left to improvise — every
action is a typed decision (order lookup, return eligibility, escalation),
and confidence is never asserted, it's checked against two independent
signals in the open. When the order tools can't answer it, it retrieves from
a 50-article help center built from the store's own data.

**Live:** [ecomm-support-agent.vercel.app](https://ecomm-support-agent.vercel.app)
**Debug:** `/debug?session={id}` — the chat is the input; the debug view is where
the agent's decisions are legible. That's the part worth looking at.

## Demo paths

- **Happy path.** *"Can I check order FG-100001?"* → agent asks for the email
  → `lookup_order` → delivered status from `store.json`. One tool call, no
  fabrication.
- **Return flow with tool routing.** *"Return the cutting board on FG-100001,
  maya.ortiz@example.com"* → `lookup_order` → `check_return_eligibility` →
  policy-correct reply citing the 30-day window and the $7.95 opened-item fee.
  Eligibility from the tool, timelines from the policy block, nothing from
  inference.
- **Hard escalation.** *"I want to dispute a charge on my card"* →
  `escalate_to_human` on turn one with `reason_code: "payment_dispute"`, session
  terminal. The eleven-value enum is what a contact-center platform would route on.
- **Retrieval with confidence disagreement.** *"How do I season a cast iron
  pan?"* → `search_help_center` pulls five on-topic chunks, the reply is solidly
  grounded. Haiku sees the reply without the chunks and rates it under-specific
  (~0.50); the retrieval-derived score sees top-1 cosine 0.66 and reads high
  (~0.91). Open `/debug` on this turn — the dual-signal panel shows the
  disagreement with the structural reason alongside. The disagreement is the
  demo-worthy moment, not a bug.

## Architecture

Next.js App Router, Node runtime. Anthropic SDK direct — no LangChain, no
LlamaIndex, no AI SDK wrapper, no agent framework. Embeddings on `voyage-4-lite`
via MongoDB Atlas's `/v1/embeddings` endpoint (the Atlas-scoped key 403s on the
public Voyage host, and the `voyageai` npm SDK 0.2.1 ships a broken ESM export
— `fetch` against the Atlas URL is smaller and more reliable). In-memory
everything: session state in a `Map` on `globalThis`, corpus + embeddings
loaded from JSON at module init. No database, no Redis, no vector store, no
auth layer beyond identity checks inside the tools. Deployed to Vercel.

Sonnet 4.6 for the agent turn, Haiku 4.5 for the post-turn confidence side
call, Opus 4.7 for the eval judge — each tier matched to the task.
`escalate_to_human` is a first-class tool, not a prompt rule, because the
typed `reason_code` enum (`payment_dispute`, `policy_exception`,
`account_access`, `out_of_scope`, etc.) is what a real routing platform would
consume. Dual-signal confidence is instrumented but not gating — measure
calibration first; the disagreement cases have been more informative than
either score alone.

The 50-article help-center corpus is generated once, offline, by Sonnet against
`data/store.json` as authoritative ground truth — every factual claim that
overlaps `store.json` must derive from it. Chunked on H2 boundaries
(265 chunks, ~160-token median), embedded once with Voyage batch, written to
a ~5 MB JSON. At runtime the in-memory cosine takes ~2 ms; the dominant latency
is the query-embedding round trip (~250 ms). Three idempotent pnpm scripts —
generate, chunk, embed — each re-runnable against the previous stage's artifact.

See [`docs/architecture.md`](docs/architecture.md) for the runtime and build-time
diagrams.

## Eval results

18-case RAG golden set, 3 runs per case, judged by Opus 4.7 on four rubric
dimensions (tool routing, grounding, escalation, response quality). Stability
is measured by verdict agreement across runs. One residual miss is documented
in the postmortem — deliberately not patched, because tuning the agent's
natural language to clear a judge rubric is the start of Goodhart drift.

|                                  | cases | runs       | pass rate | stable |
| -------------------------------- | ----: | ---------: | --------: | -----: |
| before three targeted fixes      |    18 | 36 (×2)    |       78% |  16/18 |
| after fixes                      |    18 | 54 (×3)    | **98.1%** |  17/18 |

Reproduce: `pnpm dev` in one terminal, `pnpm eval:rag` in another.

## Postmortem

Build decisions and what I learned: [`docs/POSTMORTEM.md`](docs/POSTMORTEM.md).

## Run it locally

```bash
pnpm install
cp .env.example .env.local          # fill in ANTHROPIC_API_KEY and VOYAGE_API_KEY
pnpm dev                            # http://localhost:3000

# Rebuild the corpus (optional — artifacts are checked in):
pnpm corpus:generate
pnpm corpus:chunk
pnpm corpus:embed

# RAG eval suite against the local server:
pnpm eval:rag
```

## Repo layout

```
app/                chat UI, /debug, /api/chat, /api/session/[id]
lib/                agent.ts · tools.ts · retrieval.ts · confidence.ts · sessions.ts
scripts/            generate-corpus · chunk-corpus · embed-corpus · agent-smoke · retrieval-smoke
evals/              run.ts (Path 1 structural + Path 2 LLM-as-judge) · rubric.md
data/               store.json · golden-set.json · golden-set-rag.json · corpus/
docs/               architecture.md · POSTMORTEM.md · PATH_2_PLAN.md · POSTMORTEM_NOTES.md
```

MIT license.

Built by Daniel Kitchen · nospellingoutloud@gmail.com · github.com/iamdanielkitchen
