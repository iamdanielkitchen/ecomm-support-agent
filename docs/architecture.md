# Architecture

Two diagrams: the **runtime** agent loop (what happens when a customer
sends a chat message) and the **build-time** corpus pipeline (what
happens once, offline, to produce the retrieval index). They are
deliberately separated — build-time runs as a set of pnpm scripts
against the Anthropic and Voyage APIs; runtime serves a single chat
turn off in-memory state plus three live API calls (Sonnet for the
agent loop, Voyage for the query embedding, Haiku for post-turn
confidence scoring).

The runtime side is intentionally lean. CLAUDE.md pre-commits to no
database, no vector store, no auth, no voice for Weekend 1; Path 2
added a corpus but kept the same posture. The 265-chunk index fits
in ~1 MB of hot vectors, cosine over the full set takes ~2 ms, and
the interesting latency is the query-embedding round trip. The three
non-obvious choices worth flagging up front:

1. **Voyage via MongoDB Atlas (`ai.mongodb.com/v1/embeddings`), not
   the public Voyage endpoint.** Our API key is scoped to Atlas and
   returns 403 on the direct Voyage host; we also skip the `voyageai`
   npm SDK because its 0.2.1 release ships a broken ESM export. Native
   `fetch` against the Atlas URL is both smaller and more reliable.
2. **In-memory session state via `globalThis`.** The Path 1 design
   used a module-scope `Map`, which silently empties across route
   handlers in Next dev (each route compiles to its own module
   instance). Hoisting to `globalThis` gives `/api/chat` and
   `/api/session/[id]` a shared handle without introducing a real
   store.
3. **Dual-signal confidence is instrumentation, not a gate.** The
   Haiku self-scorer and the retrieval-derived score are logged and
   rendered in `/debug` but never used to branch the agent. We wanted
   to measure calibration first; surfacing when the two disagree has
   been the more valuable finding than either score alone.

---

## Runtime — agent loop (worked example: "how do I season a cast iron pan")

```mermaid
flowchart TD
    User([Chat UI])

    subgraph Next[" Next.js · Node runtime "]
        ChatRoute["/api/chat"]
        SessionAPI["/api/session/id"]
        DebugRoute["/debug"]
    end

    subgraph AgentCore[" Agent core "]
        AgentLoop["lib/agent.ts<br/>tool_use loop"]
        Sessions[("Session store<br/>globalThis Map<br/>tool_trace + confidence")]
    end

    subgraph Tools[" Tool dispatcher · lib/tools.ts "]
        SearchTool["search_help_center"]
        OtherTools["lookup_order<br/>check_return_eligibility<br/>escalate_to_human"]
    end

    subgraph Retrieval[" Retrieval · lib/retrieval.ts "]
        RetrievalLib["cosine over 265 chunks<br/>threshold gate at 0.40"]
        Corpus[("chunks.json<br/>embeddings.json<br/>loaded at module init")]
    end

    Sonnet(["Claude Sonnet 4.6<br/>agent model"])
    Haiku(["Claude Haiku 4.5<br/>confidence scorer"])
    Voyage(["Voyage Atlas<br/>/v1/embeddings<br/>input_type=query"])

    StoreJSON[("store.json<br/>orders · catalog · returns")]
    Handoffs[("logs/handoffs/*.json")]
    Logs["logs/*.jsonl<br/>sessions · retrieval<br/>confidence"]

    User -->|1. POST message| ChatRoute
    ChatRoute -->|2. createAgentStream| AgentLoop
    AgentLoop <-->|3. messages + tool_use<br/>streaming| Sonnet
    AgentLoop -->|4. runTool search_help_center| SearchTool
    SearchTool -->|5. retrieve query| RetrievalLib
    RetrievalLib -->|6. embed query| Voyage
    Voyage -->|7. 1024-dim vector| RetrievalLib
    RetrievalLib -->|8. top-5 chunks + scores| SearchTool
    SearchTool -->|9. joined markdown<br/>+ chunk refs| AgentLoop
    AgentLoop -->|10. tool_result<br/>next iteration| Sonnet

    AgentLoop -.->|same pattern<br/>runTool -> store.json| OtherTools
    OtherTools -.-> StoreJSON
    OtherTools -.-> Handoffs

    AgentLoop -->|11. record invocation| Sessions
    AgentLoop -->|12. post-turn score| Haiku
    Haiku -->|JSON verdict| AgentLoop
    AgentLoop -->|13. append turn| Logs
    AgentLoop -->|14. stream NDJSON| ChatRoute
    ChatRoute -->|15. text + events| User

    User -.->|GET| DebugRoute
    DebugRoute -.-> SessionAPI
    SessionAPI -.-> Sessions
    SessionAPI -.-> Logs

    classDef external fill:#1a2a3a,stroke:#3a5a7a,color:#d0e0f0
    classDef data fill:#2a1f1a,stroke:#5a4a3a,color:#e0d0c0
    classDef route fill:#1a2a1a,stroke:#3a5a3a,color:#d0e0d0
    class Sonnet,Haiku,Voyage external
    class StoreJSON,Handoffs,Logs,Sessions,Corpus data
    class ChatRoute,SessionAPI,DebugRoute,User route
```

**What the worked example shows.** A customer asks about cast-iron
care (steps 1–2). The agent loop sends the transcript to Sonnet
(step 3), which returns a `tool_use` block requesting
`search_help_center` with a reformulated query. `runTool` dispatches
to the tool impl (step 4), which calls `retrieve()`. Retrieval
embeds the query via Voyage Atlas with `input_type="query"` — the
asymmetric pair to the `input_type="document"` used at build time —
computes cosine against the 265 precomputed vectors, checks the
top-1 against the 0.40 threshold, and returns the top-5 with scores
and timing (steps 5–8). The tool joins those chunks into a small
Markdown document with headers and gives it back to the loop (step
9), which feeds it as `tool_result` to Sonnet for the next
iteration (step 10). Sonnet produces the final streamed reply. In
the `finally` block the agent loop makes a side call to Haiku to
score the reply against the user message (step 12) and appends
everything — tool invocations, confidence object, turn log — to the
session store and JSONL logs (steps 11, 13). The `/debug` route
(dashed edges) reads that same state back through
`/api/session/[id]` so the interview surface renders exactly the
state the agent saw, not a sanitized view.

**The three other tools follow the same dispatcher pattern** —
`runTool` looks up the handler by name; `lookup_order` and
`check_return_eligibility` read `store.json`, `escalate_to_human`
writes a handoff payload and flips the session terminal. Retrieval
is the only tool that touches an external API at request time.

---

## Build-time — corpus pipeline (offline, runs once per corpus change)

```mermaid
flowchart LR
    StoreJSON[("data/store.json<br/>policies + catalog")]
    Taxonomy[("data/corpus/taxonomy.json<br/>8 categories · 50 articles")]

    Generate["scripts/generate-corpus.ts<br/>→ Claude Sonnet 4.6<br/>per-article prompt"]
    Raw[("data/corpus/raw/<br/>category/slug.md<br/>YAML frontmatter + body")]

    Chunk["scripts/chunk-corpus.ts<br/>split on H2 · 400-tok windows"]
    Chunks[("data/corpus/chunks.json<br/>265 chunks")]

    Embed["scripts/embed-corpus.ts<br/>batch 20 · paced for free-tier"]
    VoyageDoc(["Voyage Atlas<br/>/v1/embeddings<br/>input_type=document"])
    Embeddings[("data/corpus/embeddings.json<br/>265 × 1024-dim")]

    BuildLogs[("logs/corpus-build.jsonl<br/>logs/embedding-build.jsonl")]

    StoreJSON -->|policy + catalog<br/>inlined as context| Generate
    Taxonomy -->|article list| Generate
    Generate --> Raw
    Generate -.-> BuildLogs

    Raw --> Chunk
    Chunk --> Chunks

    Chunks --> Embed
    Embed <-->|batch embed| VoyageDoc
    Embed --> Embeddings
    Embed -.-> BuildLogs

    classDef script fill:#2a2a14,stroke:#5a5a24,color:#f0f0c0
    classDef external fill:#1a2a3a,stroke:#3a5a7a,color:#d0e0f0
    classDef data fill:#2a1f1a,stroke:#5a4a3a,color:#e0d0c0
    class Generate,Chunk,Embed script
    class VoyageDoc external
    class StoreJSON,Taxonomy,Raw,Chunks,Embeddings,BuildLogs data
```

**What the build pipeline does.** Three scripts, three artifacts,
each stage re-runnable against the previous stage's output.
`generate-corpus.ts` takes the canonical topic list in
`taxonomy.json` plus the policy block + catalog from `store.json`
(inlined as ground-truth context) and produces 50 Markdown articles
with YAML frontmatter. The consistency rule — every factual claim
overlapping `store.json` must derive from `store.json` — is enforced
at generation time by the system prompt. `chunk-corpus.ts` strips
frontmatter, splits on H2 boundaries, and emits 265 chunks with a
`char/4` token estimate; a re-chunking re-reads raw markdown without
re-calling Claude. `embed-corpus.ts` batches 20 chunks per call
against the Atlas endpoint with `input_type="document"` (asymmetric
to the runtime query side) and writes a single ~5 MB JSON of
`{chunk_id, vector}` pairs. The free-tier ceiling of 3 RPM / 10K TPM
is the binding constraint for the full corpus; the script paces
itself with a 21-second inter-batch delay by default.

The runtime diagram depends on `chunks.json` and `embeddings.json`.
Nothing else in the build pipeline is reached at request time. If
`store.json` changes, the full chain re-runs; the articles are the
only stage that's expensive (~20 s × 50 articles via Sonnet), and
re-chunking + re-embedding are both under a minute.
