# Path 2 — RAG Agent Plan

Extends the Path 1 Fieldstone support agent with a retrieval layer over a
generated help-center corpus. Path 1 answers from policy + `data/store.json`
only; Path 2 additionally grounds long-tail FAQ answers in retrieved
Markdown articles. The corpus is generated from an LLM but every factual
claim is gated by `data/store.json` to keep tools and corpus in lockstep.

Canonical topic list lives in [`data/corpus/taxonomy.json`](../data/corpus/taxonomy.json) — this doc
describes the shape and intent; the JSON is the source the pipeline reads.

---

## 1. Topic taxonomy

Eight top-level categories, 5–8 articles each, **50 articles total.**

| # | Category | Slug | # articles |
|---|----------|------|-----------:|
| 1 | Orders & Shipping            | `orders-shipping`     | 7 |
| 2 | Returns & Exchanges          | `returns-exchanges`   | 7 |
| 3 | Product Care                 | `product-care`        | 7 |
| 4 | Sizing & Specifications      | `sizing-specs`        | 6 |
| 5 | Materials & Sourcing         | `materials-sourcing`  | 6 |
| 6 | Account & Order Lookup       | `account-lookup`      | 5 |
| 7 | Gifting & Promotions         | `gifting-promotions`  | 6 |
| 8 | Company & Contact            | `company-contact`     | 6 |

See `data/corpus/taxonomy.json` for the full per-article list including
`slug`, `title`, `angle` (one-line thesis the article answers), and
`related_articles` (sibling slugs the article should link back to).

### Why this split
- Mirrors a real support-ops taxonomy so retrieval-quality evals feel
  grounded, not synthetic.
- Categories 1–2 and 6 overlap heavily with existing tool scope — these
  articles deepen context around the tools rather than replace them.
- Categories 3–5 are the "why RAG exists" categories: long-tail product
  questions the tools cannot answer, where retrieval earns its keep.
- Category 7 is intentionally out-of-scope for the agent (promos, gift
  cards). Having articles here stress-tests the escalation path — the
  retriever returns an article, the agent still escalates rather than
  quoting it as if it were policy.

---

## 2. Article template

Every article is a Markdown file with YAML frontmatter:

```markdown
---
title: "How to start a return"
category: "returns-exchanges"
slug: "how-to-start-a-return"
last_updated: "2026-04-19"
related_articles:
  - "return-eligibility-and-window"
  - "final-sale-items"
  - "refund-timelines"
---

# How to start a return

<intro paragraph — 2–3 sentences, answers the question at a glance so
customers who bounce after the first paragraph still leave informed>

## <H2 section 1 — the core "how">

<body, 2–3 short paragraphs OR a numbered list>

## <H2 section 2 — common edge case>

<body>

## <optional H2 section 3 — timing/exceptions/escalation path>

<body>

## FAQ <optional, included when 2–3 micro-questions cluster around the topic>

**Q: <short question>**
A: <1–2 sentence answer>

**Q: <short question>**
A: <1–2 sentence answer>
```

Frontmatter fields are all required except the FAQ block and
`related_articles` (empty array allowed, but discouraged — each article
should surface 2–4 siblings to improve retrieval graph coverage).

---

## 3. Style guide

**Voice.** Same register as Ember (see `lib/prompts.ts`): warm, brief,
specific, no corporate filler. Help-center voice is slightly more formal
than chat — second person, declarative, no contractions where clarity
suffers ("cannot" not "can't" for hard rules; "can't" elsewhere is fine).

**Tense.** Present tense for policy ("Returns are free for unopened
items"), imperative for instructions ("Open the order confirmation
email"), past tense only when narrating prior customer actions.

**Length.** 300–700 words per article. Below 300 and it reads like a
stub; above 700 and customers stop scrolling. Target ~450 words.

**Headings.** Sentence case, not title case. No terminal punctuation.
H1 matches `title` in frontmatter exactly.

**What articles must NOT do:**
- Contradict any policy in `data/store.json` (see §5).
- Name specific customers, order numbers, or SKUs not in the catalog.
- Promise refunds, timelines, or exceptions outside the policy block.
- Use phrases like "We sincerely apologize" / "We value your business."
- Include emoji, exclamation points beyond one per article, or hedging
  ("might", "possibly") on questions policy answers definitively.

---

## 4. Pipeline

Four stages, each a separate script + artifact. Each stage is
independently re-runnable; downstream stages read the previous stage's
artifact, not intermediate state.

| Stage | Script | Artifact |
|-------|--------|----------|
| Generate | `scripts/generate-corpus.ts` | `data/corpus/raw/{category}/{slug}.md` |
| Chunk    | `scripts/chunk-corpus.ts`    | `data/corpus/chunks.json` |
| Embed    | `scripts/embed-corpus.ts`    | `data/corpus/embeddings.json` |
| Retrieve | `lib/retrieval.ts`            | (runtime) — in-memory cosine lookup |

### 4.1 `scripts/generate-corpus.ts`

- Reads `data/store.json` (policies, catalog) and
  `data/corpus/taxonomy.json` (topic list).
- For each article: calls Claude Sonnet 4.5 via the Anthropic SDK with
  a prompt containing (a) the store policy block, (b) the article
  template, (c) the category-specific angle from taxonomy, (d) the
  related-articles hook (sibling titles + slugs).
- Writes the generated markdown to
  `data/corpus/raw/{category_slug}/{article_slug}.md`.
- Appends one JSONL line per article to `logs/corpus-build.jsonl`
  with `{ts, category, slug, tokens_in, tokens_out, latency_ms, model}`.
- CLI flags: `--sample` (one article per category, ~10 total),
  `--only <slug>` (single article), `--force` (overwrite existing),
  default (all 50, skipping already-written files).

### 4.2 `scripts/chunk-corpus.ts` (next stage, not yet built)

- Reads all `data/corpus/raw/**/*.md`.
- Strips frontmatter, splits body on H2 boundaries first, then falls
  back to ~400-token windows with 50-token overlap for any section
  longer than that.
- Emits `data/corpus/chunks.json`: array of `{chunk_id, slug, title,
  category, section_heading, text, tokens}`.

### 4.3 `scripts/embed-corpus.ts` (next stage)

- Reads `chunks.json`, embeds each chunk's `text` via
  `voyage-4-lite` (Voyage's current small general-purpose embedding model).
- Writes `data/corpus/embeddings.json`: array of `{chunk_id, vector}`.
- Voyage key pulled from `VOYAGE_API_KEY`.

### 4.4 `lib/retrieval.ts`

- Loads `chunks.json` + `embeddings.json` once at process start and
  precomputes L2 norms per vector, so each retrieve() call is one
  dot product per chunk.
- `retrieve(query, { k, threshold, request_id })` → embeds the query
  via Voyage with `input_type="query"` (asymmetric to the document
  embeddings), cosine-scores every chunk, returns the top-k with
  their scores plus timing breakdown. Default `k=5`, default
  `threshold=DEFAULT_RETRIEVAL_THRESHOLD` (see §4.4 calibration
  below).
- If the top-1 score is below `threshold`, returns `chunks: []` —
  an explicit "no confident hit" signal the agent branches on
  rather than grounding off weak retrieval.
- Per-call JSONL log at `logs/retrieval.jsonl` (gitignored):
  query, top_k_chunk_ids, top_k_scores, latencies, and a
  caller-supplied `request_id` for correlation with chat sessions.
- In-memory only. 265 chunks × 1024 dims × 4 bytes ≈ 1 MB of hot
  vectors. Cosine over the whole set is ~2 ms; the query-embedding
  round trip dominates at ~300 ms. No vector DB.

#### Threshold calibration (2026-04-19 smoke test)

Six-query smoke test against voyage-4-lite established the score
distribution on this corpus: **noise ~0.20** (off-topic control),
**weak on-topic 0.33–0.40** (short queries and identifier-style
queries), **solid on-topic 0.54–0.65** (full-sentence semantic
matches). The original 0.65 default filtered 4 of 5 on-topic queries.

The default is set to **0.40** — approximately 2× the observed
noise floor. It passes the three full-sentence on-topic queries
(shipping, cast-iron care, gift-card + promo interaction) with
margin and filters the weather-control query (0.20) comfortably.
Two on-topic queries still filter at 0.40: the terse
return-flow query (`"how do I return something I opened"`, top-1
0.390) and the identifier query (`"FG-123456"`, top-1 0.331).
Both represent the short-query asymmetry noted below; lowering
the gate further to capture them would squeeze the noise margin
and is a judgment call the agent can work around by calling the
search tool only when its own policy block cannot answer. Q1
(returns) and Q6 (order-number format) filter at 0.40 and are
handled by `check_return_eligibility` and the system prompt
respectively — retrieval is backup, not primary, for those
paths. The constant is exported as `DEFAULT_RETRIEVAL_THRESHOLD`
so callers reference the tuned value by name.

Known asymmetry — worth capturing in the postmortem: short
queries (e.g. `"FG-123456"` at 7 tokens) score ~0.10 lower than
full-sentence queries on the same topic, even when the top-1
chunk is semantically correct. voyage-4-lite's asymmetric
embedding pairs a compressed query representation against
richer document chunks; brevity compresses further. Mitigations
we're not adopting in this build but should document: (a) a
query-rewrite pass that expands terse queries before embedding,
(b) a reranker as a second stage, (c) a per-query-length
dynamic threshold. Any of the three moves the calibration
question from "one knob" to "two knobs" — not worth the
complexity at 50 articles.

### 4.5 Agent integration (next stage)

- Add a `search_help_center` tool to `lib/tools.ts` that wraps
  `retrieve()`.
- Update `lib/prompts.ts`: the agent may call `search_help_center` for
  policy or product questions it cannot answer from the store-policy
  block directly. It **must still** call `lookup_order` and
  `check_return_eligibility` for order-specific questions — retrieval
  never replaces tools.

---

## 5. Consistency rule (load-bearing)

**Every factual claim in every article that overlaps `data/store.json`
must be derivable from `data/store.json`.** Specifically:

- **Return window** — the 30-day figure lives in the system prompt and
  is duplicated nowhere else. Articles that state a window MUST use 30
  days.
- **Opened-item return fee** — $7.95. Exact figure, no rounding.
- **Final-sale items** — every article that names a final-sale example
  must use a SKU with `final_sale: true` in `store.json`.
- **Refund timeline** — 5–7 business days after warehouse receipt.
- **Shipping** — standard 3–5 business days, expedited 1–2 business
  days. No same-day exists; articles must not imply it does.
- **SKUs and catalog** — articles may reference product lines (cast iron,
  linen throws, wool rugs) but must not invent SKUs, prices, or
  variants not in `catalog`.

**How the pipeline enforces this:**
1. The generation prompt includes the full policy block + catalog as
   authoritative ground truth with an explicit "do not contradict" rule.
2. A post-generation lint (`scripts/lint-corpus.ts`, not yet built —
   stretch for Path 2 if time permits) regex-scans every article for
   "$X.XX" return fees and "N-day" windows, and fails the build if any
   value disagrees with `store.json`.
3. If `store.json` changes, the corpus is regenerated — do not hand-edit
   articles to patch policy drift.

The consistency rule is the whole reason the corpus exists as a
downstream artifact of `store.json` instead of as a parallel source of
truth. Retrieval surfaces content the tools cannot; it must not surface
claims the tools contradict.
