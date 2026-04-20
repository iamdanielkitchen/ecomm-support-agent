# Postmortem: Fieldstone Support Agent

Built over two weekends in April 2026. A narrow support agent for a fictional
home-goods store, with a RAG layer, instrumented confidence scoring, and a
judge-graded eval suite. Deployed to Vercel. The [README](../README.md)
covers what it does; this is why it looks the way it does and what I learned
doing it.

I'm a career operator, not a career engineer. I came up through growth and
product at startups where the job was pick what ships, ship it, and defend
the scope. I've been shipping *with* AI for a while. Shipping an AI product
isn't the same muscle, and I wanted to prove I had the second one before
applying to teams that build forward-deployed AI for a living. This repo is
that proof.

## The brief I gave myself

Honest version, because the essay deserves the honest version: cold
applications to forward-deployed AI roles had stopped landing. Parloa,
Cresta, Ada, Writer, Cognigy — these are the companies doing real AI
deployment work in enterprise support, and "operator who also ships" is a
harder story to tell at their resume-review step than I'd like. Build
something they can see instead of something they have to take my word for.

The temptation was to build broad. Voice, multi-channel, a flashy dashboard,
a custom frontend. I didn't. Breadth without depth reads as a portfolio,
and portfolios read as unserious. Narrow agent + production discipline reads
as "this person has shipped." One fictional domain. Four typed tools. One
vector of extension per weekend. All the time I would have spent on surface
went into the architecture around the agent instead of the agent itself.

Weekend 1 was Path 1: system prompt, four tools, streaming chat, session
state, structural eval harness, handoff payload. Weekend 2 was Path 2: RAG
over a generated corpus, threshold calibration, dual-signal confidence,
LLM-judge eval expansion, debug-view rebuild. I wrote the brief for each
weekend in [CLAUDE.md](../CLAUDE.md) and
[docs/PATH_2_PLAN.md](./PATH_2_PLAN.md) before writing code, committed the
plan, and referenced it when scope crept. That discipline is in git
history, which is part of the point.

## Architecture decisions worth defending

**In-memory state, not Redis.** Session state lives in a
`Map<string, SessionState>` hoisted to `globalThis`. No database. No Redis.
No Postgres. A 30-minute TTL sweeper runs every five minutes and clears
stale entries. Process restart wipes everything. I chose this because
"would swap to Redis at 10x volume" is a short, correct answer that
protects the scope. At ten concurrent sessions the Map is fine; at ten
thousand the swap is literally hoist the Map interface behind an async
façade, back it with `ioredis`, change `get`/`set` to `await`. Two days of
work. Shipping the demo required none of it. YAGNI isn't a slogan — it's a
scope-defense tool.

**Anthropic SDK direct, no LangChain / LlamaIndex / AI SDK.** Framework
indirection is the thing that eats you in a debugger. When a tool call
misfires I want to read the exact JSON my code sent to Anthropic and the
exact JSON it sent back. I don't want to step through three layers of
abstraction to find out which of them transformed the schema. The agent
loop in [`lib/agent.ts`](../lib/agent.ts) is about 200 lines. It streams,
dispatches `tool_use` blocks, records invocations, emits events to the
client, handles escalation. That fits in my head. LangChain does not fit
in my head.

**Sonnet 4.6 for the agent, not Opus.** Latency. Support customers are
waiting, not reading an essay. Sonnet 4.6 gets to first token in about a
second; Opus takes meaningfully longer. The eval grader is Opus because
the judgment is the bottleneck there, not the latency. The post-turn
confidence scorer is Haiku because it runs after the stream closes and
only needs to emit a small JSON verdict. Each tier matched to the task,
and each tier's identifier lives in one place
([`lib/anthropic.ts`](../lib/anthropic.ts),
[`lib/confidence.ts`](../lib/confidence.ts), and the judge constant in
[`evals/run.ts`](../evals/run.ts)).

**`escalate_to_human` as a first-class tool, not a fallback.** This is the
whole pattern enterprise contact-center companies sell, so it belongs at
the center of the design. The tool has an eleven-value `reason_code` enum
— `payment_dispute`, `policy_exception`, `account_access`,
`order_modification`, `billing_issue`, `tool_error`,
`customer_requested_human`, `emotional_distress`,
`suspected_fraud_or_security`, `ambiguous_identity`, `out_of_scope`. The
enum is load-bearing. A real contact-center integration consumes that code
and decides who gets paged, what SLA applies, what context bundle goes in
the ticket. In this build I write the payload to
`logs/handoffs/{session_id}.json`; in a real deployment the same code path
POSTs it to a routing API. Nothing else about the design changes.

**Hard vs. soft escalation.** I added this distinction after a smoke run
showed the agent politely offering "want me to connect you with someone?"
on out-of-catalog questions without firing the tool — and the judge marking
it incorrect because the original prompt framed any unanswered question as
an escalation trigger. Wrong shape. An out-of-catalog product question
doesn't need a human ticket; a payment dispute does. I split the prompt to
name two paths: hard escalation (call the tool, session terminal, ticket
created) for authority-bounded problems — payment, policy exceptions,
account access, billing — and soft verbal offers for everything else the
bot can't answer but a human isn't obviously better placed to answer. The
tool ticket costs a real support agent fifteen minutes. A soft offer costs
a customer one more message. That's the math.

## The corpus problem and how I solved it

I needed a help-center corpus for the RAG layer. The easy thing was to
scrape Allbirds or some other real home-goods retailer and chunk that. I
started there — Allbirds' taxonomy was my blueprint — then I realized it
was wrong. The agent's tools read from
[`data/store.json`](../data/store.json), which is the fictional store's
ground truth. If the corpus came from a real retailer, the corpus and the
tools would disagree on every specific fact. The 30-day return window in
`store.json` would clash with whatever Allbirds' actual policy is.
Pretending they didn't would make the demo brittle. Flagging the mismatch
would make the demo noisy.

So I generated the corpus against `store.json` itself. Fifty articles,
produced by [`scripts/generate-corpus.ts`](../scripts/generate-corpus.ts),
which feeds Sonnet a per-article prompt that inlines the policy block and
catalog from `store.json` and instructs the model to treat them as
authoritative. The consistency rule is simple: every factual claim in any
article that overlaps `store.json` must derive from `store.json`. Voice,
structure, and long-tail details (cast-iron seasoning temperatures, RWS
wool certification mechanics) can come from the model's training; dollar
figures, return windows, shipping SLAs, and catalog SKUs must not. I
dropped the Allbirds framing from
[PATH_2_PLAN.md](./PATH_2_PLAN.md) the moment the taxonomy stood on its
own — keeping it would have read as borrowed authority.

The pipeline is three idempotent scripts: generate, chunk (split on H2,
~400-token windows), embed (Voyage batch against the Atlas endpoint with
`input_type="document"`). Artifacts are checked into the repo: 50 articles
→ 265 chunks → a 5.04 MB `embeddings.json` of 1024-dim vectors.
Regenerating the corpus takes about fifteen minutes on the free-tier
Voyage rate; re-chunking plus re-embedding is under two minutes. If
`store.json` changes, the whole chain re-runs.

## Retrieval calibration

The threshold I picked for [`lib/retrieval.ts`](../lib/retrieval.ts) was
0.65 cosine, which is the number you see in most RAG tutorials. It was
wrong for voyage-4-lite on this corpus, and I didn't know it until I ran a
smoke test against six representative queries.

Six queries. One below-threshold control ("what's the weather in
stonington"). Five on-topic queries spanning the scenario shape the agent
handles. The score distribution was not what the 0.65 default implied:

- Noise floor: **0.20** (weather control)
- Weak on-topic: **0.33 – 0.40** — short queries, identifier-style queries
  like `"FG-123456"`
- Solid on-topic: **0.54 – 0.65** — full-sentence semantic matches

At 0.65, four of five on-topic queries filtered out. The threshold was
rejecting legitimate retrievals because voyage-4-lite's asymmetric
query/document embedding pushes query-side scores lower than symmetric
models. Short queries and identifier queries score lower still, because a
terse query has less semantic surface to match against denser document
chunks.

I recalibrated to **0.40**, roughly 2× the observed noise floor. That
passes the three full-sentence on-topic queries with margin and filters the
weather control comfortably. Two on-topic queries still filter at 0.40 —
the terse return-flow query ("how do I return something I opened," 0.390)
and the identifier query ("FG-123456," 0.331) — and I deliberately did not
lower the gate further for them. Both paths are covered by other code: the
return flow runs through `check_return_eligibility`, and order-number-format
questions are answered from the system prompt directly. Retrieval is
backup for those cases, not primary. Shrinking the noise margin to rescue
two backup queries wasn't worth it.

The exported constant `DEFAULT_RETRIEVAL_THRESHOLD = 0.40` lives in
[`lib/retrieval.ts`](../lib/retrieval.ts) as a named export so the eval
harness and the agent pull from one place. If it changes, one edit. The
methodology — measure a distribution, pick a threshold from data, document
what stays uncovered and why — is the reproducible part; the specific
number is specific to this corpus plus this model.

## Dual-signal confidence

This was the least obvious design call in the build, and it turned out to
be the most informative.

How do you know when the agent's answer is trustworthy? Self-scoring is
cheap — run a second model against the user message and the assistant
reply and ask "is this grounded and useful?" The cheap answer is "build
that and use it to gate responses." I didn't do that.

I built two scorers in [`lib/confidence.ts`](../lib/confidence.ts). The
first is a side call to Haiku that grades the reply against the user
message in isolation and returns `{confidence, reason}`. The second is a
retrieval-derived score that normalizes the top-1 cosine from any
`search_help_center` call this turn through `[0.40, 0.70] → [0.3, 1.0]`.
If retrieval didn't run this turn, the second signal is `null`, not zero —
N/A is a real signal, not a failure. Both scores are attached to the
session trace and rendered side by side in `/debug`. Neither gates agent
behavior.

The reason for two scorers lands the first time they disagree. Cast-iron
seasoning: the agent retrieves five strong cast-iron chunks (top-1 cosine
0.660), composes a reply that quotes the retrieved content accurately, and
the dual signals come out:

- Haiku self-score: **0.35** — *"assumes customer bought from Fieldstone
  without confirming"*
- Retrieval-derived score: **0.91** — top-1 cosine high, small gap to top-2

Same reply. Two scorers. Opposite verdicts. The structural reason is
obvious once you see it. Haiku can't see the retrieved chunks, so it can't
distinguish "the agent quoted a fact from a chunk" from "the agent
invented a fact from training data." Retrieval-derived confidence knows
the chunks were strong. Haiku only knows the reply reads confident. If I'd
built one scorer, I'd have gotten either false-low (Haiku reading
quoted-facts as fabrication) or false-high (retrieval saying "chunks were
strong" when the agent ignored them). Two scorers, independently, tell me
which failure mode I'm in.

The instrumentation surfaced a retry heuristic I didn't design for. Across
the first full eval run, self-score **< 0.70** AND retrieval-not-used
caught **five of six** retrieval-miss failures. It's a cheap signal.
"Agent declined a question, wasn't confident, and didn't try retrieval" is
the shape of "agent should have called `search_help_center` first." I
haven't shipped this as an automated retry. It's a finding, not a feature.
But it exists because I measured before I gated. If you instrument
honestly, the system tells you what to build.

## Evals and judge calibration

Path 2 needed a real eval suite. I extended the Path 1 structural harness
in [`evals/run.ts`](../evals/run.ts) with a Path 2 mode: 18 RAG cases in
[`data/golden-set-rag.json`](../data/golden-set-rag.json), 3 runs per
case for stability, Opus 4.7 as the judge, four rubric dimensions (tool
routing, grounding, escalation appropriateness, response quality). A case
is stable if every run agrees on `overall_pass`.

First full run: **28/36 (78%)**. Not a pass. Eight failures across five
cases. I resisted the urge to patch reflexively and built a condensed
failure summary instead — one paragraph per failing run: query text, tools
called, retrieval top-1, agent reply, full judge reasoning, one-line
diagnosis. Four diagnosis categories: `SYSTEM_PROMPT gap`,
`real agent bug`, `judge calibration issue`, `retrieval infra issue`. All
eight failures fell into three patterns. Six were `SYSTEM_PROMPT gap` —
agent refusing product questions with variations of "I don't have access
to the catalog" instead of calling `search_help_center` first. One was
judge calibration (truncation of retrieved content hid the decisive
chunks from the judge's view). One was a retrieval infra cascade — Voyage
free-tier 3 RPM ceiling returning 429 mid-eval, agent fabricating
wood-care advice when the tool errored.

Three targeted fixes:

1. `fix(prompt): close retrieval-first gap on catalog/product questions` —
   a paragraph in the system prompt naming the anti-phrases ("I don't have
   access to the catalog") and requiring `search_help_center` before
   declining any product / care / sizing / existence question. Closed
   rag-8, rag-12, rag-13.
2. `fix(evals): bump judge chunk truncation 1500→4000 chars` — the judge
   was flagging legitimate grounded claims as fabricated because the
   truncated content didn't show the evidence. Closed rag-6.
3. `fix(prompt): explicit tool-error handling, no knowledge substitution` —
   stricter language specifically for `search_help_center` errors, plus a
   parallel infra fix (added a payment method to the Voyage account, which
   keeps the 200M-token free tier intact but raises the RPM ceiling to
   production limits). Closed rag-4.

Re-ran with 3 runs per case for a better stability signal: **53/54 (98.1%)**.
17 of 18 cases stable. Zero regressions on previously-passing cases. Total
judge cost: **$2.37**.

The residual failure was rag-13, copper colander — one of the three runs.
The agent correctly retrieved, correctly got `NO_RELEVANT_CONTENT` back,
correctly declined to fabricate a restock date. The failing run used the
phrase *"our inventory team tracks those details"* and the judge read that
as implicit confirmation the product exists. The other two runs phrased
the same handoff a little differently and the judge cleared them.

I deliberately did not patch this. Tuning the agent's natural language to
clear a judge nuance is the start of Goodhart drift — optimizing for the
test instead of the thing the test is supposed to measure. The same agent
behavior passed two of three judge runs on identical retrieval. That's
judge-side noise, not agent misbehavior. The essay reports it rather than
patches it, which is the call I want recruiters reading this to see.

## What broke during the build

Three real things, each one I paid for in time.

**The MongoDB Atlas / Voyage endpoint mismatch.** I installed the `voyageai`
npm SDK, wired the embed script, got back `403 Forbidden` on every call.
My Voyage key had been issued through MongoDB Atlas, which hosts Voyage
models behind its own endpoint (`ai.mongodb.com/v1/embeddings`) rather
than the public `api.voyageai.com/v1/embeddings` the SDK defaults to.
Different hosts, different auth scopes, same model catalog. The SDK had no
flag to change the base URL. I also discovered the SDK's 0.2.1 release
ships a broken ESM export anyway — it imports a non-existent `.jsx` file —
so I dropped the SDK entirely and hit the Atlas URL with native `fetch`.
Smaller, more reliable, and I could see exactly what bytes were leaving
the process. About thirty minutes lost; lesson kept.

**The Voyage free-tier 3 RPM ceiling cascading into fabrication.** During
the first full eval run, one case (rag-4, walnut cutting board) returned
`search_help_center: {error: "Voyage 429..."}` because the burst of
retrieval calls exceeded the free tier's three-requests-per-minute ceiling.
The agent handled the error badly — acknowledged briefly ("the help-center
search hit a technical issue"), then filled the void with generic
wood-care advice pulled from its training data. Judge flagged it as
grounding fail, correctly.

Two-layer fix. Code side: tighten the system prompt for
`search_help_center` errors specifically, forbid knowledge substitution on
tool failure. Infra side: add a payment method to the Voyage Atlas account.
This looks like a spending decision but isn't. Adding a payment method
keeps the 200M-token free tier — those tokens stay free — but raises the
RPM/TPM ceiling to production-tier limits. The free tier's 3 RPM cap is a
throughput-shape gate, not a spending gate. Eval suites and batch
operations hit that gate long before they'd hit the token budget. The
lesson generalizes: for any metered API, read the rate-limit structure,
not just the price per unit.

**Next.js module-scope state silently breaking across route handlers in
dev.** During the debug-view smoke I hit `session_present: false` even
though I'd just posted to `/api/chat` with the same session id. The
in-memory session Map in `lib/sessions.ts` was a module-scope `const`. In
production that's fine — Node runs one process, one module instance, one
Map. In Next dev, each route compiles to its own module instance;
`/api/chat` wrote into one Map, `/api/session/[id]` read from a different
one. Silently. No error, just empty responses.

The fix is two lines: hoist the Map to `globalThis`, same pattern the
existing sweeper-flag already uses. It's in
[`lib/sessions.ts`](../lib/sessions.ts). The lesson is that module-scope
state bugs don't surface in unit tests — they show up at the integration
boundary where two routes share state. It's a real artifact of running an
agent loop in a serverless framework, and it's the kind of thing you don't
learn from a tutorial.

## What this looks like at 10x or 100x

Each in-memory choice has a swap path. The swap is what I'd ship if
traffic justified the work.

Session state: `Map<string, SessionState>` on `globalThis` → async façade
backed by Redis or a Postgres session table. Two days of work. The
interface in [`lib/sessions.ts`](../lib/sessions.ts) becomes
`async getOrCreateSession`; every call site already awaits the surrounding
function, so nothing structural cascades. The TTL sweeper goes away —
Redis does that natively.

Embeddings: `embeddings.json` loaded at module init → pgvector or Qdrant.
The retrieval interface in [`lib/retrieval.ts`](../lib/retrieval.ts)
becomes an async query against the vector store; the normalization,
threshold gate, and result shape stay the same. The 5 MB JSON is correct
until the corpus hits roughly ten thousand chunks. Below that, in-memory
cosine is faster and simpler than the network round-trip to a vector DB.

Logs: JSONL on the local filesystem → structured logging to Datadog,
Honeycomb, or whatever the team runs. The logger interface in
[`lib/logger.ts`](../lib/logger.ts) already wraps its writes in try/catch
for fail-open behavior. One function swap.

Eval harness: serial against localhost → parallelized with a
regression-diff against `main` on every PR. The serial loop in
[`evals/run.ts`](../evals/run.ts) becomes a worker pool. Judge cost
becomes the bottleneck — at that point I'd put a cheaper filter pass
(Sonnet or Haiku) in front of the Opus judge for clear-cut cases and
reserve Opus for borderline ones.

Escalation: `logs/handoffs/{session_id}.json` → POST to the Zendesk /
Salesforce Service Cloud / custom router API. One function in
[`lib/tools.ts`](../lib/tools.ts) changes from `writeFileSync` to `fetch`.
The payload shape doesn't change because the `reason_code` enum was the
whole design. That's why it was a first-class tool.

## What I'd build next

**Voice is first.** Parloa is voice-native; the biggest portfolio gap
relative to that company is that Fieldstone is chat-only. Wiring voice
means a STT/TTS layer, an interruption-aware streaming model, and a
different debug view — the interesting telemetry is pauses and overlap,
not tokens. The work isn't "make chat bigger," it's "design for a
different failure surface."

**Real ticketing handoff is second.** Replace
`logs/handoffs/{id}.json` with an actual POST to a Zendesk sandbox. The
payload is already in the right shape. Half a weekend; value is moving
"this would route to a contact-center platform" from a claim into a demo.

**Online learning from judge failures is third, and the most speculative.**
Feed judge-flagged grounding misses into a dashboard that tracks
corpus-quality drift. If the same chunk keeps getting cited in
fabrication-flagged replies, rewrite the article or adjust the taxonomy.
If a chunk retrieves high but the answer keeps failing, it's probably
irrelevant despite the score. Eval failures currently go into a markdown
file I read manually. That file is the prototype of the dashboard.

## What I learned doing this

Two things I actually didn't know before.

The gap between "shipping with AI" and "shipping an AI product" is mostly
about whether you measure before you gate. I've been using Claude and GPT
for operator work for a while. That's shipping with AI. Shipping an AI
product means the system's decisions are instrumented, its failure modes
are named, and the eval pass rate isn't a vibe but a number that moves
when you change code. Three of my commits in this build are specifically
"close a failure mode the eval surfaced," and those commits are legible
because the eval is legible. That's the muscle I was testing for.

The credential gap matters less than I feared. I don't write idiomatic
TypeScript as naturally as someone who went through a CS degree, and I
asked Claude for help on every non-trivial type error. What I didn't
outsource was what the system should do, where the decisions were
load-bearing, and which trade-offs to defend. The decisions in this repo —
in-memory state, SDK direct, hard-vs-soft escalation, dual-signal
confidence, Goodhart-resistant eval judgment — were mine. They're the
part of the build that matters for the job I'm applying for.

Code is at
[github.com/iamdanielkitchen/ecomm-support-agent](https://github.com/iamdanielkitchen/ecomm-support-agent).
Debug view is live at
[ecomm-support-agent.vercel.app/debug](https://ecomm-support-agent.vercel.app/debug).
Thanks for the time.
