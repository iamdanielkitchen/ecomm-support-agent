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
