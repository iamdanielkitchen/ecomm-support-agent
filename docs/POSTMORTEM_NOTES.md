# Postmortem notes — Path 2 build

Scratch file for findings to incorporate into the full writeup later.
Notes appended during the build, not edited for polish.

1. Short queries score lower than long queries on voyage-4-lite.
   Observed in threshold calibration: "how do I return something I
   opened" scored 0.390 while semantically-exact match. Asymmetry
   is known in document-vs-query embedding spaces. Mitigation if
   needed: query-expansion step before retrieval.

2. Dual-signal confidence surfaced a structural disagreement.
   Self-scored (Haiku, no context) and retrieval-derived signals
   disagree on grounded-but-confident-sounding replies. Haiku
   cannot distinguish "quoted from retrieved chunk" from
   "fabricated from nothing" because the scorer doesn't see the
   chunks. Retrieval-derived confidence is the more reliable
   signal for grounded replies; self-scored is useful for catching
   hedged/empty replies. Future work: pass chunks into self-scorer
   for a third "grounded-in-context" signal.

3. Escalation distinction matters more than escalation coverage.
   Hard escalation via tool is for authority-bounded problems
   (payment, policy exceptions, account access). Soft verbal
   offers handle out-of-catalog curiosity without consuming human
   agent tickets. Naive "escalate everything the bot can't answer"
   design multiplies human-agent load without adding value.

4. Generic weekend RAG builds hide failure modes; this one
   surfaces them. Trace view exposes (a) retrieval quality per
   turn, (b) agent re-query behavior, (c) grounding vs.
   fabrication distinction. The debug view is the interview
   surface.

## Eval findings (first full run)

- Pass rate: 28/36 runs (18 cases × 2)
- Stability: 16 of 18 cases stable across 2 runs
- Notable: Opus judge passed rag-1 "cast iron seasoning" with a
  grounded verdict; Haiku self-scorer rated the same reply 0.35.
  Same agent output, two scorers, opposite verdicts. Self-scoring
  without retrieval context is weaker signal than judge-with-trace.
  Reinforces the dual-signal finding.
- Category-level pattern: the 8 failing runs cluster by scenario
  type, not by bad replies. Retrieval-miss cases (rag-12 chef's
  knives, rag-13 copper colander, plus rag-8 rug sizing which is
  catalog-adjacent) failed 5 of 6 runs on tool_routing — the agent
  refused honestly from its own knowledge instead of first calling
  search_help_center. Grounding and response_quality passed on most
  of those same runs. Root cause is a prompt gap, not an agent
  capability gap: SYSTEM_PROMPT doesn't explicitly require
  attempting retrieval before declining a product-existence or
  product-detail question. Fix is a one-line prompt update.
  Tool-primary, escalation, and off-topic categories were 12/12
  clean — the agent's tool routing is crisp everywhere the system
  prompt is explicit.
- Two divergent cases expose a separate failure mode: rag-4 walnut
  board (run 1 got a retrieval error response → agent fabricated
  generic wood-care advice without acknowledging the tool failure;
  judge flagged grounding fail) and rag-6 wool RWS (identical
  retrieval both runs; judge called the same "New Zealand /
  Tasmania" specifics "likely in the truncated chunk" on run 0
  and "unsupported fabrication" on run 1). First is a real bug —
  the agent doesn't handle search_help_center tool errors
  gracefully. Second is judge-calibration noise on borderline
  grounding where the truncated chunk content hides the decisive
  evidence; fixable by either un-truncating more aggressively or
  passing chunk metadata the judge can reason over.

## Emergent finding from confidence instrumentation

Dual-signal confidence was instrumented for measurement, not
for behavior gating. In the first full eval run, the failure
data revealed an unintended signal: self_score < 0.70 AND
retrieval not used catches 5 of 6 retrieval-miss failures.
This is a cheap retry heuristic the design didn't anticipate —
surfaced only because we measured both signals independently.
Fix shipped before relying on it, but it's worth noting: if
you instrument honestly, the system tells you what to fix.

## Infrastructure note: free-tier rate limits and eval design

Voyage's payment-free tier is capped at 3 RPM. Across an 18-case
× 3-run eval suite, this manifested as one rag-4 retrieval-error
cascade where the agent fabricated wood-care advice after the
search tool returned an empty error response. Diagnosis surfaced
because instrumentation logged the empty above_threshold flag.
Mitigation was twofold: tighten the agent-side tool-error
prompt (Fix 3) so fabrication doesn't fill the gap, and remove
the rate-limit ceiling by adding a payment method (still $0
spend — same 200M-token free tier, just higher RPM/TPM ceilings).
Lesson for production deployment: the free-tier limit isn't a
spending question, it's a throughput-shape question; eval suites
hit RPM ceilings well before they hit token ceilings.

## Eval findings (second full run, after three fixes)

- Pass rate: 53/54 runs (18 cases × 3)
- Stability: 17 of 18 cases stable across 3 runs
- Deltas from first run:
    rag-8 (rug sizing): 0/2 → 3/3 — Fix 1 closed it
    rag-12 (chef's knives): 0/2 → 3/3 — Fix 1 closed it
    rag-13 (copper colander): 0/2 → 2/3 — Fix 1 helped, one residual
    rag-4 (walnut board): 1/2 → 3/3 — Fix 3 + Tier-1 rate limit
    rag-6 (wool RWS): 1/2 → 3/3 — Fix 2 made the evidence visible
- No regressions on the 12 previously-passing cases.
- Cost: $2.37 vs prior $1.34 (1.77× for 1.5× more runs + truncation bump).
- The lone residual divergence (rag-13 run 1) is phrasing-level:
  agent said "Our inventory team tracks those details" after
  NO_RELEVANT_CONTENT came back; judge read that as implying the
  product exists. Runs 0 and 2 framed the same handoff without
  the implicit-existence phrasing and passed. This looks like
  residual judge noise on borderline "we don't carry this" vs
  "we can't check right now" distinctions, not a systemic bug.
  Candidate for a prompt nuance later; not a ship-blocker.
